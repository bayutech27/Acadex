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

// ─── Helper: totalOwed ───────────────────────────
function totalOwed(feeData) {
  if (!feeData) return 0;
  return (feeData.amount || 0) + (feeData.openingBalance || 0);
}

// ─── Shared bulk recalc ─────────────────────────
async function recalculateAllFeeGates(term, session) {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  const studentsSnap = await getDocs(query(collection(db, 'students'),
    where('schoolId', '==', schoolId), where('status', '==', 'active')));
  for (const s of studentsSnap.docs) {
    await recalculateFeeGateStatus(schoolId, s.id, term, session);
  }
}

// ─── Finance Page Init ──────────────────────────────
export async function initFinancePage() {
  await initAdminPage(async () => {
    // Academic badge with rollover detection
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
    await populateIncomeExpenseSessionSelects();
    await loadClassesDropdown();
    await loadStudentLookupDropdown();
    await loadSummaryCards();
    await loadIncomeExpenseSummaryCards();
    await loadFeeGateState();

    // ─── Event listeners ──────────────────────────────
    document.getElementById('refreshFinanceBtn').addEventListener('click', refreshClassFeeTable);
    document.getElementById('financeClassSelect').addEventListener('change', refreshClassFeeTable);
    document.getElementById('financeTermSelect').addEventListener('change', refreshClassFeeTable);
    document.getElementById('financeSessionSelect').addEventListener('change', refreshClassFeeTable);
    document.getElementById('statusFilterSelect').addEventListener('change', refreshClassFeeTable);

    document.getElementById('lookupStudentBtn').addEventListener('click', lookupStudentFee);

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
      addBulkRow(); // Now defined below
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

    // Modal close handlers
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

    // Expense and Income form submissions
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

// ─── Function: addBulkRow (was missing) ─────────────────
function addBulkRow() {
  const container = document.getElementById('bulkPaymentRows');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'bulk-payment-row';
  row.innerHTML = `
    <input type="date" class="bulk-date" required placeholder="Date" />
    <input type="number" class="bulk-amount" required placeholder="Amount" min="0" step="100" />
    <select class="bulk-method">
      <option value="cash">Cash</option>
      <option value="transfer">Transfer</option>
      <option value="paystack">Paystack</option>
      <option value="other">Other</option>
    </select>
    <input type="text" class="bulk-note" placeholder="Note (optional)" />
    <button type="button" class="btn-remove-row" title="Remove row"><i class="fa-solid fa-xmark"></i></button>
  `;
  row.querySelector('.btn-remove-row').addEventListener('click', () => {
    if (container.children.length > 1) {
      row.remove();
    } else {
      toast.warning('At least one row is required.');
    }
  });
  container.appendChild(row);
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
    populateIncomeExpenseSessionSelects();
    await refreshIncomeExpenseCards();
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
    await refreshIncomeExpenseCards();
  } catch (err) {
    console.error('Save income error:', err);
    toast.error('Failed to save other income.');
  }
}

// ─── Helper to refresh income/expense cards ─────────
async function refreshIncomeExpenseCards() {
  await loadSummaryCards();
  await loadIncomeExpenseSummaryCards();
}

// ─── Load Income & Expense totals, including Gross Balance ──
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
    let totalOtherIncome = 0;
    incomeSnap.forEach(d => totalOtherIncome += d.data().amount || 0);

    // Get total school fees paid (this term) from DOM
    const totalPaidTermText = document.getElementById('totalFeesPaidTerm').textContent.replace(/[₦,]/g, '');
    const totalPaidTerm = parseFloat(totalPaidTermText) || 0;

    const grossIncome = totalPaidTerm + totalOtherIncome;
    const grossBalance = grossIncome - totalExpenses;

    document.getElementById('otherIncomeTerm').textContent = `₦${totalOtherIncome.toLocaleString()}`;
    document.getElementById('expensesTerm').textContent = `₦${totalExpenses.toLocaleString()}`;
    document.getElementById('grossBalanceTerm').textContent = `₦${grossBalance.toLocaleString()}`;
    document.getElementById('grossIncomeSubtext').textContent = `Gross Income: ₦${grossIncome.toLocaleString()}`;
  } catch (err) {
    console.error('Load income/expense summary error:', err);
    toast.warning('Could not load income/expense totals.');
  }
}

