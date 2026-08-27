// js/financeReportRenderer.js – Render financial report for download/print
import { db } from './firebase-config.js';
import {
  collection, getDocs, query, where
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

// Helper to calculate total owed from fee data
function totalOwed(feeData) {
  if (!feeData) return 0;
  return (feeData.amount || 0) + (feeData.openingBalance || 0);
}

/**
 * Generates a clean A4-friendly financial report and opens it for printing.
 * @param {string} schoolId - The school ID.
 * @param {string} sessionFilter - 'all' or a specific session string.
 */
export async function renderFinanceReport(schoolId, sessionFilter) {
  try {
    // 1. Gather data from Firestore
    //    - Total School Fees Paid (from payments under fees)
    //    - Other Income records
    //    - Expenses records

    // Get all fees for this school (all sessions) or filtered by session
    const feesQ = sessionFilter === 'all'
      ? collection(db, 'schools', schoolId, 'fees')
      : query(collection(db, 'schools', schoolId, 'fees'), where('session', '==', sessionFilter));
    const feesSnap = await getDocs(feesQ);

    // Accumulate total fees paid (only non-voided payments)
    let totalSchoolFeesPaid = 0;
    for (const feeDoc of feesSnap.docs) {
      const paymentsSnap = await getDocs(collection(feeDoc.ref, 'payments'));
      paymentsSnap.forEach(p => {
        if (!p.data().voided) totalSchoolFeesPaid += p.data().amount || 0;
      });
    }

    // Other income
    const incomeQ = sessionFilter === 'all'
      ? collection(db, 'schools', schoolId, 'otherIncome')
      : query(collection(db, 'schools', schoolId, 'otherIncome'), where('session', '==', sessionFilter));
    const incomeSnap = await getDocs(incomeQ);
    const incomeRecords = [];
    incomeSnap.forEach(doc => {
      const data = doc.data();
      incomeRecords.push({ title: data.title, amount: data.amount || 0, date: data.date || '' });
    });

    // Expenses
    const expensesQ = sessionFilter === 'all'
      ? collection(db, 'schools', schoolId, 'expenses')
      : query(collection(db, 'schools', schoolId, 'expenses'), where('session', '==', sessionFilter));
    const expensesSnap = await getDocs(expensesQ);
    const expenseRecords = [];
    expensesSnap.forEach(doc => {
      const data = doc.data();
      expenseRecords.push({ title: data.title, amount: data.amount || 0, date: data.date || '' });
    });

    // Calculate totals
    const totalOtherIncome = incomeRecords.reduce((sum, r) => sum + r.amount, 0);
    const totalExpenses = expenseRecords.reduce((sum, r) => sum + r.amount, 0);
    const totalIncome = totalSchoolFeesPaid + totalOtherIncome;
    const balance = totalIncome - totalExpenses;

    // 2. Build HTML report (A4-friendly)
    const reportTitle = sessionFilter === 'all'
      ? 'All Sessions Financial Report'
      : `Financial Report for ${sessionFilter}`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>${reportTitle}</title>
        <style>
          @page {
            size: A4;
            margin: 15mm;
          }
          body {
            font-family: 'Arial', sans-serif;
            font-size: 10pt;
            color: #333;
            margin: 0;
            padding: 0;
          }
          h1 {
            text-align: center;
            font-size: 14pt;
            margin: 0 0 10px 0;
          }
          .section-title {
            font-size: 12pt;
            font-weight: bold;
            margin: 15px 0 5px 0;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 10px;
          }
          th, td {
            border: 1px solid #ccc;
            padding: 4px 6px;
            text-align: left;
            font-size: 9pt;
          }
          th {
            background-color: #f0f0f0;
            font-weight: bold;
          }
          .total-row td {
            font-weight: bold;
            background-color: #f9f9f9;
          }
          .balance-row td {
            font-weight: bold;
            background-color: #eaf4ff;
            font-size: 10pt;
          }
          .text-right { text-align: right; }
          .footer {
            margin-top: 20px;
            font-size: 8pt;
            text-align: center;
            color: #666;
          }
        </style>
      </head>
      <body>
        <h1>${reportTitle}</h1>

        <!-- School Fees Paid Section -->
        <div class="section-title">1. School Fees Income</div>
        <table>
          <thead>
            <tr><th>Description</th><th class="text-right">Amount (₦)</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Total School Fees Paid</td>
              <td class="text-right">₦${totalSchoolFeesPaid.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>

        <!-- Other Income Section -->
        <div class="section-title">2. Other Income</div>
        <table>
          <thead>
            <tr><th>Title</th><th>Date</th><th class="text-right">Amount (₦)</th></tr>
          </thead>
          <tbody>
            ${incomeRecords.length === 0
              ? '<tr><td colspan="3">No other income records found.</td></tr>'
              : incomeRecords.map(r => `
                <tr>
                  <td>${r.title || '—'}</td>
                  <td>${r.date || '—'}</td>
                  <td class="text-right">₦${r.amount.toLocaleString()}</td>
                </tr>`).join('')}
            <tr class="total-row">
              <td colspan="2">Total Other Income</td>
              <td class="text-right">₦${totalOtherIncome.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>

        <!-- Expenses Section -->
        <div class="section-title">3. Expenses</div>
        <table>
          <thead>
            <tr><th>Title</th><th>Date</th><th class="text-right">Amount (₦)</th></tr>
          </thead>
          <tbody>
            ${expenseRecords.length === 0
              ? '<tr><td colspan="3">No expense records found.</td></tr>'
              : expenseRecords.map(r => `
                <tr>
                  <td>${r.title || '—'}</td>
                  <td>${r.date || '—'}</td>
                  <td class="text-right">₦${r.amount.toLocaleString()}</td>
                </tr>`).join('')}
            <tr class="total-row">
              <td colspan="2">Total Expenses</td>
              <td class="text-right">₦${totalExpenses.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>

        <!-- Summary / Balance -->
        <div class="section-title">4. Summary</div>
        <table>
          <tbody>
            <tr>
              <td>Total Income (School Fees + Other Income)</td>
              <td class="text-right">₦${totalIncome.toLocaleString()}</td>
            </tr>
            <tr>
              <td>Total Expenses</td>
              <td class="text-right">₦${totalExpenses.toLocaleString()}</td>
            </tr>
            <tr class="balance-row">
              <td>Net Balance</td>
              <td class="text-right">₦${balance.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>

        <div class="footer">
          Generated by Acadex on ${new Date().toLocaleString()}
        </div>
      </body>
      </html>
    `;

    // 3. Open in new window and trigger print
    const printWindow = window.open('', '_blank', 'width=800,height=600');
    if (!printWindow) {
      alert('Please allow pop-ups to download the report.');
      return;
    }
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    // Wait for content to load then print
    printWindow.onload = () => {
      printWindow.print();
    };
  } catch (err) {
    console.error('Error generating finance report:', err);
    alert('Failed to generate report. Please try again.');
  }
}