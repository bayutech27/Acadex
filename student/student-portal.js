// student-portal.js (inside student folder)
// Attendance tab: aggregates morning/afternoon sessions from Firestore attendance collection.
// Subjects tab: shows only subject names (scores removed, but remain in Results tab).
// Calendar integration: uses academic-calendar.js subscription to get current term/session.
// ADDED: Subscription check for CBT – disables access if school subscription is inactive.
// NOTIFICATIONS: real‑time from Firestore 'cbt' and 'scores' collections.
//   * Scores: subjectName, CA, Exam.
//   * CBT: subjectName, type, teacher name (fetched), scheduled date, status (started/assigned).
//   * Badge shows unread count based on a localStorage lastSeen timestamp.
//   * Dropdown holds the 10 latest items, styled beautifully.
//
// MODIFIED: Results tab now shows assigned CBT scores from test_results collection.
//   Columns: Subject, Score, Term/Session, Date.
//
// All Firestore operations go through service.js where possible.
// TODO: service.js does not yet support test_results queries, real-time scores/cbt listeners,
// attachment of custom listeners for notifications – those remain as direct Firestore calls.
// All user-facing errors now show clear, friendly messages without technical jargon.

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
  updateDoc
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

import { subscribeToCalendar } from '../js/academic-calendar.js';
import { syncAcademicCalendar, startPeriodicSync } from '../js/calendar-sync.js';
import * as service from '../js/service.js';
import { toast } from '../js/error-handler.js';
import { enforcePasswordChange } from '../js/security.js';   // NEW

// ─────────────────────────────────── Global state ────────────────────────────
let currentStudentData = null;
let currentSchoolId    = null;
let currentStudentId   = null;
let resolvedClassName  = '';
let attendanceRecords  = [];
let subjectsList       = [];
let assignmentsList    = [];

// Notification state
let unsubscribeCBT = null;
let unsubscribeScores = null;
let mergedNotifications = [];

// Teacher name cache
const teacherNameCache = new Map();

// Calendar state
let globalCurrentTerm    = '';
let globalCurrentSession = '';

// Subscription state
let isSchoolSubscriptionActive = true;
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

// ─────────────────────────────────── Calendar ────────────────────────────────
function initCalendar() {
  syncAcademicCalendar().catch(err => console.warn('[StudentPortal] Calendar sync failed:', err));
  startPeriodicSync(60);
  subscribeToCalendar(state => {
    globalCurrentTerm    = state.currentTerm    || '';
    globalCurrentSession = state.currentSession || '';
    const termEl = document.getElementById('currentTermDisplay');
    const sessEl = document.getElementById('currentSessionDisplay');
    if (termEl) termEl.innerText = globalCurrentTerm || '—';
    if (sessEl) sessEl.innerText = globalCurrentSession || '—';
    if (currentStudentData) renderProfile(currentStudentData);
  });
}

function getCalendarDisplay() {
  const t = globalCurrentTerm && globalCurrentTerm !== '—' ? globalCurrentTerm : '';
  const s = globalCurrentSession && globalCurrentSession !== '—' ? globalCurrentSession : '';
  if (!t && !s) return '';
  return t ? (s ? `${t} — ${s}` : t) : s;
}