// ─── loadSummaryCards (modified for new cards) ──
async function loadSummaryCards() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) { toast.error('School ID not found.'); return; }
  const term = getCurrentTerm();
  const session = getCurrentSession();
  if (!term || !session) { toast.warning('Could not determine current term/session.'); return; }

  try {
    const studentsQ = query(collection(db, 'students'),
      where('schoolId', '==', schoolId), where('status', '==', 'active'));
    const studentsSnap = await getDocs(studentsQ);
    const studentIds = studentsSnap.docs.map(d => d.id);

    const ALL_TERMS = ['First Term', 'Second Term', 'Third Term'];
    const safeSession = sanitizeSession(session);

    let totalExpectedTerm = 0;
    let totalPaidTerm = 0;
    let totalBroughtForward = 0;

    for (const studentId of studentIds) {
      for (const t of ALL_TERMS) {
        const feeId = `${studentId}_${t}_${safeSession}`;
        const feeRef = doc(db, 'schools', schoolId, 'fees', feeId);
        const feeDoc = await getDoc(feeRef);
        if (!feeDoc.exists()) continue;
        const feeData = feeDoc.data();
        const owed = totalOwed(feeData);
        const paymentsSnap = await getDocs(collection(feeRef, 'payments'));
        let paid = 0;
        paymentsSnap.forEach(p => { if (!p.data().voided) paid += p.data().amount || 0; });

        if (t === term) {
          totalExpectedTerm += owed;
          totalPaidTerm += paid;
        } else {
          // Arrears from previous terms (could be negative if overpaid; clamp to >=0)
          totalBroughtForward += Math.max(0, owed - paid);
        }
      }
    }

    const totalArrearsTerm = totalExpectedTerm - totalPaidTerm;

    document.getElementById('totalFeesExpectedTerm').textContent = `₦${totalExpectedTerm.toLocaleString()}`;
    document.getElementById('totalFeesPaidTerm').textContent = `₦${totalPaidTerm.toLocaleString()}`;
    document.getElementById('totalArrearsTerm').textContent = `₦${totalArrearsTerm.toLocaleString()}`;
    document.getElementById('totalBroughtForward').textContent = `₦${totalBroughtForward.toLocaleString()}`;

  } catch (err) {
    console.error('Load summary cards error:', err);
    toast.error('Could not load summary totals.');
  }
}

// ─── loadFeeGateState (unchanged) ────────────────────
async function loadFeeGateState() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  try {
    const schoolDoc = await getDoc(doc(db, 'schools', schoolId));
    const enabled = schoolDoc.data()?.feeGateEnabled !== false;
    document.getElementById('feeGateToggle').checked = enabled;
  } catch (err) {
    console.error('Load fee gate state error:', err);
    const toggle = document.getElementById('feeGateToggle');
    if (toggle) toggle.checked = true;
  }
}

// ─── handleFeeGateToggle (unchanged) ─────────────────
async function handleFeeGateToggle(e) {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) { toast.error('School ID not found.'); return; }
  const enabled = e.target.checked;
  try {
    await updateDoc(doc(db, 'schools', schoolId), { feeGateEnabled: enabled });
    toast.success(enabled ? 'Fee gating enabled.' : 'Fee gating disabled.');
    await recalculateAllFeeGates(getCurrentTerm(), getCurrentSession());
  } catch (err) {
    console.error('Fee gate toggle error:', err);
    toast.error('Failed to update fee gate setting.');
  }
}

// ─── recalculateFeeGateStatus (unchanged) ────────────
async function recalculateFeeGateStatus(schoolId, studentId, term, session) {
  const schoolDoc = await getDoc(doc(db, 'schools', schoolId));
  const gateEnabled = schoolDoc.data()?.feeGateEnabled !== false;

  const studentRef = doc(db, 'students', studentId);
  const studentDoc = await getDoc(studentRef);
  const studentData = studentDoc.data() || {};

  const safeSession = sanitizeSession(session);
  const periodKey = `${term}_${safeSession}`;

  const setBlocked = async (blocked) => {
    await updateDoc(studentRef, { [`feeGateStatus.${periodKey}`]: blocked });
  };

  if (!gateEnabled || studentData.feeExempt === true) {
    await setBlocked(false);
    return;
  }

  const hasTermExemption = (studentData.feeExemptions || [])
    .some(ex => ex.term === term && ex.session === session);
  if (hasTermExemption) {
    await setBlocked(false);
    return;
  }

  const feeId = `${studentId}_${term}_${safeSession}`;
  const feeRef = doc(db, 'schools', schoolId, 'fees', feeId);
  const feeDoc = await getDoc(feeRef);
  if (!feeDoc.exists()) {
    await setBlocked(false);
    return;
  }
  const amount = totalOwed(feeDoc.data());
  const paymentsSnap = await getDocs(collection(feeRef, 'payments'));
  let paid = 0;
  paymentsSnap.forEach(p => { if (!p.data().voided) paid += p.data().amount || 0; });

  await setBlocked((amount - paid) > 0);
}

// ─── getKnownFeeSessions (unchanged) ─────────────────
async function getKnownFeeSessions(schoolId, currentSession) {
  const sessions = new Set();
  try {
    const feeSnap = await getDocs(collection(db, 'schools', schoolId, 'fees'));
    feeSnap.forEach(doc => {
      const data = doc.data();
      if (data.session) sessions.add(data.session);
    });
  } catch (err) {
    console.error('Get known fee sessions error:', err);
  }
  if (currentSession) sessions.add(currentSession);
  return Array.from(sessions).sort().reverse();
}

