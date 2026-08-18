// js/parent-portal.js
import { auth, db } from './firebase-config.js';
import {
  onAuthStateChanged,
  signOut,
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import {
  doc,
  getDoc,
  updateDoc,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentTerm, getCurrentSession, initAcademicCalendar, subscribeToCalendar } from './academic-calendar.js';
import { toast } from './error-handler.js';
import * as service from './service.js';
import { logoutUser } from './auth.js';
import { initMobileMenu } from './menu.js';
import { renderReportCardUI } from './reportCardRenderer.js';
import { getDefaultRatings, escapeHtml } from './report-utils.js';
import { enforcePasswordChange } from './security.js';

let parentData = null;
let selectedChildId = null;
let currentSchoolId = null;
let currentChild = null;
let currentChildClassInfo = null;
let subjectsMap = new Map();
let feeGateEnabled = false;               // <-- current school setting
let unsubscribeSchoolListener = null;    // <-- real‑time listener

let cbtResults = [];
let cbtShowAll = false;

// ── Helpers ─────────────────────────────────────────────
function totalOwed(feeData) {
  if (!feeData) return 0;
  return (feeData.amount || 0) + (feeData.openingBalance || 0);
}

function computeAttendanceSummary(records) {
  let present = 0, absent = 0;
  records.forEach(rec => {
    const days = rec.days || {};
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri']) {
      const sess = days[day];
      if (sess) {
        if (sess.M === true) present++;
        else if (sess.M === false) absent++;
        if (sess.A === true) present++;
        else if (sess.A === false) absent++;
      }
    }
  });
  const total = present + absent;
  return { schoolOpened: total, present, absent };
}

// ── Helper to get initials from name ──────────────────
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    const first = parts[0];
    if (first.length >= 2) return first.substring(0, 2).toUpperCase();
    return first.substring(0, 1).toUpperCase();
  }
  const first = parts[0][0] || '';
  const last = parts[parts.length - 1][0] || '';
  return (first + last).toUpperCase();
}

// ── Compute total outstanding for a student ──────────
async function computeStudentOutstanding(schoolId, studentId, currentTerm, currentSession) {
  const allFees = await service.getFeesByStudent(schoolId, studentId);
  if (!allFees || allFees.length === 0) {
    return { totalOutstanding: 0, totalArrears: 0, currentBalance: 0, currentFeeAmount: 0, currentPayments: 0 };
  }

  let totalOutstanding = 0;
  let totalArrears = 0;
  let currentBalance = 0;
  let currentFeeAmount = 0;
  let currentPayments = 0;

  for (const fee of allFees) {
    const feeAmount = totalOwed(fee);
    const term = fee.term;
    const session = fee.session;
    const payments = await service.getPaymentsByStudent(schoolId, studentId, term, session);
    let paid = 0;
    payments.forEach(p => { if (!p.voided) paid += p.amount || 0; });
    const unpaid = Math.max(0, feeAmount - paid);

    const isCurrent = (term === currentTerm && session === currentSession);
    if (isCurrent) {
      currentFeeAmount = feeAmount;
      currentPayments = paid;
      currentBalance = unpaid;
    } else {
      totalArrears += unpaid;
    }
    totalOutstanding += unpaid;
  }

  return { totalOutstanding, totalArrears, currentBalance, currentFeeAmount, currentPayments };
}

// ── Helper: get CA max from scoring config ─────────────
async function getCaMax(schoolId, level, term, session) {
  try {
    const configs = await service.getScoringConfig(schoolId, level);
    if (!configs || configs.length === 0) return 40;
    const match = configs.find(c => c.term === term && c.session === session);
    if (match && match.grading) {
      const parts = match.grading.split('/');
      if (parts.length === 2) {
        const caMax = parseInt(parts[0], 10);
        if (!isNaN(caMax)) return caMax;
      }
    }
    return 40;
  } catch (err) {
    console.warn('Failed to fetch scoring config for CA max:', err);
    return 40;
  }
}

