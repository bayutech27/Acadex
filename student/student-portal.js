// student-portal.js
// Attendance tab: aggregates morning/afternoon sessions from Firestore attendance collection.
// Subjects tab: shows only subject names (scores removed, but remain in Results tab).
// Calendar integration: uses academic-calendar.js subscription to get current term/session.
// ADDED: Subscription check for CBT – disables access if school subscription is inactive.

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
  limit,
  onSnapshot,
  updateDoc          // <-- added for passport update
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

// ─── SUBSCRIPTION STATE ─────────────────────────────────────────────────────
let isSchoolSubscriptionActive = true;   // default true until proven otherwise
let unsubscribeSubscription = null;

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

function showNotification(message, type = 'error') {
  // Simple alert for now – can be upgraded to toast later
  alert(message);
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

// ───────────────────────────── Passport photo edit ─────────────────────────
// Inject minimal camera-icon styles (once)
function injectPassportStyles() {
  if (document.getElementById('passport-edit-styles')) return;
  const style = document.createElement('style');
  style.id = 'passport-edit-styles';
  style.textContent = `
    .student-photo-wrapper {
      position: relative;
      display: inline-block;
      cursor: pointer;
    }
    .student-photo-wrapper .camera-icon {
      position: absolute;
      bottom: 6px;
      right: 6px;
      background: rgba(0,0,0,0.5);
      color: #fff;
      border-radius: 50%;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      transition: background 0.2s;
    }
    .student-photo-wrapper .camera-icon:hover {
      background: rgba(0,0,0,0.75);
    }
    .passport-menu {
      position: absolute;
      top: 32px;
      right: 0;
      background: #fff;
      border: 1px solid var(--gray-300, #ddd);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      z-index: 1000;
      min-width: 160px;
    }
    .passport-menu button {
      display: block;
      width: 100%;
      padding: 10px 14px;
      border: none;
      background: none;
      text-align: left;
      font-size: 14px;
      cursor: pointer;
      color: var(--gray-800, #333);
    }
    .passport-menu button:hover {
      background: var(--gray-100, #f5f5f5);
    }
  `;
  document.head.appendChild(style);
}

function openPassportMenu(e, photoWrapper) {
  e.stopPropagation();
  // Remove any existing menu
  const existing = document.querySelector('.passport-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'passport-menu';
  menu.innerHTML = `
    <button id="uploadFromDeviceBtn"><i class="fas fa-upload"></i> Upload from device</button>
  `;
  photoWrapper.style.position = 'relative';
  photoWrapper.appendChild(menu);

  const closeMenu = () => { menu.remove(); document.removeEventListener('click', outsideClick); };
  const outsideClick = (ev) => { if (!menu.contains(ev.target) && ev.target !== photoWrapper.querySelector('.camera-icon')) closeMenu(); };
  document.addEventListener('click', outsideClick);

  document.getElementById('uploadFromDeviceBtn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeMenu();
    triggerFileInput();
  });
}

function triggerFileInput() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    handlePassportFile(file);
  };
  input.click();
}