// ─── populateSessionSelects (unchanged) ──────────────
async function populateSessionSelects() {
  try {
    const currentSession = getCurrentSession();
    const currentTerm = getCurrentTerm();
    const schoolId = await getCurrentSchoolId();

    const sessionSelects = [
      document.getElementById('financeSessionSelect'),
      document.getElementById('studentLookupSession')
    ];

    const sessions = await getKnownFeeSessions(schoolId, currentSession);
    sessionSelects.forEach(select => {
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

    const termSelects = [
      document.getElementById('financeTermSelect'),
      document.getElementById('studentLookupTerm')
    ];
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
  } catch (err) {
    console.error('Session population error:', err);
    toast.warning('Could not load academic calendar. Using defaults.');
  }
}

// ─── loadClassesDropdown (unchanged) ─────────────────
async function loadClassesDropdown() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  try {
    const q = query(collection(db, 'classes'), where('schoolId', '==', schoolId));
    const snap = await getDocs(q);
    const select = document.getElementById('financeClassSelect');
    select.innerHTML = '<option value="">Select Class</option>';
    snap.forEach(doc => {
      const opt = document.createElement('option');
      opt.value = doc.id;
      opt.textContent = doc.data().name;
      select.appendChild(opt);
    });
  } catch (err) {
    console.error('Load classes error:', err);
    toast.error('Failed to load classes.');
  }
}

// ─── loadStudentLookupDropdown (unchanged) ────────────
async function loadStudentLookupDropdown() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  try {
    const q = query(collection(db, 'students'), where('schoolId', '==', schoolId), where('status', '==', 'active'));
    const snap = await getDocs(q);
    const select = document.getElementById('studentLookupSelect');
    select.innerHTML = '<option value="">Select Student</option>';
    snap.forEach(doc => {
      const data = doc.data();
      const opt = document.createElement('option');
      opt.value = doc.id;
      opt.textContent = data.name || 'Unnamed';
      select.appendChild(opt);
    });
    const obSelect = document.getElementById('openingBalanceStudent');
    if (obSelect) {
      obSelect.innerHTML = '<option value="">Select Student</option>';
      snap.forEach(doc => {
        const data = doc.data();
        const opt = document.createElement('option');
        opt.value = doc.id;
        opt.textContent = data.name || 'Unnamed';
        obSelect.appendChild(opt);
      });
    }
  } catch (err) {
    console.error('Load students error:', err);
    toast.error('Failed to load students.');
  }
}

// ─── refreshClassFeeTable (unchanged) ─────────────────
async function refreshClassFeeTable() {
  const classId = document.getElementById('financeClassSelect').value;
  const term = document.getElementById('financeTermSelect').value;
  const session = document.getElementById('financeSessionSelect').value;
  const statusFilter = document.getElementById('statusFilterSelect').value;

  if (!classId || !term || !session) {
    document.getElementById('classFeeTableBody').innerHTML = '<tr><td colspan="6">Please select class, term and session.</td></tr>';
    return;
  }

  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;

  const safeSession = sanitizeSession(session);

  try {
    const studentsQ = query(collection(db, 'students'),
      where('schoolId', '==', schoolId),
      where('classId', '==', classId),
      where('status', '==', 'active'));
    const studentsSnap = await getDocs(studentsQ);
    const students = [];
    studentsSnap.forEach(doc => students.push({ id: doc.id, ...doc.data() }));

    const feesPromises = students.map(async student => {
      const feeId = `${student.id}_${term}_${safeSession}`;
      const feeRef = doc(db, 'schools', schoolId, 'fees', feeId);
      const feeDoc = await getDoc(feeRef);
      if (!feeDoc.exists()) {
        return { ...student, feeAmount: 0, totalPaid: 0, balance: 0, hasFee: false, feeDocId: null };
      }
      const feeData = feeDoc.data();
      const paymentsQ = query(collection(feeRef, 'payments'));
      const paymentsSnap = await getDocs(paymentsQ);
      let totalPaid = 0;
      paymentsSnap.forEach(p => { if (!p.data().voided) totalPaid += p.data().amount || 0; });
      const owed = totalOwed(feeData);
      const balance = owed - totalPaid;
      return {
        ...student,
        feeAmount: owed,
        totalPaid,
        balance,
        hasFee: true,
        feeDocId: feeId
      };
    });

    const rows = await Promise.all(feesPromises);

    let filteredRows = rows;
    if (statusFilter === 'paid') filteredRows = rows.filter(r => r.balance <= 0 && r.hasFee);
    else if (statusFilter === 'unpaid') filteredRows = rows.filter(r => r.balance > 0 || !r.hasFee);

    const tbody = document.getElementById('classFeeTableBody');
    if (filteredRows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6">No matching records.</td></tr>';
      return;
    }

    let html = '';
    filteredRows.forEach(r => {
      const balanceLabel = r.balance > 0
        ? `<span style="color:var(--danger-text);">Owing ₦${r.balance.toLocaleString()}</span>`
        : r.balance < 0
          ? `<span style="color:var(--success-text);">₦${Math.abs(r.balance).toLocaleString()} credit</span>`
          : `<span style="color:var(--success-text);">Settled</span>`;
      const statusClass = r.hasFee ? (r.balance <= 0 ? 'paid' : 'unpaid') : 'not-set';
      html += `
        <tr>
          <td>${r.name}</td>
          <td>₦${(r.feeAmount || 0).toLocaleString()}</td>
          <td>₦${(r.totalPaid || 0).toLocaleString()}</td>
          <td>${balanceLabel}</td>
          <td><span class="status-badge ${statusClass}">${statusClass === 'not-set' ? 'Fee not set' : (r.balance <= 0 ? 'Paid' : 'Unpaid')}</span></td>
          <td>
            <div class="table-actions">
              <button class="btn-secondary btn-sm set-fee-btn" data-student-id="${r.id}" data-student-name="${r.name}">Set Fee</button>
              <button class="btn-success btn-sm add-payment-btn" data-fee-id="${r.feeDocId || ''}" data-student-id="${r.id}" data-student-name="${r.name}" ${!r.hasFee ? 'disabled' : ''}>+ Payment</button>
            </div>
          </td>
        </tr>`;
    });
    tbody.innerHTML = html;

    document.querySelectorAll('.set-fee-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const studentId = btn.dataset.studentId;
        const studentName = btn.dataset.studentName;
        openSetFeeModal(studentId, studentName);
      });
    });
    document.querySelectorAll('.add-payment-btn').forEach(btn => {
      if (btn.disabled) return;
      btn.addEventListener('click', (e) => {
        const feeId = btn.dataset.feeId;
        const studentId = btn.dataset.studentId;
        const studentName = btn.dataset.studentName;
        document.getElementById('editPaymentId').value = '';
        document.getElementById('paymentModalTitle').innerHTML = '<i class="fa-solid fa-money-bill-wave"></i> Record Payment';
        document.getElementById('savePaymentBtn').textContent = 'Save Payment';
        document.getElementById('paymentAmount').value = '';
        document.getElementById('paymentDate').valueAsDate = new Date();
        document.getElementById('paymentMethod').value = 'cash';
        document.getElementById('paymentNote').value = '';
        document.getElementById('paymentForm').dataset.feeId = feeId;
        document.getElementById('paymentForm').dataset.studentId = studentId;
        updatePaymentTermDisplay(new Date());
        document.getElementById('paymentModal').style.display = 'flex';
      });
    });
  } catch (err) {
    console.error('Refresh class fee table error:', err);
    toast.error('Failed to load fee data.');
  }
}