// ── Main init ──────────────────────────────────────────
export async function initParentPortal() {
  const user = await new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (u) => { unsub(); resolve(u); });
  });
  if (!user) { window.location.href = '/'; return; }

  const userDoc = await service.getUserById(user.uid);
  if (!userDoc || userDoc.role !== 'parent') {
    toast.error('Access denied. Parent privileges required.');
    window.location.href = '/';
    return;
  }
  currentSchoolId = userDoc.schoolId;

  // ---- NEW: enforce password change ----
  try {
    await enforcePasswordChange(window.location.href);
  } catch (e) { /* redirecting */ }

  // ---- NEW: disabled account check ----
  if (userDoc.disabled) {
    toast.error('Your account has been disabled. Contact the school.');
    await signOut(auth);
    window.location.href = '/';
    return;
  }

  parentData = await service.getParentById(user.uid);
  if (!parentData) {
    toast.error('Parent profile not found. Please contact admin.');
    window.location.href = '/';
    return;
  }

  await initAcademicCalendar();
  subscribeToCalendar((state) => {
    document.getElementById('currentTermDisplay').textContent = state.currentTerm || '';
    document.getElementById('currentSessionDisplay').textContent = state.currentSession || '';
  });

  // ── REAL‑TIME LISTENER on school document for feeGateEnabled ──
  const schoolRef = doc(db, 'schools', currentSchoolId);
  unsubscribeSchoolListener = onSnapshot(schoolRef, (snap) => {
    if (snap.exists()) {
      const newGateSetting = snap.data().feeGateEnabled === true;
      // Only refresh UI if the setting actually changed
      if (newGateSetting !== feeGateEnabled) {
        feeGateEnabled = newGateSetting;
        // Re‑render the fee detail for the currently selected child to update the download button
        if (selectedChildId) {
          renderFeeDetail(selectedChildId);
        }
      }
    }
  });

  await loadSchoolInfo();       // initial load also sets feeGateEnabled
  await loadSubjectsMap();
  await renderChildren();

  document.getElementById('logoutBtn').addEventListener('click', logoutUser);
  document.querySelector('.mobile-logout-btn')?.addEventListener('click', logoutUser);
  initMobileMenu();

  document.getElementById('currentYear').textContent = new Date().getFullYear();
  document.getElementById('sidebarYear').textContent = new Date().getFullYear();

  const hour = new Date().getHours();
  let greeting = 'Good ';
  if (hour < 12) greeting += 'Morning';
  else if (hour < 17) greeting += 'Afternoon';
  else greeting += 'Evening';
  const lastName = parentData.name ? parentData.name.split(' ').pop() : 'Parent';
  document.getElementById('greetingText').textContent = `${greeting}, ${parentData.title || ''} ${lastName}`;

  document.getElementById('downloadReportBtn').addEventListener('click', downloadReport);

  // Clean up listener if the page is closed (optional)
  window.addEventListener('beforeunload', () => {
    if (unsubscribeSchoolListener) unsubscribeSchoolListener();
  });
}

async function loadSchoolInfo() {
  const school = await service.getSchoolById(currentSchoolId);
  if (school) {
    document.getElementById('schoolName').textContent = school.name || '';
    document.getElementById('schoolAddress').textContent = school.address || '';
    const logo = document.getElementById('schoolLogoImg');
    if (school.logo) logo.src = school.logo;
    feeGateEnabled = school.feeGateEnabled === true;   // initial value
  }
}

async function loadSubjectsMap() {
  const subjects = await service.getSubjectsBySchool(currentSchoolId);
  subjectsMap.clear();
  subjects.forEach(s => subjectsMap.set(s.id, { name: s.name, level: s.level }));
}

async function renderChildren() {
  const childIds = parentData.childIds || [];
  if (childIds.length === 0) {
    document.getElementById('childrenContainer').innerHTML = '<p>No children linked to your account.</p>';
    return;
  }
  const students = await service.getStudentsByIds(childIds);
  const container = document.getElementById('childrenContainer');
  container.innerHTML = '';
  students.forEach(s => {
    const chip = document.createElement('div');
    chip.className = 'child-card stat-card';
    chip.style.padding = '0.75rem 1.25rem';
    chip.style.cursor = 'pointer';
    chip.style.borderRadius = '999px';
    chip.style.display = 'inline-flex';
    chip.style.alignItems = 'center';
    chip.style.gap = '0.5rem';
    chip.innerHTML = `
      <img src="${s.passport || ''}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;background:#e2e8f0;" />
      <span>${s.name || 'Student'}</span>
      <span style="font-size:0.7rem;color:var(--text-500);">${s.admissionNumber || ''}</span>
    `;
    chip.dataset.studentId = s.id;
    chip.addEventListener('click', () => selectChild(s.id));
    container.appendChild(chip);
  });
  if (students.length > 0) {
    selectChild(students[0].id);
  }
}

