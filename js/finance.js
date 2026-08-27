// js/finance.js – School Finance Page logic
import { getCurrentSchoolId, initAdminPage, getCurrentUserData } from './admin.js';
import {
  getCurrentSession,
  getCurrentTerm,
  getAcademicCalendar,
  subscribeToCalendar,
  calculateTermAndSessionFromDate
} from './academic-calendar.js';
import { db } from './firebase-config.js';
import {
  collection, doc, getDoc, getDocs, query, where, orderBy,
  setDoc, updateDoc, addDoc, serverTimestamp, writeBatch,
  arrayUnion, arrayRemove
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { toast } from './error-handler.js';
import { sanitizeSession } from './service.js';

// ─── Existing helper: totalOwed ───────────────────────
function totalOwed(feeData) {
  if (!feeData) return 0;
  return (feeData.amount || 0) + (feeData.openingBalance || 0);
}

// ─── Shared bulk recalc (unchanged) ──────────────────
async function recalculateAllFeeGates(term, session) {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  const studentsSnap = await getDocs(query(collection(db, 'students'),
    where('schoolId', '==', schoolId), where('status', '==', 'active')));
  for (const s of studentsSnap.docs) {
    await recalculateFeeGateStatus(schoolId, s.id, term, session);
  }
}

// ─── Finance Page Init ──────────────────────────────────
export async function initFinancePage() {
  await initAdminPage(async () => {
    // Academic badge with rollover detection (FIX 7a)
    let lastKnownPeriod = null;
    subscribeToCalendar(async (state) => {
      const termEl = document.getElementById('currentTermDisplay');
      const sessionEl = document.getElementById('currentSessionDisplay');
      if (termEl) termEl.textContent = state.currentTerm || '—';
      if (sessionEl) sessionEl.textContent = state.currentSession || '—';
      if (state.manualOverride) termEl?.classList.add('override-badge');
      else termEl?.classList.remove('override-badge');

      const currentPeriod = `${state.currentTerm}||${state.currentSession}`;
      if (lastKnownPeriod && lastKnownPeriod !== currentPeriod && state.currentTerm && state.currentSession) {
        toast.info('New term detected — recalculating fee status for all students...');
        await recalculateAllFeeGates(state.currentTerm, state.currentSession);
      }
      lastKnownPeriod = currentPeriod;
    });

    await populateSessionSelects();
    await populateIncomeExpenseSessionSelects(); // NEW: populate session dropdowns for expense/income forms
    await loadClassesDropdown();
    await loadStudentLookupDropdown();
    await loadSummaryCards();
    await loadIncomeExpenseSummaryCards(); // NEW: load other income/expense totals
    await loadFeeGateState();

    // ─── Event listeners ──────────────────────────────
    document.getElementById('refreshFinanceBtn').addEventListener('click', refreshClassFeeTable);
    document.getElementById('financeClassSelect').addEventListener('change', refreshClassFeeTable);
    document.getElementById('financeTermSelect').addEventListener('change', refreshClassFeeTable);
    document.getElementById('financeSessionSelect').addEventListener('change', refreshClassFeeTable);
    document.getElementById('statusFilterSelect').addEventListener('change', refreshClassFeeTable);

    document.getElementById('lookupStudentBtn').addEventListener('click', lookupStudentFee);

    // FIX 2a: carry studentId in payment modal
    document.getElementById('recordPaymentBtn').addEventListener('click', () => {
      document.getElementById('editPaymentId').value = '';
      document.getElementById('paymentModalTitle').innerHTML = '<i class="fa-solid fa-money-bill-wave"></i> Record Payment';
      document.getElementById('savePaymentBtn').textContent = 'Save Payment';
      document.getElementById('paymentAmount').value = '';
      document.getElementById('paymentDate').valueAsDate = new Date();
      document.getElementById('paymentMethod').value = 'cash';
      document.getElementById('paymentNote').value = '';
      document.getElementById('paymentForm').dataset.studentId = document.getElementById('recordPaymentBtn').dataset.studentId || '';
      updatePaymentTermDisplay(new Date());
      document.getElementById('paymentModal').style.display = 'flex';
    });

    document.getElementById('paymentDate').addEventListener('change', (e) => {
      const date = new Date(e.target.value);
      updatePaymentTermDisplay(date);
    });

    document.getElementById('bulkPaymentBtn').addEventListener('click', () => {
      const container = document.getElementById('bulkPaymentRows');
      container.innerHTML = '';
      addBulkRow();
      document.getElementById('bulkPaymentModal').style.display = 'flex';
    });

    document.getElementById('addBulkRowBtn').addEventListener('click', addBulkRow);
    document.getElementById('bulkPaymentForm').addEventListener('submit', handleBulkPayments);

    document.getElementById('bulkSetClassFeeBtn').addEventListener('click', () => {
      const classId = document.getElementById('financeClassSelect').value;
      if (!classId) { toast.error('Select a class first.'); return; }
      const className = document.getElementById('financeClassSelect').selectedOptions[0]?.textContent || 'Class';
      document.getElementById('bulkClassFeeClassName').value = className;
      document.getElementById('bulkSetClassFeeForm').dataset.classId = classId;
      document.getElementById('bulkSetClassFeeModal').style.display = 'flex';
    });

    document.getElementById('bulkSetClassFeeForm').addEventListener('submit', handleBulkSetClassFee);

    document.getElementById('feeGateToggle').addEventListener('change', handleFeeGateToggle);

    // FIX 7c: Recalculate All button
    document.getElementById('recalcAllGatesBtn').addEventListener('click', async () => {
      const btn = document.getElementById('recalcAllGatesBtn');
      btn.disabled = true;
      btn.textContent = 'Recalculating...';
      try {
        await recalculateAllFeeGates(getCurrentTerm(), getCurrentSession());
        toast.success('Fee status recalculated for all students.');
      } catch (err) {
        console.error('Manual recalc error:', err);
        toast.error('Recalculation failed.');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Recalculate All Now';
      }
    });

    // Modal close handlers (same)
    document.querySelectorAll('.close-modal, [data-modal-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.modal').style.display = 'none';
      });
    });
    document.querySelectorAll('.modal').forEach(m => {
      m.addEventListener('click', (e) => {
        if (e.target === m) m.style.display = 'none';
      });
    });

    document.getElementById('setFeeForm').addEventListener('submit', saveFee);
    document.getElementById('paymentForm').addEventListener('submit', handlePaymentSubmit);
    document.getElementById('loadHistoryBtn').addEventListener('click', loadFinancialHistory);
    document.getElementById('downloadHistoryPdfBtn').addEventListener('click', downloadHistoryPdf);
    document.getElementById('editSummaryForm').addEventListener('submit', saveSummary);

    document.getElementById('saveOpeningBalanceBtn').addEventListener('click', handleOpeningBalance);
    document.getElementById('importCsvBtn').addEventListener('click', handleCsvImport);
    document.getElementById('downloadCsvTemplateLink').addEventListener('click', downloadCsvTemplate);

    // NEW: Expense and Income form submissions
    document.getElementById('expenseForm').addEventListener('submit', saveExpense);
    document.getElementById('incomeForm').addEventListener('submit', saveOtherIncome);
    // Manual title overrides dropdown
    document.getElementById('incomeTitleManual').addEventListener('input', (e) => {
      if (e.target.value.trim()) {
        document.getElementById('incomeTitleDropdown').value = '';
      }
    });
    document.getElementById('incomeTitleDropdown').addEventListener('change', (e) => {
      if (e.target.value) {
        document.getElementById('incomeTitleManual').value = '';
      }
    });

    await populateHistorySessionSelect();
    setTimeout(() => loadFinancialHistory(), 500);

    if (document.getElementById('financeClassSelect').value) {
      refreshClassFeeTable();
    }
  });
}

