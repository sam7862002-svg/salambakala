const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const db = require('../db');
let zatcaCrypto = null;
try {
  zatcaCrypto = require('../zatca_crypto');
} catch (e) {
  console.log('zatca_crypto module load skipped');
}

// 1. Auto-migrate missing database columns safely
try {
  // A. Columns for invoices table
  const invCols = db.prepare("PRAGMA table_info(invoices)").all().map(c => c.name);
  const neededInvCols = [
    ['terminal_id', "TEXT DEFAULT '1'"],
    ['icv', "INTEGER DEFAULT 1"],
    ['pih', "TEXT DEFAULT ''"],
    ['zatca_hash', "TEXT DEFAULT ''"],
    ['zatca_signature', "TEXT DEFAULT ''"],
    ['zatca_xml', "TEXT DEFAULT ''"],
    ['zatca_status', "TEXT DEFAULT 'PENDING'"],
    ['zatca_qr', "TEXT DEFAULT ''"],
    ['notes', "TEXT DEFAULT ''"]
  ];
  neededInvCols.forEach(([col, def]) => {
    if (!invCols.includes(col)) {
      try { db.prepare(`ALTER TABLE invoices ADD COLUMN ${col} ${def}`).run(); } catch (err) {}
    }
  });

  // B. Missing columns for invoice_items table (discount_amount, batch_no, expiry_date)
  const itemCols = db.prepare("PRAGMA table_info(invoice_items)").all().map(c => c.name);
  const neededItemCols = [
    ['discount_amount', "REAL DEFAULT 0"],
    ['batch_no', "TEXT DEFAULT ''"],
    ['expiry_date', "TEXT DEFAULT ''"]
  ];
  neededItemCols.forEach(([col, def]) => {
    if (!itemCols.includes(col)) {
      try { db.prepare(`ALTER TABLE invoice_items ADD COLUMN ${col} ${def}`).run(); } catch (err) {}
    }
  });
} catch (e) {
  console.error('Invoice migration error:', e.message);
}

function getKsaNow() {
  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utcMs + (3 * 3600000)); // Exact KSA Time (UTC+3)
}

function getBusinessDate() {
  const ksa = getKsaNow();
  if (ksa.getHours() < 6) {
    ksa.setDate(ksa.getDate() - 1);
  }
  const yyyy = ksa.getFullYear();
  const mm = String(ksa.getMonth() + 1).padStart(2, '0');
  const dd = String(ksa.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getKsaTimeString() {
  const ksa = getKsaNow();
  const hh = String(ksa.getHours()).padStart(2, '0');
  const min = String(ksa.getMinutes()).padStart(2, '0');
  const ss = String(ksa.getSeconds()).padStart(2, '0');
  return `${hh}:${min}:${ss}`;
}

function syncInvoiceToSupabase(invoiceData) {
  try {
    const store = db.prepare('SELECT supabase_url, supabase_key FROM settings WHERE id = 1').get();
    if (!store || !store.supabase_url || !store.supabase_key) return;

    let sUrl = store.supabase_url.trim().replace(/\/$/, '');
    const sKey = store.supabase_key.trim();
    if (!sUrl || !sKey) return;

    const payload = JSON.stringify({
      invoice_no: invoiceData.invoice_no,
      invoice_date: invoiceData.invoice_date,
      invoice_time: invoiceData.invoice_time,
      customer_name: invoiceData.customer_name,
      total_amount: invoiceData.total_amount,
      vat_amount: invoiceData.vat_amount,
      payment_method: invoiceData.payment_method,
      is_return: invoiceData.is_return ? 1 : 0
    });

    const parsed = new URL(`${sUrl}/rest/v1/live_sales`);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': sKey,
        'Authorization': `Bearer ${sKey}`,
        'Prefer': 'return=minimal'
      },
      timeout: 4000
    };

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(options, () => {});
    req.on('error', () => {});
    req.on('timeout', () => { req.destroy(); });
    req.write(payload);
    req.end();
  } catch (e) {}
}

