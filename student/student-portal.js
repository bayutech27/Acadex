// student-portal.js
// Attendance tab: aggregates morning/afternoon sessions from Firestore attendance collection.
// Subjects tab: shows only subject names (scores removed, but remain in Results tab).
// Calendar integration: uses academic-calendar.js subscription to get current term/session.

import { auth, db } from '../js/firebase-config.js';
import {
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import {
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  orderBy,
  where,
  limit
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

// academic-calendar.js — single source of truth for term/session state
import { subscribeToCalendar } from '../js/academic-calendar.js';
// calendar-sync.js — handles Firestore rollover and periodic background sync
import { syncAcademicCalendar, startPeriodicSync } from '../js/calendar-sync.js';

// ─────────────────────────────────── Global state ────────────────────────────
let currentStudentData = null;
let currentSchoolId    = null;
let currentStudentId   = null;
let resolvedClassName  = '';
let attendanceRecords  = [];      // flattened array of { status, weekNumber, day, session }
let subjectsList       = [];
let assignmentsList    = [];
let notificationsList  = [];

// Calendar state (updated by subscription)
let globalCurrentTerm    = '';
let globalCurrentSession = '';

// ─────────────────────────────────── Utilities ───────────────────────────────
function safeVal(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return (s === 'null' || s === 'undefined') ? '' : s;
}
function hasValue(v) { return safeVal(v) !== ''; }

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  return 'Good Evening';
}

// ─────────────────────────────────── Calendar ────────────────────────────────
function initCalendar() {
  syncAcademicCalendar().catch(err =>
    console.warn('[StudentPortal] Calendar initial sync failed:', err)
  );
  startPeriodicSync(60);

  subscribeToCalendar(state => {
    globalCurrentTerm    = state.currentTerm    || '';
    globalCurrentSession = state.currentSession || '';

    const termEl    = document.getElementById('currentTermDisplay');
    const sessionEl = document.getElementById('currentSessionDisplay');
    if (termEl)    termEl.innerText    = globalCurrentTerm || '—';
    if (sessionEl) sessionEl.innerText = globalCurrentSession || '—';

    if (currentStudentData) renderProfile(currentStudentData);
  });
}

function getCalendarDisplay() {
  const t = globalCurrentTerm && globalCurrentTerm !== '—' ? globalCurrentTerm : '';
  const s = globalCurrentSession && globalCurrentSession !== '—' ? globalCurrentSession : '';
  if (!t && !s) return '';
  if (!t) return s;
  if (!s) return t;
  return `${t} — ${s}`;
}

// ─────────────────────────────────── Section toggle ──────────────────────────
function showSection(sectionId) {
  document.getElementById('dashboardSection').style.display =
    sectionId === 'dashboard' ? 'block' : 'none';
  document.getElementById('resultsSection').style.display  =
    sectionId === 'results'   ? 'block' : 'none';

  document.querySelectorAll(
    '#studentSidebarNav a, .mobile-sidebar .sidebar-nav a'
  ).forEach(link => {
    link.classList.toggle('active', link.getAttribute('data-section') === sectionId);
  });
}

// ─────────────────────────────────── Internal tabs ───────────────────────────
function initInternalTabs() {
  const tabs  = document.querySelectorAll('.internal-tab-btn');
  const panes = {
    profile:     document.getElementById('profileTab'),
    attendance:  document.getElementById('attendanceTab'),
    subjects:    document.getElementById('subjectsTab'),
    assignments: document.getElementById('assignmentsTab')
  };
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      tabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Object.values(panes).forEach(p => p && p.classList.remove('active-pane'));
      if (panes[target]) panes[target].classList.add('active-pane');
    });
  });
}

// ─────────────────────────────────── School header ───────────────────────────
async function loadSchoolHeader(schoolId) {
  if (!schoolId) return;
  try {
    const snap = await getDoc(doc(db, 'schools', schoolId));
    if (!snap.exists()) return;
    const data = snap.data();

    const nameEl = document.getElementById('schoolName');
    if (nameEl) nameEl.innerText = safeVal(data.name) || 'School Name';

    const addrEl = document.getElementById('schoolAddress');
    if (addrEl) addrEl.innerText = safeVal(data.address);

    const logoEl = document.getElementById('schoolLogoImg');
    if (logoEl && hasValue(data.logo)) {
      logoEl.src = data.logo;
      logoEl.onerror = () => {
        logoEl.src = `https://ui-avatars.com/api/?background=e0e7ff&color=4f46e5&name=${encodeURIComponent(safeVal(data.name) || 'S')}&size=80`;
      };
    }
  } catch (err) {
    console.warn('[StudentPortal] School header load failed:', err);
  }
}