// ─────────────────────────────────── Section toggle ──────────────────────────
function showSection(sectionId) {
  document.getElementById('dashboardSection').style.display = sectionId === 'dashboard' ? 'block' : 'none';
  document.getElementById('resultsSection').style.display  = sectionId === 'results'   ? 'block' : 'none';
  document.querySelectorAll('#studentSidebarNav a, .mobile-sidebar .sidebar-nav a').forEach(link => {
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

// ─────────────────────────────────── School header (using service) ───────────
async function loadSchoolHeader(schoolId) {
  if (!schoolId) return;
  try {
    const school = await service.getSchoolById(schoolId);
    if (!school) return;
    const nameEl = document.getElementById('schoolName');
    if (nameEl) nameEl.innerText = safeVal(school.name) || 'School Name';
    const addrEl = document.getElementById('schoolAddress');
    if (addrEl) addrEl.innerText = safeVal(school.address);
    const logoEl = document.getElementById('schoolLogoImg');
    if (logoEl && hasValue(school.logo)) {
      logoEl.src = school.logo;
      logoEl.onerror = () => { logoEl.src = `https://ui-avatars.com/api/?background=e0e7ff&color=4f46e5&name=${encodeURIComponent(safeVal(school.name)||'S')}&size=80`; };
    }
  } catch (err) {
    console.warn('[StudentPortal] School header failed:', err);
    toast.warning('Unable to load school information. Please refresh the page.');
  }
}

// ─────────────────────────────────── Class name resolver (using service) ─────
async function resolveClassName(schoolId, classId) {
  if (!classId) return '';
  try {
    const classData = await service.getClassById(classId);
    if (classData) return safeVal(classData.name || classData.className);
  } catch (err) { 
    console.warn('[StudentPortal] Class name fail:', err); 
    toast.warning('Unable to load class name. Please refresh.');
  }
  return '';
}

// ───────────────────────────── Passport photo edit (using service.updateStudent) ──
function injectPassportStyles() {
  if (document.getElementById('passport-edit-styles')) return;
  const style = document.createElement('style');
  style.id = 'passport-edit-styles';
  style.textContent = `
    .student-photo-wrapper { position: relative; display: inline-block; cursor: pointer; }
    .student-photo-wrapper .camera-icon { position: absolute; bottom: 6px; right: 6px; background: rgba(0,0,0,0.5); color: #fff; border-radius: 50%; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; font-size: 14px; transition: background 0.2s; }
    .student-photo-wrapper .camera-icon:hover { background: rgba(0,0,0,0.75); }
    .passport-menu { position: absolute; top: 32px; right: 0; background: #fff; border: 1px solid #ddd; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); z-index: 1000; min-width: 160px; }
    .passport-menu button { display: block; width: 100%; padding: 10px 14px; border: none; background: none; text-align: left; font-size: 14px; cursor: pointer; color: #333; }
    .passport-menu button:hover { background: #f5f5f5; }
  `;
  document.head.appendChild(style);
}

function openPassportMenu(e, photoWrapper) {
  e.stopPropagation();
  const existing = document.querySelector('.passport-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.className = 'passport-menu';
  menu.innerHTML = `<button id="uploadFromDeviceBtn"><i class="fas fa-upload"></i> Upload from device</button>`;
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
  input.onchange = (e) => { const file = e.target.files[0]; if (file) handlePassportFile(file); };
  input.click();
}

async function handlePassportFile(file) {
  try {
    let processed = file;
    if (file.size > 950 * 1024) processed = await compressImage(file, 900, 950);
    const base64 = await fileToBase64(processed);
    await service.updateStudent(currentStudentId, { passport: base64 });
    currentStudentData.passport = base64;
    renderHero(currentStudentData);
  } catch (err) {
    console.error('Passport update failed:', err);
    toast.error('Failed to update photo. Please try again with a smaller image.');
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
      let width = img.width, height = img.height;
      const MAX_DIM = 1200;
      if (width > MAX_DIM || height > MAX_DIM) {
        if (width > height) { height = Math.round((height * MAX_DIM) / width); width = MAX_DIM; }
        else { width = Math.round((width * MAX_DIM) / height); height = MAX_DIM; }
      }
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      let quality = 0.8;
      const tryCompress = (q) => {
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('Compression failed')); return; }
          if (blob.size <= targetKB * 1024 || q <= 0.2) resolve(blob);
          else tryCompress(q - 0.1);
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
  const fallback = `https://ui-avatars.com/api/?background=4f46e5&color=fff&name=${encodeURIComponent(name)}&size=100`;
  const photoSrc = passportUrl || fallback;
  injectPassportStyles();
  container.innerHTML = `
    <div class="hero-card">
      <div class="student-photo-wrapper">
        <img src="${photoSrc}" class="student-photo" alt="Passport photo" onerror="this.onerror=null;this.src='${fallback}'">
        <i class="fas fa-camera camera-icon"></i>
      </div>
      <div class="hero-info">
        <h2>${greeting()}, ${name}</h2>
        <div class="hero-meta">
          ${cls ? `<span>📚 ${cls}</span>` : ''}
          ${admNum ? `<span>🎓 ${admNum}</span>` : ''}
        </div>
      </div>
    </div>`;
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
  const cls = resolvedClassName || safeVal(student.classId);
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

// ─────────────────────────────────── Attendance tab (using service) ──────────
function renderAttendance(records) {
  const container = document.getElementById('attendanceTab');
  if (!container) return;
  if (!records.length) {
    container.innerHTML = '<div class="card" style="padding:1.5rem;text-align:center;color:var(--gray-500);">No attendance records found for the current term/session.</div>';
    return;
  }
  let present = 0, absent = 0;
  records.forEach(r => r.status === 'present' ? present++ : absent++);
  const total = records.length;
  const pct = total === 0 ? 0 : ((present / total) * 100).toFixed(1);

  const weeksMap = new Map();
  records.forEach(rec => {
    const week = rec.weekNumber;
    if (!weeksMap.has(week)) weeksMap.set(week, { present: 0, total: 0 });
    const wd = weeksMap.get(week);
    wd.total++;
    if (rec.status === 'present') wd.present++;
  });
  let latestWeek = -1, latestWeekData = null;
  weeksMap.forEach((data, week) => { if (week > latestWeek) { latestWeek = week; latestWeekData = data; } });
  const weeklyHtml = latestWeekData
    ? `<div class="attendance-meta-card"><div class="info-label">Weekly Attendance (Week ${latestWeek})</div><div class="info-value" style="margin-top:0.3rem">${latestWeekData.present} present out of ${latestWeekData.total} recorded this week</div></div>`
    : `<div class="attendance-meta-card"><div class="info-label">Weekly Attendance</div><div class="info-value">No weekly data</div></div>`;

  container.innerHTML = `
    <div class="summary-stats">
      <div class="stat-badge"><div class="number">${present}</div><div>Term Present</div></div>
      <div class="stat-badge"><div class="number">${absent}</div><div>Term Absent</div></div>
      <div class="stat-badge"><div class="number">${pct}%</div><div>Attendance Rate</div></div>
    </div>
    <div class="attendance-progress"><div class="attendance-progress-bar" style="width:${pct}%"></div></div>
    <div class="attendance-pct-label">${pct}% attendance this term</div>
    <div class="attendance-meta-grid">
      ${weeklyHtml}
      <div class="attendance-meta-card"><div class="info-label">Term Total</div><div class="info-value">${total} record${total!==1?'s':''}</div></div>
    </div>`;
}

// ─────────────────────────────────── Subjects tab (using service) ────────────
function renderSubjects(subjects) {
  const container = document.getElementById('subjectsTab');
  if (!container) return;
  if (!subjects.length) { 
    container.innerHTML = '<div class="card" style="padding:1.2rem">No subjects assigned for this term.</div>'; 
    return; 
  }
  const names = subjects.map(s => safeVal(s.name || s.subjectName) || '—');
  container.innerHTML = `<div class="card" style="padding:1.2rem"><h3>📚 Subjects</h3><ul style="margin-top:0.75rem; list-style-type: disc; padding-left: 1.5rem;">${names.map(n => `<li>${n}</li>`).join('')}</ul></div>`;
}

// ─────────────────────────────────── Assignments tab (using service) ─────────
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
      <p><strong>Subject:</strong> ${safeVal(a.subject)} | <strong>Due:</strong> ${safeVal(a.dueDate) || 'No date set'}</p>
      <p><strong>Status:</strong> <span style="color:${a.status==='submitted'?'green':'orange'}">${safeVal(a.status)||'pending'}</span></p>
      <p><em>Remarks: ${safeVal(a.remarks)||'—'}</em></p>
    </div>`).join('');
  container.innerHTML = `<div>${cards}</div>`;
}

// ======================= CBT SCORES FOR RESULTS TAB (direct Firestore) =======================
async function fetchCbtScores() {
  if (!currentStudentId || !currentSchoolId) return [];
  try {
    const q = query(
      collection(db, 'test_results'),
      where('userId', '==', currentStudentId),
      where('examType', '==', 'CBT'),
      where('mode', '==', 'cbt'),
      orderBy('completedAt', 'desc')
    );
    const snapshot = await getDocs(q);
    const results = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      results.push({
        subject: data.subject || 'Unknown Subject',
        score: data.rawScore ?? data.correctAnswers ?? 0,
        term: data.term || '—',
        session: data.session || '—',
        date: data.completedAt ? data.completedAt.toDate() : null
      });
    });
    return results;
  } catch (err) {
    console.error('[StudentPortal] Failed to fetch CBT scores:', err);
    toast.warning('Unable to load CBT scores. Please refresh the page.');
    return [];
  }
}

async function renderResultsSection() {
  const summaryEl = document.getElementById('resultsSummaryContainer');
  const tableEl   = document.getElementById('resultsTableContainer');
  if (!summaryEl || !tableEl) return;

  summaryEl.innerHTML = '';
  tableEl.innerHTML = '<div style="text-align:center; padding:2rem;"><i class="fa-solid fa-spinner fa-spin"></i> Loading CBT results...</div>';

  try {
    const scores = await fetchCbtScores();

    if (!scores.length) {
      tableEl.innerHTML = `
        <div style="text-align:center; padding:2rem; color: var(--gray-500);">
          <i class="fa-solid fa-clipboard-list" style="font-size:2rem; margin-bottom:0.5rem; display:block;"></i>
          No CBT scores found yet.<br>
          Complete a CBT test to see your results here.
        </div>`;
      return;
    }

    let html = `
      <div class="table-responsive-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Score</th>
              <th>Term / Session</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
    `;

    scores.forEach(item => {
      const dateStr = item.date ? item.date.toLocaleDateString('en-NG', { year:'numeric', month:'short', day:'numeric' }) : '—';
      const termSession = `${item.term} ${item.session}`.trim();
      html += `
        <tr>
          <td class="subject-name-cell">${escapeHtml(item.subject)}</td>
          <td class="score-highlight">${item.score}</td>
          <td>${escapeHtml(termSession || '—')}</td>
          <td>${dateStr}</td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>
      </div>
    `;
    tableEl.innerHTML = html;
  } catch (err) {
    console.error('[StudentPortal] Error rendering CBT results:', err);
    toast.error('Failed to load results. Please try again later.');
    tableEl.innerHTML = '<div class="card" style="color:red; text-align:center;">Failed to load results. Please try again later.</div>';
  }
}

// Helper escape (reused)
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

// ─────────────────────────── NOTIFICATIONS (direct Firestore) ──────────────────
async function fetchTeacherName(teacherId) {
  if (!teacherId) return 'Teacher';
  if (teacherNameCache.has(teacherId)) return teacherNameCache.get(teacherId);
  const promise = (async () => {
    try {
      const teacher = await service.getTeacherById(teacherId);
      return teacher?.name || teacher?.fullName || 'Teacher';
    } catch (err) { 
      console.warn('Teacher fetch error:', err); 
      return 'Teacher'; 
    }
  })();
  teacherNameCache.set(teacherId, promise);
  return promise;
}

function formatScoreMessage(data) {
  const sub = safeVal(data.subjectName) || 'Unknown Subject';
  const parts = [];
  if (data.ca !== null && data.ca !== undefined) parts.push(`CA: ${data.ca}`);
  if (data.exam !== null && data.exam !== undefined) parts.push(`Exam: ${data.exam}`);
  const scoreText = parts.length ? parts.join(', ') : 'Score updated';
  return `📊 ${sub}: ${scoreText}`.substring(0, 120);
}

function formatCBTMessage(data) {
  const sub = safeVal(data.subjectName) || 'Unknown Subject';
  const type = safeVal(data.type) || 'Test';
  const date = data.scheduledDate
    ? new Date(data.scheduledDate + 'T00:00:00').toLocaleDateString()
    : 'N/A';
  const status = data.status || 'assigned';
  const teacherPlaceholder = `{{teacher_${data.teacherId}}}`;
  if (status === 'started') {
    return { message: `🚀 ${sub} ${type} has started! Scheduled: ${date}`, teacherId: data.teacherId, placeholder: teacherPlaceholder };
  }
  return { message: `📝 New ${sub} ${type} assigned by ${teacherPlaceholder} — ${date}`, teacherId: data.teacherId, placeholder: teacherPlaceholder };
}

function renderNotifications(notifs) {
  const container = document.getElementById('notificationList');
  if (!container) return;
  if (!notifs.length) {
    container.innerHTML = '<div class="empty-notification"><i class="fa-regular fa-bell-slash"></i> No notifications</div>';
    return;
  }
  container.innerHTML = notifs.map(n => {
    const icon = n.type === 'score' ? '📊' : '📝';
    const borderClass = n.type === 'score' ? 'score' : 'cbt';
    return `
      <div class="notification-item" data-type="${borderClass}">
        <span class="notif-icon">${icon}</span>
        <div class="notif-body">
          <div class="notif-text">${n.message || 'Update'}</div>
          ${n.meta ? `<div class="notif-meta">${n.meta}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

function updateBadgeFromMerged() {
  const badge = document.getElementById('notificationBadge');
  if (!badge) return;
  const lastSeen = parseInt(localStorage.getItem('notificationLastSeen') || '0', 10);
  const unread = mergedNotifications.filter(item => item.timestampMillis > lastSeen).length;
  if (unread > 0) {
    badge.textContent = unread;
    badge.style.display = 'flex';
  } else {
    badge.textContent = '';
    badge.style.display = 'none';
  }
}

function processScoreDocs(scoreDocs) {
  return scoreDocs.map(docSnap => {
    const data = docSnap.data();
    const timestamp = data.updatedAt || data.createdAt;
    const millis = timestamp ? timestamp.toDate().getTime() : 0;
    const message = formatScoreMessage(data);
    return {
      id: `score-${docSnap.id}`,
      type: 'score',
      message,
      meta: '',
      timestampMillis: millis,
      teacherPlaceholder: null
    };
  });
}

function processCBTDocs(cbtDocs) {
  const items = [];
  const fetchPromises = [];

  cbtDocs.forEach(docSnap => {
    const data = docSnap.data();
    const timestamp = data.updatedAt || data.createdAt;
    const millis = timestamp ? timestamp.toDate().getTime() : 0;
    const formatted = formatCBTMessage(data);
    const teacherId = formatted.teacherId;

    const item = {
      id: `cbt-${docSnap.id}`,
      type: 'cbt',
      message: formatted.message,
      meta: '',
      timestampMillis: millis,
      teacherId,
      placeholder: formatted.placeholder
    };
    items.push(item);

    if (teacherId && formatted.message.includes(formatted.placeholder)) {
      if (!teacherNameCache.has(teacherId)) {
        teacherNameCache.set(teacherId, fetchTeacherName(teacherId));
      }
      const promise = teacherNameCache.get(teacherId).then(name => {
        item.message = item.message.replace(item.placeholder, name);
        item.teacherResolved = true;
      });
      fetchPromises.push(promise);
    }
  });

  return { items, fetchPromises };
}

function mergeAndRender(cbtDocs, scoreDocs) {
  const scoreItems = processScoreDocs(scoreDocs);
  const { items: cbtItems, fetchPromises } = processCBTDocs(cbtDocs);

  Promise.all(fetchPromises).then(() => {
    const all = [...scoreItems, ...cbtItems];
    all.sort((a, b) => b.timestampMillis - a.timestampMillis);
    mergedNotifications = all.slice(0, 10);
    renderNotifications(mergedNotifications);
    updateBadgeFromMerged();
  }).catch(err => {
    console.warn('Teacher name fetch error:', err);
    const all = [...scoreItems, ...cbtItems];
    all.sort((a, b) => b.timestampMillis - a.timestampMillis);
    mergedNotifications = all.slice(0, 10);
    renderNotifications(mergedNotifications);
    updateBadgeFromMerged();
  });
}

function setupNotificationListeners(classId, studentId) {
  if (!studentId) return;
  if (unsubscribeCBT) { unsubscribeCBT(); unsubscribeCBT = null; }
  if (unsubscribeScores) { unsubscribeScores(); unsubscribeScores = null; }

  const scoresQuery = query(
    collection(db, 'scores'),
    where('studentId', '==', studentId),
    orderBy('updatedAt', 'desc'),
    limit(10)
  );

  const cbtQuery = query(
    collection(db, 'cbt'),
    where('assignedTo', 'array-contains', studentId),
    orderBy('updatedAt', 'desc'),
    limit(10)
  );

  let cbtDocs = [];
  let scoreDocs = [];

  unsubscribeCBT = onSnapshot(cbtQuery, snap => {
    cbtDocs = snap.docs;
    mergeAndRender(cbtDocs, scoreDocs);
  }, err => {
    console.warn('CBT listener error:', err);
    toast.warning('Unable to load test notifications. Please refresh.');
  });

  unsubscribeScores = onSnapshot(scoresQuery, snap => {
    scoreDocs = snap.docs;
    mergeAndRender(cbtDocs, scoreDocs);
  }, err => {
    console.warn('Scores listener error:', err);
    toast.warning('Unable to load score notifications. Please refresh.');
  });
}

// ─────────────────────────────────── Bell click handler ──────────────────────
function initNotificationBell() {
  const bell     = document.getElementById('notificationBell');
  const dropdown = document.getElementById('notificationDropdown');
  if (!bell || !dropdown) return;

  bell.addEventListener('click', e => {
    e.stopPropagation();
    const wasOpen = dropdown.classList.contains('show');
    dropdown.classList.toggle('show');
    if (!wasOpen) {
      localStorage.setItem('notificationLastSeen', Date.now().toString());
      updateBadgeFromMerged();
    }
  });
  document.addEventListener('click', e => {
    if (!bell.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove('show');
    }
  });
}

// ─────────────────────────────────── Subject resolver ────────────────────────
async function resolveSubjects(rawSubjects) {
  if (!Array.isArray(rawSubjects) || rawSubjects.length === 0) return [];
  let resolved = [];
  const first = rawSubjects[0];
  if (typeof first === 'string') {
    const promises = rawSubjects.map(async (id) => {
      try {
        const snap = await getDoc(doc(db, 'subjects', id));
        const d = snap.exists() ? snap.data() : {};
        return { id, name: safeVal(d.name || d.subjectName) || id, ca: null, exam: null, total: null, grade: null };
      } catch { 
        return { id, name: id, ca: null, exam: null, total: null, grade: null }; 
      }
    });
    resolved = await Promise.all(promises);
  } else if (typeof first === 'object' && first !== null) {
    resolved = rawSubjects.map(s => ({
      id: safeVal(s.id || s.subjectId),
      name: safeVal(s.name || s.subjectName) || '—',
      ca: s.ca ?? null, exam: s.exam ?? null, total: s.total ?? null, grade: s.grade ?? null
    }));
  }
  if (currentStudentId && currentSchoolId) {
    try {
      const snap = await getDocs(query(collection(db, 'scores'), where('studentId','==',currentStudentId), where('schoolId','==',currentSchoolId)));
      if (!snap.empty) {
        const scoresMap = {};
        snap.docs.forEach(d => {
          const sd = d.data();
          const key = safeVal(sd.subjectId || sd.subject);
          if (key) scoresMap[key] = sd;
        });
        resolved = resolved.map(sub => {
          const sc = scoresMap[sub.id] || scoresMap[sub.name] || {};
          return {
            ...sub,
            ca: sub.ca ?? sc.ca ?? sc.caScore ?? null,
            exam: sub.exam ?? sc.exam ?? sc.examScore ?? null,
            total: sub.total ?? sc.total ?? sc.totalScore ?? null,
            grade: sub.grade ?? sc.grade ?? null,
          };
        });
      }
    } catch (err) { 
      console.warn('Scores supplement failed:', err); 
      toast.warning('Unable to load score details. Please refresh.');
    }
  }
  return resolved;
}

// ─────────────────────────────────── Subscription listener (using service) ───
function initSubscriptionListener(schoolId) {
  if (!schoolId) return;
  if (unsubscribeSubscription) unsubscribeSubscription();
  unsubscribeSubscription = service.subscribeToSubscription(schoolId, (subData) => {
    if (!subData) {
      isSchoolSubscriptionActive = false;
    } else {
      isSchoolSubscriptionActive = !(subData.locked === true || subData.locked === 'true' || subData.status === 'inactive' || subData.status === 'expired');
    }
  });
}

// ─────────────────────────────────── CBT navigation with sub check ───────────
function attachCbtClickHandlers() {
  const cbtLinks = document.querySelectorAll('[data-section="cbt"]');
  cbtLinks.forEach(link => {
    const newLink = link.cloneNode(true);
    link.parentNode.replaceChild(newLink, link);
    newLink.addEventListener('click', e => {
      e.preventDefault();
      if (!isSchoolSubscriptionActive) {
        toast.error('School subscription is inactive. Please contact your administrator.');
        return;
      }
      const schoolId = localStorage.getItem('userSchoolId');
      const studentId = localStorage.getItem('studentId');
      if (!schoolId || !studentId) {
        toast.error('Unable to access CBT. Please log out and log in again.');
        return;
      }
      window.location.href = '../cbt/html/cbt.html';
    });
  });
}

// ─────────────────────────────────── Master data loader (using service) ──────
async function loadStudentDashboard() {
  const user = auth.currentUser;
  if (!user) return;
  currentStudentId = user.uid;

  try {
    const userData = await service.getUserById(user.uid);
    if (!userData) {
      toast.error('User profile not found. Please log out and log in again.');
      throw new Error('User document not found');
    }
    if (userData.role !== 'student') {
      toast.error('Access denied. Student privileges required.');
      throw new Error('Not a student account');
    }
    currentSchoolId = userData.schoolId;
    if (!currentSchoolId) {
      toast.error('School information missing. Please contact your administrator.');
      throw new Error('No schoolId linked');
    }

    // ---- NEW: enforce password change ----
    try {
      await enforcePasswordChange(window.location.href);
    } catch (e) { /* redirecting */ }

    // ---- NEW: disabled account check ----
    if (userData.disabled) {
      toast.error('Your account has been disabled. Contact the school.');
      await signOut(auth);
      window.location.href = '/';
      return;
    }

    localStorage.setItem('userSchoolId', currentSchoolId);
    initSubscriptionListener(currentSchoolId);
  } catch (err) {
    console.error('[StudentPortal] User/school resolve:', err);
    document.getElementById('profileTab').innerHTML = `<div class="card">⚠️ ${err.message}</div>`;
    return;
  }

  try {
    const student = await service.getStudentById(currentStudentId);
    if (!student) {
      toast.error('Student profile not found. Please contact your administrator.');
      throw new Error('Student profile not found');
    }
    currentStudentData = student;
  } catch (err) {
    console.warn('[StudentPortal] Student profile:', err);
    currentStudentData = null;
    document.getElementById('profileTab').innerHTML = `<div class="card">⚠️ ${err.message}</div>`;
  }

  try {
    const classId = safeVal(currentStudentData?.classId);
    if (classId) resolvedClassName = await resolveClassName(currentSchoolId, classId);
  } catch (err) { 
    console.warn('Class resolve:', err); 
    resolvedClassName = ''; 
  }

  loadSchoolHeader(currentSchoolId).catch(err => console.warn('School header failed:', err));

  attendanceRecords = [];
  try {
    const classId = safeVal(currentStudentData?.classId);
    const term = globalCurrentTerm;
    const session = globalCurrentSession;
    if (currentSchoolId && classId && term && session) {
      const records = await service.getAttendanceByStudent(currentSchoolId, currentStudentId, classId, session, term);
      records.forEach(data => {
        const days = data.days || {};
        const week = data.weekNumber;
        for (const [day, sessions] of Object.entries(days)) {
          if (sessions && typeof sessions === 'object') {
            if (typeof sessions.M === 'boolean') attendanceRecords.push({ status: sessions.M ? 'present' : 'absent', weekNumber: week, day, session: 'M' });
            if (typeof sessions.A === 'boolean') attendanceRecords.push({ status: sessions.A ? 'present' : 'absent', weekNumber: week, day, session: 'A' });
          }
        }
      });
    }
  } catch (err) { 
    console.warn('Attendance load fail:', err); 
    toast.warning('Unable to load attendance data. Please refresh.');
    attendanceRecords = []; 
  }

  try {
    const rawSubjects = currentStudentData?.subjects;
    subjectsList = await resolveSubjects(rawSubjects);
  } catch (err) { 
    console.warn('Subjects fail:', err); 
    subjectsList = []; 
  }

  try {
    const classId = safeVal(currentStudentData?.classId);
    if (currentSchoolId && classId) {
      assignmentsList = await service.getAssignmentsByClass(currentSchoolId, classId);
    } else assignmentsList = [];
  } catch (err) { 
    console.warn('Assignments fail:', err); 
    assignmentsList = []; 
  }

  setupNotificationListeners(safeVal(currentStudentData?.classId), currentStudentId);

  renderHero(currentStudentData);
  renderProfile(currentStudentData);
  renderAttendance(attendanceRecords);
  renderSubjects(subjectsList);
  renderAssignments(assignmentsList);
  await renderResultsSection();
}

// ─────────────────────────────────── Navigation ──────────────────────────────
function initDesktopNav() {
  document.querySelectorAll('#studentSidebarNav a').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const section = link.getAttribute('data-section');
      if (section === 'cbt') return;
      showSection(section === 'results' ? 'results' : 'dashboard');
      if (section === 'results') renderResultsSection();
    });
  });
}

function initMobileMenu() {
  const hamburger = document.querySelector('.hamburger-menu');
  const mobileSidebar = document.getElementById('mobileSidebar');
  const overlay = document.getElementById('overlay');
  const closeBtn = document.querySelector('.close-sidebar');
  const open = () => { mobileSidebar?.classList.add('open'); overlay?.classList.add('active'); document.body.style.overflow = 'hidden'; };
  const close = () => { mobileSidebar?.classList.remove('open'); overlay?.classList.remove('active'); document.body.style.overflow = ''; };
  hamburger?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', close);
  document.querySelectorAll('.mobile-sidebar .sidebar-nav a').forEach(link => {
    link.addEventListener('click', () => {
      const section = link.getAttribute('data-section');
      if (section === 'cbt') return;
      showSection(section === 'results' ? 'results' : 'dashboard');
      if (section === 'results') renderResultsSection();
      close();
    });
  });
  document.getElementById('mobileLogoutBtn')?.addEventListener('click', logout);
}

function cleanupListeners() {
  if (unsubscribeCBT) { unsubscribeCBT(); unsubscribeCBT = null; }
  if (unsubscribeScores) { unsubscribeScores(); unsubscribeScores = null; }
}

async function logout() {
  cleanupListeners();
  try { await signOut(auth); } catch(err) {
    console.error('Logout error:', err);
    toast.error('Logout failed. Please try again.');
  }
  window.location.href = '/';
}

function initDownload() {
  document.getElementById('downloadResultBtn')?.addEventListener('click', () => {
    toast.info('Result PDF generation will be available soon.');
  });
}

// ─────────────────────────────────── App entry ───────────────────────────────
onAuthStateChanged(auth, async user => {
  if (!user) { 
    window.location.href = '/'; 
    return; 
  }
  try {
    const userData = await service.getUserById(user.uid);
    if (!userData || userData.role !== 'student') {
      await signOut(auth);
      window.location.href = '/';
      return;
    }
    const schoolId = userData.schoolId || '';
    localStorage.setItem('userSchoolId', schoolId);
    localStorage.setItem('userRole', 'student');
    localStorage.setItem('studentId', user.uid);
    currentSchoolId = schoolId;

    initCalendar();
    await loadStudentDashboard();

    initInternalTabs();
    initDesktopNav();
    initMobileMenu();
    initNotificationBell();
    initDownload();
    showSection('dashboard');
    attachCbtClickHandlers();
    document.getElementById('currentYear').innerText = new Date().getFullYear();
    document.getElementById('logoutBtn')?.addEventListener('click', logout);
  } catch (err) {
    console.error('[StudentPortal] Init error:', err);
    toast.error('Unable to load dashboard. Please refresh the page.');
  }
});