// ─── lookupStudentFee (unchanged) ─────────────────────
async function lookupStudentFee() {
  const studentId = document.getElementById('studentLookupSelect').value;
  const term = document.getElementById('studentLookupTerm').value;
  const session = document.getElementById('studentLookupSession').value;

  if (!studentId || !term || !session) {
    toast.error('Select a student, term, and session.');
    return;
  }

  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;

  const safeSession = sanitizeSession(session);
  const feeId = `${studentId}_${term}_${safeSession}`;
  const feeRef = doc(db, 'schools', schoolId, 'fees', feeId);

  try {
    const feeDoc = await getDoc(feeRef);
    const detailDiv = document.getElementById('studentFeeDetail');
    const recordBtn = document.getElementById('recordPaymentBtn');
    const bulkBtn = document.getElementById('bulkPaymentBtn');

    if (!feeDoc.exists()) {
      detailDiv.innerHTML = '<p>No fee set for this student in the selected period.</p>';
      recordBtn.style.display = 'none';
      bulkBtn.style.display = 'none';
      return;
    }

    const feeData = feeDoc.data();
    const paymentsQ = query(collection(feeRef, 'payments'), orderBy('date', 'desc'));
    const paymentsSnap = await getDocs(paymentsQ);
    const payments = [];
    let totalPaid = 0;
    paymentsSnap.forEach(p => {
      const pd = p.data();
      payments.push({ id: p.id, ...pd });
      if (!pd.voided) totalPaid += pd.amount || 0;
    });

    const owed = totalOwed(feeData);
    const balance = owed - totalPaid;
    const balanceLabel = balance > 0
      ? `<span style="color:var(--danger-text);">Owing ₦${balance.toLocaleString()}</span>`
      : balance < 0
        ? `<span style="color:var(--success-text);">₦${Math.abs(balance).toLocaleString()} credit</span>`
        : `<span style="color:var(--success-text);">Settled</span>`;

    let html = `
      <div class="student-detail-container">
        <div class="student-detail-info">
          <div><strong>Fee Set:</strong> ₦${owed.toLocaleString()}</div>
          ${feeData.openingBalance ? `<div style="font-size:0.8rem;color:var(--text-500);">Includes ₦${feeData.openingBalance.toLocaleString()} opening balance (as of ${feeData.openingBalanceAsOf || 'migration'})</div>` : ''}
          <div><strong>Total Paid:</strong> ₦${totalPaid.toLocaleString()}</div>
          <div><strong>Balance:</strong> ${balanceLabel}</div>
          <button type="button" class="btn-secondary btn-sm" id="openManualOverrideBtn" style="margin-top:0.75rem;">
            <i class="fa-solid fa-triangle-exclamation"></i> Manual Override (Advanced)
          </button>
        </div>
        <div class="student-detail-history">
          <strong>Payment History</strong>
          <div class="payment-list">
            ${payments.length === 0 ? '<p style="margin:0.5rem 0;">No payments recorded.</p>' : ''}
            ${payments.map(p => {
              const isVoided = p.voided === true;
              return `
                <div class="detail-row" style="${isVoided ? 'opacity:0.5;' : ''}">
                  <span style="${isVoided ? 'text-decoration:line-through;' : ''}">
                    ${new Date(p.date).toLocaleDateString()} – ₦${p.amount.toLocaleString()} (${p.method || 'n/a'})
                    ${p.term && p.session ? ` <span style="font-size:0.7rem; color:#64748b;">(${p.term}, ${p.session})</span>` : ''}
                  </span>
                  <div class="payment-actions">
                    ${isVoided
                      ? '<small style="color:var(--danger-text);">Voided</small>'
                      : `<button class="btn-edit-payment edit-payment-btn" 
                                data-payment-id="${p.id}" 
                                data-fee-id="${feeId}"
                                data-student-id="${studentId}"
                                data-amount="${p.amount}"
                                data-date="${p.date}"
                                data-method="${p.method || 'cash'}"
                                data-note="${p.note || ''}"
                                title="Edit payment">
                          <i class="fa-regular fa-pen-to-square"></i>
                        </button>`
                    }
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>`;
    detailDiv.innerHTML = html;
    recordBtn.style.display = 'inline-block';
    bulkBtn.style.display = 'inline-block';
    recordBtn.dataset.studentId = studentId;
    recordBtn.dataset.feeId = feeId;
    bulkBtn.dataset.studentId = studentId;
    bulkBtn.dataset.feeId = feeId;

    document.getElementById('openManualOverrideBtn')?.addEventListener('click', () => {
      const studentName = document.getElementById('studentLookupSelect').selectedOptions[0]?.textContent || '';
      document.getElementById('editSummaryStudentId').value = studentId;
      document.getElementById('editSummaryStudentName').value = studentName;
      document.getElementById('editSummarySession').value = session;
      document.getElementById('editSummarySessionDisplay').value = `${term}, ${session}`;
      document.getElementById('editSummaryTotalFee').value = owed;
      document.getElementById('editSummaryTotalPaid').value = totalPaid;
      document.getElementById('editSummaryArrears').value = Math.max(0, balance);
      document.getElementById('editSummaryModal').style.display = 'flex';
    });

    document.querySelectorAll('.edit-payment-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const paymentId = btn.dataset.paymentId;
        const feeId = btn.dataset.feeId;
        const studentId = btn.dataset.studentId;
        const amount = parseFloat(btn.dataset.amount);
        const date = btn.dataset.date;
        const method = btn.dataset.method;
        const note = btn.dataset.note;
        openEditPaymentModal(paymentId, feeId, studentId, amount, date, method, note);
      });
    });

  } catch (err) {
    console.error('Student lookup error:', err);
    toast.error('Failed to load student fee details.');
  }
}

// ─── openEditPaymentModal (unchanged) ─────────────────
function openEditPaymentModal(paymentId, feeId, studentId, amount, date, method, note) {
  document.getElementById('editPaymentId').value = paymentId;
  document.getElementById('paymentForm').dataset.feeId = feeId;
  document.getElementById('paymentForm').dataset.studentId = studentId;
  document.getElementById('paymentModalTitle').innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Edit Payment';
  document.getElementById('savePaymentBtn').textContent = 'Update Payment';
  document.getElementById('paymentAmount').value = amount;
  document.getElementById('paymentDate').value = date;
  document.getElementById('paymentMethod').value = method;
  document.getElementById('paymentNote').value = note;
  updatePaymentTermDisplay(new Date(date));
  document.getElementById('paymentModal').style.display = 'flex';
}

// ─── handlePaymentSubmit (unchanged) ─────────────────
async function handlePaymentSubmit(e) {
  e.preventDefault();
  const feeId = document.getElementById('paymentForm').dataset.feeId;
  const paymentId = document.getElementById('editPaymentId').value;
  const amount = parseFloat(document.getElementById('paymentAmount').value);
  const date = document.getElementById('paymentDate').value;
  const method = document.getElementById('paymentMethod').value;
  const note = document.getElementById('paymentNote').value.trim();

  if (!feeId || isNaN(amount) || amount <= 0) {
    toast.error('Enter a valid amount.');
    return;
  }
  if (!date) {
    toast.error('Select a payment date.');
    return;
  }

  const dt = new Date(date);
  const { term, session } = calculateTermAndSessionFromDate(dt);

  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;

  const feeRef = doc(db, 'schools', schoolId, 'fees', feeId);
  const btn = document.getElementById('savePaymentBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    if (paymentId) {
      const originalRef = doc(feeRef, 'payments', paymentId);
      await updateDoc(originalRef, {
        voided: true,
        voidedAt: serverTimestamp(),
        voidReason: 'Corrected by admin — see replacement record',
      });
      await addDoc(collection(feeRef, 'payments'), {
        amount, date, method, note, term, session,
        correctionOf: paymentId,
        createdAt: serverTimestamp()
      });
      toast.success('Payment corrected — original entry preserved as voided.');
    } else {
      await addDoc(collection(feeRef, 'payments'), {
        amount, date, method, note, term, session,
        createdAt: serverTimestamp()
      });
      toast.success('Payment recorded successfully.');
    }

    document.getElementById('paymentModal').style.display = 'none';
    await lookupStudentFee();
    if (document.getElementById('financeClassSelect').value) {
      await refreshClassFeeTable();
    }
    await loadSummaryCards();
    await loadIncomeExpenseSummaryCards();
    await populateHistorySessionSelect();

    const studentId = document.getElementById('paymentForm').dataset.studentId;
    if (studentId) {
      await recalculateFeeGateStatus(schoolId, studentId, term, session);
    }
  } catch (err) {
    console.error('Save payment error:', err);
    toast.error('Failed to save payment.');
  } finally {
    btn.disabled = false;
    btn.textContent = paymentId ? 'Update Payment' : 'Save Payment';
  }
}

// ─── handleBulkPayments (unchanged) ─────────────────
async function handleBulkPayments(e) {
  e.preventDefault();
  const feeId = document.getElementById('bulkPaymentBtn').dataset.feeId;
  const studentId = document.getElementById('bulkPaymentBtn').dataset.studentId;
  if (!feeId || !studentId) {
    toast.error('No student/fee selected. Please lookup a student first.');
    return;
  }

  const rows = document.querySelectorAll('#bulkPaymentRows .bulk-payment-row');
  const payments = [];
  let valid = true;
  rows.forEach(row => {
    const date = row.querySelector('.bulk-date').value;
    const amount = parseFloat(row.querySelector('.bulk-amount').value);
    const method = row.querySelector('.bulk-method').value;
    const note = row.querySelector('.bulk-note').value.trim();
    if (!date || isNaN(amount) || amount <= 0) {
      valid = false;
      toast.error('All rows must have a valid date and amount.');
      return;
    }
    const dt = new Date(date);
    const { term, session } = calculateTermAndSessionFromDate(dt);
    payments.push({ date, amount, method, note, term, session });
  });
  if (!valid || payments.length === 0) return;

  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;

  const feeRef = doc(db, 'schools', schoolId, 'fees', feeId);
  const btn = document.getElementById('saveBulkPaymentsBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const batch = writeBatch(db);
    for (const p of payments) {
      const newRef = doc(collection(feeRef, 'payments'));
      batch.set(newRef, {
        amount: p.amount,
        date: p.date,
        method: p.method,
        note: p.note,
        term: p.term,
        session: p.session,
        isMigrated: false,
        createdAt: serverTimestamp()
      });
    }
    await batch.commit();

    const uniquePeriods = new Set(payments.map(p => `${p.term}||${p.session}`));
    for (const key of uniquePeriods) {
      const [t, s] = key.split('||');
      await recalculateFeeGateStatus(schoolId, studentId, t, s);
    }

    toast.success(`${payments.length} payment(s) recorded successfully.`);
    document.getElementById('bulkPaymentModal').style.display = 'none';
    await lookupStudentFee();
    if (document.getElementById('financeClassSelect').value) {
      await refreshClassFeeTable();
    }
    await loadSummaryCards();
    await loadIncomeExpenseSummaryCards();
    await populateHistorySessionSelect();
  } catch (err) {
    console.error('Bulk payment error:', err);
    toast.error('Failed to save bulk payments.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit All Payments';
  }
}

// ─── handleBulkSetClassFee (unchanged) ───────────────
async function handleBulkSetClassFee(e) {
  e.preventDefault();
  const classId = e.target.dataset.classId;
  const amount = parseFloat(document.getElementById('bulkClassFeeAmount').value);
  const term = document.getElementById('financeTermSelect').value;
  const session = document.getElementById('financeSessionSelect').value;
  if (!classId || isNaN(amount) || amount <= 0) {
    toast.error('Enter a valid amount.');
    return;
  }

  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;

  const safeSession = sanitizeSession(session);
  const btn = document.getElementById('saveBulkClassFeeBtn');
  btn.disabled = true;
  btn.textContent = 'Applying...';

  try {
    const studentsQ = query(collection(db, 'students'),
      where('schoolId', '==', schoolId), where('classId', '==', classId), where('status', '==', 'active'));
    const studentsSnap = await getDocs(studentsQ);

    const batch = writeBatch(db);
    studentsSnap.forEach(studentDoc => {
      const feeId = `${studentDoc.id}_${term}_${safeSession}`;
      const feeRef = doc(db, 'schools', schoolId, 'fees', feeId);
      batch.set(feeRef, {
        studentId: studentDoc.id,
        amount,
        term,
        session,
        setViaBulkClassAction: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
    });
    await batch.commit();

    toast.success(`Fee applied to ${studentsSnap.size} student(s).`);
    document.getElementById('bulkSetClassFeeModal').style.display = 'none';
    await refreshClassFeeTable();
    await loadSummaryCards();
    await loadIncomeExpenseSummaryCards();
    for (const studentDoc of studentsSnap.docs) {
      await recalculateFeeGateStatus(schoolId, studentDoc.id, term, session);
    }
  } catch (err) {
    console.error('Bulk class fee error:', err);
    toast.error('Failed to apply fee to class.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply to Class';
  }
}

// ─── openSetFeeModal (unchanged) ─────────────────────
function openSetFeeModal(studentId, studentName) {
  document.getElementById('setFeeStudentName').value = studentName;
  document.getElementById('setFeeForm').dataset.studentId = studentId;
  document.getElementById('setFeeModal').style.display = 'flex';
}

// ─── saveFee (unchanged) ─────────────────────────────
async function saveFee(e) {
  e.preventDefault();
  const studentId = document.getElementById('setFeeForm').dataset.studentId;
  const amount = parseFloat(document.getElementById('setFeeAmount').value);
  const note = document.getElementById('setFeeNote').value.trim();
  const term = document.getElementById('financeTermSelect').value;
  const session = document.getElementById('financeSessionSelect').value;

  if (!studentId || isNaN(amount) || amount <= 0) {
    toast.error('Enter a valid amount.');
    return;
  }

  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;

  const safeSession = sanitizeSession(session);
  const feeId = `${studentId}_${term}_${safeSession}`;
  const feeRef = doc(db, 'schools', schoolId, 'fees', feeId);
  const btn = document.getElementById('saveFeeBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await setDoc(feeRef, {
      studentId,
      amount,
      note,
      term,
      session,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    toast.success('Fee set successfully.');
    document.getElementById('setFeeModal').style.display = 'none';
    await refreshClassFeeTable();
    await loadSummaryCards();
    await loadIncomeExpenseSummaryCards();
    await populateHistorySessionSelect();
    await recalculateFeeGateStatus(schoolId, studentId, term, session);
  } catch (err) {
    console.error('Save fee error:', err);
    toast.error('Failed to save fee.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Fee';
  }
}

// ─── populateHistorySessionSelect (unchanged) ────────
async function populateHistorySessionSelect() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  const select = document.getElementById('historySessionSelect');
  try {
    const feeSnap = await getDocs(query(collection(db, 'schools', schoolId, 'fees')));
    const sessions = new Set();
    feeSnap.forEach(doc => {
      const data = doc.data();
      if (data.session) sessions.add(data.session);
    });
    select.innerHTML = '<option value="all">All Sessions</option>';
    Array.from(sessions).sort().forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      select.appendChild(opt);
    });
    if (sessions.size === 0) {
      const current = getCurrentSession();
      if (current) {
        const opt = document.createElement('option');
        opt.value = current;
        opt.textContent = current;
        select.appendChild(opt);
      }
    }
  } catch (err) {
    console.error('Populate history sessions error:', err);
  }
}

// ─── loadFinancialHistory (modified to include income/expenses) ──
async function loadFinancialHistory() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) {
    toast.error('School ID not found.');
    return;
  }
  const selectedSession = document.getElementById('historySessionSelect').value;

  try {
    // Existing student fee history loading
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

// ─── downloadHistoryPdf (unchanged) ─────────────────
function downloadHistoryPdf() {
  window.print();
}

// ─── saveSummary (unchanged) ─────────────────────────
async function saveSummary(e) {
  e.preventDefault();
  const studentId = document.getElementById('editSummaryStudentId').value;
  const session = document.getElementById('editSummarySession').value;
  const totalFee = parseFloat(document.getElementById('editSummaryTotalFee').value) || 0;
  const totalPaid = parseFloat(document.getElementById('editSummaryTotalPaid').value) || 0;
  const arrears = parseFloat(document.getElementById('editSummaryArrears').value) || 0;

  if (totalFee < 0 || totalPaid < 0 || arrears < 0) {
    toast.error('Amounts cannot be negative.');
    return;
  }

  const schoolId = await getCurrentSchoolId();
  if (!schoolId) {
    toast.error('School ID not found.');
    return;
  }

  const userData = await getCurrentUserData();
  const docId = `${studentId}_${sanitizeSession(session)}`;
  const ref = doc(db, 'schools', schoolId, 'manualOverrides', docId);
  const btn = document.getElementById('saveSummaryBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await setDoc(ref, {
      studentId,
      session,
      totalFee,
      totalPaid,
      arrears,
      editedBy: userData?.email || 'admin',
      editedAt: serverTimestamp(),
      editReason: 'Manual override via admin finance history',
      updatedAt: serverTimestamp()
    }, { merge: true });
    toast.success('Manual override saved (audit trail recorded).');
    document.getElementById('editSummaryModal').style.display = 'none';
  } catch (err) {
    console.error('Save summary error:', err);
    toast.error('Failed to save manual override.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Summary';
  }
}

// ─── handleOpeningBalance (unchanged) ────────────────
async function handleOpeningBalance(e) {
  const studentId = document.getElementById('openingBalanceStudent').value;
  const amount = parseFloat(document.getElementById('openingBalanceAmount').value);
  const asOfDate = document.getElementById('openingBalanceDate').value;
  if (!studentId || isNaN(amount) || amount < 0 || !asOfDate) {
    toast.error('Fill in student, amount, and date.');
    return;
  }
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) { toast.error('School ID not found.'); return; }
  const term = getCurrentTerm();
  const session = getCurrentSession();
  const safeSession = sanitizeSession(session);
  const feeId = `${studentId}_${term}_${safeSession}`;
  const feeRef = doc(db, 'schools', schoolId, 'fees', feeId);

  try {
    await setDoc(feeRef, {
      studentId,
      term,
      session,
      openingBalance: amount,
      isOpeningBalance: true,
      openingBalanceAsOf: asOfDate,
      migratedBy: (await getCurrentUserData())?.email || 'admin',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    toast.success('Opening balance recorded.');

    await recalculateFeeGateStatus(schoolId, studentId, term, session);
    await refreshClassFeeTable();
    await loadSummaryCards();
    await loadIncomeExpenseSummaryCards();
  } catch (err) {
    console.error('Opening balance error:', err);
    toast.error('Failed to save opening balance.');
  }
}

// ─── handleCsvImport (unchanged) ─────────────────────
async function handleCsvImport() {
  const file = document.getElementById('csvImportFile').files[0];
  if (!file) { toast.error('Choose a CSV file first.'); return; }
  const text = await file.text();
  const lines = text.trim().split('\n').filter(line => line.trim());
  if (lines.length < 2) { toast.error('CSV must have a header row and at least one data row.'); return; }

  const rows = lines.map(r => r.split(',').map(c => c.trim()));
  const header = rows[0];
  const dataRows = rows.slice(1);

  const required = ['admissionNumber', 'term', 'session', 'amount', 'date'];
  const missing = required.filter(col => !header.includes(col));
  if (missing.length) {
    toast.error(`CSV is missing required columns: ${missing.join(', ')}`);
    return;
  }

  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const parsed = dataRows.filter(r => r.length >= header.length).map(r => ({
    admissionNumber: r[idx.admissionNumber] || '',
    term: r[idx.term] || '',
    session: r[idx.session] || '',
    amount: parseFloat(r[idx.amount]) || 0,
    date: r[idx.date] || '',
    method: idx.method !== undefined ? (r[idx.method] || 'other') : 'other',
  })).filter(row => row.admissionNumber && !isNaN(row.amount) && row.amount > 0 && row.date);

  const previewDiv = document.getElementById('csvImportPreview');
  if (parsed.length === 0) {
    previewDiv.innerHTML = '<p style="color:var(--danger-text);">No valid rows found. Check your CSV format.</p>';
    return;
  }

  previewDiv.innerHTML = `
    <p>${parsed.length} valid row(s) found. Review before importing:</p>
    <div class="table-container" style="max-height:250px;overflow-y:auto;">
      <table class="data-table"><thead><tr><th>Admission No.</th><th>Term</th><th>Session</th><th>Amount</th><th>Date</th></tr></thead>
      <tbody>${parsed.map(r => `<tr><td>${r.admissionNumber}</td><td>${r.term}</td><td>${r.session}</td><td>₦${r.amount.toLocaleString()}</td><td>${r.date}</td></tr>`).join('')}</tbody></table>
    </div>
    <button id="confirmCsvImportBtn" class="btn-success" style="margin-top:1rem;">Confirm Import (${parsed.length} rows)</button>
  `;

  document.getElementById('confirmCsvImportBtn').addEventListener('click', async () => {
    const schoolId = await getCurrentSchoolId();
    if (!schoolId) { toast.error('School ID not found.'); return; }
    const confirmBtn = document.getElementById('confirmCsvImportBtn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Importing...';
    let successCount = 0, errorCount = 0;
    const recalcTargets = new Set();

    const studentsSnap = await getDocs(query(collection(db, 'students'),
      where('schoolId', '==', schoolId), where('status', '==', 'active')));
    const admissionMap = new Map();
    studentsSnap.forEach(doc => {
      const data = doc.data();
      if (data.admissionNumber) {
        admissionMap.set(data.admissionNumber, doc.id);
      }
    });

    for (const row of parsed) {
      const studentId = admissionMap.get(row.admissionNumber);
      if (!studentId) {
        console.warn(`Student with admission number ${row.admissionNumber} not found. Skipping row.`);
        errorCount++;
        continue;
      }

      try {
        const safeSession = sanitizeSession(row.session);
        const feeId = `${studentId}_${row.term}_${safeSession}`;
        const feeRef = doc(db, 'schools', schoolId, 'fees', feeId);
        await addDoc(collection(feeRef, 'payments'), {
          amount: row.amount,
          date: row.date,
          method: row.method,
          note: 'Imported from CSV migration',
          term: row.term,
          session: row.session,
          isMigrated: true,
          createdAt: serverTimestamp(),
        });
        successCount++;
        recalcTargets.add(`${studentId}||${row.term}||${row.session}`);
      } catch (err) {
        console.error('Row import failed:', row, err);
        errorCount++;
      }
    }

    for (const key of recalcTargets) {
      const [sid, t, s] = key.split('||');
      await recalculateFeeGateStatus(schoolId, sid, t, s);
    }

    toast.success(`Imported ${successCount} payment(s).${errorCount ? ` ${errorCount} row(s) failed — check console.` : ''}`);
    previewDiv.innerHTML = '';
    document.getElementById('csvImportFile').value = '';
    await refreshClassFeeTable();
    await loadSummaryCards();
    await loadIncomeExpenseSummaryCards();
  });
}

// ─── downloadCsvTemplate (unchanged) ─────────────────
function downloadCsvTemplate(e) {
  e.preventDefault();
  const headers = ['admissionNumber', 'term', 'session', 'amount', 'date', 'method'];
  const sample = ['GO/2026/045', 'First Term', '2025/2026', '5000', '2025-09-15', 'cash'];
  const csv = headers.join(',') + '\n' + sample.join(',');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'acadex_payment_import_template.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}