function processInvoice(p) {
  const isReturn = p.is_return ? 1 : 0;
  const dateStr = p.invoice_date || getBusinessDate();
  const timeStr = getKsaTimeString();
  const invoiceUuid = p.invoice_uuid || crypto.randomUUID();

  let terminalPrefix = 'INV-';
  if (p.terminal_id) {
    terminalPrefix = `T${p.terminal_id}-`;
  }
  if (isReturn) {
    terminalPrefix = p.terminal_id ? `RET-T${p.terminal_id}-` : 'RET-';
  }

  const prefix = terminalPrefix + dateStr.replace(/-/g, '') + '-';
  const last = db.prepare('SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY id DESC LIMIT 1').get(prefix + '%');
  let seq = 1;
  if (last) {
    const parts = last.invoice_no.split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(n)) seq = n + 1;
  }
  const invoiceNo = prefix + String(seq).padStart(4, '0');

  let totalAmount = 0;
  let vatAmount = 0;
  let subtotal = 0;

  p.items.forEach(it => {
    const lineTot = parseFloat(it.line_total) || (parseFloat(it.selling_price) * (parseFloat(it.quantity) || 1));
    totalAmount += lineTot;
    const lineBase = lineTot / 1.15;
    subtotal += lineBase;
    vatAmount += (lineTot - lineBase);
  });

  let store = {};
  try { store = db.prepare('SELECT * FROM settings LIMIT 1').get() || {}; } catch(e) {}

  let currentIcv = 1;
  let previousInvoiceHash = (zatcaCrypto && zatcaCrypto.DEFAULT_INITIAL_PIH) ? zatcaCrypto.DEFAULT_INITIAL_PIH : '';
  try {
    const lastInvoiceInChain = db.prepare('SELECT icv, zatca_hash FROM invoices ORDER BY id DESC LIMIT 1').get();
    if (lastInvoiceInChain && lastInvoiceInChain.icv) currentIcv = lastInvoiceInChain.icv + 1;
    if (lastInvoiceInChain && lastInvoiceInChain.zatca_hash) previousInvoiceHash = lastInvoiceInChain.zatca_hash;
  } catch (e) {}

  const isB2B = (p.invoice_type === 'standard' || (p.customer_vat && p.customer_vat.length >= 15));
  const invoiceSubtype = isB2B ? '0100000' : '0200000';
  const invoiceTypeCode = isReturn ? '381' : '388';

  let xmlPayload = '';
  let hashBase64 = '';
  let signatureBase64 = '';
  let zatcaQr = '';
  const timestampIso = `${dateStr}T${timeStr}Z`;

  // 2. Safe ZATCA crypto generation (will not crash if private key is missing)
  try {
    if (zatcaCrypto && typeof zatcaCrypto.buildUBL21InvoiceXML === 'function') {
      xmlPayload = zatcaCrypto.buildUBL21InvoiceXML({
        invoiceNo,
        uuid: invoiceUuid,
        issueDate: dateStr,
        issueTime: timeStr,
        invoiceTypeCode,
        invoiceSubtype,
        pih: previousInvoiceHash,
        icv: currentIcv,
        seller: {
          company_name_en: store.company_name_en,
          vat_number: store.vat_number,
          cr_number: store.cr_number,
          street_en: store.street_en,
          building_no: store.building_no,
          district_en: store.district_en,
          city_en: store.city_en,
          postal_code: store.postal_code
        },
        buyer: {
          name: p.customer_name || 'Walk-in Customer',
          vat_number: p.customer_vat || ''
        },
        items: p.items,
        totals: {
          subtotal,
          vat_amount: vatAmount,
          total_amount: totalAmount
        }
      });

      if (typeof zatcaCrypto.computeInvoiceHash === 'function') {
        const hashRes = zatcaCrypto.computeInvoiceHash(xmlPayload);
        if (hashRes) {
          hashBase64 = hashRes.hashBase64 || '';
          if (store.zatca_private_key && typeof zatcaCrypto.signInvoiceHash === 'function') {
            try {
              const signRes = zatcaCrypto.signInvoiceHash(hashRes.hashBuffer, store.zatca_private_key);
              if (signRes) {
                signatureBase64 = signRes.signatureBase64 || '';
                if (typeof zatcaCrypto.generatePhase2TLV_QR === 'function') {
                  zatcaQr = zatcaCrypto.generatePhase2TLV_QR({
                    sellerName: store.company_name_en || 'STORE',
                    vatNumber: store.vat_number || '300000000000003',
                    timestamp: timestampIso,
                    totalWithVat: totalAmount,
                    vatTotal: vatAmount,
                    invoiceHashBuffer: hashRes.hashBuffer,
                    signatureDer: signRes.signatureDer,
                    publicKeyPem: store.zatca_public_key || store.zatca_private_key
                  });
                }
              }
            } catch (signErr) {
              console.log('[ZATCA] Phase 2 signing skipped (Private key not registered)');
            }
          }
        }
      }
    }
  } catch (zErr) {
    console.error('[ZATCA Builder Warning]', zErr.message);
  }

  // Phase 1 standard TLV QR code backup
  if (!zatcaQr) {
    try {
      function getTLV(tag, val) {
        const buf = Buffer.from(String(val || ''), 'utf8');
        return Buffer.concat([Buffer.from([tag, buf.length]), buf]);
      }
      const tlvTags = [
        getTLV(1, store.company_name_en || 'STORE'),
        getTLV(2, store.vat_number || '300000000000003'),
        getTLV(3, timestampIso),
        getTLV(4, parseFloat(totalAmount).toFixed(2)),
        getTLV(5, parseFloat(vatAmount).toFixed(2))
      ];
      zatcaQr = Buffer.concat(tlvTags).toString('base64');
    } catch (qErr) {
      zatcaQr = 'https://zatca.gov.sa';
    }
  }

  const payMethod = p.payment_method || 'CASH';
  const paidCash = parseFloat(p.paid_cash) || 0;
  const paidBank = parseFloat(p.paid_bank) || 0;
  const paidCredit = parseFloat(p.paid_credit) || (payMethod === 'CREDIT' ? Math.max(0, totalAmount - (paidCash + paidBank)) : 0);
  const changeAmt = parseFloat(p.change_amount) || 0;

  let prevBal = 0;
  let netBal = 0;

  if (p.party_id) {
    const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(p.party_id);
    if (party) {
      prevBal = party.current_balance;
      let curBal = prevBal;

      if (!isReturn) {
        curBal += totalAmount;
        db.prepare('UPDATE parties SET current_balance = ? WHERE id = ?').run(curBal, party.id);
        db.prepare(`
          INSERT INTO ledger (party_id, entry_date, entry_type, reference_no, description, debit, credit, balance_after)
          VALUES (?, ?, 'INVOICE', ?, 'Credit Sale Invoice', ?, 0, ?)
        `).run(party.id, dateStr, invoiceNo, totalAmount, curBal);

        const counterPaid = (paidCash + paidBank);
        if (counterPaid > 0) {
          curBal -= counterPaid;
          db.prepare('UPDATE parties SET current_balance = ? WHERE id = ?').run(curBal, party.id);
          db.prepare(`
            INSERT INTO ledger (party_id, entry_date, entry_type, reference_no, description, debit, credit, balance_after, payment_mode)
            VALUES (?, ?, 'PAYMENT', ?, 'Counter Receipt at Billing', 0, ?, ?, ?)
          `).run(party.id, dateStr, 'RCT-' + invoiceNo, counterPaid, curBal, payMethod);
        }
      } else {
        curBal -= totalAmount;
        db.prepare('UPDATE parties SET current_balance = ? WHERE id = ?').run(curBal, party.id);
        db.prepare(`
          INSERT INTO ledger (party_id, entry_date, entry_type, reference_no, description, debit, credit, balance_after)
          VALUES (?, ?, 'RETURN', ?, 'Sale Return (Credit Note)', 0, ?, ?)
        `).run(party.id, dateStr, invoiceNo, totalAmount, curBal);
      }
      netBal = curBal;
    }
  }

  // 3. Insert complete invoice record including terminal_id
  const invStmt = db.prepare(`
    INSERT INTO invoices (
      invoice_no, invoice_uuid, invoice_type, invoice_subtype, is_return, return_ref_no, party_id,
      customer_name, customer_phone, customer_vat, customer_cr, customer_address,
      invoice_date, invoice_time, subtotal, vat_amount, total_amount,
      payment_method, paid_cash, paid_bank, paid_credit, change_amount,
      prev_balance, net_balance, zatca_qr, notes,
      icv, pih, zatca_hash, zatca_signature, zatca_xml, zatca_status, terminal_id
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, 'PENDING', ?
    )
  `);

  const invInfo = invStmt.run(
    invoiceNo, invoiceUuid, isB2B ? 'standard' : 'simplified', invoiceSubtype, isReturn, p.return_ref_no || null,
    p.party_id || null, (p.customer_name || 'WALK-IN CUSTOMER').toUpperCase(),
    p.customer_phone || null, p.customer_vat || null, p.customer_cr || null,
    p.customer_address || null, dateStr, timeStr, subtotal, vatAmount, totalAmount,
    payMethod, paidCash, paidBank, paidCredit, changeAmt,
    prevBal, netBal, zatcaQr, p.notes || '',
    currentIcv, previousInvoiceHash, hashBase64, signatureBase64, xmlPayload,
    p.terminal_id ? String(p.terminal_id) : '1'
  );

  const invoiceId = invInfo.lastInsertRowid;

  const itemStmt = db.prepare(`
    INSERT INTO invoice_items (
      invoice_id, product_id, item_code, barcode, name_en, name_ar,
      unit, cost_price, selling_price, quantity, discount_amount, vat_rate, vat_amount, line_total,
      batch_no, expiry_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 15.00, ?, ?, ?, ?)
  `);

  const stockDeduct = db.prepare('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?');
  const stockRestore = db.prepare('UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?');

  p.items.forEach(it => {
    const lineTot = parseFloat(it.line_total) || (parseFloat(it.selling_price) * (parseFloat(it.quantity) || 1));
    const itVat = lineTot - (lineTot / 1.15);

    itemStmt.run(
      invoiceId, it.product_id || null, it.item_code || null, it.barcode || null,
      (it.name_en || 'ITEM').toUpperCase(), it.name_ar || '', it.unit || 'PCS',
      parseFloat(it.cost_price) || 0, parseFloat(it.selling_price) || 0,
      parseFloat(it.quantity) || 1, parseFloat(it.discount_amount) || 0, itVat, lineTot,
      it.batch_no || null, it.expiry_date || null
    );

    if (it.product_id) {
      if (isReturn) {
        stockRestore.run(parseFloat(it.quantity) || 1, it.product_id);
      } else {
        stockDeduct.run(parseFloat(it.quantity) || 1, it.product_id);
      }
    }
  });

  setTimeout(() => {
    syncInvoiceToSupabase({
      invoice_no: invoiceNo,
      invoice_date: dateStr,
      invoice_time: timeStr,
      customer_name: (p.customer_name || 'WALK-IN CUSTOMER').toUpperCase(),
      total_amount: totalAmount,
      vat_amount: vatAmount,
      payment_method: payMethod,
      is_return: isReturn
    });
  }, 100);

  return { invoiceId, invoiceNo, totalAmount, zatcaQr, icv: currentIcv, hash: hashBase64 };
}

