const express = require('express');
const router = express.Router();
const db = require('../db');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

try {
  const tableCols = db.prepare("PRAGMA table_info(settings)").all();
  const colNames = tableCols.map(c => c.name);

  if (!colNames.includes('admin_password')) {
    db.prepare("ALTER TABLE settings ADD COLUMN admin_password TEXT DEFAULT 'admin123'").run();
  }
  if (!colNames.includes('bank_name')) {
    db.prepare("ALTER TABLE settings ADD COLUMN bank_name TEXT DEFAULT ''").run();
  }
  if (!colNames.includes('account_number')) {
    db.prepare("ALTER TABLE settings ADD COLUMN account_number TEXT DEFAULT ''").run();
  }
  if (!colNames.includes('iban')) {
    db.prepare("ALTER TABLE settings ADD COLUMN iban TEXT DEFAULT ''").run();
  }
  if (!colNames.includes('server_port')) {
    db.prepare("ALTER TABLE settings ADD COLUMN server_port INTEGER DEFAULT 5050").run();
  }
  if (!colNames.includes('printer_barcode_name')) {
    db.prepare("ALTER TABLE settings ADD COLUMN printer_barcode_name TEXT DEFAULT ''").run();
  }
  if (!colNames.includes('supabase_url')) {
    db.prepare("ALTER TABLE settings ADD COLUMN supabase_url TEXT DEFAULT ''").run();
  }
  if (!colNames.includes('supabase_key')) {
    db.prepare("ALTER TABLE settings ADD COLUMN supabase_key TEXT DEFAULT ''").run();
  }
} catch (e) {
  console.error("Settings Migration error:", e.message);
}

// സ്ഥിരമായി ടെംപ്ലേറ്റ് ഫോൾഡർ കണ്ടുപിടിക്കാനുള്ള സമഗ്രമായ പാത്ത് ഫംഗ്ഷൻ
function getTemplatesDir() {
  const possiblePaths = [
    // 1. Electron Production Resources Path (C:\Program Files\...\resources\templates)
    process.resourcesPath ? path.join(process.resourcesPath, 'templates') : null,
    // 2. Executable parent resources path
    process.execPath ? path.join(path.dirname(process.execPath), 'resources', 'templates') : null,
    // 3. Local Development direct folder
    path.join(__dirname, '../templates'),
    path.join(__dirname, 'templates'),
    // 4. Current Working Directory fallback
    path.join(process.cwd(), 'templates'),
    path.join(process.cwd(), 'resources', 'templates')
  ];

  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }

  // ഇല്ലെങ്കിൽ പുതിയത് ഉണ്ടാക്കാൻ റൂട്ട് പാത്ത് നൽകുന്നു
  const defaultPath = path.join(process.cwd(), 'templates');
  if (!fs.existsSync(defaultPath)) {
    try { fs.mkdirSync(defaultPath, { recursive: true }); } catch (e) {}
  }
  return defaultPath;
}

function getDatabaseFilePath() {
  try {
    const electron = require('electron');
    const app = electron.app || (electron.remote && electron.remote.app);
    if (app) return path.join(app.getPath('userData'), 'data', 'pos.db');
  } catch (e) {}
  return path.join(__dirname, '../data/pos.db');
}

