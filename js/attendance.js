// attendance.js — Acadex Class Attendance Engine
// ─────────────────────────────────────────────────────────────────────────────
// Self-contained module: authenticates the teacher, loads their host class(es),
// fetches / saves attendance records from Firestore (via service layer),
// renders the full attendance table, weekly summary, and term summary.
// Supports teachers assigned as class teacher of multiple classes (hostClassIds array).
// Academic calendar (session + term) comes exclusively from the Central
// Academic Calendar Engine (academic-calendar.js + calendar-sync.js).
// ─────────────────────────────────────────────────────────────────────────────

import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { logoutUser } from './auth.js';
import { showNotification, handleError, showLoader, hideLoader, toast } from './error-handler.js';
import { initMobileMenu } from './menu.js';
import * as service from './service.js';

// Calendar Engine imports
import {
  initAcademicCalendar,
  getCurrentTerm,
  getCurrentSession,
  subscribeToCalendar,
  calculateTermAndSessionFromDate
} from './academic-calendar.js';
import { syncAcademicCalendar, startPeriodicSync } from './calendar-sync.js';

// ═════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═════════════════════════════════════════════════════════════════════════════
const WEEKS        = 15;
const DAYS         = ['mon', 'tue', 'wed', 'thu', 'fri'];
const DAY_LABELS   = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri' };
const PERIODS      = ['M', 'A'];
const MAX_BATCH    = 490;

// ═════════════════════════════════════════════════════════════════════════════
// CENTRALIZED STATE
// ═════════════════════════════════════════════════════════════════════════════
const STATE = {
  teacher:    { id: null, schoolId: null, hostClassIds: [], name: null },
  academic:   { session: null, term: null },
  school:     { id: null, name: null, address: null, logo: null },
  class:      { id: null, name: null },
  students:   [],
  stats:      { boys: 0, girls: 0, total: 0 },
  attendance: {},
  modified:   new Set(),
  stopSync:   null,
  initialized: false
};

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════
function attKey(studentId, week) {
  return `${studentId}_w${week}`;
}

function firestoreDocId(classId, studentId, week, term, session) {
  const safeTerm    = term.replace(/\s+/g, '-').toLowerCase();
  const safeSession = session.replace('/', '-');
  return `${classId}_${studentId}_w${week}_${safeTerm}_${safeSession}`;
}

function getVal(studentId, week, day, period) {
  return STATE.attendance[attKey(studentId, week)]?.[day]?.[period] ?? false;
}

function setVal(studentId, week, day, period, value) {
  const key = attKey(studentId, week);
  if (!STATE.attendance[key]) {
    STATE.attendance[key] = {
      mon: { M: false, A: false }, tue: { M: false, A: false },
      wed: { M: false, A: false }, thu: { M: false, A: false },
      fri: { M: false, A: false }
    };
  }
  STATE.attendance[key][day][period] = Boolean(value);
  STATE.modified.add(key);
}

function blankDay() { return { M: false, A: false }; }

