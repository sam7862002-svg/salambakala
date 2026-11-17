const express = require('express');
const router = express.Router();
const db = require('../db');

function getAccountBalances() {
  const cashIn = db.prepare("SELECT COALESCE(SUM(amount), 0) as tot FROM account_transactions WHERE account_type = 'CASH' AND flow = 'IN'").get().tot;
  const cashOut = db.prepare("SELECT COALESCE(SUM(amount), 0) as tot FROM account_transactions WHERE account_type = 'CASH' AND flow = 'OUT'").get().tot;
  
  const bankIn = db.prepare("SELECT COALESCE(SUM(amount), 0) as tot FROM account_transactions WHERE account_type = 'BANK' AND flow = 'IN'").get().tot;
  const bankOut = db.prepare("SELECT COALESCE(SUM(amount), 0) as tot FROM account_transactions WHERE account_type = 'BANK' AND flow = 'OUT'").get().tot;

  let salesCash = 0, salesBank = 0;
  try {
    salesCash = db.prepare("SELECT COALESCE(SUM(paid_cash), 0) as tot FROM sales").get().tot;
    salesBank = db.prepare("SELECT COALESCE(SUM(paid_bank), 0) as tot FROM sales").get().tot;
  } catch(e) {}

  let purchCash = 0, purchBank = 0;
  try {
    purchCash = db.prepare("SELECT COALESCE(SUM(paid_cash), 0) as tot FROM purchases").get().tot;
    purchBank = db.prepare("SELECT COALESCE(SUM(paid_bank), 0) as tot FROM purchases").get().tot;
  } catch(e) {}

  return {
    netCash: (salesCash + cashIn) - (purchCash + cashOut),
    netBank: (salesBank + bankIn) - (purchBank + bankOut)
  };
}

