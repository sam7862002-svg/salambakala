const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../db');

function getPartyCols() {
  try {
    return db.prepare("PRAGMA table_info(parties)").all().map(c => c.name);
  } catch(e) { return []; }
}

// Serve Templates statically
router.get('/templates/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '../templates', req.params.file));
});

// --- AGENTS APIS ---
router.get('/agents', (req, res) => {
  try {
    const list = db.prepare('SELECT * FROM agents ORDER BY id DESC').all();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/agents', (req, res) => {
  try {
    const { name_en, name_ar, phone } = req.body;
    if (!name_en || !phone) {
      return res.status(400).json({ success: false, error: 'Name and Phone are required' });
    }
    const stmt = db.prepare(`INSERT INTO agents (name_en, name_ar, phone) VALUES (?, ?, ?)`);
    const info = stmt.run(name_en.toUpperCase().trim(), name_ar ? name_ar.trim() : '', phone.trim());
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/agents/:id', (req, res) => {
  try {
    db.prepare('UPDATE parties SET agent_id = NULL WHERE agent_id = ?').run(req.params.id);
    db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Agent deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- PARTIES (CUSTOMERS / VENDORS) APIS ---
router.get('/', (req, res) => {
  try {
    const filterType = (req.query.type || req.query.party_type || '').toLowerCase();
    const agent_id = req.query.agent_id;
    const cols = getPartyCols();
    const typeCol = cols.includes('party_type') ? 'party_type' : (cols.includes('type') ? 'type' : null);

    let sql = `
      SELECT p.*, a.name_en as agent_name 
      FROM parties p 
      LEFT JOIN agents a ON p.agent_id = a.id
    `;
    const params = [];
    const conditions = [];

    if (filterType && typeCol) {
      // Allow flexible matching (e.g. 'customer' matches 'customer', 'CREDIT', etc. if needed, or exact lowercase)
      conditions.push(`LOWER(p.${typeCol}) = ?`);
      params.push(filterType);
    }
    if (agent_id) {
      conditions.push('p.agent_id = ?');
      params.push(agent_id);
    }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY p.id DESC';

    const data = db.prepare(sql).all(...params);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/', (req, res) => {
  const p = req.body;
  try {
    const insertTransaction = db.transaction(() => {
      const pType = (p.party_type || p.type || 'customer').toLowerCase();
      const openBal = parseFloat(p.opening_balance) || 0;
      const cols = getPartyCols();

      const partyData = {
        sub_type: p.sub_type || 'credit',
        name_en: (p.name_en || '').toUpperCase().trim(),
        name_ar: p.name_ar || '',
        phone: p.phone || null,
        vat_number: p.vat_number || '',
        cr_number: p.cr_number || '',
        short_address: p.short_address || '',
        building_no: p.building_no || '',
        street_en: p.street_en || '',
        street_ar: p.street_ar || '',
        district_en: p.district_en || '',
        district_ar: p.district_ar || '',
        city_en: p.city_en || 'Jeddah',
        city_ar: p.city_ar || 'جدة',
        postal_code: p.postal_code || '',
        additional_no: p.additional_no || '',
        credit_limit: parseFloat(p.credit_limit) || 0,
        opening_balance: openBal,
        current_balance: openBal,
        agent_id: p.agent_id ? parseInt(p.agent_id) : null,
        bank_name: p.bank_name || '',
        account_number: p.account_number || '',
        iban: p.iban || ''
      };

      if (cols.includes('party_type')) partyData.party_type = pType;
      if (cols.includes('type')) partyData.type = pType;

      const validCols = Object.keys(partyData).filter(c => cols.includes(c));
      const placeholders = validCols.map(() => '?').join(', ');
      const values = validCols.map(c => partyData[c]);

      const sql = `INSERT INTO parties (${validCols.join(', ')}) VALUES (${placeholders})`;
      const info = db.prepare(sql).run(...values);
      const partyId = info.lastInsertRowid;

      if (openBal !== 0) {
        db.prepare(`
          INSERT INTO ledger (party_id, entry_date, entry_type, reference_no, description, debit, credit, balance_after)
          VALUES (?, date('now'), 'OPENING_BAL', 'INIT', 'Opening Balance / الرصيد الافتتاحي', ?, ?, ?)
        `).run(
          partyId,
          pType === 'customer' ? openBal : 0,
          pType === 'vendor' ? openBal : 0,
          openBal
        );
      }
      return partyId;
    });

    const partyId = insertTransaction();
    res.json({ success: true, id: partyId, message: 'Party registered successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const p = req.body;
  try {
    const updateTransaction = db.transaction(() => {
      const oldParty = db.prepare('SELECT * FROM parties WHERE id = ?').get(req.params.id);
      if (!oldParty) throw new Error('Party not found');

      let currentBal = parseFloat(oldParty.current_balance) || 0;
      let newOpening = parseFloat(oldParty.opening_balance) || 0;

      if (p.opening_balance !== undefined && p.opening_balance !== null && p.opening_balance !== '') {
        const parsedOpening = parseFloat(p.opening_balance);
        if (!isNaN(parsedOpening) && parsedOpening !== newOpening) {
          const diff = parsedOpening - newOpening;
          newOpening = parsedOpening;
          currentBal += diff;

          const existingOpen = db.prepare("SELECT * FROM ledger WHERE party_id = ? AND entry_type = 'OPENING_BAL'").get(req.params.id);
          const pType = (oldParty.party_type || oldParty.type || 'customer').toLowerCase();
          if (existingOpen) {
            db.prepare(`
              UPDATE ledger SET debit = ?, credit = ?, balance_after = ? WHERE id = ?
            `).run(pType === 'customer' ? newOpening : 0, pType === 'vendor' ? newOpening : 0, newOpening, existingOpen.id);
          } else if (newOpening !== 0) {
            db.prepare(`
              INSERT INTO ledger (party_id, entry_type, reference_no, description, debit, credit, balance_after)
              VALUES (?, date('now'), 'OPENING_BAL', 'INIT', 'Opening Balance / الرصيد الافتتاحي', ?, ?, ?)
            `).run(req.params.id, pType === 'customer' ? newOpening : 0, pType === 'vendor' ? newOpening : 0, newOpening);
          }
        }
      }

      db.prepare(`
        UPDATE parties SET
          sub_type = COALESCE(?, sub_type),
          name_en = COALESCE(?, name_en),
          name_ar = COALESCE(?, name_ar),
          phone = COALESCE(?, phone),
          vat_number = COALESCE(?, vat_number),
          cr_number = COALESCE(?, cr_number),
          short_address = COALESCE(?, short_address),
          building_no = COALESCE(?, building_no),
          street_en = COALESCE(?, street_en),
          street_ar = COALESCE(?, street_ar),
          district_en = COALESCE(?, district_en),
          district_ar = COALESCE(?, district_ar),
          city_en = COALESCE(?, city_en),
          city_ar = COALESCE(?, city_ar),
          postal_code = COALESCE(?, postal_code),
          additional_no = COALESCE(?, additional_no),
          credit_limit = COALESCE(?, credit_limit),
          agent_id = ?,
          bank_name = COALESCE(?, bank_name),
          account_number = COALESCE(?, account_number),
          iban = COALESCE(?, iban),
          opening_balance = ?,
          current_balance = ?
        WHERE id = ?
      `).run(
        p.sub_type, p.name_en ? p.name_en.toUpperCase() : null, p.name_ar, p.phone,
        p.vat_number, p.cr_number, p.short_address, p.building_no, p.street_en, p.street_ar,
        p.district_en, p.district_ar, p.city_en, p.city_ar, p.postal_code, p.additional_no,
        p.credit_limit, p.agent_id ? parseInt(p.agent_id) : null,
        p.bank_name, p.account_number, p.iban,
        newOpening, currentBal,
        req.params.id
      );
    });

    updateTransaction();
    res.json({ success: true, message: 'Party updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SAFE DELETE CHECK
router.delete('/:id', (req, res) => {
  const id = req.params.id;
  try {
    let invCount = 0;
    try { invCount = db.prepare('SELECT COUNT(*) as cnt FROM invoices WHERE party_id = ?').get(id).cnt; } catch(e) {}

    let purCount = 0;
    try { purCount = db.prepare('SELECT COUNT(*) as cnt FROM purchases WHERE party_id = ? OR vendor_id = ?').get(id, id).cnt; } catch(e) {}

    if (invCount > 0 || purCount > 0) {
      const billMsg = invCount > 0 ? `${invCount} സെയിൽസ് ബില്ലുകൾ` : `${purCount} പർച്ചേസ് ബില്ലുകൾ`;
      return res.status(400).json({
        success: false,
        error: `ഈ പാർട്ടിക്ക് ${billMsg} ഉള്ളതിനാൽ ഡിലീറ്റ് ചെയ്യാൻ സാധിക്കില്ല.`
      });
    }

    db.transaction(() => {
      try { db.prepare('DELETE FROM ledger WHERE party_id = ?').run(id); } catch(e) {}
      db.prepare('DELETE FROM parties WHERE id = ?').run(id);
    })();

    res.json({ success: true, message: 'Party deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- LEDGER & PAYMENTS APIS ---
router.get('/:id/ledger', (req, res) => {
  try {
    const { from, to } = req.query;
    let sql = 'SELECT * FROM ledger WHERE party_id = ?';
    const params = [req.params.id];

    if (from) { sql += ' AND entry_date >= ?'; params.push(from); }
    if (to) { sql += ' AND entry_date <= ?'; params.push(to); }
    sql += ' ORDER BY id ASC';

    const entries = db.prepare(sql).all(...params);
    const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(req.params.id);
    res.json({ success: true, party, entries });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/payment', (req, res) => {
  const { amount, payment_mode, reference_no, description, entry_date } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });

  try {
    const payTransaction = db.transaction(() => {
      const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(req.params.id);
      if (!party) throw new Error('Party not found');

      let newBalance = party.current_balance;
      let debit = 0;
      let credit = 0;

      const pType = (party.party_type || party.type || '').toLowerCase();
      if (pType === 'customer') {
        credit = amt;
        newBalance -= amt;
      } else {
        debit = amt;
        newBalance -= amt;
      }

      db.prepare('UPDATE parties SET current_balance = ? WHERE id = ?').run(newBalance, party.id);

      const info = db.prepare(`
        INSERT INTO ledger (party_id, entry_date, entry_type, reference_no, description, debit, credit, balance_after, payment_mode)
        VALUES (?, ?, 'PAYMENT', ?, ?, ?, ?, ?, ?)
      `).run(
        party.id,
        entry_date || new Date().toISOString().slice(0, 10),
        reference_no || 'PAY-' + Date.now().toString().slice(-6),
        description || 'Payment Received / سداد',
        debit, credit, newBalance, payment_mode || 'CASH'
      );

      return { ledgerId: info.lastInsertRowid, newBalance, party };
    });

    const result = payTransaction();
    res.json({ success: true, message: 'Payment recorded', data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function getOrCreateAgent(agentName) {
  if (!agentName || !agentName.trim()) return null;
  const cleanName = agentName.trim().toUpperCase();
  const existing = db.prepare('SELECT id FROM agents WHERE name_en = ?').get(cleanName);
  if (existing) return existing.id;
  
  const dummyPhone = '0500' + Math.floor(100000 + Math.random() * 900000);
  const info = db.prepare('INSERT INTO agents (name_en, name_ar, phone) VALUES (?, ?, ?)').run(cleanName, cleanName, dummyPhone);
  return info.lastInsertRowid;
}

// --- UNIVERSAL MASTER BULK IMPORT API ---
router.post('/bulk-import', (req, res) => {
  const { parties } = req.body;
  if (!Array.isArray(parties) || parties.length === 0) {
    return res.status(400).json({ success: false, error: 'No parties provided' });
  }

  try {
    let imported = 0;
    const runBulk = db.transaction(() => {
      const cols = getPartyCols();

      for (const p of parties) {
        let pType = (p.PartyType || p.party_type || p.Type || p.type || 'customer').toLowerCase().trim();
        const subType = (p.AccountType || p.SubType || p.sub_type || 'credit').toLowerCase().trim();
        const nameEn = (p.NameEN || p.name_en || '').toUpperCase().trim();
        if (!nameEn) continue;

        if (pType === 'agent') {
          const ph = p.Phone || p.phone || ('0500' + Math.floor(100000 + Math.random() * 900000));
          const existAg = db.prepare('SELECT id FROM agents WHERE name_en = ?').get(nameEn);
          if (!existAg) {
            db.prepare('INSERT INTO agents (name_en, name_ar, phone) VALUES (?, ?, ?)').run(nameEn, p.NameAR || p.name_ar || '', ph);
            imported++;
          }
          continue;
        }

        const nameAr = p.NameAR || p.name_ar || '';
        const phone = p.Phone && p.Phone.trim() ? p.Phone.trim() : (p.phone && p.phone.trim() ? p.phone.trim() : null);
        const openBal = parseFloat(p.OpeningBalance || p.opening_balance) || 0;
        const creditLim = parseFloat(p.CreditLimit || p.credit_limit) || 0;
        const agentName = p.AgentName || p.agent_name || '';
        const agentId = agentName ? getOrCreateAgent(agentName) : (p.agent_id ? parseInt(p.agent_id) : null);

        const existing = db.prepare('SELECT id FROM parties WHERE name_en = ? AND (party_type = ? OR type = ?)').get(nameEn, pType, pType);
        let partyId;

        if (existing) {
          partyId = existing.id;
          db.prepare(`
            UPDATE parties SET
              sub_type = ?, opening_balance = ?, current_balance = ?, credit_limit = ?, agent_id = ?
            WHERE id = ?
          `).run(subType, openBal, openBal, creditLim, agentId, partyId);
        } else {
          const partyData = {
            sub_type: subType,
            name_en: nameEn,
            name_ar: nameAr,
            phone: phone,
            vat_number: p.VATNumber || p.vat_number || '',
            cr_number: p.CRNumber || p.cr_number || '',
            short_address: p.Address || p.ShortAddress || p.short_address || '',
            credit_limit: creditLim,
            opening_balance: openBal,
            current_balance: openBal,
            agent_id: agentId
          };

          if (cols.includes('party_type')) partyData.party_type = pType;
          if (cols.includes('type')) partyData.type = pType;

          const validCols = Object.keys(partyData).filter(c => cols.includes(c));
          const placeholders = validCols.map(() => '?').join(', ');
          const values = validCols.map(c => partyData[c]);

          const ins = db.prepare(`INSERT INTO parties (${validCols.join(', ')}) VALUES (${placeholders})`).run(...values);
          partyId = ins.lastInsertRowid;
        }

        imported++;

        if (openBal > 0) {
          db.prepare("DELETE FROM ledger WHERE party_id = ? AND entry_type = 'OPENING_BAL'").run(partyId);
          db.prepare(`
            INSERT INTO ledger (party_id, entry_date, entry_type, reference_no, description, debit, credit, balance_after)
            VALUES (?, date('now'), 'OPENING_BAL', 'INIT', 'Opening Balance / الرصيد الافتتاحي', ?, ?, ?)
          `).run(
            partyId,
            pType === 'customer' ? openBal : 0,
            pType === 'vendor' ? openBal : 0,
            openBal
          );
        }
      }
    });

    runBulk();
    res.json({ success: true, count: imported });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;