// ─────────────────────────────────── Class name resolver ─────────────────────
async function resolveClassName(schoolId, classId) {
  if (!classId) return '';
  try {
    if (schoolId) {
      const snap = await getDoc(doc(db, 'schools', schoolId, 'classes', classId));
      if (snap.exists()) return safeVal(snap.data().name || snap.data().className);
    }
    const snap2 = await getDoc(doc(db, 'classes', classId));
    if (snap2.exists()) return safeVal(snap2.data().name || snap2.data().className);
  } catch (err) {
    console.warn('[StudentPortal] Class name resolve failed:', err);
  }
  return '';
}

// ─────────────────────────────────── Hero card ───────────────────────────────
function renderHero(student) {
  const container = document.getElementById('heroContainer');
  if (!container) return;

  const name    = safeVal(student?.name) || 'Student';
  const cls     = resolvedClassName || safeVal(student?.classId) || '';
  const admNum  = safeVal(student?.admissionNumber);

  const passportUrl = safeVal(student?.passport);
  const fallback    = `https://ui-avatars.com/api/?background=4f46e5&color=fff&name=${encodeURIComponent(name)}&size=100`;
  const photoSrc    = passportUrl || fallback;

  container.innerHTML = `
    <div class="hero-card">
      <img
        src="${photoSrc}"
        class="student-photo"
        alt="Passport photo"
        onerror="this.onerror=null;this.src='${fallback}'"
      >
      <div class="hero-info">
        <h2>${greeting()}, ${name}</h2>
        <div class="hero-meta">
          ${cls    ? `<span>📚 ${cls}</span>`    : ''}
          ${admNum ? `<span>🎓 ${admNum}</span>` : ''}
        </div>
      </div>
    </div>`;
}

// ─────────────────────────────────── Profile tab ─────────────────────────────
function renderProfile(student) {
  const container = document.getElementById('profileTab');
  if (!container) return;
  if (!student) {
    container.innerHTML = '<div class="card">No profile data available.</div>';
    return;
  }

  const item = (label, value) => `
    <div class="info-item">
      <div class="info-label">${label}</div>
      <div class="info-value">${safeVal(value)}</div>
    </div>`;

  const cls      = resolvedClassName || safeVal(student.classId);
  const calLabel = getCalendarDisplay();

  container.innerHTML = `
    <div class="info-grid">
      ${item('Full Name',           student.name)}
      ${item('Gender',              student.gender)}
      ${item('Date of Birth',       student.dob)}
      ${item('Admission No',        student.admissionNumber)}
      ${item('Class',               cls)}
      ${item('Session / Term',      calLabel)}
      ${item('Parent / Guardian',   student.parentName || student.parentDetails)}
      ${item('Parent Phone',        student.parentPhone)}
      ${item('Parent Email',        student.parentEmail)}
      ${item('Address',             student.address)}
      ${item('State',               student.state)}
      ${item('Nationality',         student.nationality)}
      ${item('Religion',            student.religion)}
      ${item('House',               student.house)}
    </div>`;
}

// ─────────────────────────────────── Attendance tab ──────────────────────────
/**
 * Renders aggregated attendance summary.
 * Displays:
 *   - Term Present / Term Absent totals
 *   - Weekly attendance for the most recent week (Mon–Fri, M & A → up to 10 marks)
 */
