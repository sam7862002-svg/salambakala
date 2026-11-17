const express = require('express');
const router = express.Router();
const db = require('../db');

function generateInvoiceNumber() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM sales WHERE invoice_number LIKE ?").get(`INV-${dateStr}-%`);
  const seq = String(countRow.count + 1).padStart(4, '0');
  return `INV-${dateStr}-${seq}`;
}

router.post('/', (req, res) => {
  const { customer_id, payment_type, items, discount_total, paid_amount } = req.body;
  if (!payment_type || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Missing sale items or payment method' });
  }

  const executeSale = db.transaction(() => {
    let subtotal = 0, vat_total = 0;
    const discount = discount_total || 0;

    const prep = items.map(it => {
      const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
      if (!prod) throw new Error(`Product ${it.product_id} not found`);
      const price = it.unit_price !== undefined ? it.unit_price : prod.selling_price;
      const lineSub = it.quantity * price;
      const lineVat = lineSub * (prod.vat_rate / 100);
      subtotal += lineSub;
      vat_total += lineVat;
      return { ...prod, quantity: it.quantity, unit_price: price, lineVat, total_line_amount: lineSub + lineVat };
    });

    const grand_total = (subtotal - discount) + vat_total;
    const invNo = generateInvoiceNumber();
    const actualPaid = paid_amount !== undefined ? paid_amount : (payment_type === 'credit' ? 0 : grand_total);
    const changeDue = actualPaid > grand_total ? actualPaid - grand_total : 0;

    const sResult = db.prepare('INSERT INTO sales (invoice_number, customer_id, payment_type, subtotal, vat_total, discount_total, grand_total, paid_amount, change_due) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(invNo, customer_id || null, payment_type, subtotal, vat_total, discount, grand_total, actualPaid, changeDue);
    const saleId = sResult.lastInsertRowid;

    for (const it of prep) {
      db.prepare('INSERT INTO sale_items (sale_id, product_id, product_name_en, product_name_ar, quantity, cost_price, unit_price, vat_rate, vat_amount, total_line_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(saleId, it.id, it.name_en, it.name_ar, it.quantity, it.cost_price, it.unit_price, it.vat_rate, it.lineVat, it.total_line_amount);
      db.prepare('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?').run(it.quantity, it.id);
    }

    const unpaid = grand_total - actualPaid;
    if (payment_type === 'credit' && customer_id && unpaid > 0) {
      const cust = db.prepare('SELECT current_balance FROM parties WHERE id = ?').get(customer_id);
      const newBal = (cust ? cust.current_balance : 0) + unpaid;
      db.prepare('UPDATE parties SET current_balance = ? WHERE id = ?').run(newBal, customer_id);
      db.prepare('INSERT INTO party_ledger (party_id, transaction_type, reference_id, reference_no, debit, running_balance, notes) VALUES (?, "sale_credit", ?, ?, ?, ?, "Customer credit purchase")')
        .run(customer_id, saleId, invNo, unpaid, newBal);
    }
    return { saleId, invoiceNumber: invNo, grand_total, paid_amount: actualPaid, changeDue };
  });

  try {
    const data = executeSale();
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const company = db.prepare('SELECT * FROM settings WHERE id = 1').get();
    const sale = db.prepare('SELECT s.*, p.name_en AS customer_name_en, p.name_ar AS customer_name_ar, p.phone AS customer_phone FROM sales s LEFT JOIN parties p ON s.customer_id = p.id WHERE s.id = ?').get(req.params.id);
    if (!sale) return res.status(404).json({ success: false, message: 'Invoice not found' });
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(req.params.id);
    res.json({ success: true, company, sale, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