router.post('/', (req, res) => {
  const p = req.body;
  if (!p.items || p.items.length === 0) {
    return res.status(400).json({ success: false, error: 'Cart is empty' });
  }

  try {
    const tx = db.transaction(() => processInvoice(p));
    const result = tx();
    res.json({ success: true, message: 'Invoice processed successfully', data: result });
  } catch (err) {
    console.error('Save Invoice Failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/sync-bulk', (req, res) => {
  const { invoices } = req.body;
  if (!Array.isArray(invoices) || invoices.length === 0) {
    return res.json({ success: true, synced: 0 });
  }

  try {
    const syncTx = db.transaction(() => {
      let count = 0;
      for (const inv of invoices) {
        processInvoice(inv);
        count++;
      }
      return count;
    });

    const count = syncTx();
    res.json({ success: true, message: `Successfully synced ${count} offline bills`, synced: count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/price-history/:partyId/:productId', (req, res) => {
  try {
    const { partyId, productId } = req.params;
    const history = db.prepare(`
      SELECT inv.invoice_no, inv.invoice_date, it.quantity, it.selling_price, it.unit
      FROM invoice_items it
      JOIN invoices inv ON it.invoice_id = inv.id
      WHERE inv.party_id = ? AND it.product_id = ? AND COALESCE(inv.is_return, 0) = 0
      ORDER BY inv.id DESC
      LIMIT 10
    `).all(partyId, productId);

    res.json({ success: true, data: history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/search/:query', (req, res) => {
  try {
    const q = req.params.query.trim();
    const inv = db.prepare(`
      SELECT * FROM invoices 
      WHERE invoice_no = ? OR customer_phone = ? 
      ORDER BY id DESC LIMIT 1
    `).get(q, q);

    if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found' });
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(inv.id);
    inv.items = items;
    res.json({ success: true, data: inv });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/recent', (req, res) => {
  try {
    const list = db.prepare(`
      SELECT id, invoice_no, invoice_uuid, invoice_type, invoice_date, invoice_time, customer_name,
             total_amount, payment_method, is_return, return_ref_no,
             COALESCE(zatca_status, 'PENDING') as zatca_status, icv, zatca_hash
      FROM invoices
      ORDER BY id DESC LIMIT 50
    `).all();
    res.json({ success: true, data: list });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/closing-report', (req, res) => {
  try {
    const reportType = req.query.type || 'x';
    const bDate = req.query.date || getBusinessDate();

    const bills = db.prepare(`
      SELECT * FROM invoices WHERE invoice_date = ?
    `).all(bDate);

    let totalSales = 0;
    let totalReturns = 0;
    let cashSales = 0;
    let bankSales = 0;
    let creditSales = 0;
    let vatTotal = 0;
    let pendingZatcaCount = 0;

    bills.forEach(b => {
      const amt = parseFloat(b.total_amount) || 0;
      const vAmt = parseFloat(b.vat_amount) || 0;
      if (b.is_return) {
        totalReturns += amt;
      } else {
        totalSales += amt;
        vatTotal += vAmt;
        if (b.payment_method === 'CASH') cashSales += amt;
        else if (b.payment_method === 'BANK') bankSales += amt;
        else if (b.payment_method === 'CREDIT') creditSales += amt;
        else if (b.payment_method === 'SPLIT') {
          cashSales += (parseFloat(b.paid_cash) || 0);
          bankSales += (parseFloat(b.paid_bank) || 0);
        }
      }
      if (b.zatca_status !== 'REPORTED' && b.zatca_status !== 'CLEARED') {
        pendingZatcaCount++;
      }
    });

    const netSales = totalSales - totalReturns;
    let reportedNowCount = 0;
    if (reportType === 'z' && pendingZatcaCount > 0) {
      db.prepare(`
        UPDATE invoices 
        SET zatca_status = 'REPORTED' 
        WHERE invoice_date = ? AND (zatca_status IS NULL OR zatca_status = 'PENDING')
      `).run(bDate);
      reportedNowCount = pendingZatcaCount;
      pendingZatcaCount = 0;
    }

    let store = {};
    try { store = db.prepare('SELECT * FROM settings LIMIT 1').get() || {}; } catch(e) {}

    res.json({
      success: true,
      data: {
        reportType: reportType.toUpperCase(),
        businessDate: bDate,
        closingTime: new Date().toLocaleTimeString('en-US', { hour12: true }),
        storeName: store.company_name_en || 'RETAIL STORE',
        storeVat: store.vat_number || '300000000000003',
        totalBills: bills.length,
        totalSales,
        totalReturns,
        netSales,
        vatTotal,
        cashSales,
        bankSales,
        creditSales,
        reportedNowCount,
        pendingZatcaCount
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!inv) return res.status(404).json({ success: false, error: 'Invoice not found' });
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(inv.id);
    inv.items = items;

    let store = {};
    try { store = db.prepare('SELECT * FROM settings LIMIT 1').get() || {}; } catch(e) {}
    
    let party = null;
    if (inv.party_id) {
      party = db.prepare('SELECT * FROM parties WHERE id = ?').get(inv.party_id);
    }

    res.json({ success: true, data: inv, store, party });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/:id/whatsapp-text', (req, res) => {
  try {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!inv) return res.status(404).json({ success: false, error: 'Invoice not found' });
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(inv.id);
    
    let store = {};
    try { store = db.prepare('SELECT * FROM settings LIMIT 1').get() || {}; } catch(e) {}
    let party = inv.party_id ? db.prepare('SELECT * FROM parties WHERE id = ?').get(inv.party_id) : null;

    const templatePath = path.join(__dirname, '../templates/whatsapp_template.txt');
    let template = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : '';

    let itemsSummary = items.map(it => `• ${it.name_en} x${it.quantity} = ${it.line_total.toFixed(2)} SAR`).join('\n');
    const counterPaid = (inv.paid_cash + inv.paid_bank).toFixed(2);
    const netBal = (inv.net_balance !== undefined && inv.net_balance !== null) ? inv.net_balance.toFixed(2) : (party ? party.current_balance.toFixed(2) : '0.00');

    let text = template
      .replace(/{{STORE_NAME}}/g, store.company_name_en || 'RETAIL STORE')
      .replace(/{{STORE_VAT}}/g, store.vat_number || 'N/A')
      .replace(/{{INVOICE_NO}}/g, inv.invoice_no)
      .replace(/{{DATE}}/g, inv.invoice_date)
      .replace(/{{CUSTOMER_NAME}}/g, inv.customer_name)
      .replace(/{{ITEMS_SUMMARY}}/g, itemsSummary)
      .replace(/{{SUBTOTAL}}/g, inv.subtotal.toFixed(2))
      .replace(/{{VAT_AMOUNT}}/g, inv.vat_amount.toFixed(2))
      .replace(/{{TOTAL_AMOUNT}}/g, inv.total_amount.toFixed(2))
      .replace(/{{PAID_COUNTER}}/g, counterPaid)
      .replace(/{{BALANCE_CHARGED}}/g, inv.paid_credit.toFixed(2))
      .replace(/{{CURRENT_BALANCE}}/g, netBal);

    res.json({ success: true, text, phone: inv.customer_phone || (party ? party.phone : '') });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;