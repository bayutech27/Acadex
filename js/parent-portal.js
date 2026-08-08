// js/parent-portal.js
import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, updatePassword } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { doc, getDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentTerm, getCurrentSession, initAcademicCalendar, subscribeToCalendar } from './academic-calendar.js';
import { toast } from './error-handler.js';
import * as service from './service.js';
import { logoutUser } from './auth.js';
import { initMobileMenu } from './menu.js';

let parentData = null;
let selectedChildId = null;
let currentSchoolId = null;
let currentChild = null;

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

  await loadSchoolInfo();
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
}

async function loadSchoolInfo() {
  const school = await service.getSchoolById(currentSchoolId);
  if (school) {
    document.getElementById('schoolName').textContent = school.name || '';
    document.getElementById('schoolAddress').textContent = school.address || '';
    const logo = document.getElementById('schoolLogoImg');
    if (school.logo) logo.src = school.logo;
  }
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
  document.getElementById('selectedChildDetail').style.display = 'block';
  document.getElementById('childNameDisplay').textContent = currentChild.name || '';
  const classInfo = currentChild.classId ? await service.getClassById(currentChild.classId) : null;
  document.getElementById('childClassDisplay').textContent = `Admission: ${currentChild.admissionNumber || '—'} | Class: ${classInfo?.name || currentChild.classId || ''}`;
  if (currentChild.passport) {
    document.getElementById('childPhoto').src = currentChild.passport;
  }
  await loadAttendance();
  await loadFees();
  await loadCbtScores();
  await loadSubjectScores();
  await populateReportSelectors();
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
    let present = 0, totalSessions = 0;
    records.forEach(rec => {
      const days = rec.days || {};
      ['mon','tue','wed','thu','fri'].forEach(day => {
        if (days[day]) {
          if (days[day].M === true) present++;
          if (days[day].A === true) present++;
          totalSessions += 2;
        }
      });
    });
    const absent = totalSessions - present;
    const pct = totalSessions > 0 ? Math.round((present / totalSessions) * 100) : 0;
    document.getElementById('attPresent').textContent = present;
    document.getElementById('attAbsent').textContent = absent;
    document.getElementById('attPercent').textContent = pct + '%';
  } catch (err) {
    toast.error('Could not load attendance.');
    console.error(err);
  }
}

async function loadFees() {
  const term = getCurrentTerm();
  const session = getCurrentSession();
  if (!term || !session) return;
  try {
    const feeDoc = await service.getFeeStructure(currentSchoolId, selectedChildId, term, session);
    const amount = feeDoc ? feeDoc.amount : null;
    const payments = await service.getPaymentsByStudent(currentSchoolId, selectedChildId, term, session);
    const totalPaid = payments.reduce((sum, p) => sum + (p.amountPaid || 0), 0);
    const owed = amount !== null ? amount : 0;
    const arrears = amount !== null ? Math.max(0, owed - totalPaid) : null;

    document.getElementById('feeAmount').textContent = amount !== null ? `₦${amount.toLocaleString()}` : 'Not set';
    document.getElementById('totalPaid').textContent = `₦${totalPaid.toLocaleString()}`;
    const arrearsEl = document.getElementById('arrears');
    if (amount === null) {
      arrearsEl.textContent = 'No fee set for this term';
      arrearsEl.className = 'fee-status not-set';
    } else if (arrears === 0) {
      arrearsEl.textContent = 'Fully Paid';
      arrearsEl.className = 'fee-status paid';
    } else {
      arrearsEl.textContent = `₦${arrears.toLocaleString()}`;
      arrearsEl.className = 'fee-status unpaid';
    }
  } catch (err) {
    toast.error('Could not load fees.');
    console.error(err);
  }
}

async function loadCbtScores() {
  const results = await service.getTestResultsByUser(selectedChildId);
  const container = document.getElementById('cbtScoresList');
  if (!results || results.length === 0) {
    container.innerHTML = '<p class="no-data-msg">No CBT scores available.</p>';
    return;
  }
  let html = '<table class="data-table"><thead><tr><th>Test</th><th>Score</th><th>Date</th></tr></thead><tbody>';
  results.forEach(r => {
    html += `<tr><td>${r.testName || 'CBT'}</td><td>${r.score || 0}</td><td>${r.completedAt ? new Date(r.completedAt.seconds*1000).toLocaleDateString() : ''}</td></tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

async function loadSubjectScores() {
  const term = getCurrentTerm();
  const session = getCurrentSession();
  if (!term || !session) return;
  try {
    const scores = await service.getScoresByStudent(selectedChildId, currentSchoolId, term, session);
    const container = document.getElementById('subjectScoresList');
    if (!scores || scores.length === 0) {
      container.innerHTML = '<p class="no-data-msg">No subject scores recorded.</p>';
      return;
    }
    let html = '<table class="data-table"><thead><tr><th>Subject</th><th>CA</th><th>Exam</th><th>Total</th></tr></thead><tbody>';
    scores.forEach(s => {
      const total = (s.ca || 0) + (s.exam || 0);
      html += `<tr><td>${s.subjectName || s.subjectId}</td><td>${s.ca || 0}</td><td>${s.exam || 0}</td><td>${total}</td></tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (err) {
    toast.error('Could not load subject scores.');
    console.error(err);
  }
}

async function populateReportSelectors() {
  const sessionSelect = document.getElementById('reportSessionSelect');
  const current = getCurrentSession();
  const prev = current ? `${parseInt(current.split('/')[0])-1}/${parseInt(current.split('/')[0])}` : '';
  sessionSelect.innerHTML = `<option value="${current}">${current}</option>`;
  if (prev) sessionSelect.innerHTML += `<option value="${prev}">${prev}</option>`;
  document.getElementById('loadReportBtn').addEventListener('click', loadReport);
}

async function loadReport() {
  const term = document.getElementById('reportTermSelect').value;
  const session = document.getElementById('reportSessionSelect').value;
  if (!term || !session) return;
  try {
    const report = await service.getReportByStudent(selectedChildId, currentSchoolId, term, session);
    const container = document.getElementById('reportCardContent');
    if (report) {
      container.innerHTML = `<pre style="background:#f8fafc;padding:1rem;border-radius:8px;">${JSON.stringify(report, null, 2)}</pre>`;
    } else {
      container.innerHTML = '<p class="no-data-msg">No report card available for this term/session.</p>';
    }
  } catch (err) {
    toast.error('Failed to load report.');
    console.error(err);
  }
}