const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
  try {
    const products = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
    res.json({ success: true, data: products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    res.json({ success: true, data: product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/search/:query', (req, res) => {
  try {
    const q = req.params.query.trim().toUpperCase();
    const product = db.prepare(`
      SELECT * FROM products 
      WHERE (item_code = ? OR barcode1 = ? OR barcode2 = ? OR barcode3 = ? OR name_en = ?)
        AND is_active = 1
      LIMIT 1
    `).get(q, q, q, q, q);

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    res.json({ success: true, data: product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const {
      item_code, barcode1, barcode2, barcode3,
      name_en, name_ar, category, unit,
      cost_price, selling_price, vat_rate,
      stock_quantity, min_stock_alert
    } = req.body;

    if (!barcode1 || !name_en || selling_price === undefined) {
      return res.status(400).json({ success: false, message: 'Barcode 1, English Name, and Selling Price are required.' });
    }

    const stmt = db.prepare(`
      INSERT INTO products (
        item_code, barcode1, barcode2, barcode3,
        name_en, name_ar, category, unit,
        cost_price, selling_price, vat_rate,
        stock_quantity, min_stock_alert
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      item_code || null,
      barcode1.trim().toUpperCase(),
      barcode2 ? barcode2.trim().toUpperCase() : null,
      barcode3 ? barcode3.trim().toUpperCase() : null,
      name_en.trim().toUpperCase(),
      name_ar ? name_ar.trim() : '',
      category ? category.trim().toUpperCase() : 'GENERAL',
      unit || 'PCS',
      cost_price || 0,
      selling_price,
      vat_rate !== undefined ? vat_rate : 15.00,
      stock_quantity || 0,
      min_stock_alert || 5
    );

    res.status(201).json({ success: true, productId: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/bulk-import', (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'No items provided' });
    }

    const insertStmt = db.prepare(`
      INSERT INTO products (
        item_code, barcode1, barcode2, barcode3,
        name_en, name_ar, category, unit,
        cost_price, selling_price, vat_rate,
        stock_quantity, min_stock_alert
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(barcode1) DO UPDATE SET
        item_code = COALESCE(excluded.item_code, products.item_code),
        barcode2 = COALESCE(excluded.barcode2, products.barcode2),
        barcode3 = COALESCE(excluded.barcode3, products.barcode3),
        name_en = excluded.name_en,
        name_ar = COALESCE(excluded.name_ar, products.name_ar),
        cost_price = excluded.cost_price,
        selling_price = excluded.selling_price,
        stock_quantity = excluded.stock_quantity,
        is_active = 1
    `);

    const bulkTx = db.transaction((rows) => {
      let count = 0;
      for (const p of rows) {
        if (!p.name_en) continue;
        const b1 = (p.barcode1 || p.barcode || ('GEN' + Date.now() + '' + count)).trim().toUpperCase();
        insertStmt.run(
          p.item_code ? String(p.item_code).trim().toUpperCase() : null,
          b1,
          p.barcode2 ? String(p.barcode2).trim().toUpperCase() : null,
          p.barcode3 ? String(p.barcode3).trim().toUpperCase() : null,
          String(p.name_en).trim().toUpperCase(),
          p.name_ar ? String(p.name_ar).trim() : '',
          p.category ? String(p.category).trim().toUpperCase() : 'GENERAL',
          p.unit ? String(p.unit).trim().toUpperCase() : 'PCS',
          parseFloat(p.cost_price) || 0,
          parseFloat(p.selling_price) || 0,
          parseFloat(p.vat_rate) || 15.00,
          parseFloat(p.stock_quantity) || 0,
          parseFloat(p.min_stock_alert) || 5
        );
        count++;
      }
      return count;
    });

    const totalInserted = bulkTx(items);
    res.json({ success: true, count: totalInserted, message: `Successfully imported ${totalInserted} items!` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const {
      item_code, barcode1, barcode2, barcode3,
      name_en, name_ar, category, unit,
      cost_price, selling_price, vat_rate,
      stock_quantity, min_stock_alert, is_active
    } = req.body;

    const stmt = db.prepare(`
      UPDATE products SET
        item_code = ?,
        barcode1 = ?,
        barcode2 = ?,
        barcode3 = ?,
        name_en = ?,
        name_ar = ?,
        category = ?,
        unit = ?,
        cost_price = ?,
        selling_price = ?,
        vat_rate = ?,
        stock_quantity = ?,
        min_stock_alert = ?,
        is_active = COALESCE(?, is_active)
      WHERE id = ?
    `);

    stmt.run(
      item_code || null,
      barcode1.trim().toUpperCase(),
      barcode2 ? barcode2.trim().toUpperCase() : null,
      barcode3 ? barcode3.trim().toUpperCase() : null,
      name_en.trim().toUpperCase(),
      name_ar ? name_ar.trim() : '',
      category ? category.trim().toUpperCase() : 'GENERAL',
      unit || 'PCS',
      cost_price || 0,
      selling_price,
      vat_rate !== undefined ? vat_rate : 15.00,
      stock_quantity || 0,
      min_stock_alert || 5,
      is_active,
      req.params.id
    );

    res.json({ success: true, message: 'Product updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/:id/toggle', (req, res) => {
  try {
    db.prepare('UPDATE products SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Status toggled successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/reset', (req, res) => {
  try {
    db.prepare('DELETE FROM products').run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'products'").run();
    res.json({ success: true, message: 'All products cleared successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/stock', (req, res) => {
  try {
    const { new_stock } = req.body;
    const stockVal = parseFloat(new_stock);
    if (isNaN(stockVal) || stockVal < 0) {
      return res.status(400).json({ success: false, error: 'Valid stock count is required' });
    }
    db.prepare('UPDATE products SET stock_quantity = ? WHERE id = ?').run(stockVal, req.params.id);
    res.json({ success: true, message: 'Stock updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