// Dashboard Summary
router.get('/dashboard-summary', (req, res) => {
  try {
    const balances = getAccountBalances();
    const totalSalaryDue = db.prepare("SELECT COALESCE(SUM(current_balance), 0) as tot FROM employees WHERE status = 'active'").get().tot;
    const totalUtilityDue = db.prepare("SELECT COALESCE(SUM(current_due), 0) as tot FROM utilities").get().tot;
    const todayPetty = db.prepare("SELECT COALESCE(SUM(amount), 0) as tot FROM petty_expenses WHERE expense_date = date('now')").get().tot;

    const todayStr = new Date().toISOString().slice(0, 10);
    const in7Days = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    const alerts = db.prepare(`
      SELECT id, name_en, iqama_no, iqama_expiry, baladiya_expiry
      FROM employees
      WHERE status = 'active' AND (
        (iqama_expiry IS NOT NULL AND iqama_expiry <= ?) OR
        (baladiya_expiry IS NOT NULL AND baladiya_expiry <= ?)
      )
    `).all(in7Days, in7Days);

    res.json({
      success: true,
      data: {
        cashInHand: balances.netCash,
        bankBalance: balances.netBank,
        totalSalaryDue,
        totalUtilityDue,
        todayPetty,
        alerts
      }
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Auto 30-day Salary Accrual
function autoAccrueSalaries() {
  const activeEmployees = db.prepare("SELECT * FROM employees WHERE status = 'active'").all();
  const today = new Date();

  activeEmployees.forEach(emp => {
    const lastDateStr = emp.last_accrual_date || emp.joining_date;
    const lastDate = new Date(lastDateStr);
    const diffDays = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24));

    if (diffDays >= 30 && emp.monthly_salary > 0) {
      const nextAccrualDate = new Date(lastDate);
      nextAccrualDate.setDate(nextAccrualDate.getDate() + 30);
      const nextAccrualStr = nextAccrualDate.toISOString().slice(0, 10);
      const newBal = emp.current_balance + emp.monthly_salary;

      db.transaction(() => {
        db.prepare("UPDATE employees SET current_balance = ?, last_accrual_date = ? WHERE id = ?")
          .run(newBal, nextAccrualStr, emp.id);
        db.prepare(`
          INSERT INTO employee_ledger (employee_id, entry_date, entry_type, description, debit, credit, balance_after)
          VALUES (?, ?, 'SALARY_ACCRUAL', 'Monthly Salary Accrued (30 Days Cycle)', 0, ?, ?)
        `).run(emp.id, nextAccrualStr, emp.monthly_salary, newBal);
      })();
    }
  });
}

// -------------------------------------------------------------------------
// 1. EMPLOYEES CRUD & WORKFLOW
// -------------------------------------------------------------------------
router.get('/employees', (req, res) => {
  try {
    autoAccrueSalaries();
    const list = db.prepare('SELECT * FROM employees ORDER BY status ASC, id DESC').all();
    res.json({ success: true, data: list });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Add Employee
router.post('/employees', (req, res) => {
  const p = req.body;
  try {
    const salary = parseFloat(p.monthly_salary) || 0;
    const openBal = parseFloat(p.opening_balance) || 0;
    const joinDate = p.joining_date || new Date().toISOString().slice(0, 10);

    const info = db.prepare(`
      INSERT INTO employees (name_en, name_ar, phone, iqama_no, iqama_expiry, baladiya_expiry, joining_date, monthly_salary, opening_balance, current_balance, last_accrual_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      p.name_en.toUpperCase().trim(),
      p.name_ar || null,
      p.phone.trim(),
      p.iqama_no || null,
      p.iqama_expiry || null,
      p.baladiya_expiry || null,
      joinDate,
      salary,
      openBal,
      openBal,
      joinDate
    );

    if (openBal !== 0) {
      db.prepare(`
        INSERT INTO employee_ledger (employee_id, entry_date, entry_type, description, debit, credit, balance_after)
        VALUES (?, ?, 'OPENING_BALANCE', 'Opening Balance / الرصيد الافتتاحي', ?, ?, ?)
      `).run(info.lastInsertRowid, joinDate, openBal < 0 ? Math.abs(openBal) : 0, openBal > 0 ? openBal : 0, openBal);
    }

    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Edit Employee (WITH OPENING BALANCE EDITING!)
router.put('/employees/:id', (req, res) => {
  const empId = req.params.id;
  const p = req.body;

  try {
    db.transaction(() => {
      const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
      if (!emp) throw new Error('Employee not found');

      const oldOpenBal = emp.opening_balance || 0;
      const newOpenBal = parseFloat(p.opening_balance) || 0;
      const delta = newOpenBal - oldOpenBal;
      const newCurrentBal = emp.current_balance + delta;

      // Update Employee Record
      db.prepare(`
        UPDATE employees
        SET name_en = ?, name_ar = ?, phone = ?, iqama_no = ?, iqama_expiry = ?,
            baladiya_expiry = ?, monthly_salary = ?, opening_balance = ?, current_balance = ?
        WHERE id = ?
      `).run(
        p.name_en.toUpperCase().trim(),
        p.name_ar || null,
        p.phone.trim(),
        p.iqama_no || null,
        p.iqama_expiry || null,
        p.baladiya_expiry || null,
        parseFloat(p.monthly_salary) || 0,
        newOpenBal,
        newCurrentBal,
        empId
      );

      // Adjust or insert in ledger if opening balance was modified
      if (delta !== 0) {
        const existingOpen = db.prepare("SELECT id FROM employee_ledger WHERE employee_id = ? AND entry_type = 'OPENING_BALANCE'").get(empId);
        if (existingOpen) {
          db.prepare("UPDATE employee_ledger SET debit = ?, credit = ?, balance_after = ? WHERE id = ?")
            .run(newOpenBal < 0 ? Math.abs(newOpenBal) : 0, newOpenBal > 0 ? newOpenBal : 0, newOpenBal, existingOpen.id);
        } else {
          db.prepare(`
            INSERT INTO employee_ledger (employee_id, entry_date, entry_type, description, debit, credit, balance_after)
            VALUES (?, date('now'), 'OPENING_BALANCE', 'Opening Balance Adjusted', ?, ?, ?)
          `).run(empId, delta < 0 ? Math.abs(delta) : 0, delta > 0 ? delta : 0, newCurrentBal);
        }
      }
    })();

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Delete Employee Safely
router.delete('/employees/:id', (req, res) => {
  const empId = req.params.id;
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM employee_ledger WHERE employee_id = ?').run(empId);
      db.prepare('DELETE FROM account_transactions WHERE reference_no = ?').run('EMP-' + empId);
      db.prepare('DELETE FROM employees WHERE id = ?').run(empId);
    })();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Pay Employee (UNIFIED SPLIT PAYMENT: Cash + Bank simultaneously)
router.post('/employees/:id/pay', (req, res) => {
  const empId = req.params.id;
  const { paid_cash, paid_bank, entry_date, description } = req.body;
  const cashAmt = parseFloat(paid_cash) || 0;
  const bankAmt = parseFloat(paid_bank) || 0;
  const totalAmt = cashAmt + bankAmt;

  if (totalAmt <= 0) return res.status(400).json({ success: false, error: 'Enter valid Cash or Bank amount' });
  const dateStr = entry_date || new Date().toISOString().slice(0, 10);

  try {
    const tx = db.transaction(() => {
      const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
      if (!emp) throw new Error('Employee not found');

      const newBal = emp.current_balance - totalAmt;
      const desc = description ? description.trim() : 'Payment to Employee';
      const payModeLabel = (cashAmt > 0 && bankAmt > 0) ? 'SPLIT (Cash & Bank)' : (bankAmt > 0 ? 'BANK' : 'CASH');

      // 1. Update Employee Balance
      db.prepare('UPDATE employees SET current_balance = ? WHERE id = ?').run(newBal, empId);

      // 2. Add to Employee Ledger
      db.prepare(`
        INSERT INTO employee_ledger (employee_id, entry_date, entry_type, description, debit, credit, balance_after, payment_mode)
        VALUES (?, ?, 'PAYMENT', ?, ?, 0, ?, ?)
      `).run(empId, dateStr, `${desc} (Cash: ${cashAmt.toFixed(2)}, Bank: ${bankAmt.toFixed(2)})`, totalAmt, newBal, payModeLabel);

      // 3. Deduct from Cash Drawer
      if (cashAmt > 0) {
        db.prepare(`
          INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_id, reference_no, description)
          VALUES (?, 'CASH', 'OUT', ?, 'SALARY', ?, ?, ?)
        `).run(dateStr, cashAmt, empId, 'EMP-' + empId, `Paid to ${emp.name_en} (Cash)`);
      }

      // 4. Deduct from Bank Account
      if (bankAmt > 0) {
        db.prepare(`
          INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_id, reference_no, description)
          VALUES (?, 'BANK', 'OUT', ?, 'SALARY', ?, ?, ?)
        `).run(dateStr, bankAmt, empId, 'EMP-' + empId, `Paid to ${emp.name_en} (Bank)`);
      }

      return { newBal };
    });

    const result = tx();
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// BORROW CASH FROM EMPLOYEE (Store borrows cash -> Cash In Hand (+) and Employee Balance (+))
router.post('/employees/:id/borrow-cash', (req, res) => {
  const empId = req.params.id;
  const { amount, entry_date, description } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ success: false, error: 'Enter valid amount' });

  const dateStr = entry_date || new Date().toISOString().slice(0, 10);
  const desc = description ? description.trim() : 'Temporary Cash borrowed from Employee';

  try {
    const tx = db.transaction(() => {
      const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
      if (!emp) throw new Error('Employee not found');

      // Increases employee payable balance (Store owes employee this cash back)
      const newBal = emp.current_balance + amt;
      db.prepare('UPDATE employees SET current_balance = ? WHERE id = ?').run(newBal, empId);

      // Add Credit in Employee Ledger
      db.prepare(`
        INSERT INTO employee_ledger (employee_id, entry_date, entry_type, description, debit, credit, balance_after, payment_mode)
        VALUES (?, ?, 'CASH_BORROWED', ?, 0, ?, ?, 'CASH')
      `).run(empId, dateStr, desc, amt, newBal);

      // INCREASES SHOP CASH IN HAND!
      db.prepare(`
        INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_id, reference_no, description)
        VALUES (?, 'CASH', 'IN', ?, 'CASH_FROM_EMP', ?, ?, ?)
      `).run(dateStr, amt, empId, 'EMP-BORROW-' + empId, `Cash received from ${emp.name_en} - ${desc}`);

      return { newBal };
    });

    const result = tx();
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// End Duty & Rejoin Endpoints
router.post('/employees/:id/end-duty', (req, res) => {
  const empId = req.params.id;
  const { end_date, pay_settlement_now, paid_cash, paid_bank } = req.body;
  const endDate = new Date(end_date || new Date().toISOString().slice(0, 10));

  try {
    const tx = db.transaction(() => {
      const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
      if (!emp) throw new Error('Employee not found');

      const lastDate = new Date(emp.last_accrual_date || emp.joining_date);
      const diffDays = Math.max(0, Math.floor((endDate - lastDate) / (1000 * 60 * 60 * 24)));
      const dailyWage = (emp.monthly_salary || 0) / 30;
      const proRataSalary = Math.round(diffDays * dailyWage * 100) / 100;
      let finalBal = emp.current_balance + proRataSalary;

      if (proRataSalary > 0) {
        db.prepare(`
          INSERT INTO employee_ledger (employee_id, entry_date, entry_type, description, debit, credit, balance_after)
          VALUES (?, ?, 'SALARY_ACCRUAL', ?, 0, ?, ?)
        `).run(empId, endDate.toISOString().slice(0, 10), `Duty Ended: ${diffDays} Days Worked (${dailyWage.toFixed(2)}/day)`, proRataSalary, finalBal);
      }

      if (pay_settlement_now && finalBal > 0) {
        const cPaid = parseFloat(paid_cash) || 0;
        const bPaid = parseFloat(paid_bank) || 0;
        const dateStr = endDate.toISOString().slice(0, 10);

        db.prepare(`
          INSERT INTO employee_ledger (employee_id, entry_date, entry_type, description, debit, credit, balance_after)
          VALUES (?, ?, 'FINAL_SETTLEMENT', 'Full Final Settlement Paid / مخالصة نهائية', ?, 0, 0.00)
        `).run(empId, dateStr, finalBal);

        if (cPaid > 0) {
          db.prepare("INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_no, description) VALUES (?, 'CASH', 'OUT', ?, 'SALARY', ?, ?)")
            .run(dateStr, cPaid, 'SETTLE-' + empId, 'Final Settlement Cash - ' + emp.name_en);
        }
        if (bPaid > 0) {
          db.prepare("INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_no, description) VALUES (?, 'BANK', 'OUT', ?, 'SALARY', ?, ?)")
            .run(dateStr, bPaid, 'SETTLE-' + empId, 'Final Settlement Bank - ' + emp.name_en);
        }
        finalBal = 0.00;
      }

      db.prepare("UPDATE employees SET status = 'on_leave', current_balance = ? WHERE id = ?").run(finalBal, empId);
      return { diffDays, proRataSalary, finalBal };
    });

    const result = tx();
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/employees/:id/rejoin', (req, res) => {
  const empId = req.params.id;
  const rejoinDate = req.body.rejoin_date || new Date().toISOString().slice(0, 10);
  try {
    db.prepare("UPDATE employees SET status = 'active', joining_date = ?, last_accrual_date = ? WHERE id = ?")
      .run(rejoinDate, rejoinDate, empId);
    db.prepare(`
      INSERT INTO employee_ledger (employee_id, entry_date, entry_type, description, debit, credit, balance_after)
      VALUES (?, ?, 'REJOIN', 'Rejoined Duty / استئناف العمل', 0, 0, (SELECT current_balance FROM employees WHERE id = ?))
    `).run(empId, rejoinDate, empId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/employees/:id/statement', (req, res) => {
  try {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const entries = db.prepare('SELECT * FROM employee_ledger WHERE employee_id = ? ORDER BY id DESC').all(emp.id);
    res.json({ success: true, employee: emp, entries });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// -------------------------------------------------------------------------
// 2. UTILITY BILLS (FULL CRUD: ADD, EDIT, DELETE, PAY SPLIT)
// -------------------------------------------------------------------------
router.get('/utilities', (req, res) => {
  try {
    const list = db.prepare('SELECT * FROM utilities ORDER BY id ASC').all();
    res.json({ success: true, data: list });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Add New Utility Category/Account
router.post('/utilities', (req, res) => {
  const { name_en, name_ar, category, account_no, current_due } = req.body;
  if (!name_en) return res.status(400).json({ success: false, error: 'Name is required' });

  try {
    const due = parseFloat(current_due) || 0;
    const info = db.prepare(`
      INSERT INTO utilities (name_en, name_ar, category, account_no, current_due)
      VALUES (?, ?, ?, ?, ?)
    `).run(name_en.toUpperCase().trim(), name_ar || null, category || 'GENERAL', account_no || null, due);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Edit Utility
router.put('/utilities/:id', (req, res) => {
  const { name_en, name_ar, category, account_no, current_due } = req.body;
  try {
    db.prepare(`
      UPDATE utilities
      SET name_en = ?, name_ar = ?, category = ?, account_no = ?, current_due = ?
      WHERE id = ?
    `).run(name_en.toUpperCase().trim(), name_ar || null, category || 'GENERAL', account_no || null, parseFloat(current_due) || 0, req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Delete Utility
router.delete('/utilities/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM utility_transactions WHERE utility_id = ?').run(req.params.id);
    db.prepare('DELETE FROM utilities WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Add Bill to Utility (Increases Due)
router.post('/utilities/:id/add-bill', (req, res) => {
  const utilId = req.params.id;
  const { amount, bill_date, description } = req.body;
  const billAmt = parseFloat(amount);
  if (!billAmt || billAmt <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });

  try {
    const tx = db.transaction(() => {
      const util = db.prepare('SELECT * FROM utilities WHERE id = ?').get(utilId);
      if (!util) throw new Error('Utility not found');

      const newDue = util.current_due + billAmt;
      const dateStr = bill_date || new Date().toISOString().slice(0, 10);

      db.prepare('UPDATE utilities SET current_due = ? WHERE id = ?').run(newDue, utilId);
      db.prepare(`
        INSERT INTO utility_transactions (utility_id, entry_date, type, amount, description, balance_after)
        VALUES (?, ?, 'BILL_ADDED', ?, ?, ?)
      `).run(utilId, dateStr, billAmt, description || 'Monthly Bill Received', newDue);

      return { newDue };
    });
    const result = tx();
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Pay Utility Bill (SPLIT CASH + BANK DEDUCTION)
router.post('/utilities/:id/pay', (req, res) => {
  const utilId = req.params.id;
  const { paid_cash, paid_bank, pay_date, description } = req.body;
  const cashAmt = parseFloat(paid_cash) || 0;
  const bankAmt = parseFloat(paid_bank) || 0;
  const totalAmt = cashAmt + bankAmt;

  if (totalAmt <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });
  const dateStr = pay_date || new Date().toISOString().slice(0, 10);

  try {
    const tx = db.transaction(() => {
      const util = db.prepare('SELECT * FROM utilities WHERE id = ?').get(utilId);
      if (!util) throw new Error('Utility not found');

      const newDue = Math.max(0, util.current_due - totalAmt);
      const desc = description ? description.trim() : ('Bill Payment: ' + util.name_en);

      db.prepare('UPDATE utilities SET current_due = ? WHERE id = ?').run(newDue, utilId);
      db.prepare(`
        INSERT INTO utility_transactions (utility_id, entry_date, type, amount, payment_mode, description, balance_after)
        VALUES (?, ?, 'BILL_PAID', ?, ?, ?, ?)
      `).run(utilId, dateStr, totalAmt, `Cash: ${cashAmt.toFixed(2)}, Bank: ${bankAmt.toFixed(2)}`, desc, newDue);

      if (cashAmt > 0) {
        db.prepare(`
          INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_id, reference_no, description)
          VALUES (?, 'CASH', 'OUT', ?, 'UTILITY', ?, ?, ?)
        `).run(dateStr, cashAmt, utilId, 'UTIL-' + utilId, desc + ' (Cash)');
      }

      if (bankAmt > 0) {
        db.prepare(`
          INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_id, reference_no, description)
          VALUES (?, 'BANK', 'OUT', ?, 'UTILITY', ?, ?, ?)
        `).run(dateStr, bankAmt, utilId, 'UTIL-' + utilId, desc + ' (Bank)');
      }

      return { newDue };
    });

    const result = tx();
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// -------------------------------------------------------------------------
// 3. PETTY CASH CATEGORIES CRUD (ADD, EDIT, DELETE)
// -------------------------------------------------------------------------
router.get('/petty-categories', (req, res) => {
  try {
    const list = db.prepare('SELECT * FROM petty_categories ORDER BY id ASC').all();
    res.json({ success: true, data: list });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/petty-categories', (req, res) => {
  const { name_en, name_ar, icon } = req.body;
  if (!name_en) return res.status(400).json({ success: false, error: 'Category Name is required' });

  try {
    const info = db.prepare('INSERT INTO petty_categories (name_en, name_ar, icon) VALUES (?, ?, ?)')
      .run(name_en.toUpperCase().trim(), name_ar || null, icon || '🏷️');
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.put('/petty-categories/:id', (req, res) => {
  const { name_en, name_ar, icon } = req.body;
  try {
    db.prepare('UPDATE petty_categories SET name_en = ?, name_ar = ?, icon = ? WHERE id = ?')
      .run(name_en.toUpperCase().trim(), name_ar || null, icon || '🏷️', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/petty-categories/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM petty_categories WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// -------------------------------------------------------------------------
// 4. PETTY EXPENSES (WITH SPLIT CASH + BANK DEDUCTION)
// -------------------------------------------------------------------------
router.get('/petty', (req, res) => {
  try {
    const list = db.prepare('SELECT * FROM petty_expenses ORDER BY id DESC LIMIT 100').all();
    res.json({ success: true, data: list });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/petty', (req, res) => {
  const { category, paid_cash, paid_bank, description, expense_date } = req.body;
  const cashAmt = parseFloat(paid_cash) || 0;
  const bankAmt = parseFloat(paid_bank) || 0;
  const totalAmt = cashAmt + bankAmt;

  if (totalAmt <= 0) return res.status(400).json({ success: false, error: 'Enter valid Cash or Bank amount' });
  const dateStr = expense_date || new Date().toISOString().slice(0, 10);
  const cat = (category || 'GENERAL').toUpperCase().trim();
  const payModeLabel = (cashAmt > 0 && bankAmt > 0) ? 'SPLIT' : (bankAmt > 0 ? 'BANK' : 'CASH');

  try {
    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO petty_expenses (expense_date, category, amount, payment_mode, description)
        VALUES (?, ?, ?, ?, ?)
      `).run(dateStr, cat, totalAmt, payModeLabel, description || null);

      if (cashAmt > 0) {
        db.prepare(`
          INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_id, reference_no, description)
          VALUES (?, 'CASH', 'OUT', ?, 'EXPENSE', ?, ?, ?)
        `).run(dateStr, cashAmt, info.lastInsertRowid, 'EXP-' + info.lastInsertRowid, `${cat}: ${description||''} (Cash)`);
      }

      if (bankAmt > 0) {
        db.prepare(`
          INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_id, reference_no, description)
          VALUES (?, 'BANK', 'OUT', ?, 'EXPENSE', ?, ?, ?)
        `).run(dateStr, bankAmt, info.lastInsertRowid, 'EXP-' + info.lastInsertRowid, `${cat}: ${description||''} (Bank)`);
      }

      return { id: info.lastInsertRowid };
    });

    const result = tx();
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/petty/:id', (req, res) => {
  const id = req.params.id;
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM account_transactions WHERE category = "EXPENSE" AND reference_id = ?').run(id);
      db.prepare('DELETE FROM petty_expenses WHERE id = ?').run(id);
    })();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
