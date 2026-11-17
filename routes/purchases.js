const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../db');

const DEFAULT_VENDOR_ID = 147;

// Recent Purchases & Returns with instant search filter
router.get('/recent', (req, res) => {
  try {
    const q = req.query.search ? '%' + req.query.search.trim() + '%' : null;
    let list;
    if (q) {
      list = db.prepare(`
        SELECT id, purchase_no, bill_number, supplier_inv_no, purchase_date, purchase_time, vendor_name,
               total_amount, payment_mode, is_return, return_ref_no
        FROM purchases
        WHERE purchase_no LIKE ? OR supplier_inv_no LIKE ? OR vendor_name LIKE ?
        ORDER BY id DESC LIMIT 50
      `).all(q, q, q);
    } else {
      list = db.prepare(`
        SELECT id, purchase_no, bill_number, supplier_inv_no, purchase_date, purchase_time, vendor_name,
               total_amount, payment_mode, is_return, return_ref_no
        FROM purchases
        ORDER BY id DESC LIMIT 50
      `).all();
    }
    res.json({ success: true, data: list });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Single Purchase (Used for loading past bill into Return mode)
router.get('/:id', (req, res) => {
  try {
    const pur = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.id);
    if (!pur) return res.status(404).json({ success: false, error: 'Record not found' });
    const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?').all(pur.id);
    pur.items = items;

    let store = {};
    try { store = db.prepare('SELECT * FROM settings LIMIT 1').get() || {}; } catch(e) {}
    
    let party = null;
    const vendorId = pur.party_id || pur.vendor_id;
    if (vendorId) {
      party = db.prepare('SELECT * FROM parties WHERE id = ?').get(vendorId);
    }

    res.json({ success: true, data: pur, store, party });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Create Purchase OR Return
router.post('/', (req, res) => {
  const p = req.body;
  if (!p.items || p.items.length === 0) {
    return res.status(400).json({ success: false, error: 'Purchase cart is empty' });
  }

  // Mandatory Supplier Invoice Number
  if (!p.supplier_inv_no || !p.supplier_inv_no.trim()) {
    return res.status(400).json({ success: false, error: 'Supplier Invoice Number is mandatory!' });
  }

  try {
    const createTx = db.transaction(() => {
      const isReturn = p.is_return ? 1 : 0;
      const dateStr = p.purchase_date || new Date().toISOString().slice(0, 10);
      const timeStr = new Date().toTimeString().slice(0, 8);

      // Terminal ID അനുസരിച്ച് വെവ്വേറെ പ്രീഫിക്സ് സെറ്റ് ചെയ്യുന്നു (ഉദാ: PUR-T1- അല്ലെങ്കിൽ PUR-)
      let terminalPrefix = 'PUR-';
      if (p.terminal_id) {
        terminalPrefix = `PUR-T${p.terminal_id}-`;
      }
      if (isReturn) {
        terminalPrefix = p.terminal_id ? `PRET-T${p.terminal_id}-` : 'PRET-';
      }

      const prefix = terminalPrefix + dateStr.replace(/-/g, '') + '-';
      const last = db.prepare('SELECT purchase_no FROM purchases WHERE purchase_no LIKE ? ORDER BY id DESC LIMIT 1').get(prefix + '%');
      let seq = 1;
      if (last && last.purchase_no) {
        const parts = last.purchase_no.split('-');
        const n = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(n)) seq = n + 1;
      }
      const purchaseNo = prefix + String(seq).padStart(4, '0');

      // VAT EXCLUSIVE CALCULATION:
      let subtotal = 0;
      let vatAmount = 0;
      let totalAmount = 0;

      p.items.forEach(it => {
        const costP = parseFloat(it.cost_price) || 0;
        const qty = parseFloat(it.quantity) || 1;
        const lineBase = Math.round(costP * qty * 100) / 100;
        const lineVat = Math.round(lineBase * 0.15 * 100) / 100;
        const lineTot = lineBase + lineVat;

        subtotal += lineBase;
        vatAmount += lineVat;
        totalAmount += lineTot;
      });

      subtotal = Math.round(subtotal * 100) / 100;
      vatAmount = Math.round(vatAmount * 100) / 100;
      totalAmount = Math.round(totalAmount * 100) / 100;

      const payMode = (p.payment_mode || p.payment_method || 'CASH').toUpperCase();
      let payTypeLower = 'cash';
      if (payMode === 'CREDIT') payTypeLower = 'credit';
      else if (payMode === 'BANK') payTypeLower = 'bank';

      const paidCash = parseFloat(p.paid_cash) || 0;
      const paidBank = parseFloat(p.paid_bank) || 0;
      const paidCredit = parseFloat(p.paid_credit) || (payMode === 'CREDIT' ? Math.max(0, totalAmount - (paidCash + paidBank)) : 0);

      let inputVendorId = parseInt(p.party_id || p.vendor_id, 10) || 0;
      let activeVendorId = inputVendorId > 0 ? inputVendorId : DEFAULT_VENDOR_ID;

      let party = db.prepare('SELECT * FROM parties WHERE id = ?').get(activeVendorId);
      if (!party) {
        activeVendorId = DEFAULT_VENDOR_ID;
        party = db.prepare('SELECT * FROM parties WHERE id = ?').get(activeVendorId);
      }

      let prevBal = 0;
      let netBal = 0;

      if (party) {
        prevBal = party.current_balance;
        let curBal = prevBal;

        if (!isReturn) {
          curBal += totalAmount;
          db.prepare('UPDATE parties SET current_balance = ? WHERE id = ?').run(curBal, party.id);
          db.prepare(`
            INSERT INTO ledger (party_id, entry_date, entry_type, reference_no, description, debit, credit, balance_after)
            VALUES (?, ?, 'PURCHASE', ?, ?, 0, ?, ?)
          `).run(party.id, dateStr, purchaseNo, 'Purchase: ' + p.supplier_inv_no, totalAmount, curBal);

          const counterPaid = (paidCash + paidBank);
          if (counterPaid > 0) {
            curBal -= counterPaid;
            db.prepare('UPDATE parties SET current_balance = ? WHERE id = ?').run(curBal, party.id);
            db.prepare(`
              INSERT INTO ledger (party_id, entry_date, entry_type, reference_no, description, debit, credit, balance_after, payment_mode)
              VALUES (?, ?, 'PAYMENT', ?, 'Payment to Vendor', ?, 0, ?, ?)
            `).run(party.id, dateStr, 'PV-' + purchaseNo, counterPaid, curBal, payMode);
          }
        } else {
          curBal -= totalAmount;
          db.prepare('UPDATE parties SET current_balance = ? WHERE id = ?').run(curBal, party.id);
          db.prepare(`
            INSERT INTO ledger (party_id, entry_date, entry_type, reference_no, description, debit, credit, balance_after)
            VALUES (?, ?, 'RETURN', ?, 'Purchase Return (Debit Note)', ?, 0, ?)
          `).run(party.id, dateStr, purchaseNo, totalAmount, curBal);
        }
        netBal = curBal;
      }

      // 1. Insert Purchases Record
      const purTableInfo = db.prepare('PRAGMA table_info(purchases)').all();
      const insertRecord = {
        purchase_no: purchaseNo,
        bill_number: p.supplier_inv_no || purchaseNo,
        supplier_inv_no: p.supplier_inv_no,
        is_return: isReturn,
        return_ref_no: p.return_ref_no || null,
        vendor_id: activeVendorId,
        party_id: activeVendorId,
        vendor_name: (party ? party.name_en : 'LOCAL CASH VENDOR').toUpperCase(),
        vendor_phone: p.vendor_phone || (party ? party.phone : null),
        vendor_vat: p.vendor_vat || (party ? party.vat_number : null),
        vendor_cr: p.vendor_cr || (party ? party.cr_number : null),
        purchase_date: dateStr,
        purchase_time: timeStr,
        subtotal: subtotal,
        vat_amount: vatAmount,
        total_amount: totalAmount,
        payment_type: payTypeLower,
        payment_mode: payMode,
        payment_method: payMode,
        paid_cash: paidCash,
        paid_bank: paidBank,
        paid_credit: paidCredit,
        prev_balance: prevBal,
        net_balance: netBal,
        notes: p.notes || '',
        status: 'COMPLETED'
      };

      const validPurchCols = [];
      const purchPlaceholders = [];
      const purchValues = [];

      purTableInfo.forEach(col => {
        if (col.name === 'id') return;
        if (insertRecord.hasOwnProperty(col.name)) {
          validPurchCols.push(col.name);
          purchPlaceholders.push('?');
          purchValues.push(insertRecord[col.name]);
        } else if (col.notnull === 1 && col.dflt_value === null) {
          validPurchCols.push(col.name);
          purchPlaceholders.push('?');
          purchValues.push(col.type && col.type.includes('INT') ? 0 : '');
        }
      });

      const sqlPurch = `INSERT INTO purchases (${validPurchCols.join(', ')}) VALUES (${purchPlaceholders.join(', ')})`;
      const purInfo = db.prepare(sqlPurch).run(...purchValues);
      const purchaseId = purInfo.lastInsertRowid;

      // 2. Insert Items
      const itemTableInfo = db.prepare('PRAGMA table_info(purchase_items)').all();
      const stockAdd = db.prepare('UPDATE products SET stock_quantity = stock_quantity + ?, cost_price = ?, selling_price = CASE WHEN ? > 0 THEN ? ELSE selling_price END WHERE id = ?');
      const stockDeduct = db.prepare('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?');

      p.items.forEach(it => {
        const costP = parseFloat(it.cost_price) || 0;
        const sellP = parseFloat(it.selling_price) || 0;
        const qty = parseFloat(it.quantity) || 1;
        const lineBase = Math.round(costP * qty * 100) / 100;
        const itVat = Math.round(lineBase * 0.15 * 100) / 100;
        const lineTot = lineBase + itVat;

        const rowObj = {
          purchase_id: purchaseId,
          product_id: it.product_id || null,
          quantity: qty,
          unit_cost: costP,
          cost_price: costP,
          vat_rate: 15.00,
          vat_amount: itVat,
          total_line_amount: lineTot,
          line_total: lineTot,
          item_code: it.item_code || null,
          barcode: it.barcode || null,
          name_en: (it.name_en || 'ITEM').toUpperCase(),
          name_ar: it.name_ar || '',
          unit: it.unit || 'PCS',
          selling_price: sellP
        };

        const colsToInsert = [];
        const placeHolders = [];
        const vals = [];

        itemTableInfo.forEach(col => {
          if (col.name === 'id') return;
          if (rowObj.hasOwnProperty(col.name)) {
            colsToInsert.push(col.name);
            placeHolders.push('?');
            vals.push(rowObj[col.name]);
          } else if (col.notnull === 1 && col.dflt_value === null) {
            colsToInsert.push(col.name);
            placeHolders.push('?');
            vals.push(col.type && col.type.includes('INT') ? 0 : '');
          }
        });

        const sqlItem = `INSERT INTO purchase_items (${colsToInsert.join(', ')}) VALUES (${placeHolders.join(', ')})`;
        db.prepare(sqlItem).run(...vals);

        if (it.product_id) {
          if (isReturn) {
            stockDeduct.run(qty, it.product_id);
          } else {
            stockAdd.run(qty, costP, sellP, sellP, it.product_id);
          }
        }
      });

      return { purchaseId, purchaseNo, totalAmount, isReturn };
    });

    const result = createTx();
    res.json({ success: true, message: 'Processed successfully', data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// WhatsApp Text Generator
router.get('/:id/whatsapp-text', (req, res) => {
  try {
    const pur = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.id);
    if (!pur) return res.status(404).json({ success: false, error: 'Record not found' });
    const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?').all(pur.id);
    let store = {};
    try { store = db.prepare('SELECT * FROM settings LIMIT 1').get() || {}; } catch(e) {}
    const vId = pur.party_id || pur.vendor_id;
    let party = vId ? db.prepare('SELECT * FROM parties WHERE id = ?').get(vId) : null;

    const title = pur.is_return ? 'DEBIT NOTE / اشعار مدين مرتجع' : 'PURCHASE VOUCHER / سند مشتريات';
    let itemsSummary = items.map(it => `• ${it.name_en} x${it.quantity} = ${it.total_line_amount || it.line_total} SAR`).join('\n');
    const counterPaid = (pur.paid_cash + pur.paid_bank).toFixed(2);
    const netBal = (pur.net_balance !== undefined && pur.net_balance !== null) ? pur.net_balance.toFixed(2) : (party ? party.current_balance.toFixed(2) : '0.00');

    let text = `*${title}*\n*${store.company_name_en || 'STORE'}*\n--------------------------------\nRef No: *${pur.purchase_no}*\nSupp Bill: *${pur.supplier_inv_no || 'N/A'}*\nDate: ${pur.purchase_date}\nVendor: *${pur.vendor_name}*\n--------------------------------\n${itemsSummary}\n--------------------------------\nSubtotal (Excl. VAT): ${pur.subtotal.toFixed(2)} SAR\nVAT (15%): ${pur.vat_amount.toFixed(2)} SAR\n*Total: ${pur.total_amount.toFixed(2)} SAR*\nPaid: ${counterPaid} SAR\n*Net Balance: ${netBal} SAR*`;

    res.json({ success: true, text, phone: pur.vendor_phone || (party ? party.phone : '') });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;