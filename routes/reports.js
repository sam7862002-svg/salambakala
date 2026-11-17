const express = require('express');
const router = express.Router();
const db = require('../db');

function getCols(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  } catch(e) { return []; }
}

function getTables() {
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  } catch(e) { return []; }
}

// COMPLETE LIQUIDITY ENGINE (AUDITED OPENING BALANCES, PERIOD MOVEMENTS & DETAILED STATEMENT)
function getAccountLiquidity(from, to, isAllTime) {
  let initCash = 0, initBank = 0;
  try {
    const s = db.prepare('SELECT initial_cash, initial_bank FROM settings LIMIT 1').get() || {};
    initCash = parseFloat(s.initial_cash) || 0;
    initBank = parseFloat(s.initial_bank) || 0;
  } catch(e) {}

  const allTables = getTables();

  // Helper to calculate Cash & Bank movements for any date condition
  function calculateFlows(dateCondition, params) {
    let salesCash = 0, salesBank = 0;
    if (allTables.includes('invoices')) {
      try {
        const sRes = db.prepare(`
          SELECT 
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 0 THEN paid_cash ELSE -paid_cash END), 0) AS net_cash,
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 0 THEN paid_bank ELSE -paid_bank END), 0) AS net_bank
          FROM invoices
          WHERE ${dateCondition}
        `).get(...params);
        if (sRes) {
          salesCash = parseFloat(sRes.net_cash) || 0;
          salesBank = parseFloat(sRes.net_bank) || 0;
        }
      } catch(e) {}
    }

    let purchCash = 0, purchBank = 0;
    if (allTables.includes('purchases')) {
      try {
        const pRes = db.prepare(`
          SELECT 
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 0 THEN paid_cash ELSE -paid_cash END), 0) AS net_cash,
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 0 THEN paid_bank ELSE -paid_bank END), 0) AS net_bank
          FROM purchases
          WHERE ${dateCondition}
        `).get(...params);
        if (pRes) {
          purchCash = parseFloat(pRes.net_cash) || 0;
          purchBank = parseFloat(pRes.net_bank) || 0;
        }
      } catch(e) {}
    }

    let custRecCash = 0, custRecBank = 0;
    let vendPayCash = 0, vendPayBank = 0;
    if (allTables.includes('ledger') && allTables.includes('parties')) {
      try {
        const crRes = db.prepare(`
          SELECT 
            COALESCE(SUM(CASE WHEN UPPER(COALESCE(l.payment_mode, 'CASH')) = 'CASH' THEN l.credit ELSE 0 END), 0) AS cash_in,
            COALESCE(SUM(CASE WHEN UPPER(COALESCE(l.payment_mode, 'CASH')) = 'BANK' THEN l.credit ELSE 0 END), 0) AS bank_in
          FROM ledger l
          JOIN parties p ON l.party_id = p.id
          WHERE (LOWER(p.party_type) = 'customer' OR LOWER(p.type) = 'customer')
            AND l.entry_type = 'PAYMENT'
            AND ${dateCondition}
        `).get(...params);
        if (crRes) {
          custRecCash = parseFloat(crRes.cash_in) || 0;
          custRecBank = parseFloat(crRes.bank_in) || 0;
        }

        const vpRes = db.prepare(`
          SELECT 
            COALESCE(SUM(CASE WHEN UPPER(COALESCE(l.payment_mode, 'CASH')) = 'CASH' THEN l.debit ELSE 0 END), 0) AS cash_out,
            COALESCE(SUM(CASE WHEN UPPER(COALESCE(l.payment_mode, 'CASH')) = 'BANK' THEN l.debit ELSE 0 END), 0) AS bank_out
          FROM ledger l
          JOIN parties p ON l.party_id = p.id
          WHERE (LOWER(p.party_type) = 'vendor' OR LOWER(p.type) = 'vendor')
            AND l.entry_type = 'PAYMENT'
            AND l.reference_no NOT LIKE 'PV-PUR-%'
            AND ${dateCondition}
        `).get(...params);
        if (vpRes) {
          vendPayCash = parseFloat(vpRes.cash_out) || 0;
          vendPayBank = parseFloat(vpRes.bank_out) || 0;
        }
      } catch(e) {}
    }

    let actCashIn = 0, actCashOut = 0, actBankIn = 0, actBankOut = 0;
    if (allTables.includes('account_transactions')) {
      try {
        const actRes = db.prepare(`
          SELECT 
            COALESCE(SUM(CASE WHEN account_type = 'CASH' AND flow = 'IN' THEN amount ELSE 0 END), 0) AS cash_in,
            COALESCE(SUM(CASE WHEN account_type = 'CASH' AND flow = 'OUT' THEN amount ELSE 0 END), 0) AS cash_out,
            COALESCE(SUM(CASE WHEN account_type = 'BANK' AND flow = 'IN' THEN amount ELSE 0 END), 0) AS bank_in,
            COALESCE(SUM(CASE WHEN account_type = 'BANK' AND flow = 'OUT' THEN amount ELSE 0 END), 0) AS bank_out
          FROM account_transactions
          WHERE ${dateCondition}
        `).get(...params);
        if (actRes) {
          actCashIn = parseFloat(actRes.cash_in) || 0;
          actCashOut = parseFloat(actRes.cash_out) || 0;
          actBankIn = parseFloat(actRes.bank_in) || 0;
          actBankOut = parseFloat(actRes.bank_out) || 0;
        }
      } catch(e) {}
    }

    return {
      cashIn: salesCash + custRecCash + actCashIn,
      cashOut: purchCash + vendPayCash + actCashOut,
      bankIn: salesBank + custRecBank + actBankIn,
      bankOut: purchBank + vendPayBank + actBankOut
    };
  }

  // 1. Opening Balances prior to 'from' date
  let priorCashIn = 0, priorCashOut = 0, priorBankIn = 0, priorBankOut = 0;
  if (!isAllTime) {
    const prior = calculateFlows("date(invoice_date) < ?", [from]);
    // Also include ledger, purchases, account_transactions prior dates safely
    const priorLeg = calculateFlows("date(entry_date) < ?", [from]);
    const priorPur = calculateFlows("date(purchase_date) < ?", [from]);
    const priorAct = calculateFlows("date(entry_date) < ?", [from]);

    priorCashIn = Math.max(prior.cashIn, priorLeg.cashIn, priorPur.cashIn, priorAct.cashIn);
    priorCashOut = Math.max(prior.cashOut, priorLeg.cashOut, priorPur.cashOut, priorAct.cashOut);
    priorBankIn = Math.max(prior.bankIn, priorLeg.bankIn, priorPur.bankIn, priorAct.bankIn);
    priorBankOut = Math.max(prior.bankOut, priorLeg.bankOut, priorPur.bankOut, priorAct.bankOut);
  }

  const openingCash = initCash + priorCashIn - priorCashOut;
  const openingBank = initBank + priorBankIn - priorBankOut;

  // 2. Period Movements
  const periodCond = isAllTime ? "1=1" : "date(invoice_date) BETWEEN ? AND ?";
  const periodParams = isAllTime ? [] : [from, to];
  const period = calculateFlows(periodCond, periodParams);

  // 3. Final Closing Balance
  const closingCash = openingCash + period.cashIn - period.cashOut;
  const closingBank = openingBank + period.bankIn - period.bankOut;

  // 4. Detailed Audit Log Entries within the period
  let liquidityLog = [];
  const logCond = isAllTime ? "1=1" : "date(invoice_date) BETWEEN ? AND ?";
  const logParams = isAllTime ? [] : [from, to];

  if (allTables.includes('invoices')) {
    try {
      const invs = db.prepare(`
        SELECT COALESCE(invoice_date, date('now')) as date, COALESCE(invoice_time, '') as time,
               invoice_no as ref_no, CASE WHEN COALESCE(is_return, 0) = 1 THEN 'SALES RETURN' ELSE 'POS SALES' END as category,
               COALESCE(customer_name, 'WALK-IN CUSTOMER') as party_name, paid_cash, paid_bank, COALESCE(is_return, 0) as is_return
        FROM invoices WHERE ${logCond} AND (paid_cash > 0 OR paid_bank > 0)
        ORDER BY id DESC LIMIT 200
      `).all(...logParams);

      invs.forEach(iv => {
        if (iv.paid_cash > 0) liquidityLog.push({ date: iv.date, time: iv.time, ref_no: iv.ref_no, account: 'CASH', category: iv.category, flow: iv.is_return === 1 ? 'OUT' : 'IN', party_name: iv.party_name, amount: iv.paid_cash, description: iv.is_return === 1 ? 'Refund to Customer (Cash)' : 'Sales Cash Collected' });
        if (iv.paid_bank > 0) liquidityLog.push({ date: iv.date, time: iv.time, ref_no: iv.ref_no, account: 'BANK', category: iv.category, flow: iv.is_return === 1 ? 'OUT' : 'IN', party_name: iv.party_name, amount: iv.paid_bank, description: iv.is_return === 1 ? 'Refund to Customer (Bank)' : 'Sales Card / Bank Collected' });
      });
    } catch(e) {}
  }

  if (allTables.includes('ledger') && allTables.includes('parties')) {
    try {
      const ledgCond = isAllTime ? "1=1" : "date(l.entry_date) BETWEEN ? AND ?";
      const ledgItems = db.prepare(`
        SELECT l.entry_date as date, l.reference_no as ref_no, p.name_en as party_name, p.party_type, l.description,
               UPPER(COALESCE(l.payment_mode, 'CASH')) as payment_mode, l.debit, l.credit
        FROM ledger l JOIN parties p ON l.party_id = p.id
        WHERE l.entry_type = 'PAYMENT' AND l.reference_no NOT LIKE 'PV-PUR-%' AND ${ledgCond}
        ORDER BY l.id DESC LIMIT 200
      `).all(...logParams);

      ledgItems.forEach(li => {
        const isCustomer = (li.party_type || '').toLowerCase() === 'customer';
        const mode = li.payment_mode === 'BANK' ? 'BANK' : 'CASH';
        if (isCustomer && li.credit > 0) {
          liquidityLog.push({ date: li.date, time: '', ref_no: li.ref_no || 'REC', account: mode, category: 'CUSTOMER RECEIPT', flow: 'IN', party_name: li.party_name, amount: li.credit, description: li.description || 'Customer Outstanding Collected' });
        } else if (!isCustomer && li.debit > 0) {
          liquidityLog.push({ date: li.date, time: '', ref_no: li.ref_no || 'PAY', account: mode, category: 'VENDOR PAYMENT', flow: 'OUT', party_name: li.party_name, amount: li.debit, description: li.description || 'Payment to Supplier' });
        }
      });
    } catch(e) {}
  }

  if (allTables.includes('purchases')) {
    try {
      const purLogCond = isAllTime ? "1=1" : "date(purchase_date) BETWEEN ? AND ?";
      const purs = db.prepare(`
        SELECT COALESCE(purchase_date, date('now')) as date, COALESCE(purchase_time, '') as time, purchase_no as ref_no,
               CASE WHEN COALESCE(is_return, 0) = 1 THEN 'PURCHASE RETURN' ELSE 'PURCHASE BILL' END as category,
               COALESCE(vendor_name, 'LOCAL CASH VENDOR') as party_name, paid_cash, paid_bank, COALESCE(is_return, 0) as is_return
        FROM purchases WHERE ${purLogCond} AND (paid_cash > 0 OR paid_bank > 0)
        ORDER BY id DESC LIMIT 200
      `).all(...logParams);

      purs.forEach(pu => {
        if (pu.paid_cash > 0) liquidityLog.push({ date: pu.date, time: pu.time, ref_no: pu.ref_no, account: 'CASH', category: pu.category, flow: pu.is_return === 1 ? 'IN' : 'OUT', party_name: pu.party_name, amount: pu.paid_cash, description: 'Purchase Cash' });
        if (pu.paid_bank > 0) liquidityLog.push({ date: pu.date, time: pu.time, ref_no: pu.ref_no, account: 'BANK', category: pu.category, flow: pu.is_return === 1 ? 'IN' : 'OUT', party_name: pu.party_name, amount: pu.paid_bank, description: 'Purchase Bank' });
      });
    } catch(e) {}
  }

  if (allTables.includes('account_transactions')) {
    try {
      const actLogCond = isAllTime ? "1=1" : "date(entry_date) BETWEEN ? AND ?";
      const acts = db.prepare(`
        SELECT entry_date as date, reference_no as ref_no, account_type as account, flow, category, description, amount
        FROM account_transactions WHERE ${actLogCond}
        ORDER BY id DESC LIMIT 200
      `).all(...logParams);

      acts.forEach(ac => {
        let catLabel = ac.category;
        if (ac.category === 'SALARY') catLabel = 'STAFF SALARY';
        else if (ac.category === 'UTILITY') catLabel = 'UTILITY BILL';
        else if (ac.category === 'EXPENSE') catLabel = 'PETTY EXPENSE';
        else if (ac.category === 'CASH_FROM_EMP') catLabel = 'BORROWED CASH';
        else if (ac.category === 'TRANSFER') catLabel = 'FUND TRANSFER';

        liquidityLog.push({ date: ac.date, time: '', ref_no: ac.ref_no || ('TR-' + ac.category), account: ac.account, category: catLabel, flow: ac.flow, party_name: ac.description || ac.category, amount: ac.amount, description: ac.description || ac.category });
      });
    } catch(e) {}
  }

  liquidityLog.sort((a, b) => (b.date + ' ' + (b.time||'')).localeCompare(a.date + ' ' + (a.time||'')));

  return {
    initialCash: initCash,
    initialBank: initBank,
    openingCash: openingCash,
    openingBank: openingBank,
    cashInHand: closingCash,
    bankBalance: closingBank,
    log: liquidityLog
  };
}