function escapeHtml(str) {
  if (!str) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str).replace(/[&<>"']/g, c => map[c]);
}

// ===== NEW: Truncate name for display (keeps full name in data) =====
function truncateName(name, maxLen = 10) {
  if (!name) return '';
  return name.length > maxLen ? name.slice(0, maxLen) + '…' : name;
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC HOLIDAY DETECTION
// ═════════════════════════════════════════════════════════════════════════════
function isHoliday(week, day) {
  for (const s of STATE.students) {
    const rec = STATE.attendance[attKey(s.id, week)]?.[day];
    if (rec && (rec.M === true || rec.A === true)) return false;
  }
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// EFFECTIVE LAST WEEK
// ═════════════════════════════════════════════════════════════════════════════
function effectiveLastWeek() {
  let last = 0;
  for (const key of Object.keys(STATE.attendance)) {
    const match = key.match(/_w(\d+)$/);
    if (!match) continue;
    const week = parseInt(match[1], 10);
    if (week < 1 || week > WEEKS) continue;
    const rec = STATE.attendance[key];
    const hasData = DAYS.some(d => PERIODS.some(p => rec[d]?.[p] === true));
    if (hasData && week > last) last = week;
  }
  return last;
}

// ═════════════════════════════════════════════════════════════════════════════
// CALCULATIONS
// ═════════════════════════════════════════════════════════════════════════════
function calcStudentTotal(studentId) {
  const lastWeek = effectiveLastWeek();
  if (lastWeek === 0) return 0;
  let total = 0;
  for (let w = 1; w <= lastWeek; w++) {
    for (const day of DAYS) {
      if (isHoliday(w, day)) continue;
      for (const p of PERIODS) {
        if (getVal(studentId, w, day, p)) total++;
      }
    }
  }
  return total;
}

function calcWeekStats(week) {
  const stats = { days: {}, totalM: 0, totalA: 0, combined: 0, percentage: 0, schoolOpenSessions: 0 };

  for (const day of DAYS) {
    const holiday = isHoliday(week, day);
    stats.days[day] = { holiday, M: 0, A: 0, combined: 0 };
    if (holiday) continue;

    for (const s of STATE.students) {
      const m = getVal(s.id, week, day, 'M');
      const a = getVal(s.id, week, day, 'A');
      if (m) { stats.totalM++; stats.days[day].M++; }
      if (a) { stats.totalA++; stats.days[day].A++; }
      stats.days[day].combined += (m ? 1 : 0) + (a ? 1 : 0);
    }
    stats.schoolOpenSessions += STATE.students.length * 2;
  }

  stats.combined = stats.totalM + stats.totalA;
  stats.percentage = stats.schoolOpenSessions > 0
    ? Math.round((stats.combined / stats.schoolOpenSessions) * 100)
    : null;

  return stats;
}

function calcTermStats() {
  const lastWeek = effectiveLastWeek();
  let totalOpenedSessions = 0;
  let totalPresent = 0;

  for (let w = 1; w <= lastWeek; w++) {
    for (const day of DAYS) {
      if (isHoliday(w, day)) continue;
      totalOpenedSessions += 2;
      for (const s of STATE.students) {
        if (getVal(s.id, w, day, 'M')) totalPresent++;
        if (getVal(s.id, w, day, 'A')) totalPresent++;
      }
    }
  }

  let weeklyPercentagesSum = 0;
  let weeksWithData = 0;
  for (let w = 1; w <= lastWeek; w++) {
    const ws = calcWeekStats(w);
    if (ws.percentage !== null) {
      weeklyPercentagesSum += ws.percentage;
      weeksWithData++;
    }
  }
  const avgPercentage = weeksWithData > 0 ? Math.round(weeklyPercentagesSum / weeksWithData) : 0;

  return { totalOpenedSessions, totalPresent, avgPercentage };
}

// ═════════════════════════════════════════════════════════════════════════════
// FIRESTORE — LOAD ATTENDANCE (via service)
// ═════════════════════════════════════════════════════════════════════════════
async function loadAttendanceFromFirestore() {
  const { session, term } = STATE.academic;
  const { id: classId }   = STATE.class;

  if (!STATE.school.id || !classId || !session || !term) {
    console.warn('[Attendance] Cannot load attendance: missing data');
    return;
  }

  try {
    const records = await service.getAttendanceByClass(STATE.school.id, classId, session, term);
    if (!Array.isArray(records)) {
      console.warn('[Attendance] Expected array from getAttendanceByClass, got', records);
      return;
    }

    records.forEach(record => {
      const { studentId, weekNumber, days } = record;
      if (!studentId || !weekNumber || !days) return;
      STATE.attendance[attKey(studentId, weekNumber)] = {
        mon: { ...blankDay(), ...days.mon },
        tue: { ...blankDay(), ...days.tue },
        wed: { ...blankDay(), ...days.wed },
        thu: { ...blankDay(), ...days.thu },
        fri: { ...blankDay(), ...days.fri }
      };
    });
    console.log(`[Attendance] Loaded ${Object.keys(STATE.attendance).length} attendance records`);
  } catch (err) {
    console.error('[Attendance] loadAttendanceFromFirestore error:', err);
    toast.error('Unable to load attendance records. Please refresh the page.');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// FIRESTORE — SAVE ATTENDANCE (via service.saveAttendanceBatch)
// ═════════════════════════════════════════════════════════════════════════════
async function saveAttendanceToFirestore() {
  if (STATE.modified.size === 0) {
    toast.info('No changes to save.');
    return;
  }

  if (!STATE.school.id || !STATE.class.id || !STATE.academic.session || !STATE.academic.term) {
    toast.error('Cannot save: missing school, class, session or term.');
    return;
  }

  showLoader();
  try {
    const { session, term } = STATE.academic;
    const { id: classId }   = STATE.class;
    const keys = Array.from(STATE.modified);

    const operations = [];
    for (const key of keys) {
      const wIdx      = key.lastIndexOf('_w');
      const studentId = key.slice(0, wIdx);
      const weekNum   = parseInt(key.slice(wIdx + 2), 10);
      const rec       = STATE.attendance[key];
      if (!rec || isNaN(weekNum)) continue;

      operations.push({
        docId: firestoreDocId(classId, studentId, weekNum, term, session),
        data: {
          schoolId:        STATE.school.id,
          classId,
          studentId,
          academicSession: session,
          term,
          weekNumber:      weekNum,
          days: {
            mon: { M: rec.mon?.M ?? false, A: rec.mon?.A ?? false },
            tue: { M: rec.tue?.M ?? false, A: rec.tue?.A ?? false },
            wed: { M: rec.wed?.M ?? false, A: rec.wed?.A ?? false },
            thu: { M: rec.thu?.M ?? false, A: rec.thu?.A ?? false },
            fri: { M: rec.fri?.M ?? false, A: rec.fri?.A ?? false }
          },
          markedByTeacherId: STATE.teacher.id,
          updatedAt:         new Date()
        }
      });
    }

    if (operations.length === 0) {
      STATE.modified.clear();
      toast.info('No valid attendance records to save.');
      return;
    }

    await service.saveAttendanceBatch(operations);
    STATE.modified.clear();
    toast.success('Attendance saved successfully!');
    renderWeeklySummary();
    renderTermSummary();
  } catch (err) {
    console.error('[Attendance] Save error:', err);
    toast.error('Failed to save attendance. Please try again.');
  } finally {
    hideLoader();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// RENDERING — CLASS STATISTICS
// ═════════════════════════════════════════════════════════════════════════════
function renderClassStats() {
  const el = document.getElementById('classStatsContainer');
  if (!el) return;
  const { boys, girls, total } = STATE.stats;
  el.innerHTML = `
    <div class="stat-chip boys">
      <div class="chip-val">${boys}</div>
      <div class="chip-lbl">👦 Boys</div>
    </div>
    <div class="stat-chip girls">
      <div class="chip-val">${girls}</div>
      <div class="chip-lbl">👧 Girls</div>
    </div>
    <div class="stat-chip total">
      <div class="chip-val">${total}</div>
      <div class="chip-lbl">👥 Total</div>
    </div>
  `;
}

// ═════════════════════════════════════════════════════════════════════════════
// RENDERING — MAIN ATTENDANCE TABLE
// ═════════════════════════════════════════════════════════════════════════════
function renderAttendanceTable() {
  const container = document.getElementById('attendanceTableContainer');
  if (!container) return;

  if (STATE.students.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No active students found in this class.</p></div>';
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll-wrapper';

  const table = document.createElement('table');
  table.className = 'attendance-table';
  table.id = 'mainAttendanceTable';

  const thead = document.createElement('thead');
  thead.innerHTML = buildTableHeader();
  table.appendChild(thead);
  table.appendChild(buildTableBody());

  wrapper.appendChild(table);
  container.innerHTML = '';
  container.appendChild(wrapper);
  table.addEventListener('change', onCheckboxChange);
}

function buildTableHeader() {
  let r1 = '<tr class="week-header-row">'
    + '<th rowspan="3" class="th-sn sticky-col sticky-sn">S/N</th>'
    + '<th rowspan="3" class="th-name sticky-col sticky-name">Student Name</th>';

  for (let w = 1; w <= WEEKS; w++) {
    const cls = w % 2 === 0 ? 'th-week even' : 'th-week';
    r1 += `<th colspan="10" class="${cls}">Week ${w}</th>`;
  }
  r1 += '<th rowspan="3" class="th-total sticky-col sticky-total">Total</th></td>';

  let r2 = '<tr class="day-header-row">';
  for (let w = 0; w < WEEKS; w++) {
    DAYS.forEach(d => { r2 += `<th colspan="2" class="th-day">${DAY_LABELS[d]}</th>`; });
  }
  r2 += '</tr>';

  let r3 = '<tr class="period-header-row">';
  for (let w = 0; w < WEEKS; w++) {
    DAYS.forEach(() => { r3 += '<th class="th-period">M</th><th class="th-period">A</th>'; });
  }
  r3 += '</tr>';

  return r1 + r2 + r3;
}

function buildTableBody() {
  const tbody = document.createElement('tbody');

  STATE.students.forEach((student, idx) => {
    const tr = document.createElement('tr');
    tr.dataset.studentId = student.id;

    const tdSn = document.createElement('td');
    tdSn.className = 'td-sn sticky-col sticky-sn';
    tdSn.textContent = idx + 1;
    tr.appendChild(tdSn);

    const tdName = document.createElement('td');
    tdName.className = 'td-name sticky-col sticky-name';
    // --- TRUNCATE DISPLAYED NAME, but keep full name in tooltip ---
    const displayName = truncateName(student.name);
    tdName.textContent = displayName;
    tdName.title = student.name; // full name on hover
    tdName.style.paddingTop = '14px';
    tdName.style.paddingBottom = '14px';
    tdName.style.minHeight = '56px';
    tdName.style.fontSize = '0.95rem';
    tdName.style.verticalAlign = 'middle';
    tr.appendChild(tdName);

    for (let w = 1; w <= WEEKS; w++) {
      DAYS.forEach(day => {
        PERIODS.forEach(period => {
          const td = document.createElement('td');
          td.className = 'td-check';
          td.style.paddingTop = '10px';
          td.style.paddingBottom = '10px';
          td.style.minHeight = '56px';
          td.style.verticalAlign = 'middle';

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'att-checkbox';
          cb.style.width = '18px';
          cb.style.height = '18px';
          cb.style.cursor = 'pointer';
          cb.checked = getVal(student.id, w, day, period);
          cb.dataset.studentId = student.id;
          cb.dataset.week = w;
          cb.dataset.day = day;
          cb.dataset.period = period;
          cb.setAttribute('aria-label',
            `${student.name} Wk${w} ${DAY_LABELS[day]} ${period === 'M' ? 'Morning' : 'Afternoon'}`);
          td.appendChild(cb);
          tr.appendChild(td);
        });
      });
    }

    const tdTotal = document.createElement('td');
    tdTotal.className = 'td-total sticky-col sticky-total';
    tdTotal.id = `total-${student.id}`;
    tdTotal.textContent = calcStudentTotal(student.id);
    tr.appendChild(tdTotal);

    tbody.appendChild(tr);
  });

  return tbody;
}

// ═════════════════════════════════════════════════════════════════════════════
// RENDERING — WEEKLY SUMMARY TABLE
// ═════════════════════════════════════════════════════════════════════════════
function renderWeeklySummary() {
  const el = document.getElementById('weeklySummaryContainer');
  if (!el) return;

  const lastWeek = effectiveLastWeek();
  if (lastWeek === 0) {
    el.innerHTML = '<p class="no-data-msg">Weekly summary will appear after first attendance is recorded.</p>';
    return;
  }

  let html = `
    <h3 class="section-title">Weekly Attendance Summary</h3>
    <div class="table-scroll-wrapper">
      <table class="summary-table">
        <thead>
          <tr>
            <th>Week</th>
            <th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th>
            <th>Total M</th><th>Total A</th>
            <th>Combined</th><th>Percentage</th>
          </tr>
        </thead>
        <tbody>
  `;

  for (let w = 1; w <= lastWeek; w++) {
    const ws = calcWeekStats(w);
    html += `<tr><td class="week-label">Week ${w}</td>`;

    DAYS.forEach(day => {
      if (ws.days[day].holiday) {
        html += `<td class="holiday-cell">Holiday</td>`;
      } else {
        const { M, A, combined } = ws.days[day];
        html += `<td class="open-day-cell">${combined}<span class="day-detail"> (${M}M/${A}A)</span></td>`;
      }
    });

    const pct = ws.percentage !== null ? `${ws.percentage}%` : 'N/A';
    html += `
      <td class="stat-cell">${ws.totalM}</td>
      <td class="stat-cell">${ws.totalA}</td>
      <td class="stat-cell combined">${ws.combined}</td>
      <td class="stat-cell percentage">${pct}</td>
    </tr>`;
  }

  html += '</tbody></table></div>';
  el.innerHTML = html;
}

// ═════════════════════════════════════════════════════════════════════════════
// RENDERING — TERM SUMMARY
// ═════════════════════════════════════════════════════════════════════════════
function renderTermSummary() {
  const el = document.getElementById('termSummaryContainer');
  if (!el) return;

  const lastWeek = effectiveLastWeek();
  if (lastWeek === 0) {
    el.innerHTML = '<p class="no-data-msg">Term summary will appear after attendance is recorded.</p>';
    return;
  }

  const { totalOpenedSessions, totalPresent, avgPercentage } = calcTermStats();
  const quality = avgPercentage >= 75 ? 'good' : avgPercentage >= 50 ? 'fair' : 'poor';

  el.innerHTML = `
    <h3 class="section-title">Term Summary</h3>
    <div class="term-summary-grid">
      <div class="term-stat">
        <div class="term-stat-label">Total Number of Times School Opened</div>
        <div class="term-stat-value">${totalOpenedSessions} time${totalOpenedSessions !== 1 ? 's' : ''}</div>
      </div>
      <div class="term-stat">
        <div class="term-stat-label">Total Number of Student Attendance</div>
        <div class="term-stat-value">${totalPresent} times</div>
      </div>
      <div class="term-stat">
        <div class="term-stat-label">Average Class Attendance</div>
        <div class="term-stat-value ${quality}">${avgPercentage}%</div>
      </div>
    </div>
  `;
}

// ═════════════════════════════════════════════════════════════════════════════
// LIVE TOTAL UPDATE
// ═════════════════════════════════════════════════════════════════════════════
function refreshStudentTotal(studentId) {
  const cell = document.getElementById(`total-${studentId}`);
  if (cell) cell.textContent = calcStudentTotal(studentId);
}

// ═════════════════════════════════════════════════════════════════════════════
// EVENT HANDLER — checkbox change
// ═════════════════════════════════════════════════════════════════════════════
let _summaryDebounce = null;

function onCheckboxChange(e) {
  const cb = e.target;
  if (cb.type !== 'checkbox' || !cb.classList.contains('att-checkbox')) return;

  const { studentId, week, day, period } = cb.dataset;
  setVal(studentId, parseInt(week, 10), day, period, cb.checked);
  refreshStudentTotal(studentId);

  clearTimeout(_summaryDebounce);
  _summaryDebounce = setTimeout(() => {
    renderWeeklySummary();
    renderTermSummary();
  }, 350);
}

// ═════════════════════════════════════════════════════════════════════════════
// PRINT ENGINE
// ═════════════════════════════════════════════════════════════════════════════
function injectPrintStyles() {
  if (document.getElementById('attendance-print-styles')) return;

  const style = document.createElement('style');
  style.id = 'attendance-print-styles';
  style.textContent = `
    @media print {
      .sidebar, .hamburger-menu, .header-right, .school-header-left .camera-icon,
      .app-footer, .logout-btn, .mobile-sidebar, .overlay, .hamburger-menu,
      .btn-primary, .btn-secondary, .create-test-btn, .cbt-header,
      #saveAttendanceBtn, #printAttendanceBtn, #downloadAttendanceBtn,
      .attendance-filters, .no-data-msg, .empty-state { display: none !important; }
      .header { display: flex !important; justify-content: space-between !important; margin-bottom: 10px !important; padding: 0 !important; }
      .school-header-left { display: flex !important; align-items: center !important; gap: 15px !important; }
      .school-logo img { max-width: 50px !important; }
      .school-name h1 { font-size: 1.2rem !important; margin: 0 !important; }
      .school-address { font-size: 0.8rem !important; }
      .academic-badge-row { margin: 5px 0 10px !important; text-align: center !important; }
      .academic-badge { font-size: 0.9rem !important; background: none !important; padding: 0 !important; }
      @page { size: A4 landscape; margin: 0.5cm; }
      body { margin: 0; padding: 0; font-size: 9pt !important; line-height: 1.2 !important; }
      .main-content { margin: 0 !important; padding: 0 !important; width: 100% !important; }
      .content { padding: 0 !important; }
      .attendance-table { font-size: 7pt !important; border-collapse: collapse !important; width: 100% !important; table-layout: fixed !important; }
      .attendance-table th, .attendance-table td { padding: 2px 2px !important; border: 1px solid #ccc !important; white-space: nowrap !important; }
      .attendance-table .th-week { font-size: 6pt !important; padding: 1px !important; }
      .attendance-table .th-day { font-size: 6pt !important; padding: 1px !important; }
      .attendance-table .th-period { font-size: 6pt !important; padding: 1px !important; }
      .attendance-table .td-check input { transform: scale(0.7); width: 12px !important; height: 12px !important; margin: 0 auto !important; display: block !important; }
      .attendance-table .td-sn, .attendance-table .td-name, .attendance-table .td-total { font-size: 6pt !important; padding: 2px 2px !important; }
      .sticky-col { position: static !important; }
      .summary-table { font-size: 7pt !important; width: 100% !important; border-collapse: collapse !important; margin-top: 10px !important; }
      .summary-table th, .summary-table td { padding: 2px 4px !important; border: 1px solid #ccc !important; }
      .term-summary-grid { display: flex !important; justify-content: space-between !important; gap: 10px !important; margin-top: 10px !important; }
      .term-stat { background: #f5f5f5 !important; padding: 5px !important; border-radius: 4px !important; text-align: center !important; flex: 1 !important; }
      .term-stat-label { font-size: 8pt !important; font-weight: bold !important; }
      .term-stat-value { font-size: 10pt !important; font-weight: bold !important; }
      .section-title { font-size: 10pt !important; margin: 10px 0 5px !important; }
      .table-scroll-wrapper { overflow-x: visible !important; }
    }
  `;
  document.head.appendChild(style);
}

function printAttendance() {
  injectPrintStyles();

  const setPrintText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value || '—';
  };
  setPrintText('printSchoolName', STATE.school.name);
  setPrintText('printClass', STATE.class.name);
  setPrintText('printSession', STATE.academic.session);
  setPrintText('printTerm', STATE.academic.term);
  setPrintText('printTeacher', STATE.teacher.name);

  window.print();
}

// ═════════════════════════════════════════════════════════════════════════════
// DOWNLOAD ENGINE — CSV export
// ═════════════════════════════════════════════════════════════════════════════
function downloadCSV() {
  if (STATE.students.length === 0) {
    toast.error('No student data to download.');
    return;
  }

  const rows = [];
  rows.push(['School', STATE.school.name || '']);
  rows.push(['Class', STATE.class.name || '']);
  rows.push(['Session', STATE.academic.session || '']);
  rows.push(['Term', STATE.academic.term || '']);
  rows.push(['Teacher', STATE.teacher.name || '']);
  rows.push([]);

  const header = ['S/N', 'Student Name'];
  for (let w = 1; w <= WEEKS; w++) {
    DAYS.forEach(d => {
      PERIODS.forEach(p => { header.push(`W${w}-${DAY_LABELS[d]}-${p}`); });
    });
  }
  header.push('Total');
  rows.push(header);

  STATE.students.forEach((s, i) => {
    const row = [i + 1, `"${s.name.replace(/"/g, '""')}"`];
    for (let w = 1; w <= WEEKS; w++) {
      DAYS.forEach(d => {
        PERIODS.forEach(p => { row.push(getVal(s.id, w, d, p) ? 1 : 0); });
      });
    }
    row.push(calcStudentTotal(s.id));
    rows.push(row);
  });

  const { totalOpenedSessions, totalPresent, avgPercentage } = calcTermStats();
  rows.push([]);
  rows.push(['Total Number of Times School Opened', totalOpenedSessions]);
  rows.push(['Total Number of Student Attendance', totalPresent]);
  rows.push(['Average Class Attendance', `${avgPercentage}%`]);

  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (STATE.class.name || 'class').replace(/\s+/g, '_');
  const safeTerm = (STATE.academic.term || 'term').replace(/\s+/g, '_');
  a.href = url;
  a.download = `attendance_${safeName}_${safeTerm}_${STATE.academic.session || 'session'}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast.success('Attendance downloaded as CSV.');
}

// ═════════════════════════════════════════════════════════════════════════════
// UI SETUP HELPERS
// ═════════════════════════════════════════════════════════════════════════════
function setupButtons() {
  document.getElementById('saveAttendanceBtn')?.addEventListener('click', saveAttendanceToFirestore);
  document.getElementById('printAttendanceBtn')?.addEventListener('click', printAttendance);
  document.getElementById('downloadAttendanceBtn')?.addEventListener('click', downloadCSV);
}

function setupSidebar() {
  const page = window.location.pathname.split('/').pop();
  document.querySelectorAll('.sidebar-nav a').forEach(link => {
    link.classList.toggle('active', link.getAttribute('href') === page);
  });
}

function setupLogout() {
  const doLogout = async () => {
    if (STATE.stopSync) { STATE.stopSync(); STATE.stopSync = null; }
    try { await logoutUser(); } catch (err) { toast.error('Logout failed. Please try again.'); }
  };
  document.getElementById('logoutBtn')?.addEventListener('click', doLogout);
  document.querySelector('.mobile-logout-btn')?.addEventListener('click', doLogout);
}

// ═════════════════════════════════════════════════════════════════════════════
// ACADEMIC CALENDAR — real-time subscription + periodic sync
// ═════════════════════════════════════════════════════════════════════════════
function setupCalendarDisplay() {
  subscribeToCalendar(calState => {
    const termEl = document.getElementById('currentTermDisplay');
    const sessionEl = document.getElementById('currentSessionDisplay');

    if (termEl) {
      termEl.textContent = calState.currentTerm || '';
      termEl.classList.toggle('override-badge', !!calState.manualOverride);
    }
    if (sessionEl) sessionEl.textContent = calState.currentSession || '';

    if (calState.currentTerm && calState.currentTerm !== STATE.academic.term) {
      STATE.academic.term = calState.currentTerm;
    }
    if (calState.currentSession && calState.currentSession !== STATE.academic.session) {
      STATE.academic.session = calState.currentSession;
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// DATA LOADERS (using service.js)
// ═════════════════════════════════════════════════════════════════════════════
async function loadSchoolInfo() {
  try {
    const school = await service.getSchoolById(STATE.school.id);
    if (school) {
      STATE.school.name = school.name || 'Unknown School';
      STATE.school.address = school.address || '';
      STATE.school.logo = school.logo || null;
    }
    const nameEl = document.getElementById('schoolName');
    const addrEl = document.getElementById('schoolAddress');
    const logoEl = document.getElementById('schoolLogoImg');
    if (nameEl) nameEl.textContent = STATE.school.name;
    if (addrEl) addrEl.textContent = STATE.school.address;
    if (logoEl) {
      logoEl.src = STATE.school.logo ||
        'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 24 24" fill="%23e2e8f0"%3E%3Ccircle cx="12" cy="12" r="12"/%3E%3C/svg%3E';
    }
  } catch (err) {
    toast.error('Unable to load school information.');
  }
}

async function loadClassInfo(classId) {
  if (!classId) {
    STATE.class.id = classId;
    STATE.class.name = 'Unknown Class';
    return;
  }
  try {
    const classData = await service.getClassById(classId);
    STATE.class.id = classId;
    STATE.class.name = classData ? classData.name : 'Unknown Class';
  } catch (err) {
    toast.error('Unable to load class information.');
    STATE.class.id = classId;
    STATE.class.name = 'Class';
  }
}

async function loadClassStudents() {
  if (!STATE.school.id || !STATE.class.id) {
    STATE.students = [];
    return;
  }
  try {
    const students = await service.getStudentsByClass(STATE.school.id, STATE.class.id);
    const list = students.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    STATE.students = list;
    STATE.stats.boys = list.filter(s => (s.gender || '').toLowerCase() === 'male').length;
    STATE.stats.girls = list.filter(s => (s.gender || '').toLowerCase() === 'female').length;
    STATE.stats.total = list.length;
  } catch (err) {
    toast.error('Unable to load class students.');
    STATE.students = [];
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MULTI-CLASS SUPPORT: load teacher host classes and populate dropdown
// ═════════════════════════════════════════════════════════════════════════════
async function loadTeacherHostClassesAndPopulateDropdown() {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');

  const teacherRef = doc(db, 'teachers', user.uid);
  const teacherSnap = await getDoc(teacherRef);
  if (!teacherSnap.exists()) throw new Error('Teacher record not found');

  const teacherData = teacherSnap.data();
  STATE.teacher.schoolId = teacherData.schoolId;
  STATE.school.id = teacherData.schoolId;

  // Determine host class IDs
  let hostIds = [];
  if (teacherData.hostClassIds && Array.isArray(teacherData.hostClassIds) && teacherData.hostClassIds.length > 0) {
    hostIds = teacherData.hostClassIds;
  } else if (teacherData.hostClassId) {
    hostIds = [teacherData.hostClassId];
  } else if (teacherData.classId) {
    hostIds = [teacherData.classId];
  }

  if (hostIds.length === 0) {
    throw new Error('You are not assigned as a class teacher for any class.');
  }
  STATE.teacher.hostClassIds = hostIds;

  // Populate dropdown
  const selectorRow = document.getElementById('classSelectorRow');
  const classSelect = document.getElementById('classSelect');
  if (selectorRow && classSelect) {
    classSelect.innerHTML = '';
    for (const cid of hostIds) {
      const classDoc = await getDoc(doc(db, 'classes', cid));
      if (classDoc.exists()) {
        const option = document.createElement('option');
        option.value = cid;
        option.textContent = classDoc.data().name;
        classSelect.appendChild(option);
      }
    }
    // Show dropdown only if more than one class
    if (hostIds.length > 1) {
      selectorRow.style.display = 'flex';
    } else {
      selectorRow.style.display = 'none';
    }
    // Set initial selected class
    STATE.class.id = hostIds[0];
    classSelect.value = STATE.class.id;

    // Listen for changes
    classSelect.addEventListener('change', async () => {
      STATE.class.id = classSelect.value;
      await refreshClassDataAndAttendance();
    });
  } else {
    // Fallback: use first class only
    STATE.class.id = hostIds[0];
  }

  // Load class name
  await loadClassInfo(STATE.class.id);
  // Set teacher name
  STATE.teacher.name = teacherData.name || user.email?.split('@')[0] || 'Teacher';
}

async function refreshClassDataAndAttendance() {
  showLoader();
  try {
    await loadClassInfo(STATE.class.id);
    await loadClassStudents();
    // Reset attendance and modified set
    STATE.attendance = {};
    STATE.modified.clear();
    await loadAttendanceFromFirestore();
    // Re-render UI
    renderClassStats();
    renderAttendanceTable();
    renderWeeklySummary();
    renderTermSummary();
    // Update displayed class name in header
    const classNameEl = document.getElementById('classNameDisplay');
    if (classNameEl) {
      classNameEl.textContent = `${STATE.class.name} — ${STATE.academic.term}, ${STATE.academic.session}`;
    }
  } catch (err) {
    console.error('Error refreshing class data:', err);
    toast.error('Unable to load data for selected class.');
  } finally {
    hideLoader();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// AUTHENTICATION — Promise-based, unsubscribes after first resolution
// ═════════════════════════════════════════════════════════════════════════════
function authenticateTeacher() {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, async user => {
      unsub();

      if (!user) { window.location.href = '/'; resolve(null); return; }

      try {
        const userData = await service.getUserById(user.uid);
        if (!userData || userData.role !== 'teacher') {
          window.location.href = '/'; resolve(null); return;
        }
        if (!userData.schoolId) { window.location.href = '/'; resolve(null); return; }
        resolve({ user, userData });
      } catch (err) { reject(err); }
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// NO-CLASS WARNING
// ═════════════════════════════════════════════════════════════════════════════
function showNoClassWarning() {
  setupSidebar();
  setupLogout();
  try { initMobileMenu(); } catch (_) { }

  const content = document.querySelector('.content');
  if (!content) return;
  content.innerHTML = `
    <div class="no-class-warning">
      <div class="warning-icon">⚠️</div>
      <h2>No Class Assigned</h2>
      <p>You are not currently assigned as a class teacher.
         Please contact your school admin to get a host class assigned
         before you can record attendance.</p>
      <a href="teacher-dashboard.html" class="btn-back">← Back to Dashboard</a>
    </div>
  `;
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPER: Ensure calendar is ready with fallback
// ═════════════════════════════════════════════════════════════════════════════
async function ensureCalendarReady() {
  try {
    await initAcademicCalendar();
    await syncAcademicCalendar();
    let session = getCurrentSession();
    let term = getCurrentTerm();
    if (!session || !term) throw new Error('Calendar returned empty values');
    return { session, term };
  } catch (err) {
    console.warn('[Attendance] Calendar init failed, using client-side fallback:', err);
    toast.warning('Calendar is still loading. Using client-side date estimation.');
    const now = new Date();
    const fallback = calculateTermAndSessionFromDate(now);
    return { session: fallback.session, term: fallback.term };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPORTED HELPER FOR REPORTCARD RENDERER
// ═════════════════════════════════════════════════════════════════════════════
export function getStudentAttendanceSummary(studentId) {
  const { totalOpenedSessions } = calcTermStats();
  const present = calcStudentTotal(studentId);
  const absent = totalOpenedSessions - present;
  return { totalOpened: totalOpenedSessions, present, absent };
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT (exported — called by attendance.html)
// ═════════════════════════════════════════════════════════════════════════════
export async function initAttendancePage() {
  let authResult;
  try {
    authResult = await authenticateTeacher();
  } catch (err) {
    console.error('[Attendance] Auth failed:', err);
    toast.error('Unable to log in. Please refresh the page.');
    window.location.href = '/';
    return;
  }
  if (!authResult) return;

  const { user, userData } = authResult;
  STATE.teacher.id = user.uid;
  STATE.teacher.schoolId = userData.schoolId;
  STATE.school.id = userData.schoolId;

  showLoader();
  try {
    const calendar = await ensureCalendarReady();
    STATE.academic.session = calendar.session;
    STATE.academic.term = calendar.term;
    try { STATE.stopSync = startPeriodicSync(30); } catch (e) { console.warn(e); }
  } catch (err) {
    console.error('[Attendance] Fatal calendar error:', err);
    toast.error('Unable to determine current academic term. Please refresh.');
    hideLoader();
    return;
  }

  setupCalendarDisplay();

  try {
    // Load teacher's host classes and populate dropdown (this also sets STATE.class.id)
    await loadTeacherHostClassesAndPopulateDropdown();
    if (!STATE.class.id) {
      showNoClassWarning();
      hideLoader();
      return;
    }
    await loadSchoolInfo();
    await loadClassStudents();
    await loadAttendanceFromFirestore();
  } catch (err) {
    console.error('[Attendance] Data loading error:', err);
    if (err.message.includes('not assigned as a class teacher')) {
      showNoClassWarning();
      hideLoader();
      return;
    }
    toast.error('Unable to load page data. Please refresh.');
    hideLoader();
    return;
  } finally {
    hideLoader();
  }

  const classNameEl = document.getElementById('classNameDisplay');
  if (classNameEl) {
    classNameEl.textContent = `${STATE.class.name} — ${STATE.academic.term}, ${STATE.academic.session}`;
  }

  renderClassStats();
  renderAttendanceTable();
  renderWeeklySummary();
  renderTermSummary();

  setupButtons();
  setupSidebar();
  setupLogout();

  try { initMobileMenu(); } catch (_) { }

  const yearEl = document.getElementById('currentYear');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  STATE.initialized = true;
}