async function handlePassportFile(file) {
  try {
    let processed = file;
    // Compress if file size > 950 KB
    if (file.size > 950 * 1024) {
      processed = await compressImage(file, 900, 950);
    }
    const base64 = await fileToBase64(processed);
    // Save to Firestore
    await updateDoc(doc(db, 'students', currentStudentId), { passport: base64 });
    // Update local data and re-render hero
    currentStudentData.passport = base64;
    renderHero(currentStudentData);
  } catch (err) {
    console.error('Passport update failed:', err);
    showNotification('Failed to update photo. Please try again.', 'error');
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function compressImage(file, targetKB, thresholdKB) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;
      // max dimension to keep reasonable quality
      const MAX_DIM = 1200;
      if (width > MAX_DIM || height > MAX_DIM) {
        if (width > height) {
          height = Math.round((height * MAX_DIM) / width);
          width = MAX_DIM;
        } else {
          width = Math.round((width * MAX_DIM) / height);
          height = MAX_DIM;
        }
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      let quality = 0.8;
      const tryCompress = (q) => {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Compression failed'));
            return;
          }
          if (blob.size <= targetKB * 1024 || q <= 0.2) {
            resolve(blob);
          } else {
            tryCompress(q - 0.1);
          }
        }, 'image/jpeg', q);
      };
      tryCompress(quality);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
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

  // Ensure camera styles are injected
  injectPassportStyles();

  container.innerHTML = `
    <div class="hero-card">
      <div class="student-photo-wrapper">
        <img
          src="${photoSrc}"
          class="student-photo"
          alt="Passport photo"
          onerror="this.onerror=null;this.src='${fallback}'"
        >
        <i class="fas fa-camera camera-icon"></i>
      </div>
      <div class="hero-info">
        <h2>${greeting()}, ${name}</h2>
        <div class="hero-meta">
          ${cls    ? `<span>📚 ${cls}</span>`    : ''}
          ${admNum ? `<span>🎓 ${admNum}</span>` : ''}
        </div>
      </div>
    </div>`;

  // Attach click handler for camera icon (delegated)
  const cameraIcon = container.querySelector('.camera-icon');
  if (cameraIcon) {
    cameraIcon.addEventListener('click', (e) => {
      const wrapper = container.querySelector('.student-photo-wrapper');
      openPassportMenu(e, wrapper);
    });
  }
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
    return `<tr><td class="subject-name-cell">${safeVal(r.name || r.subjectName) || '—'}</td>${cells}</tr>`;
  }).join('');

  tableEl.innerHTML = `
    <div class="table-responsive-wrapper">
      <table class="data-table">
        <thead><tr>${thCells}</td></thead>
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

// ─────────────────────────────────── Subscription listener (REAL-TIME) ───────
function initSubscriptionListener(schoolId) {
  if (!schoolId) return;
  if (unsubscribeSubscription) unsubscribeSubscription();

  const subDocRef = doc(db, 'schools', schoolId, 'subscription', 'current');
  unsubscribeSubscription = onSnapshot(subDocRef,
    (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        const locked = data.locked === true || data.locked === 'true';
        const status = data.status || '';
        const isInactive = status === 'inactive' || status === 'expired';
        isSchoolSubscriptionActive = !(locked || isInactive);
      } else {
        // No subscription document → treat as inactive
        isSchoolSubscriptionActive = false;
      }
      console.log(`[Subscription] Active: ${isSchoolSubscriptionActive}`);
    },
    (err) => {
      console.error('[Subscription] Listener error:', err);
      isSchoolSubscriptionActive = false;
    }
  );
}

// ─────────────────────────────────── CBT navigation with subscription check ───
function attachCbtClickHandlers() {
  const cbtLinks = document.querySelectorAll('[data-section="cbt"]');
  cbtLinks.forEach(link => {
    // Remove any existing inline listeners (by cloning) to avoid duplicates
    const newLink = link.cloneNode(true);
    link.parentNode.replaceChild(newLink, link);
    newLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (!isSchoolSubscriptionActive) {
        showNotification('School subscription is inactive or has expired. Please contact the administrator to renew.', 'error');
        return;
      }
      const schoolId = localStorage.getItem('userSchoolId');
      const studentId = localStorage.getItem('studentId');
      if (!schoolId || !studentId) {
        showNotification('Unable to access CBT. Please log out and log in again.', 'error');
        return;
      }
      window.location.href = '../cbt/html/cbt.html';
    });
  });
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
    // Start listening to subscription status
    initSubscriptionListener(currentSchoolId);
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
      if (section === 'cbt')     return; // handled by attachCbtClickHandlers
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
      if (section === 'cbt') return; // handled by attachCbtClickHandlers
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

    // Attach CBT click handlers (replaces inline script logic)
    attachCbtClickHandlers();

    document.getElementById('currentYear').innerText = new Date().getFullYear();
    document.getElementById('logoutBtn')?.addEventListener('click', logout);

  } catch (err) {
    console.error('[StudentPortal] Init error:', err);
    alert('Unable to load dashboard. Please refresh or contact support.');
  }
});