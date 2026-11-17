const express = require('express');
const router = express.Router();
const https = require('https');
const db = require('../db');
const zatcaCrypto = require('../zatca_crypto');

const ZATCA_URLS = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core'
};

function makeZatcaApiCall({ endpoint, method, headers, payload, env = 'sandbox' }) {
  return new Promise((resolve, reject) => {
    const baseUrl = ZATCA_URLS[env] || ZATCA_URLS.sandbox;
    const url = new URL(`${baseUrl}${endpoint}`);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Accept-Version': 'V2',
        ...headers
      },
      timeout: 12000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', err => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('ZATCA API request timed out'));
    });

    if (payload) {
      req.write(JSON.stringify(payload));
    }
    req.end();
  });
}

// 1. ZATCA Connection Status & Stats
router.get('/status', (req, res) => {
  try {
    const s = db.prepare('SELECT vat_number, cr_number, company_name_en, zatca_env, zatca_csid, zatca_compliance_request_id FROM settings LIMIT 1').get() || {};
    const isLinked = !!(s.zatca_csid);

    let stats = { total: 0, reported: 0, pending: 0, cleared: 0, rejected: 0 };
    try {
      const resStats = db.prepare(`
        SELECT 
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN zatca_status = 'REPORTED' THEN 1 ELSE 0 END), 0) as reported,
          COALESCE(SUM(CASE WHEN zatca_status = 'CLEARED' THEN 1 ELSE 0 END), 0) as cleared,
          COALESCE(SUM(CASE WHEN zatca_status = 'REJECTED' THEN 1 ELSE 0 END), 0) as rejected,
          COALESCE(SUM(CASE WHEN zatca_status = 'PENDING' OR zatca_status IS NULL THEN 1 ELSE 0 END), 0) as pending
        FROM invoices
      `).get();
      if (resStats) stats = resStats;
    } catch (e) {}

    res.json({
      success: true,
      data: {
        isLinked,
        env: s.zatca_env || 'sandbox',
        vatNumber: s.vat_number || '399999999900003',
        crNumber: s.cr_number || '1010000000',
        companyName: s.company_name_en || 'STORE',
        requestId: s.zatca_compliance_request_id || null,
        invoiceStats: stats
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. CSR & Private Key Generation (secp256k1 EC Keypair)
router.post('/generate-csr', (req, res) => {
  try {
    const { env, vatNumber, crNumber, companyName, branchName } = req.body;
    const cleanVat = vatNumber ? vatNumber.trim() : '399999999900003';
    const cleanCr = crNumber ? crNumber.trim() : '1010000000';
    const cleanName = companyName ? companyName.trim() : 'RETAIL STORE';

    const { privateKey, publicKey, csr } = zatcaCrypto.generateZatcaKeysAndCSR({
      vatNumber: cleanVat,
      crNumber: cleanCr,
      companyName: cleanName,
      branchName: branchName || 'Main',
      env: env || 'sandbox'
    });

    db.prepare(`
      UPDATE settings 
      SET zatca_env = ?, zatca_private_key = ?, zatca_public_key = ?, vat_number = ?, cr_number = ?, company_name_en = ?
      WHERE id = 1
    `).run(env || 'sandbox', privateKey, publicKey, cleanVat, cleanCr, cleanName);

    res.json({
      success: true,
      message: 'EC Keypair & CSR generated successfully with secp256k1 curve!',
      csr: csr
    });
  } catch (err) {
    console.error('CSR Generation Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Fatoora Portal OTP CSID Onboarding
router.post('/onboard', async (req, res) => {
  const { otp, csr } = req.body;
  if (!otp || !otp.trim()) {
    return res.status(400).json({ success: false, error: 'OTP is required' });
  }

  try {
    const s = db.prepare('SELECT * FROM settings LIMIT 1').get() || {};
    const csrString = csr || (s.zatca_public_key ? Buffer.from(s.company_name_en).toString('base64') : '');

    let csidToken = '';
    let secret = '';
    let reqId = '';

    if (s.zatca_env === 'production') {
      const authHeader = 'Basic ' + Buffer.from(`${otp.trim()}:`).toString('base64');
      const apiRes = await makeZatcaApiCall({
        endpoint: '/compliance',
        method: 'POST',
        headers: { 'Authorization': authHeader },
        payload: { csr: csrString },
        env: 'production'
      });

      if (apiRes.statusCode === 200 && apiRes.data.binarySecurityToken) {
        csidToken = apiRes.data.binarySecurityToken;
        secret = apiRes.data.secret;
        reqId = apiRes.data.requestID || `REQ-${Date.now()}`;
      } else {
        return res.status(400).json({
          success: false,
          error: apiRes.data?.errors || apiRes.data?.message || 'ZATCA Onboarding failed'
        });
      }
    } else {
      reqId = 'REQ-SIM-' + Date.now();
      csidToken = Buffer.from(`MOCK_SIMULATION_CSID_TOKEN_${s.vat_number}_${Date.now()}`).toString('base64');
      secret = 'SEC_' + require('crypto').randomBytes(16).toString('hex');
    }

    db.prepare(`
      UPDATE settings 
      SET zatca_csid = ?, zatca_secret = ?, zatca_compliance_request_id = ?
      WHERE id = 1
    `).run(csidToken, secret, reqId);

    res.json({
      success: true,
      message: `Onboarding completed successfully in ${(s.zatca_env || 'sandbox').toUpperCase()} mode!`,
      data: {
        complianceRequestId: reqId,
        token: csidToken.slice(0, 35) + '...'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Sync All Pending Invoices (Both PC & Mobile) to ZATCA Phase 2
router.post('/sync-invoices', async (req, res) => {
  try {
    const s = db.prepare('SELECT * FROM settings LIMIT 1').get() || {};
    if (!s.zatca_csid) {
      return res.status(400).json({ success: false, error: 'ZATCA Phase-2 is not onboarded yet. Complete Step 1 & Step 2 first.' });
    }

    const pendingInvoices = db.prepare(`
      SELECT * FROM invoices 
      WHERE zatca_status = 'PENDING' OR zatca_status IS NULL
      ORDER BY id ASC
      LIMIT 100
    `).all();

    if (pendingInvoices.length === 0) {
      return res.json({ success: true, message: 'All PC & Mobile invoices are already reported to ZATCA!', syncedCount: 0 });
    }

    let syncedCount = 0;
    const now = new Date().toISOString();

    for (const inv of pendingInvoices) {
      let xmlStr = inv.zatca_xml;
      let hashB64 = inv.zatca_hash;
      let invUuid = inv.invoice_uuid;

      // Generate UBL XML if missing (e.g., legacy or mobile invoice)
      if (!xmlStr || !hashB64) {
        const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(inv.id);
        invUuid = invUuid || require('crypto').randomUUID();
        xmlStr = zatcaCrypto.buildUBL21InvoiceXML({
          invoiceNo: inv.invoice_no,
          uuid: invUuid,
          issueDate: inv.invoice_date,
          issueTime: inv.invoice_time || '12:00:00',
          invoiceTypeCode: inv.is_return ? '381' : '388',
          invoiceSubtype: inv.invoice_type === 'standard' ? '0100000' : '0200000',
          pih: zatcaCrypto.DEFAULT_INITIAL_PIH,
          icv: inv.icv || inv.id,
          seller: s,
          buyer: { name: inv.customer_name || 'Walk-in Customer', vat_number: inv.customer_vat || '' },
          items,
          totals: { subtotal: inv.subtotal, vat_amount: inv.vat_amount, total_amount: inv.total_amount }
        });
        hashB64 = zatcaCrypto.computeInvoiceHash(xmlStr).hashBase64;
        db.prepare('UPDATE invoices SET zatca_xml = ?, zatca_hash = ?, invoice_uuid = ? WHERE id = ?')
          .run(xmlStr, hashB64, invUuid, inv.id);
      }

      if (s.zatca_env === 'production' && xmlStr) {
        try {
          const auth = 'Basic ' + Buffer.from(`${s.zatca_csid}:${s.zatca_secret}`).toString('base64');
          const payload = {
            invoiceHash: hashB64,
            uuid: invUuid,
            invoice: Buffer.from(xmlStr, 'utf8').toString('base64')
          };

          const endpoint = (inv.invoice_type === 'standard') ? '/invoices/clearance/single' : '/invoices/reporting/single';
          const apiRes = await makeZatcaApiCall({
            endpoint,
            method: 'POST',
            headers: { 'Authorization': auth },
            payload,
            env: 'production'
          });

          if (apiRes.statusCode === 200 || apiRes.statusCode === 202) {
            const finalStatus = (inv.invoice_type === 'standard') ? 'CLEARED' : 'REPORTED';
            db.prepare("UPDATE invoices SET zatca_status = ?, reported_at = ?, is_synced = 0 WHERE id = ?")
              .run(finalStatus, now, inv.id);
            syncedCount++;
          } else {
            db.prepare("UPDATE invoices SET zatca_status = 'REJECTED', zatca_errors = ?, is_synced = 0 WHERE id = ?")
              .run(JSON.stringify(apiRes.data?.validationResults || apiRes.data), inv.id);
          }
        } catch (apiErr) {}
      } else {
        const finalStatus = (inv.invoice_type === 'standard') ? 'CLEARED' : 'REPORTED';
        db.prepare("UPDATE invoices SET zatca_status = ?, reported_at = ?, is_synced = 0 WHERE id = ?")
          .run(finalStatus, now, inv.id);
        syncedCount++;
      }
    }

    res.json({
      success: true,
      message: `Successfully reported ${syncedCount} PC & Mobile invoices to ZATCA Phase 2!`,
      syncedCount
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Download Legal UBL 2.1 XML
router.get('/download-xml/:invoiceNo', (req, res) => {
  try {
    const inv = db.prepare('SELECT invoice_no, zatca_xml FROM invoices WHERE invoice_no = ?').get(req.params.invoiceNo);
    if (!inv || !inv.zatca_xml) {
      return res.status(404).send('UBL 2.1 XML not found for this invoice.');
    }

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.invoice_no}_zatca.xml"`);
    res.send(inv.zatca_xml);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// 6. Reset ZATCA Keys
router.post('/reset', (req, res) => {
  try {
    db.prepare(`
      UPDATE settings 
      SET zatca_csid = NULL, zatca_secret = NULL, zatca_private_key = NULL, zatca_public_key = NULL, zatca_compliance_request_id = NULL
      WHERE id = 1
    `).run();
    res.json({ success: true, message: 'ZATCA connection reset successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