async function selectChild(studentId) {
  selectedChildId = studentId;
  document.querySelectorAll('.child-card').forEach(el => {
    el.classList.toggle('active', el.dataset.studentId === studentId);
  });
  currentChild = await service.getStudentById(studentId);
  if (!currentChild) return;
  if (currentChild.classId) {
    currentChildClassInfo = await service.getClassById(currentChild.classId);
  } else {
    currentChildClassInfo = null;
  }

  document.getElementById('selectedChildDetail').style.display = 'block';
  document.getElementById('childNameDisplay').textContent = currentChild.name || '';
  const classInfo = currentChildClassInfo;
  document.getElementById('childClassDisplay').textContent = `Admission: ${currentChild.admissionNumber || '—'} | Class: ${classInfo?.name || currentChild.classId || ''}`;

  const img = document.getElementById('childPhoto');
  const initialsEl = document.getElementById('childInitials');
  const wrapper = document.getElementById('childPhotoWrapper');

  if (currentChild.passport) {
    img.src = currentChild.passport;
    img.style.display = 'block';
    initialsEl.style.display = 'none';
  } else {
    img.style.display = 'none';
    const initials = getInitials(currentChild.name || 'Student');
    initialsEl.textContent = initials;
    initialsEl.style.display = 'flex';
  }

  cbtResults = [];
  cbtShowAll = false;

  await loadAttendance();
  await renderFeeDetail(studentId);
  await loadCbtScores();
  await loadSubjectScores();
}

async function loadAttendance() {
  const term = getCurrentTerm();
  const session = getCurrentSession();
  if (!term || !session) {
    document.getElementById('attPresent').textContent = 'N/A';
    document.getElementById('attAbsent').textContent = 'N/A';
    document.getElementById('attPercent').textContent = 'N/A';
    return;
  }
  try {
    const records = await service.getAttendanceByStudent(
      currentSchoolId, selectedChildId, currentChild.classId, session, term
    );
    const summary = computeAttendanceSummary(records);
    const total = summary.schoolOpened;
    const pct = total > 0 ? Math.round((summary.present / total) * 100) : 0;
    document.getElementById('attPresent').textContent = summary.present;
    document.getElementById('attAbsent').textContent = summary.absent;
    document.getElementById('attPercent').textContent = pct + '%';
  } catch (err) {
    toast.error('Could not load attendance.');
    console.error(err);
  }
}