router.get('/', (req, res) => {
  try {
    const data = db.prepare('SELECT * FROM settings WHERE id = 1').get();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const s = req.body;
    const stmt = db.prepare(`
      UPDATE settings SET
        company_name_en = COALESCE(?, company_name_en),
        company_name_ar = COALESCE(?, company_name_ar),
        vat_number = COALESCE(?, vat_number),
        cr_number = COALESCE(?, cr_number),
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        currency = COALESCE(?, currency),
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
        bank_name = COALESCE(?, bank_name),
        account_number = COALESCE(?, account_number),
        iban = COALESCE(?, iban),
        server_port = COALESCE(?, server_port),
        cost_cipher_key = COALESCE(?, cost_cipher_key),
        store_seal_img = COALESCE(?, store_seal_img),
        printer_pos_name = COALESCE(?, printer_pos_name),
        printer_barcode_name = COALESCE(?, printer_barcode_name),
        printer_a4_name = COALESCE(?, printer_a4_name),
        template_config = COALESCE(?, template_config),
        supabase_url = COALESCE(?, supabase_url),
        supabase_key = COALESCE(?, supabase_key)
      WHERE id = 1
    `);

    stmt.run(
      s.company_name_en, s.company_name_ar, s.vat_number, s.cr_number,
      s.phone, s.email, s.currency,
      s.short_address, s.building_no, s.street_en, s.street_ar,
      s.district_en, s.district_ar, s.city_en, s.city_ar,
      s.postal_code, s.additional_no,
      s.bank_name, s.account_number, s.iban,
      s.server_port || 5050,
      s.cost_cipher_key, s.store_seal_img,
      s.printer_pos_name, s.printer_barcode_name, s.printer_a4_name,
      s.template_config ? (typeof s.template_config === 'string' ? s.template_config : JSON.stringify(s.template_config)) : null,
      s.supabase_url, s.supabase_key
    );

    if (s.server_port) {
      try {
        const electron = require('electron');
        const app = electron.app || (electron.remote && electron.remote.app);
        if (app) {
          const cfgPath = path.join(app.getPath('userData'), 'config.json');
          let cfg = {};
          if (fs.existsSync(cfgPath)) {
            try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch(e) {}
          }
          cfg.port = parseInt(s.server_port, 10);
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
        }
      } catch (e) {}
    }

    try {
      const syncWorker = require('../syncWorker');
      if (syncWorker && syncWorker.runSyncCycle) {
        setTimeout(() => syncWorker.runSyncCycle(), 1000);
      }
    } catch (e) {}

    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/system-printers', (req, res) => {
  exec('powershell "Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name"', (err, stdout) => {
    if (err) return res.json({ success: false, printers: [] });
    const list = stdout.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
    res.json({ success: true, printers: list });
  });
});

router.post('/verify-password', (req, res) => {
  try {
    const { password } = req.body;
    const row = db.prepare('SELECT admin_password FROM settings WHERE id = 1').get();
    const currentPass = (row && row.admin_password) ? row.admin_password : 'admin123';
    if (password === currentPass) {
      res.json({ success: true });
    } else {
      res.status(401).json({ success: false, error: 'Incorrect Master Password' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/change-password', (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const row = db.prepare('SELECT admin_password FROM settings WHERE id = 1').get();
    const currentPass = (row && row.admin_password) ? row.admin_password : 'admin123';

    if (oldPassword !== currentPass) {
      return res.status(400).json({ success: false, error: 'Current password is incorrect' });
    }
    if (!newPassword || newPassword.trim().length < 4) {
      return res.status(400).json({ success: false, error: 'New password must be at least 4 characters' });
    }

    db.prepare('UPDATE settings SET admin_password = ? WHERE id = 1').run(newPassword.trim());
    res.json({ success: true, message: 'Admin Master Password updated successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post(['/factory-reset', '/reset-database'], (req, res) => {
  try {
    const { password, resetType } = req.body;
    const row = db.prepare('SELECT admin_password FROM settings WHERE id = 1').get();
    const currentPass = (row && row.admin_password) ? row.admin_password : 'admin123';

    if (password !== currentPass) {
      return res.status(401).json({ success: false, error: 'Incorrect Master Password' });
    }

    db.pragma('foreign_keys = OFF');

    const resetTx = db.transaction(() => {
      db.prepare('DELETE FROM invoice_items').run();
      db.prepare('DELETE FROM invoices').run();
      db.prepare('DELETE FROM sale_items').run();
      db.prepare('DELETE FROM sales').run();
      db.prepare('DELETE FROM purchase_items').run();
      db.prepare('DELETE FROM purchases').run();
      db.prepare('DELETE FROM ledger').run();
      db.prepare('DELETE FROM party_ledger').run();
      db.prepare('DELETE FROM account_transactions').run();
      db.prepare('DELETE FROM expenses').run();
      db.prepare('DELETE FROM petty_expenses').run();
      db.prepare('DELETE FROM utility_transactions').run();
      db.prepare('DELETE FROM employee_ledger').run();

      db.prepare('UPDATE parties SET current_balance = 0 WHERE party_type = ? OR type = ?').run('customer', 'customer');

      if (resetType === 'full' || resetType === 'all') {
        db.prepare('DELETE FROM products').run();
        db.prepare('DELETE FROM parties WHERE id != 147').run();
        db.prepare('DELETE FROM employees').run();
        db.prepare('DELETE FROM utilities').run();
        db.prepare('DELETE FROM petty_categories').run();

        try {
          db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('products', 'parties', 'invoices', 'purchases', 'sales', 'employees', 'utilities', 'expenses')").run();
        } catch (e) {}
      } else {
        try {
          db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('invoices', 'purchases', 'sales', 'ledger', 'expenses')").run();
        } catch (e) {}
      }
    });

    resetTx();
    db.pragma('foreign_keys = ON');

    res.json({ success: true, message: 'Database reset successfully completed!' });
  } catch (err) {
    db.pragma('foreign_keys = ON');
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/backup', (req, res) => {
  try {
    const dbPath = getDatabaseFilePath();
    if (fs.existsSync(dbPath)) {
      res.download(dbPath, `pos_backup_${new Date().toISOString().slice(0, 10)}.db`);
    } else {
      res.status(404).send('Database file not found');
    }
  } catch (e) {
    res.status(500).send(e.message);
  }
});

router.post('/restore-database', (req, res) => {
  try {
    const { dbBase64, password } = req.body;
    const row = db.prepare('SELECT admin_password FROM settings WHERE id = 1').get();
    const currentPass = (row && row.admin_password) ? row.admin_password : 'admin123';

    if (password !== currentPass) {
      return res.status(401).json({ success: false, error: 'Incorrect Master Password' });
    }

    if (!dbBase64) {
      return res.status(400).json({ success: false, error: 'No database file provided' });
    }

    const base64Clean = dbBase64.replace(/^data:.*?;base64,/, '');
    const buffer = Buffer.from(base64Clean, 'base64');
    const targetPath = getDatabaseFilePath();

    fs.writeFileSync(targetPath, buffer);
    res.json({ success: true, message: 'Database restored successfully! Please restart the application.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// TEMPLATES API (അഡ്മിൻ ടൂൾസിലെ ലിസ്റ്റിംഗും എഡിറ്റിംഗും ഉറപ്പാക്കുന്നു)
router.get('/templates-list', (req, res) => {
  try {
    const tplDir = getTemplatesDir();
    if (!fs.existsSync(tplDir)) {
      return res.json({ success: true, files: [] });
    }
    const files = fs.readdirSync(tplDir).filter(f => !fs.statSync(path.join(tplDir, f)).isDirectory());
    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/template-content/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(getTemplatesDir(), filename);
    if (fs.existsSync(filePath)) {
      res.json({ success: true, content: fs.readFileSync(filePath, 'utf8') });
    } else {
      res.status(404).json({ success: false, error: 'Template file not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/template-content/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const { content } = req.body;
    const filePath = path.join(getTemplatesDir(), filename);
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ success: true, message: `${filename} updated successfully!` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/upload-seal', (req, res) => {
  try {
    const { sealImage } = req.body;
    db.prepare('UPDATE settings SET store_seal_img = ? WHERE id = 1').run(sealImage);
    res.json({ success: true, message: 'Seal uploaded successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;