function renderAttendance(records) {
  const container = document.getElementById('attendanceTab');
  if (!container) return;

  if (!records.length) {
    container.innerHTML = `
      <div class="card" style="padding:1.5rem;text-align:center;color:var(--gray-500);">
        No attendance records found for the current term/session.
      </div>`;
    return;
  }

  // Total present/absent for the whole term
  let present = 0, absent = 0;
  records.forEach(r => r.status === 'present' ? present++ : absent++);
  const total  = records.length;
  const pct    = total === 0 ? 0 : ((present / total) * 100).toFixed(1);

  // Weekly attendance: group by weekNumber, pick the most recent week
  const weeksMap = new Map(); // weekNumber -> { presentCount, totalCount }
  records.forEach(rec => {
    const week = rec.weekNumber;
    if (!weeksMap.has(week)) {
      weeksMap.set(week, { present: 0, total: 0 });
    }
    const weekData = weeksMap.get(week);
    weekData.total++;
    if (rec.status === 'present') weekData.present++;
  });

  // Find the week with the largest number (most recent)
  let latestWeek = -1;
  let latestWeekData = null;
  for (const [week, data] of weeksMap.entries()) {
    if (week > latestWeek) {
      latestWeek = week;
      latestWeekData = data;
    }
  }

  let weeklyHtml = '';
  if (latestWeekData) {
    const weeklyPresent = latestWeekData.present;
    const weeklyTotal   = latestWeekData.total;
    // A full week has 10 possible marks (Mon-Fri, M & A)
    const maxPossible   = 10;
    weeklyHtml = `
      <div class="attendance-meta-card">
        <div class="info-label">Weekly Attendance (Week ${latestWeek})</div>
        <div class="info-value" style="margin-top:0.3rem">
          ${weeklyPresent} present out of ${weeklyTotal} recorded this week
          <span style="color:var(--gray-400);font-size:0.8rem">
            (Mon–Fri, M & A — max ${maxPossible})
          </span>
        </div>
      </div>`;
  } else {
    weeklyHtml = `
      <div class="attendance-meta-card">
        <div class="info-label">Weekly Attendance</div>
        <div class="info-value">No weekly data available</div>
      </div>`;
  }

  container.innerHTML = `
    <div class="summary-stats">
      <div class="stat-badge">
        <div class="number">${present}</div>
        <div>Term Present</div>
      </div>
      <div class="stat-badge">
        <div class="number">${absent}</div>
        <div>Term Absent</div>
      </div>
      <div class="stat-badge">
        <div class="number">${pct}%</div>
        <div>Attendance Rate</div>
      </div>
    </div>

    <div class="attendance-progress">
      <div class="attendance-progress-bar" style="width:${pct}%"></div>
    </div>
    <div class="attendance-pct-label">${pct}% attendance this term</div>

    <div class="attendance-meta-grid">
      ${weeklyHtml}
      <div class="attendance-meta-card">
        <div class="info-label">Term Total</div>
        <div class="info-value" style="margin-top:0.3rem">
          ${total} attendance record${total !== 1 ? 's' : ''} this term
        </div>
      </div>
    </div>`;
}

// ─────────────────────────────────── Subjects tab ────────────────────────────
function renderSubjects(subjects) {
  const container = document.getElementById('subjectsTab');
  if (!container) return;

  if (!subjects.length) {
    container.innerHTML = '<div class="card" style="padding:1.2rem">No subjects assigned for this term.</div>';
    return;
  }

  const subjectNames = subjects.map(sub => safeVal(sub.name || sub.subjectName) || '—');
  const listHtml = `
    <div class="card" style="padding:1.2rem">
      <h3>📚 Subjects</h3>
      <ul class="subject-list" style="margin-top:0.75rem; list-style-type: disc; padding-left: 1.5rem;">
        ${subjectNames.map(name => `<li>${name}</li>`).join('')}
      </ul>
    </div>`;
  container.innerHTML = listHtml;
}

// ─────────────────────────────────── Assignments tab ─────────────────────────
function renderAssignments(assignments) {
  const container = document.getElementById('assignmentsTab');
  if (!container) return;
  if (!assignments.length) {
    container.innerHTML = '<div class="card">📭 No assignments available at the moment.</div>';
    return;
  }
  const cards = assignments.map(a => `
    <div class="stat-card" style="margin-bottom:1rem;text-align:left">
      <h4>${safeVal(a.title) || 'Untitled'}</h4>
      <p>
        <strong>Subject:</strong> ${safeVal(a.subject)} &nbsp;|&nbsp;
        <strong>Due:</strong> ${safeVal(a.dueDate) || 'No date set'}
      </p>
      <p>
        <strong>Status:</strong>
        <span style="color:${a.status === 'submitted' ? 'green' : 'orange'}">
          ${safeVal(a.status) || 'pending'}
        </span>
      </p>
      <p><em>Remarks: ${safeVal(a.remarks) || '—'}</em></p>
    </div>`).join('');
  container.innerHTML = `<div>${cards}</div>`;
}

// ─────────────────────────────────── Results section ─────────────────────────
function gradeClass(g) {
  if (!g) return '';
  switch (String(g).trim().toUpperCase()[0]) {
    case 'A': return 'grade-A';
    case 'B': return 'grade-B';
    case 'C': return 'grade-C';
    default:  return 'grade-D';
  }
}

const SCORE_COLS = [
  { key: 'ca',    label: 'C.A'   },
  { key: 'exam',  label: 'Exam'  },
  { key: 'total', label: 'Total' },
  { key: 'grade', label: 'Grade' },
];