async function renderFeeDetail(studentId) {
  const term = getCurrentTerm();
  const session = getCurrentSession();
  const container = document.getElementById('feeDetailContainer');
  if (!term || !session) {
    container.innerHTML = '<p>Unable to determine current term/session.</p>';
    return;
  }

  try {
    const { totalOutstanding, totalArrears, currentBalance, currentFeeAmount, currentPayments } =
      await computeStudentOutstanding(currentSchoolId, studentId, term, session);

    const allFees = await service.getFeesByStudent(currentSchoolId, studentId);
    if (!allFees || allFees.length === 0) {
      container.innerHTML = '<p>No fee records found for this student.</p>';
      return;
    }

    const currentFeeDoc = allFees.find(f => f.term === term && f.session === session);
    const feeAmountDisplay = currentFeeDoc ? totalOwed(currentFeeDoc) : 0;
    const openingBalance = currentFeeDoc?.openingBalance || 0;

    const balance = currentBalance;
    const balanceLabel = balance > 0
      ? `<span style="color:var(--danger-text);">Owing ₦${balance.toLocaleString()}</span>`
      : balance < 0
        ? `<span style="color:var(--success-text);">₦${Math.abs(balance).toLocaleString()} credit</span>`
        : `<span style="color:var(--success-text);">Settled</span>`;

    const arrearsLabel = totalArrears > 0
      ? `<span style="color:var(--danger-text);">₦${totalArrears.toLocaleString()}</span>`
      : `<span style="color:var(--success-text);">None</span>`;

    const payments = await service.getPaymentsByStudent(currentSchoolId, studentId, term, session);
    let historyHtml = payments.length === 0 ? '<p style="margin:0.5rem 0;">No payments recorded.</p>' : '';
    payments.forEach(p => {
      const isVoided = p.voided === true;
      historyHtml += `
        <div class="detail-row" style="display:flex; justify-content:space-between; padding:0.3rem 0; border-bottom:1px solid #f1f5f9; ${isVoided ? 'opacity:0.5;' : ''}">
          <span style="${isVoided ? 'text-decoration:line-through;' : ''}">
            ${new Date(p.date).toLocaleDateString()} – ₦${p.amount.toLocaleString()} (${p.method || 'n/a'})
            ${p.term && p.session ? ` <span style="font-size:0.7rem; color:#64748b;">(${p.term}, ${p.session})</span>` : ''}
          </span>
          ${isVoided ? '<small style="color:var(--danger-text);">Voided</small>' : ''}
        </div>
      `;
    });

    let html = `
      <div class="student-detail-container" style="display:flex; flex-wrap:wrap; gap:1.5rem;">
        <div class="student-detail-info" style="flex:1; min-width:180px;">
          <div><strong>Fee Set (this term):</strong> ₦${feeAmountDisplay.toLocaleString()}</div>
          ${openingBalance ? `<div style="font-size:0.8rem;color:var(--text-500);">Includes ₦${openingBalance.toLocaleString()} opening balance (as of ${currentFeeDoc?.openingBalanceAsOf || 'migration'})</div>` : ''}
          <div><strong>Total Paid (this term):</strong> ₦${currentPayments.toLocaleString()}</div>
          <div><strong>Arrears from previous terms:</strong> ${arrearsLabel}</div>
          <div><strong>Balance (this term):</strong> ${balanceLabel}</div>
          <div><strong>Total Outstanding (all terms):</strong> <span style="font-weight:700;color:${totalOutstanding > 0 ? 'var(--danger-text)' : 'var(--success-text)'};">₦${totalOutstanding.toLocaleString()}</span></div>
        </div>
        <div class="student-detail-history" style="flex:2; min-width:200px;">
          <strong>Payment History (this term)</strong>
          <div class="payment-list" style="max-height:200px; overflow-y:auto; margin-top:0.5rem;">
            ${historyHtml}
          </div>
        </div>
      </div>`;

    container.innerHTML = html;

    const downloadBtn = document.getElementById('downloadReportBtn');
    // ── FIX: only block when the fee gate is ON and there are outstanding fees ──
    const shouldBlockReport = feeGateEnabled && totalOutstanding > 0;
    if (shouldBlockReport) {
      downloadBtn.disabled = true;
      downloadBtn.title = 'Report unavailable – outstanding fees';
      downloadBtn.style.opacity = '0.5';
      downloadBtn.style.cursor = 'not-allowed';
    } else {
      downloadBtn.disabled = false;
      downloadBtn.title = '';
      downloadBtn.style.opacity = '1';
      downloadBtn.style.cursor = 'pointer';
    }

  } catch (err) {
    console.error('Fee detail error:', err);
    container.innerHTML = '<p>Error loading fee details.</p>';
  }
}

async function loadCbtScores() {
  const container = document.getElementById('cbtScoresList');
  if (!selectedChildId) {
    container.innerHTML = '<p class="no-data-msg">No student selected.</p>';
    return;
  }
  try {
    const results = await service.getAssignedCbtScoresByStudent(selectedChildId);
    cbtResults = results || [];
    cbtResults.sort((a, b) => {
      const aTime = a.completedAt?.seconds || 0;
      const bTime = b.completedAt?.seconds || 0;
      return bTime - aTime;
    });
    renderCbtList();
  } catch (err) {
    console.error('CBT scores error:', err);
    container.innerHTML = '<p class="no-data-msg">Error loading CBT scores.</p>';
  }
}

function renderCbtList() {
  const container = document.getElementById('cbtScoresList');
  if (!cbtResults.length) {
    container.innerHTML = '<p class="no-data-msg">No CBT scores available.</p>';
    return;
  }

  const limit = 6;
  const showAll = cbtShowAll;
  const itemsToShow = showAll ? cbtResults : cbtResults.slice(0, limit);
  const hasMore = cbtResults.length > limit;

  let html = `<div class="table-responsive-wrapper"><table class="data-table"><thead><tr><th>Subject</th><th>Score</th><th>Date</th></tr></thead><tbody>`;
  itemsToShow.forEach(r => {
    const subject = r.subject || 'Unknown Subject';
    const score = r.rawScore ?? r.correctAnswers ?? 0;
    const date = r.completedAt ? new Date(r.completedAt.seconds * 1000).toLocaleDateString() : '';
    html += `<tr><td>${subject}</td><td>${score}</td><td>${date}</td></tr>`;
  });
  html += '</tbody></table></div>';

  if (hasMore) {
    const btnText = showAll ? 'Show less' : `Load more (${cbtResults.length - limit} remaining)`;
    html += `<button class="load-more-btn" id="cbtLoadMoreBtn">${btnText}</button>`;
  }

  container.innerHTML = html;

  if (hasMore) {
    document.getElementById('cbtLoadMoreBtn')?.addEventListener('click', () => {
      cbtShowAll = !cbtShowAll;
      renderCbtList();
    });
  }
}