// ─── NEW: Populate session selects for expense/income forms ──
async function populateIncomeExpenseSessionSelects() {
  const schoolId = await getCurrentSchoolId();
  const currentSession = getCurrentSession();
  if (!schoolId) return;
  const sessions = await getKnownFeeSessions(schoolId, currentSession);
  const selects = [document.getElementById('expenseSession'), document.getElementById('incomeSession')];
  selects.forEach(select => {
    if (!select) return;
    select.innerHTML = '';
    sessions.forEach(sess => {
      const opt = document.createElement('option');
      opt.value = sess;
      opt.textContent = sess;
      if (sess === currentSession) opt.selected = true;
      select.appendChild(opt);
    });
    if (select.options.length === 0) {
      const opt = document.createElement('option');
      opt.value = currentSession;
      opt.textContent = currentSession;
      select.appendChild(opt);
    }
  });
  // Set default term to current term
  const currentTerm = getCurrentTerm();
  const termSelects = [document.getElementById('expenseTerm'), document.getElementById('incomeTerm')];
  termSelects.forEach(select => {
    if (select && currentTerm) {
      for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === currentTerm) {
          select.selectedIndex = i;
          break;
        }
      }
    }
  });
}

// ─── NEW: Save Expense ────────────────────────────────
async function saveExpense(e) {
  e.preventDefault();
  const title = document.getElementById('expenseTitle').value.trim();
  const amount = parseFloat(document.getElementById('expenseAmount').value);
  const narration = document.getElementById('expenseNarration').value.trim();
  const date = document.getElementById('expenseDate').value;
  const term = document.getElementById('expenseTerm').value;
  const session = document.getElementById('expenseSession').value;
  if (!title || isNaN(amount) || amount <= 0 || !date || !term || !session) {
    toast.error('Please fill all required fields.');
    return;
  }
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  try {
    await addDoc(collection(db, 'schools', schoolId, 'expenses'), {
      title,
      amount,
      narration,
      date,
      term,
      session,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    toast.success('Expense saved successfully.');
    e.target.reset();
    // Reset term/session to current
    populateIncomeExpenseSessionSelects();
    loadIncomeExpenseSummaryCards();
  } catch (err) {
    console.error('Save expense error:', err);
    toast.error('Failed to save expense.');
  }
}

// ─── NEW: Save Other Income ───────────────────────────
async function saveOtherIncome(e) {
  e.preventDefault();
  const dropdownTitle = document.getElementById('incomeTitleDropdown').value;
  const manualTitle = document.getElementById('incomeTitleManual').value.trim();
  const title = manualTitle || dropdownTitle;
  if (!title) {
    toast.error('Please select or enter a title.');
    return;
  }
  const amount = parseFloat(document.getElementById('incomeAmount').value);
  const narration = document.getElementById('incomeNarration').value.trim();
  const date = document.getElementById('incomeDate').value;
  const term = document.getElementById('incomeTerm').value;
  const session = document.getElementById('incomeSession').value;
  if (isNaN(amount) || amount <= 0 || !date || !term || !session) {
    toast.error('Please fill all required fields.');
    return;
  }
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  try {
    await addDoc(collection(db, 'schools', schoolId, 'otherIncome'), {
      title,
      amount,
      narration,
      date,
      term,
      session,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    toast.success('Other income saved successfully.');
    e.target.reset();
    populateIncomeExpenseSessionSelects();
    loadIncomeExpenseSummaryCards();
  } catch (err) {
    console.error('Save income error:', err);
    toast.error('Failed to save other income.');
  }
}

// ─── NEW: Load Other Income & Expense totals for current term ──
async function loadIncomeExpenseSummaryCards() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  const term = getCurrentTerm();
  const session = getCurrentSession();
  if (!term || !session) return;

  try {
    // Expenses
    const expensesQ = query(collection(db, 'schools', schoolId, 'expenses'),
      where('term', '==', term), where('session', '==', session));
    const expensesSnap = await getDocs(expensesQ);
    let totalExpenses = 0;
    expensesSnap.forEach(d => totalExpenses += d.data().amount || 0);

    // Other Income
    const incomeQ = query(collection(db, 'schools', schoolId, 'otherIncome'),
      where('term', '==', term), where('session', '==', session));
    const incomeSnap = await getDocs(incomeQ);
    let totalIncome = 0;
    incomeSnap.forEach(d => totalIncome += d.data().amount || 0);

    document.getElementById('otherIncomeTerm').textContent = `₦${totalIncome.toLocaleString()}`;
    document.getElementById('expensesTerm').textContent = `₦${totalExpenses.toLocaleString()}`;
    document.getElementById('netPositionTerm').textContent = `₦${(totalIncome - totalExpenses).toLocaleString()}`;
  } catch (err) {
    console.error('Load income/expense summary error:', err);
    toast.warning('Could not load income/expense totals.');
  }
}

// ─── Modifications to loadFinancialHistory to include income/expenses ──
async function loadFinancialHistory() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) {
    toast.error('School ID not found.');
    return;
  }
  const selectedSession = document.getElementById('historySessionSelect').value;

  try {
    // Existing student fee history loading (unchanged)
    const studentsQ = query(collection(db, 'students'), where('schoolId', '==', schoolId), where('status', '==', 'active'));
    const studentsSnap = await getDocs(studentsQ);
    const students = [];
    studentsSnap.forEach(d => students.push({ id: d.id, name: d.data().name || 'Unnamed' }));

    let totalFees = 0;
    let totalPaid = 0;
    let totalArrears = 0;
    const tableBody = document.getElementById('historyTableBody');

    if (students.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="4">No students found.</td></tr>';
      document.getElementById('historyTotalFees').textContent = '₦0';
      document.getElementById('historyTotalPaid').textContent = '₦0';
      document.getElementById('historyTotalArrears').textContent = '₦0';
    } else {
      const rows = [];
      for (const student of students) {
        let fee = 0, paid = 0;

        const feesQ = selectedSession === 'all'
          ? query(collection(db, 'schools', schoolId, 'fees'), where('studentId', '==', student.id))
          : query(collection(db, 'schools', schoolId, 'fees'), where('studentId', '==', student.id), where('session', '==', selectedSession));
        const feesSnap = await getDocs(feesQ);
        for (const feeDoc of feesSnap.docs) {
          const feeData = feeDoc.data();
          fee += totalOwed(feeData);
          const paymentsQ = query(collection(feeDoc.ref, 'payments'));
          const paymentsSnap = await getDocs(paymentsQ);
          paymentsSnap.forEach(pd => {
            if (!pd.data().voided) paid += pd.data().amount || 0;
          });
        }

        const arrears = Math.max(0, fee - paid);
        totalFees += fee;
        totalPaid += paid;
        totalArrears += arrears;
        rows.push({ studentId: student.id, name: student.name, fee, paid, arrears });
      }

      document.getElementById('historyTotalFees').textContent = `₦${totalFees.toLocaleString()}`;
      document.getElementById('historyTotalPaid').textContent = `₦${totalPaid.toLocaleString()}`;
      document.getElementById('historyTotalArrears').textContent = `₦${totalArrears.toLocaleString()}`;

      if (rows.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="4">No data for this session.</td></tr>';
      } else {
        let html = '';
        rows.forEach(r => {
          html += `<tr>
            <td>${r.name}</td>
            <td>₦${r.fee.toLocaleString()}</td>
            <td>₦${r.paid.toLocaleString()}</td>
            <td>₦${r.arrears.toLocaleString()}</td>
          </tr>`;
        });
        tableBody.innerHTML = html;
      }
    }

    // NEW: Load income and expenses for the selected session
    await loadIncomeExpenseHistory(schoolId, selectedSession);
  } catch (err) {
    console.error('Load history error:', err);
    toast.error('Failed to load financial history.');
  }
}

// ─── Helper to load income/expense records into history table ──
async function loadIncomeExpenseHistory(schoolId, sessionFilter) {
  const tableBody = document.getElementById('incomeExpenseHistoryBody');
  if (!tableBody) return;
  tableBody.innerHTML = '<tr><td colspan="5">Loading records...</td></tr>';

  try {
    const expensesQ = sessionFilter === 'all'
      ? collection(db, 'schools', schoolId, 'expenses')
      : query(collection(db, 'schools', schoolId, 'expenses'), where('session', '==', sessionFilter));
    const incomeQ = sessionFilter === 'all'
      ? collection(db, 'schools', schoolId, 'otherIncome')
      : query(collection(db, 'schools', schoolId, 'otherIncome'), where('session', '==', sessionFilter));

    const [expensesSnap, incomeSnap] = await Promise.all([getDocs(expensesQ), getDocs(incomeQ)]);

    const records = [];
    expensesSnap.forEach(doc => {
      const data = doc.data();
      records.push({ type: 'Expense', title: data.title, amount: data.amount, date: data.date, narration: data.narration || '' });
    });
    incomeSnap.forEach(doc => {
      const data = doc.data();
      records.push({ type: 'Income', title: data.title, amount: data.amount, date: data.date, narration: data.narration || '' });
    });

    // Sort by date
    records.sort((a, b) => new Date(a.date) - new Date(b.date));

    if (records.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="5">No income/expense records for this session.</td></tr>';
      return;
    }

    let html = '';
    records.forEach(r => {
      html += `<tr>
        <td>${r.type}</td>
        <td>${r.title}</td>
        <td>₦${r.amount.toLocaleString()}</td>
        <td>${r.date}</td>
        <td>${r.narration}</td>
      </tr>`;
    });
    tableBody.innerHTML = html;
  } catch (err) {
    console.error('Load income/expense history error:', err);
    tableBody.innerHTML = '<tr><td colspan="5">Error loading records.</td></tr>';
  }
}

// ─── downloadHistoryPdf (unchanged) ──────────────────
function downloadHistoryPdf() {
  window.print();
}

// ... (all other existing functions remain identical)