// MASTER ANALYTICS & AUDIT REPORTS
router.get('/analytics', (req, res) => {
  try {
    const from = req.query.from || '2020-01-01';
    const to = req.query.to || '2099-12-31';
    const isAllTime = (from <= '2020-01-01' && to >= '2099-01-01');

    const allTables = getTables();
    const purchCols = allTables.includes('purchases') ? getCols('purchases') : [];
    const partyCols = allTables.includes('parties') ? getCols('parties') : [];

    const pAmt = purchCols.includes('total_amount') ? 'total_amount' : (purchCols.includes('grand_total') ? 'grand_total' : '0');
    const pSub = purchCols.includes('subtotal') ? 'subtotal' : `(${pAmt} / 1.15)`;
    const pVat = purchCols.includes('vat_amount') ? 'vat_amount' : (purchCols.includes('vat_total') ? 'vat_total' : `(${pAmt} - (${pAmt} / 1.15))`);
    const pDate = purchCols.includes('purchase_date') ? 'purchase_date' : (purchCols.includes('created_at') ? 'created_at' : 'date');
    const pCash = purchCols.includes('paid_cash') ? 'paid_cash' : `(CASE WHEN payment_mode = 'CASH' THEN ${pAmt} ELSE 0 END)`;
    const pBank = purchCols.includes('paid_bank') ? 'paid_bank' : `(CASE WHEN payment_mode = 'BANK' THEN ${pAmt} ELSE 0 END)`;
    const pCredit = purchCols.includes('paid_credit') ? 'paid_credit' : `(CASE WHEN payment_mode = 'CREDIT' THEN ${pAmt} ELSE 0 END)`;
    const pVendName = purchCols.includes('vendor_name') ? 'pur.vendor_name' : 'p.name_en';
    const pInv = purchCols.includes('bill_number') ? 'bill_number' : (purchCols.includes('purchase_no') ? 'purchase_no' : "'PUR-' || pur.id");
    const pTypeCol = partyCols.includes('type') ? 'type' : (partyCols.includes('party_type') ? 'party_type' : null);

    let storeInfo = {};
    try { storeInfo = db.prepare('SELECT company_name_en, company_name_ar, vat_number, cr_number, phone, address_en, address_ar FROM settings LIMIT 1').get() || {}; } catch(e) {}

    let salesSummary = { gross_sales: 0, gross_base: 0, gross_vat: 0, cash_sales: 0, bank_sales: 0, credit_sales: 0, return_sales: 0, return_base: 0, return_vat: 0, net_sales: 0 };
    let salesReport = [];
    let salesReturnReport = [];

    if (allTables.includes('invoices')) {
      const invDateCond = isAllTime ? "1=1" : "substr(COALESCE(inv.invoice_date, date('now')), 1, 10) BETWEEN ? AND ?";
      const invParams = isAllTime ? [] : [from, to];
      try {
        const sSum = db.prepare(`
          SELECT 
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 0 THEN total_amount ELSE 0 END), 0) as gross_sales,
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 0 THEN subtotal ELSE 0 END), 0) as gross_base,
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 0 THEN vat_amount ELSE 0 END), 0) as gross_vat,
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 0 THEN paid_cash ELSE 0 END), 0) as cash_sales,
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 0 THEN paid_bank ELSE 0 END), 0) as bank_sales,
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 0 THEN paid_credit ELSE 0 END), 0) as credit_sales,
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 1 THEN total_amount ELSE 0 END), 0) as return_sales,
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 1 THEN subtotal ELSE 0 END), 0) as return_base,
            COALESCE(SUM(CASE WHEN COALESCE(is_return, 0) = 1 THEN vat_amount ELSE 0 END), 0) as return_vat
          FROM invoices inv WHERE ${invDateCond}
        `).get(...invParams);
        if (sSum) { salesSummary = sSum; salesSummary.net_sales = salesSummary.gross_sales - salesSummary.return_sales; }

        salesReport = db.prepare(`
          SELECT inv.id, inv.invoice_no, COALESCE(inv.invoice_date, date('now')) as invoice_date, COALESCE(inv.invoice_time, '') as invoice_time,
                 COALESCE(inv.customer_name, 'WALK-IN CUSTOMER') as party_name, COALESCE(inv.customer_vat, p.vat_number, '—') as vat_number,
                 COALESCE(inv.payment_method, 'CASH') as payment_type, inv.subtotal as base_amount, inv.vat_amount, inv.total_amount,
                 inv.paid_cash, inv.paid_bank, inv.paid_credit, COALESCE(inv.is_return, 0) as is_return, inv.return_ref_no
          FROM invoices inv LEFT JOIN parties p ON inv.party_id = p.id WHERE ${invDateCond} ORDER BY inv.id DESC LIMIT 500
        `).all(...invParams);
        salesReturnReport = salesReport.filter(x => x.is_return === 1);
      } catch(e) {}
    }

    let purchSummary = { gross_purch: 0, gross_base: 0, gross_vat: 0, cash_purch: 0, bank_purch: 0, credit_purch: 0, return_purch: 0, return_base: 0, return_vat: 0, net_purch: 0 };
    let purchaseReport = [];
    let purchaseReturnReport = [];
    let vendorPurchases = [];

    if (allTables.includes('purchases')) {
      const purDateCond = isAllTime ? "1=1" : `substr(COALESCE(pur.${pDate}, date('now')), 1, 10) BETWEEN ? AND ?`;
      const purParams = isAllTime ? [] : [from, to];
      try {
        const pSum = db.prepare(`
          SELECT 
            COALESCE(SUM(CASE WHEN COALESCE(pur.is_return, 0) = 0 THEN pur.${pAmt} ELSE 0 END), 0) as gross_purch,
            COALESCE(SUM(CASE WHEN COALESCE(pur.is_return, 0) = 0 THEN pur.${pSub} ELSE 0 END), 0) as gross_base,
            COALESCE(SUM(CASE WHEN COALESCE(pur.is_return, 0) = 0 THEN pur.${pVat} ELSE 0 END), 0) as gross_vat,
            COALESCE(SUM(CASE WHEN COALESCE(pur.is_return, 0) = 0 THEN pur.${pCash} ELSE 0 END), 0) as cash_purch,
            COALESCE(SUM(CASE WHEN COALESCE(pur.is_return, 0) = 0 THEN pur.${pBank} ELSE 0 END), 0) as bank_purch,
            COALESCE(SUM(CASE WHEN COALESCE(pur.is_return, 0) = 0 THEN pur.${pCredit} ELSE 0 END), 0) as credit_purch,
            COALESCE(SUM(CASE WHEN COALESCE(pur.is_return, 0) = 1 THEN pur.${pAmt} ELSE 0 END), 0) as return_purch,
            COALESCE(SUM(CASE WHEN COALESCE(pur.is_return, 0) = 1 THEN pur.${pSub} ELSE 0 END), 0) as return_base,
            COALESCE(SUM(CASE WHEN COALESCE(pur.is_return, 0) = 1 THEN pur.${pVat} ELSE 0 END), 0) as return_vat
          FROM purchases pur WHERE ${purDateCond}
        `).get(...purParams);
        if (pSum) { purchSummary = pSum; purchSummary.net_purch = purchSummary.gross_purch - purchSummary.return_purch; }

        vendorPurchases = db.prepare(`
          SELECT COALESCE(${pVendName}, 'LOCAL CASH VENDOR') as vendor_name, COUNT(pur.id) as bill_count,
                 COALESCE(SUM(CASE WHEN COALESCE(pur.is_return,0)=0 THEN pur.${pAmt} ELSE -pur.${pAmt} END), 0) as total_amt,
                 COALESCE(SUM(pur.${pCash}), 0) as cash_amt, COALESCE(SUM(pur.${pCredit}), 0) as credit_amt
          FROM purchases pur LEFT JOIN parties p ON pur.vendor_id = p.id WHERE ${purDateCond}
          GROUP BY COALESCE(${pVendName}, 'LOCAL CASH VENDOR') ORDER BY total_amt DESC
        `).all(...purParams);

        purchaseReport = db.prepare(`
          SELECT pur.id, pur.${pInv} as invoice_no, COALESCE(pur.${pDate}, date('now')) as purchase_date, COALESCE(pur.purchase_time, '') as purchase_time,
                 COALESCE(${pVendName}, 'LOCAL CASH VENDOR') as party_name, COALESCE(pur.vendor_vat, p.vat_number, '—') as vat_number,
                 COALESCE(pur.payment_mode, 'CASH') as payment_type, pur.${pSub} as base_amount, pur.${pVat} as vat_amount, pur.${pAmt} as total_amount,
                 pur.${pCash} as paid_cash, pur.${pCredit} as paid_credit, COALESCE(pur.is_return, 0) as is_return, pur.return_ref_no
          FROM purchases pur LEFT JOIN parties p ON pur.vendor_id = p.id WHERE ${purDateCond} ORDER BY pur.id DESC LIMIT 500
        `).all(...purParams);
        purchaseReturnReport = purchaseReport.filter(x => x.is_return === 1);
      } catch(e) {}
    }

    let allExpensesGrouped = [];
    let detailedExpenseLog = [];
    let grandTotalExpenses = 0;
    const expParams = isAllTime ? [] : [from, to];

    if (allTables.includes('petty_expenses')) {
      try {
        const pettyWhere = isAllTime ? "1=1" : "substr(COALESCE(expense_date, date('now')), 1, 10) BETWEEN ? AND ?";
        const pCats = db.prepare("SELECT category, COALESCE(SUM(amount), 0) as total_amt, COUNT(*) as count FROM petty_expenses WHERE " + pettyWhere + " GROUP BY category").all(...expParams);
        pCats.forEach(c => { allExpensesGrouped.push({ category: c.category, amount: c.total_amt, count: c.count, type: 'Petty Cash' }); grandTotalExpenses += c.total_amt; });
        detailedExpenseLog.push(...db.prepare("SELECT expense_date as date, category, description, payment_mode, amount FROM petty_expenses WHERE " + pettyWhere + " ORDER BY id DESC LIMIT 50").all(...expParams));
      } catch(e) {}
    }

    if (allTables.includes('utility_transactions')) {
      try {
        const utilWhere = isAllTime ? "ut.type = 'BILL_PAID'" : "ut.type = 'BILL_PAID' AND substr(COALESCE(ut.entry_date, date('now')), 1, 10) BETWEEN ? AND ?";
        const uCats = db.prepare("SELECT u.name_en as category, COALESCE(SUM(ut.amount), 0) as total_amt, COUNT(*) as count FROM utility_transactions ut JOIN utilities u ON ut.utility_id = u.id WHERE " + utilWhere + " GROUP BY u.name_en").all(...expParams);
        uCats.forEach(u => { allExpensesGrouped.push({ category: u.category, amount: u.total_amt, count: u.count, type: 'Utility Bill' }); grandTotalExpenses += u.total_amt; });
        detailedExpenseLog.push(...db.prepare("SELECT ut.entry_date as date, u.name_en as category, ut.description, ut.payment_mode, ut.amount FROM utility_transactions ut JOIN utilities u ON ut.utility_id = u.id WHERE " + utilWhere + " ORDER BY ut.id DESC LIMIT 50").all(...expParams));
      } catch(e) {}
    }

    if (allTables.includes('employee_ledger')) {
      try {
        const salWhere = isAllTime ? "debit > 0 AND entry_type IN ('PAYMENT', 'FINAL_SETTLEMENT', 'ADVANCE')" : "debit > 0 AND entry_type IN ('PAYMENT', 'FINAL_SETTLEMENT', 'ADVANCE') AND substr(COALESCE(entry_date, date('now')), 1, 10) BETWEEN ? AND ?";
        const salPaid = db.prepare("SELECT COALESCE(SUM(debit), 0) as tot, COUNT(*) as count FROM employee_ledger WHERE " + salWhere).get(...expParams);
        if (salPaid && salPaid.tot > 0) { allExpensesGrouped.push({ category: 'STAFF SALARIES & ADVANCES PAID', amount: salPaid.tot, count: salPaid.count, type: 'Payroll' }); grandTotalExpenses += salPaid.tot; }
      } catch(e) {}
    }

    let totalCustDebt = 0, custDebtorsList = [];
    let totalVendPayable = 0, vendorPayablesList = [];
    if (allTables.includes('parties')) {
      try {
        const custCond = pTypeCol ? `LOWER(${pTypeCol}) = 'customer'` : "1=1";
        totalCustDebt = db.prepare(`SELECT COALESCE(SUM(current_balance), 0) as tot FROM parties WHERE ${custCond} AND current_balance > 0`).get().tot;
        custDebtorsList = db.prepare(`SELECT id, name_en, name_ar, phone, current_balance, credit_limit FROM parties WHERE ${custCond} AND current_balance > 0 ORDER BY current_balance DESC`).all();

        const vendCond = pTypeCol ? `(LOWER(${pTypeCol}) = 'vendor' OR LOWER(${pTypeCol}) = 'supplier')` : "1=1";
        totalVendPayable = db.prepare(`SELECT COALESCE(SUM(current_balance), 0) as tot FROM parties WHERE ${vendCond} AND current_balance > 0`).get().tot;
        vendorPayablesList = db.prepare(`SELECT id, name_en, name_ar, phone, current_balance FROM parties WHERE ${vendCond} AND current_balance > 0 ORDER BY current_balance DESC`).all();
      } catch(e) {}
    }

    let pendingSalariesList = [], totalPendingSal = 0;
    if (allTables.includes('employees')) {
      try {
        pendingSalariesList = db.prepare("SELECT id, name_en, phone, monthly_salary, current_balance FROM employees WHERE LOWER(status) = 'active' AND current_balance > 0").all();
        totalPendingSal = pendingSalariesList.reduce((acc, x) => acc + (x.current_balance || 0), 0);
      } catch(e) {}
    }

    let pendingUtilitiesList = [], totalPendingUtil = 0;
    if (allTables.includes('utilities')) {
      try {
        pendingUtilitiesList = db.prepare("SELECT id, name_en, category, account_no, current_due FROM utilities WHERE current_due > 0").all();
        totalPendingUtil = pendingUtilitiesList.reduce((acc, x) => acc + (x.current_due || 0), 0);
      } catch(e) {}
    }

    let liquidity = { initialCash: 0, initialBank: 0, openingCash: 0, openingBank: 0, cashInHand: 0, bankBalance: 0, log: [] };
    try { liquidity = getAccountLiquidity(from, to, isAllTime); } catch(e) {}

    const netOutputVat = Math.max(0, salesSummary.gross_vat - salesSummary.return_vat);
    const netInputVat = Math.max(0, purchSummary.gross_vat - purchSummary.return_vat);
    const netVatPayable = netOutputVat - netInputVat;

    res.json({
      success: true,
      data: {
        filter: { from, to, isAllTime },
        store: storeInfo,
        sales: { summary: salesSummary, list: salesReport },
        salesReturn: { list: salesReturnReport },
        purchases: { summary: purchSummary, vendors: vendorPurchases, list: purchaseReport },
        purchasesReturn: { list: purchaseReturnReport },
        expenses: { total: grandTotalExpenses, list: allExpensesGrouped, log: detailedExpenseLog },
        customers: { totalDebt: totalCustDebt, list: custDebtorsList },
        vendors: { totalPayable: totalVendPayable, list: vendorPayablesList },
        liabilities: {
          total: totalPendingSal + totalPendingUtil,
          salariesTotal: totalPendingSal,
          salariesList: pendingSalariesList,
          utilitiesTotal: totalPendingUtil,
          utilitiesList: pendingUtilitiesList
        },
        liquidity: liquidity,
        zatca: {
          salesBase: salesSummary.gross_base,
          salesVat: salesSummary.gross_vat,
          salesRetBase: salesSummary.return_base,
          salesRetVat: salesSummary.return_vat,
          netOutputVat: netOutputVat,
          purchBase: purchSummary.gross_base,
          purchVat: purchSummary.gross_vat,
          purchRetBase: purchSummary.return_base,
          purchRetVat: purchSummary.return_vat,
          netInputVat: netInputVat,
          netVatPayable: netVatPayable
        }
      }
    });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/transfer-fund', (req, res) => {
  const { type, amount, entry_date, description } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ success: false, error: 'Enter valid transfer amount' });
  const dateStr = entry_date || new Date().toISOString().slice(0, 10);
  const note = description ? description.trim() : (type === 'DEPOSIT' ? 'Cash Deposited to Bank' : 'Cash Withdrawn from Bank');

  try {
    db.transaction(() => {
      if (type === 'DEPOSIT') {
        db.prepare("INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_no, description) VALUES (?, 'CASH', 'OUT', ?, 'TRANSFER', 'TR-DEP', ?)").run(dateStr, amt, note);
        db.prepare("INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_no, description) VALUES (?, 'BANK', 'IN', ?, 'TRANSFER', 'TR-DEP', ?)").run(dateStr, amt, note);
      } else {
        db.prepare("INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_no, description) VALUES (?, 'BANK', 'OUT', ?, 'TRANSFER', 'TR-WTH', ?)").run(dateStr, amt, note);
        db.prepare("INSERT INTO account_transactions (entry_date, account_type, flow, amount, category, reference_no, description) VALUES (?, 'CASH', 'IN', ?, 'TRANSFER', 'TR-WTH', ?)").run(dateStr, amt, note);
      }
    })();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/opening-balance', (req, res) => {
  const { initial_cash, initial_bank } = req.body;
  try {
    db.prepare('UPDATE settings SET initial_cash = ?, initial_bank = ? WHERE id = 1').run(parseFloat(initial_cash) || 0, parseFloat(initial_bank) || 0);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;