// ── Subject scores → C.A This Term (with responsive wrapper) ──
async function loadSubjectScores() {
  const term = getCurrentTerm();
  const session = getCurrentSession();
  const container = document.getElementById('subjectScoresList');
  const heading = document.getElementById('subjectScoresHeading');

  if (heading) {
    heading.textContent = 'C.A This Term';
  }

  if (!term || !session) {
    container.innerHTML = '<p class="no-data-msg">Unable to determine current term/session.</p>';
    return;
  }

  try {
    const level = currentChildClassInfo?.level || 'secondary';
    const caMax = await getCaMax(currentSchoolId, level, term, session);

    // Fetch scores directly, no fallback mapping
    let scores = await service.getScoresByStudent(selectedChildId, currentSchoolId, term, session);

    if (!scores || scores.length === 0) {
      container.innerHTML = '<p class="no-data-msg">No C.A scores recorded for this term.</p>';
      return;
    }

    let tableHtml = `<div class="table-responsive-wrapper"><table class="data-table"><thead><tr><th>Subject</th><th>Score</th></tr></thead><tbody>`;
    scores.forEach(s => {
      const ca = s.ca || 0;
      const subjectName = subjectsMap.get(s.subjectId)?.name || s.subjectId;
      tableHtml += `<tr><td>${subjectName}</td><td>${ca} / ${caMax}</td></tr>`;
    });
    tableHtml += '</tbody></table></div>';
    container.innerHTML = tableHtml;
  } catch (err) {
    console.error('Error loading subject scores:', err);
    toast.error('Could not load C.A scores.');
    container.innerHTML = '<p class="no-data-msg">Error loading C.A scores.</p>';
  }
}