function renderResultsSection(student, resultsArray) {
  const summaryEl = document.getElementById('resultsSummaryContainer');
  const tableEl   = document.getElementById('resultsTableContainer');
  if (!summaryEl || !tableEl) return;

  if (!student) {
    summaryEl.innerHTML = '<div class="card">No student data available.</div>';
    tableEl.innerHTML   = '<p>No results available.</p>';
    return;
  }

  summaryEl.innerHTML = `
    <div class="stat-badge">
      <div class="number">${safeVal(student.currentAverage) || '—'}</div>
      <div>Average Score</div>
    </div>
    <div class="stat-badge">
      <div class="number">${subjectsList.length}</div>
      <div>Subjects</div>
    </div>
    <div class="stat-badge">
      <div class="number">${safeVal(student.classPosition) || 'N/A'}</div>
      <div>Position</div>
    </div>`;

  const data = resultsArray.length
    ? resultsArray
    : subjectsList.map(s => ({
        name:  s.name || s.subjectName,
        ca:    s.ca,
        exam:  s.exam  || s.examScore,
        total: s.total || s.average,
        grade: s.grade
      }));

  if (!data.length) {
    tableEl.innerHTML = '<p style="color:var(--gray-500)">No result data available for this term.</p>';
    return;
  }

  const activeCols = SCORE_COLS.filter(col => data.some(r => hasValue(r[col.key])));
  const thCells    = ['<th>Subject</th>', ...activeCols.map(c => `<th>${c.label}</th>`)].join('');
  const rows = data.map(r => {
    const cells = activeCols.map(col => {
      if (col.key === 'grade') {
        const g = safeVal(r.grade);
        return `<td>${g ? `<span class="${gradeClass(g)}">${g}</span>` : ''}</td>`;
      }
      return `<td>${safeVal(r[col.key])}</td>`;
    }).join('');
    return `<tr><td>${safeVal(r.name || r.subjectName) || '—'}</td>${cells}</tr>`;
  }).join('');

  tableEl.innerHTML = `
    <div class="table-responsive-wrapper">
      <table class="data-table">
        <thead><tr>${thCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ─────────────────────────────────── Notifications ───────────────────────────
function renderNotifications(notifs) {
  const container = document.getElementById('notificationList');
  if (!container) return;
  if (!notifs.length) {
    container.innerHTML = '<div class="empty-notification">✨ No new notifications</div>';
    return;
  }
  container.innerHTML = notifs.map(n => {
    const time = n.timestamp?.toDate?.()?.toLocaleString() || '';
    return `
      <div class="notification-item">
        🔔 ${safeVal(n.message) || 'Update'}
        ${time ? `<br><small>${time}</small>` : ''}
      </div>`;
  }).join('');
}

function initNotificationBell() {
  const bell     = document.getElementById('notificationBell');
  const dropdown = document.getElementById('notificationDropdown');
  if (!bell || !dropdown) return;
  bell.addEventListener('click', e => { e.stopPropagation(); dropdown.classList.toggle('show'); });
  document.addEventListener('click', e => {
    if (!bell.contains(e.target) && !dropdown.contains(e.target))
      dropdown.classList.remove('show');
  });
}

// ─────────────────────────────────── Subject resolver (with scores for Results) ──────────────────
async function resolveSubjects(rawSubjects) {
  if (!Array.isArray(rawSubjects) || rawSubjects.length === 0) return [];

  let resolved = [];
  const first  = rawSubjects[0];

  if (typeof first === 'string') {
    const promises = rawSubjects.map(async (id) => {
      try {
        const snap = await getDoc(doc(db, 'subjects', id));
        const d    = snap.exists() ? snap.data() : {};
        return {
          id,
          name:  safeVal(d.name || d.subjectName) || id,
          ca:    null, exam: null, total: null, grade: null
        };
      } catch {
        return { id, name: id, ca: null, exam: null, total: null, grade: null };
      }
    });
    resolved = await Promise.all(promises);
  } else if (typeof first === 'object' && first !== null) {
    resolved = rawSubjects.map(s => ({
      id:    safeVal(s.id || s.subjectId),
      name:  safeVal(s.name || s.subjectName) || '—',
      ca:    s.ca    ?? null,
      exam:  s.exam  ?? null,
      total: s.total ?? null,
      grade: s.grade ?? null,
    }));
  }

  if (currentStudentId && currentSchoolId) {
    try {
      const scoresSnap = await getDocs(query(
        collection(db, 'scores'),
        where('studentId', '==', currentStudentId),
        where('schoolId',  '==', currentSchoolId)
      ));
      if (!scoresSnap.empty) {
        const scoresMap = {};
        scoresSnap.docs.forEach(d => {
          const sd  = d.data();
          const key = safeVal(sd.subjectId || sd.subject);
          if (key) scoresMap[key] = sd;
        });
        resolved = resolved.map(sub => {
          const sc = scoresMap[sub.id] || scoresMap[sub.name] || {};
          return {
            ...sub,
            ca:    sub.ca    ?? sc.ca    ?? sc.caScore    ?? null,
            exam:  sub.exam  ?? sc.exam  ?? sc.examScore  ?? null,
            total: sub.total ?? sc.total ?? sc.totalScore ?? null,
            grade: sub.grade ?? sc.grade ?? null,
          };
        });
      }
    } catch (err) {
      console.warn('[StudentPortal] Scores supplement failed:', err);
    }
  }
  return resolved;
}

// ─────────────────────────────────── Master data loader ──────────────────────
async function loadStudentDashboard() {
  const user = auth.currentUser;
  if (!user) return;
  currentStudentId = user.uid;

  try {
    const userSnap = await getDoc(doc(db, 'users', user.uid));
    if (!userSnap.exists()) throw new Error('User document not found');
    const userData = userSnap.data();
    if (userData.role !== 'student') throw new Error('Not a student account');
    currentSchoolId = userData.schoolId;
    if (!currentSchoolId) throw new Error('No schoolId linked to user');
    localStorage.setItem('userSchoolId', currentSchoolId);
  } catch (err) {
    console.error('[StudentPortal] User/school resolve failed:', err);
    document.getElementById('profileTab').innerHTML =
      `<div class="card">⚠️ ${err.message}</div>`;
    return;
  }

  try {
    const snap = await getDoc(doc(db, 'students', currentStudentId));
    if (!snap.exists()) throw new Error('Student profile not found');
    currentStudentData = snap.data();
  } catch (err) {
    console.warn('[StudentPortal] Student profile load failed:', err);
    currentStudentData = null;
    document.getElementById('profileTab').innerHTML =
      `<div class="card">⚠️ ${err.message}</div>`;
  }

  try {
    const classId = safeVal(currentStudentData?.classId);
    if (classId) resolvedClassName = await resolveClassName(currentSchoolId, classId);
  } catch (err) {
    console.warn('[StudentPortal] Class name resolve failed:', err);
    resolvedClassName = '';
  }

  loadSchoolHeader(currentSchoolId).catch(err =>
    console.warn('[StudentPortal] School header silently failed:', err)
  );

  // Attendance parsing (same as before, unchanged)
  attendanceRecords = [];
  try {
    const classId = safeVal(currentStudentData?.classId);
    let snap = null;
    if (currentSchoolId && classId) {
      snap = await getDocs(query(
        collection(db, 'attendance'),
        where('schoolId',  '==', currentSchoolId),
        where('studentId', '==', currentStudentId),
        where('classId',   '==', classId)
      ));
    }
    if (!snap || snap.empty) {
      snap = await getDocs(collection(db, 'students', currentStudentId, 'attendance'));
    }

    for (const docSnap of (snap?.docs || [])) {
      const data = docSnap.data();
      const docSession = data.academicSession;
      const docTerm    = data.term;
      if (docSession === globalCurrentSession && docTerm === globalCurrentTerm) {
        const days = data.days || {};
        const week = data.weekNumber;
        for (const [day, sessions] of Object.entries(days)) {
          if (sessions && typeof sessions === 'object') {
            if (typeof sessions.M === 'boolean') {
              attendanceRecords.push({
                status: sessions.M ? 'present' : 'absent',
                weekNumber: week,
                day: day,
                session: 'M'
              });
            }
            if (typeof sessions.A === 'boolean') {
              attendanceRecords.push({
                status: sessions.A ? 'present' : 'absent',
                weekNumber: week,
                day: day,
                session: 'A'
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[StudentPortal] Attendance load/parse failed:', err);
    attendanceRecords = [];
  }

  try {
    const rawSubjects = currentStudentData?.subjects;
    subjectsList = await resolveSubjects(rawSubjects);
  } catch (err) {
    console.warn('[StudentPortal] Subjects load failed:', err);
    subjectsList = [];
  }

  try {
    const classId = safeVal(currentStudentData?.classId);
    if (currentSchoolId && classId) {
      let snap = await getDocs(query(
        collection(db, 'assignments'),
        where('schoolId', '==', currentSchoolId),
        where('classId',  '==', classId)
      ));
      if (snap.empty) {
        snap = await getDocs(query(
          collection(db, 'schools', currentSchoolId, 'assignments'),
          where('class', '==', classId)
        ));
      }
      assignmentsList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      assignmentsList = [];
    }
  } catch (err) {
    console.warn('[StudentPortal] Assignments load failed:', err);
    assignmentsList = [];
  }

  try {
    const notifSnap = await getDocs(query(
      collection(db, 'students', currentStudentId, 'notifications'),
      orderBy('timestamp', 'desc'),
      limit(10)
    ));
    notificationsList = notifSnap.docs.map(d => d.data());
  } catch (err) {
    console.warn('[StudentPortal] Notifications load failed:', err);
    notificationsList = [];
  }

  let resultsArr = [];
  try {
    const snap = await getDocs(collection(db, 'students', currentStudentId, 'results'));
    if (!snap.empty) resultsArr = snap.docs.map(d => d.data());
  } catch (err) {
    console.warn('[StudentPortal] Results load failed:', err);
  }

  renderHero(currentStudentData);
  renderProfile(currentStudentData);
  renderAttendance(attendanceRecords);
  renderSubjects(subjectsList);
  renderAssignments(assignmentsList);
  renderResultsSection(currentStudentData, resultsArr);
  renderNotifications(notificationsList);
}

// ─────────────────────────────────── Navigation ──────────────────────────────
function initDesktopNav() {
  document.querySelectorAll('#studentSidebarNav a').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const section = link.getAttribute('data-section');
      if (section === 'cbt')     { window.location.href = '../cbt/html/cbt.html'; return; }
      if (section === 'results') { showSection('results');   return; }
      showSection('dashboard');
    });
  });
}

function initMobileMenu() {
  const hamburger     = document.querySelector('.hamburger-menu');
  const mobileSidebar = document.getElementById('mobileSidebar');
  const overlay       = document.getElementById('overlay');
  const closeBtn      = document.querySelector('.close-sidebar');

  const open  = () => { mobileSidebar?.classList.add('open'); overlay?.classList.add('active'); document.body.style.overflow = 'hidden'; };
  const close = () => { mobileSidebar?.classList.remove('open'); overlay?.classList.remove('active'); document.body.style.overflow = ''; };

  hamburger?.addEventListener('click', open);
  closeBtn?.addEventListener('click',  close);
  overlay?.addEventListener('click',   close);

  document.querySelectorAll('.mobile-sidebar .sidebar-nav a').forEach(link => {
    link.addEventListener('click', () => {
      const section = link.getAttribute('data-section');
      if (section === 'cbt') { window.location.href = '../cbt/html/cbt.html'; return; }
      showSection(section === 'results' ? 'results' : 'dashboard');
      close();
    });
  });

  document.getElementById('mobileLogoutBtn')?.addEventListener('click', logout);
}

// ─────────────────────────────────── Logout ──────────────────────────────────
async function logout() {
  try { await signOut(auth); } catch { /* ignore */ }
  window.location.href = '/';
}

// ─────────────────────────────────── Download stub ───────────────────────────
function initDownload() {
  document.getElementById('downloadResultBtn')?.addEventListener('click', () =>
    alert('Result PDF generation will be available soon.')
  );
}

// ─────────────────────────────────── App entry ───────────────────────────────
onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href = '/'; return; }

  try {
    const userDoc = await getDoc(doc(db, 'users', user.uid));
    if (!userDoc.exists() || userDoc.data().role !== 'student') {
      await signOut(auth);
      window.location.href = '/';
      return;
    }

    const schoolId = userDoc.data().schoolId || '';
    localStorage.setItem('userSchoolId', schoolId);
    localStorage.setItem('userRole',     'student');
    localStorage.setItem('studentId',    user.uid);
    currentSchoolId = schoolId;

    initCalendar();
    await loadStudentDashboard();

    initInternalTabs();
    initDesktopNav();
    initMobileMenu();
    initNotificationBell();
    initDownload();
    showSection('dashboard');

    document.getElementById('currentYear').innerText = new Date().getFullYear();
    document.getElementById('logoutBtn')?.addEventListener('click', logout);

  } catch (err) {
    console.error('[StudentPortal] Init error:', err);
    alert('Unable to load dashboard. Please refresh or contact support.');
  }
});