// ── Download Report ────────────────────────────────────
async function downloadReport() {
  const term = getCurrentTerm();
  const session = getCurrentSession();
  if (!term || !session) {
    toast.error('Current term/session not available.');
    return;
  }

  if (!selectedChildId) {
    toast.error('No student selected.');
    return;
  }

  const { totalOutstanding } = await computeStudentOutstanding(currentSchoolId, selectedChildId, term, session);
  // ── FIX: only block when the fee gate is ON and there are outstanding fees ──
  if (feeGateEnabled && totalOutstanding > 0) {
    toast.warning('Cannot download report – outstanding fees remain.');
    return;
  }

  const school = await service.getSchoolById(currentSchoolId);
  const student = currentChild;
  if (!student) {
    toast.error('Student data not loaded.');
    return;
  }

  // Fetch scores directly, no fallback
  let scoresRaw = await service.getScoresByStudent(selectedChildId, currentSchoolId, term, session);

  if (!scoresRaw || scoresRaw.length === 0) {
    toast.warning('No scores found for this term. Cannot generate report.');
    return;
  }

  const scoresWithNames = scoresRaw.map(s => ({
    subjectId: s.subjectId,
    subjectName: subjectsMap.get(s.subjectId)?.name || s.subjectId,
    ca: s.ca || 0,
    exam: s.exam || 0
  }));

  const classLevel = currentChildClassInfo?.level || 'secondary';
  const isPrimary = (classLevel === 'primary');
  const gradingConfigs = await service.getScoringConfig(currentSchoolId, classLevel);
  let grading = { ca: 40, exam: 60 };
  if (gradingConfigs && gradingConfigs.length > 0) {
    const match = gradingConfigs.find(g => g.term === term && g.session === session);
    if (match && match.grading) {
      const [ca, exam] = match.grading.split('/').map(Number);
      if (!isNaN(ca) && !isNaN(exam)) grading = { ca, exam };
    }
  }

  // Get saved report, no fallback
  let report = await service.getReportByStudent(selectedChildId, currentSchoolId, term, session);
  const psychomotor = report?.psychomotor || getDefaultRatings();
  const teacherComment = report?.teacherComment || '';
  const principalComment = report?.principalComment || '';

  const attendanceRecords = await service.getAttendanceByStudent(
    currentSchoolId, selectedChildId, student.classId, session, term
  );
  const attendanceSummary = computeAttendanceSummary(attendanceRecords);

  const studentData = {
    id: student.id,
    name: student.name || 'Student',
    classId: student.classId,
    schoolId: currentSchoolId,
    admissionNumber: student.admissionNumber || '—',
    gender: student.gender || '—',
    dob: student.dob || '',
    club: student.club || '—',
    passport: student.passport || null,
    parentPhone: student.parentPhone || null
  };

  const className = currentChildClassInfo?.name || student.classId || 'Class';

  const hiddenContainer = document.createElement('div');
  hiddenContainer.style.cssText = 'position:fixed; left:-9999px; top:0; width:210mm; background:white; z-index:9999;';
  document.body.appendChild(hiddenContainer);

  try {
    await renderReportCardUI({
      student: studentData,
      scores: scoresWithNames,
      className,
      school,
      grading,
      psychomotor,
      comments: { teacherComment, principalComment },
      term,
      session,
      subjectStats: undefined,
      container: hiddenContainer,
      attendance: attendanceSummary,
      skipLiveAttendanceFetch: true,
      isPrimary
    });

    const clonedReport = hiddenContainer.cloneNode(true);
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      toast.error('Please allow pop-ups to print the report.');
      return;
    }

    const externalCssUrl = new URL('../css/styles.css', window.location.href).href;
    const inlineStyles = Array.from(document.querySelectorAll('style')).map(style => style.innerHTML).join('\n');
    const extraPrintCSS = `
      @page { size: A4; margin: 8mm; }
      body, .print-container { margin: 0; padding: 0; background: white; }
      .print-container { width: 100%; max-width: 210mm; margin: 0 auto; }
      .rc-wrapper { max-width: 100%; border: none; padding: 0; font-size: 8pt; background: #fdf8f2 !important; }
      .rc-school-name { font-size: 22pt !important; }
      .rc-main-row { display: grid !important; grid-template-columns: 62fr 35fr !important; gap: 14px !important; }
      .rc-col-left, .rc-col-right { min-width: 0; }
      .rc-att-input, .rc-tick-row, .rc-comment-controls, select, textarea, button { display: none !important; }
      .rc-print-val     { display: inline !important; }
      .rc-print-comment { display: inline !important; }
      .rc-scroll-outer  { overflow: visible !important; }
      .rc-details-band  { background: #1a3a5c !important; }
      .rc-details-cell  { color: #fff !important; border-right: 1px solid rgba(255,255,255,0.18) !important; border-bottom: 1px solid rgba(255,255,255,0.18) !important; }
      .rc-details-cell strong { color: #a8d8f0 !important; }
      .rc-subject-table, .rc-summary-table, .rc-attendance-table, .rc-skills-table, .rc-grade-scale { break-inside: avoid; page-break-inside: avoid; }
      *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
      .rc-subject-table th, .rc-summary-table th, .rc-attendance-table th, .rc-skills-table th { background: #ADD8E6 !important; }
      .rc-grade-scale th { background: #FFD700 !important; }
      .rc-comments { background: #f9f9f9 !important; }
      .rc-comment-row, .rc-comment-item {
        display: flex !important;
        flex-direction: row !important;
        align-items: baseline !important;
        gap: 8px !important;
        flex-wrap: wrap !important;
      }
      .rc-comment-label, .rc-comment-item strong {
        white-space: nowrap !important;
      }
    `;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Report Card – ${escapeHtml(studentData.name)}</title>
        <link rel="stylesheet" href="${externalCssUrl}">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { background: white; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
          .print-container { width: 210mm; margin: 0 auto; background: white; }
          ${inlineStyles}
          ${extraPrintCSS}
        </style>
      </head>
      <body>
        <div class="print-container">${clonedReport.innerHTML}</div>
      </body>
      </html>
    `);
    printWindow.document.close();
    setTimeout(() => { printWindow.focus(); printWindow.print(); }, 300);
  } catch (err) {
    console.error('Report generation error:', err);
    toast.error('Failed to generate report. Please try again.');
  } finally {
    hiddenContainer.remove();
  }
}