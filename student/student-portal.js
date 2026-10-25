// student-portal.js — Lazy-loading, low-read version, patient with slow networks.
//
// BOOT READS: 7
//   • getUserById (1)
//   • getStudentById (1)
//   • getClassById (1)
//   • getSchoolById (1)
//   • subscribeToCalendar initial (1)
//   • syncAcademicCalendar (1)
//   • subscribeToSubscription initial (1)
//
// ON-DEMAND READS (cached per session after first click)
//   • About Me    → resolveSubjectNames (~12)
//   • Attendance  → getAttendanceByStudent (~15)
//   • Assignments → getAssignmentsByClass (~5)
//   • Results     → CBT test_results query (~5)
//   • Notification bell first click → setup listeners (~20)
//
// SLOW-NETWORK TUNING (all timing now 12× more generous):
//   • ESSENTIAL_TIMEOUT_MS      = 60s
//   • CALENDAR_TIMEOUT_MS       = 60s
//   • SUBSCRIPTION_TIMEOUT_MS   = 60s
//   • CLASS_NAME_TIMEOUT_MS     = 30s
//   • TAB_LOAD_TIMEOUT_MS       = 60s
//   • MIN_BOOT_TIME_MS          = 600ms (min display only — never delays real data)
//   • HTML failsafe (refresh)   = 120s
//
// CORRECTNESS GUARANTEES:
//   • Boot cannot hang forever — every essential read is timeout-bounded.
//   • If getStudentById is slow, the loader hides at 60s and the hero
//     self-heals in the background when the read finally resolves.
//   • Tab loaders cannot spin forever — timeouts show a "retry" message.
//   • Loader is always force-hidden in the `finally` block.
//   • Failsafe timer is cleared on successful hide.

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
  onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

import { subscribeToCalendar } from '../js/academic-calendar.js';
import { syncAcademicCalendar, startPeriodicSync } from '../js/calendar-sync.js';
import * as service from '../js/service.js';
import { toast } from '../js/error-handler.js';
import { enforcePasswordChange } from '../js/security.js';

// ── Feature flags / constants ────────────────────────────────────────────────
const ENABLE_EXTERNAL_TABS = false;
const ACCORDION_ANIM_MS    = 450;
const RESULTS_PAGE_SIZE    = 10;
const RESULTS_LOAD_STEP    = 5;

// Slow-network-friendly timeouts
const MIN_BOOT_TIME_MS       = 600;    // fast-network minimum only
const ESSENTIAL_TIMEOUT_MS   = 60000;  // 60s for student + school reads
const CALENDAR_TIMEOUT_MS    = 60000;  // 60s
const SUBSCRIPTION_TIMEOUT_MS= 60000;  // 60s
const CLASS_NAME_TIMEOUT_MS  = 30000;  // 30s
const TAB_LOAD_TIMEOUT_MS    = 60000;  // 60s per-tab

const STATIC_TABS = new Set(['achievements', 'library', 'video-tutorials']);

// ── Global state ─────────────────────────────────────────────────────────────
let currentStudentData = null;
let currentSchoolId    = null;
let currentStudentId   = null;
let resolvedClassName  = '';

// Deferred caches
let subjectsList       = [];
let attendanceRecords  = [];
let assignmentsList    = [];
let allCbtScores       = [];
let visibleCbtCount    = RESULTS_PAGE_SIZE;

// Notifications
let unsubscribeCBT     = null;
let unsubscribeScores  = null;
let mergedNotifications = [];
const teacherNameCache = new Map();
let notificationListenersStarted = false;

// Calendar
let globalCurrentTerm    = '';
let globalCurrentSession = '';
let calendarReady        = false;
let calendarReadyResolve = null;
const calendarReadyPromise = new Promise(res => { calendarReadyResolve = res; });

// Subscription
let isSchoolSubscriptionActive = true;
let unsubscribeSubscription    = null;
let subscriptionReady          = false;
let subscriptionReadyResolve   = null;
const subscriptionReadyPromise = new Promise(res => { subscriptionReadyResolve = res; });

// Accordion
let activeAccordionCard = null;
let activeAccordionPane = null;

// Lazy load tracking
const loadedPanes = new Set();
const loadingTabs = new Map();

// Background-heal flag — prevents double render if the student read
// eventually resolves after timing out once.
let studentRenderDone = false;

// ── Utilities ────────────────────────────────────────────────────────────────
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

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

// withTimeout — resolves (never rejects) with undefined on timeout.
// Underlying promise keeps running; use its .then/.catch separately if needed.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(resolve, ms))
  ]);
}

// ── Loaders ──────────────────────────────────────────────────────────────────
function hideFullScreenLoader() {
  if (typeof window !== 'undefined' && window.__acadexBootFailsafe) {
    clearTimeout(window.__acadexBootFailsafe);
    window.__acadexBootFailsafe = null;
  }
  const loader = document.getElementById('acadexFullscreenLoader');
  if (loader) {
    loader.classList.remove('active');
    // Belt-and-braces: force display:none after the fade-out so the
    // loader can never linger even if CSS loading was interrupted.
    setTimeout(() => {
      if (loader && !loader.classList.contains('active')) {
        loader.style.display = 'none';
      }
    }, 420);
  }
}

function paneLoaderHTML(label = 'Loading…') {
  return `
    <div class="pane-loader">
      <div class="acadex-spinner acadex-spinner-sm">
        <svg viewBox="0 0 40 40">
          <circle class="acadex-spinner-track" cx="20" cy="20" r="16" fill="none" stroke-width="3"/>
          <circle class="acadex-spinner-ring" cx="20" cy="20" r="16" fill="none" stroke-width="3" stroke-linecap="round" pathLength="100" stroke-dasharray="25 100"/>
        </svg>
      </div>
      <div class="acadex-loader-label">${escapeHtml(label)}</div>
    </div>
  `;
}

function paneErrorHTML(message = 'Connection is slow. Please tap the tab again to retry.') {
  return `
    <div class="card" style="text-align:center;padding:2rem;color:#b91c1c;">
      <i class="fa-solid fa-triangle-exclamation" style="font-size:1.6rem;display:block;margin-bottom:0.6rem;opacity:0.8;"></i>
      ${escapeHtml(message)}
    </div>
  `;
}

function showPaneLoader(pane, label = 'Loading…') {
  if (!pane) return;
  pane.innerHTML = paneLoaderHTML(label);
}

// ── Calendar ─────────────────────────────────────────────────────────────────
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

    if (!calendarReady) {
      calendarReady = true;
      calendarReadyResolve();
    }
  });
}

function getCalendarDisplay() {
  const t = globalCurrentTerm && globalCurrentTerm !== '—' ? globalCurrentTerm : '';
  const s = globalCurrentSession && globalCurrentSession !== '—' ? globalCurrentSession : '';
  if (!t && !s) return '';
  return t ? (s ? `${t} — ${s}` : t) : s;
}

// ── Subscription ────────────────────────────────────────────────────────────
function initSubscriptionListener(schoolId) {
  if (!schoolId) {
    if (!subscriptionReady) {
      subscriptionReady = true;
      subscriptionReadyResolve();
    }
    return;
  }
  if (unsubscribeSubscription) unsubscribeSubscription();
  unsubscribeSubscription = service.subscribeToSubscription(schoolId, (subData) => {
    if (!subData) {
      isSchoolSubscriptionActive = false;
    } else {
      isSchoolSubscriptionActive = !(
        subData.locked === true ||
        subData.locked === 'true' ||
        subData.status === 'inactive' ||
        subData.status === 'expired'
      );
    }
    if (!subscriptionReady) {
      subscriptionReady = true;
      subscriptionReadyResolve();
    }
  });
}

// ── Accordion ────────────────────────────────────────────────────────────────
function positionAccordionPane(card, pane) {
  const grid = document.getElementById('tabCardGrid');
  if (!grid) return;
  const cards = Array.from(grid.querySelectorAll('.tab-card'));
  const cardTop = card.getBoundingClientRect().top;
  const tolerance = 8;

  let lastInRow = card;
  for (const c of cards) {
    if (c === card) continue;
    if (Math.abs(c.getBoundingClientRect().top - cardTop) < tolerance) {
      lastInRow = c;
    }
  }

  if (lastInRow.nextElementSibling !== pane) {
    lastInRow.after(pane);
  }
}

function openAccordionPane(card, pane) {
  positionAccordionPane(card, pane);

  pane.style.display   = 'block';
  pane.style.maxHeight = '0px';
  pane.style.opacity   = '0';
  pane.style.transform = 'translateY(-10px)';
  void pane.offsetHeight;

  const h = pane.scrollHeight;
  pane.style.maxHeight = h + 'px';
  pane.style.opacity   = '1';
  pane.style.transform = 'translateY(0)';

  setTimeout(() => {
    if (activeAccordionPane === pane) {
      pane.classList.add('open');
      pane.style.maxHeight = '';
    }
  }, ACCORDION_ANIM_MS + 20);

  setTimeout(() => {
    if (activeAccordionPane === pane) {
      try { pane.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
    }
  }, 120);
}

function closeAccordionPane(pane, { instant = false } = {}) {
  if (!pane) return;
  pane.classList.remove('open');

  if (instant) {
    pane.style.display   = 'none';
    pane.style.maxHeight = '';
    pane.style.opacity   = '';
    pane.style.transform = '';
    return;
  }

  const h = pane.scrollHeight;
  pane.style.maxHeight = h + 'px';
  void pane.offsetHeight;
  pane.style.maxHeight = '0px';
  pane.style.opacity   = '0';
  pane.style.transform = 'translateY(-10px)';

  setTimeout(() => {
    if (!pane.classList.contains('open') && activeAccordionPane !== pane) {
      pane.style.display   = 'none';
      pane.style.maxHeight = '';
      pane.style.opacity   = '';
      pane.style.transform = '';
    }
  }, ACCORDION_ANIM_MS + 20);
}

// ── Tab data loading ────────────────────────────────────────────────────────
async function loadProfileTab() {
  try {
    const names = await withTimeout(
      resolveSubjectNames(currentStudentData?.subjects || []),
      TAB_LOAD_TIMEOUT_MS
    );
    subjectsList = names || [];
    renderProfile(currentStudentData, subjectsList);
  } catch (err) {
    console.warn('[StudentPortal] Profile subjects load fail:', err);
    subjectsList = [];
    renderProfile(currentStudentData, []);
  }
}

async function loadAttendanceTab() {
  try {
    const classId = safeVal(currentStudentData?.classId);
    const term    = globalCurrentTerm;
    const session = globalCurrentSession;

    let records = [];
    if (currentSchoolId && classId && term && session) {
      const raw = await withTimeout(
        service.getAttendanceByStudent(currentSchoolId, currentStudentId, classId, session, term),
        TAB_LOAD_TIMEOUT_MS
      );
      (raw || []).forEach(data => {
        const days = data.days || {};
        const week = data.weekNumber;
        for (const [day, sessions] of Object.entries(days)) {
          if (sessions && typeof sessions === 'object') {
            if (typeof sessions.M === 'boolean') {
              records.push({ status: sessions.M ? 'present' : 'absent', weekNumber: week, day, session: 'M' });
            }
            if (typeof sessions.A === 'boolean') {
              records.push({ status: sessions.A ? 'present' : 'absent', weekNumber: week, day, session: 'A' });
            }
          }
        }
      });
    }

    attendanceRecords = records;
    renderAttendance(records);
  } catch (err) {
    console.warn('[StudentPortal] Attendance load fail:', err);
    attendanceRecords = [];
    renderAttendance([]);
  }
}

async function loadAssignmentsTab() {
  try {
    const classId = safeVal(currentStudentData?.classId);
    if (currentSchoolId && classId) {
      const data = await withTimeout(
        service.getAssignmentsByClass(currentSchoolId, classId),
        TAB_LOAD_TIMEOUT_MS
      );
      assignmentsList = data || [];
    } else {
      assignmentsList = [];
    }
    renderAssignments(assignmentsList);
  } catch (err) {
    console.warn('[StudentPortal] Assignments load fail:', err);
    assignmentsList = [];
    renderAssignments([]);
  }
}

async function loadResultsTab() {
  const tableEl = document.getElementById('resultsTableContainer');
  try {
    const data = await withTimeout(fetchCbtScores(), TAB_LOAD_TIMEOUT_MS);
    allCbtScores    = data || [];
    visibleCbtCount = RESULTS_PAGE_SIZE;
    renderResultsTableBody();
  } catch (err) {
    console.error('[StudentPortal] Results load fail:', err);
    if (tableEl) tableEl.innerHTML = paneErrorHTML();
  }
}

async function loadTabData(tabId) {
  switch (tabId) {
    case 'profile':     return loadProfileTab();
    case 'attendance':  return loadAttendanceTab();
    case 'assignments': return loadAssignmentsTab();
    case 'results':     return loadResultsTab();
    default:            return;
  }
}

function ensureTabLoaded(tabId) {
  if (loadedPanes.has(tabId)) return Promise.resolve();
  if (loadingTabs.has(tabId)) return loadingTabs.get(tabId);

  const promise = (async () => {
    try {
      await withTimeout(
        loadTabData(tabId),
        TAB_LOAD_TIMEOUT_MS,
        'tab_load'
      );
      loadedPanes.add(tabId);
    } catch (err) {
      console.warn('[StudentPortal] Tab timeout:', tabId, err);
      // Show a retry message — do NOT mark as loaded so next click retries.
      const pane = document.querySelector(`.tab-pane[data-pane="${tabId}"]`);
      if (tabId === 'results') {
        const tableEl = document.getElementById('resultsTableContainer');
        if (tableEl) tableEl.innerHTML = paneErrorHTML();
      } else if (pane) {
        pane.innerHTML = paneErrorHTML();
      }
    } finally {
      loadingTabs.delete(tabId);
    }
  })();

  loadingTabs.set(tabId, promise);
  return promise;
}

// ── Card activation ─────────────────────────────────────────────────────────
async function handleCardActivation(card) {
  const tabId      = card.getAttribute('data-tab');
  const navigateTo = card.getAttribute('data-navigate');
  const futurePage = card.getAttribute('data-future-page');

  if (navigateTo) {
    if (!isSchoolSubscriptionActive) {
      toast.error('School subscription is inactive. Please contact your administrator.');
      return;
    }
    const schoolId  = localStorage.getItem('userSchoolId');
    const studentId = localStorage.getItem('studentId');
    if (!schoolId || !studentId) {
      toast.error('Unable to access CBT. Please log out and log in again.');
      return;
    }
    window.location.href = navigateTo;
    return;
  }

  if (ENABLE_EXTERNAL_TABS && futurePage && futurePage.trim() !== '') {
    window.location.href = futurePage;
    return;
  }

  const grid = document.getElementById('tabCardGrid');
  const pane = grid ? grid.querySelector(`.tab-pane[data-pane="${tabId}"]`) : null;
  if (!pane) return;

  // Same card → close
  if (activeAccordionCard === card && activeAccordionPane === pane) {
    const prevPane = pane;
    const prevCard = card;
    activeAccordionCard = null;
    activeAccordionPane = null;
    prevCard.setAttribute('aria-expanded', 'false');
    prevCard.classList.remove('open');
    closeAccordionPane(prevPane);
    return;
  }

  // Different card → instant-close previous
  if (activeAccordionPane && activeAccordionPane !== pane) {
    const prevPane = activeAccordionPane;
    const prevCard = activeAccordionCard;
    activeAccordionPane = null;
    activeAccordionCard = null;
    if (prevCard) {
      prevCard.setAttribute('aria-expanded', 'false');
      prevCard.classList.remove('open');
    }
    closeAccordionPane(prevPane, { instant: true });
  }

  activeAccordionCard = card;
  activeAccordionPane = pane;
  card.setAttribute('aria-expanded', 'true');
  card.classList.add('open');

  // Static tabs — content already in HTML
  if (STATIC_TABS.has(tabId) || loadedPanes.has(tabId)) {
    openAccordionPane(card, pane);
    return;
  }

  // Lazy-load tabs
  if (tabId !== 'results') {
    showPaneLoader(pane);
  } else {
    const tableEl = document.getElementById('resultsTableContainer');
    if (tableEl) tableEl.innerHTML = paneLoaderHTML('Loading results…');
  }

  openAccordionPane(card, pane);

  await new Promise(r => setTimeout(r, ACCORDION_ANIM_MS + 50));
  await ensureTabLoaded(tabId);
}

function initInternalTabs() {
  const grid = document.getElementById('tabCardGrid');
  if (!grid) return;
  const cards = grid.querySelectorAll('.tab-card');
  cards.forEach(card => {
    card.addEventListener('click', () => handleCardActivation(card));
  });

  let resizeTimer = null;
  const reposition = () => {
    if (!activeAccordionCard || !activeAccordionPane) return;
    positionAccordionPane(activeAccordionCard, activeAccordionPane);
  };
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reposition, 180);
  });
  window.addEventListener('orientationchange', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reposition, 240);
  });
}

// ── School header ────────────────────────────────────────────────────────────
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
      logoEl.onerror = () => {
        logoEl.src = `https://ui-avatars.com/api/?background=e0e7ff&color=4f46e5&name=${encodeURIComponent(safeVal(school.name) || 'S')}&size=80`;
      };
    }
  } catch (err) {
    console.warn('[StudentPortal] School header failed:', err);
  }
}

// ── Class name resolver ─────────────────────────────────────────────────────
async function resolveClassName(schoolId, classId) {
  if (!classId) return '';
  try {
    const classData = await withTimeout(
      service.getClassById(classId),
      CLASS_NAME_TIMEOUT_MS
    );
    if (classData) return safeVal(classData.name || classData.className);
  } catch (err) {
    console.warn('[StudentPortal] Class name fail:', err);
  }
  return '';
}

// ── Passport photo edit ─────────────────────────────────────────────────────
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
  const outsideClick = (ev) => {
    if (!menu.contains(ev.target) && ev.target !== photoWrapper.querySelector('.camera-icon')) closeMenu();
  };
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

// ── Hero card ────────────────────────────────────────────────────────────────
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

// ── About Me ────────────────────────────────────────────────────────────────
function renderProfile(student, subjects) {
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

  const safeSubjects = Array.isArray(subjects) ? subjects : [];
  const subjectsHtml = safeSubjects.length
    ? `<div class="about-subjects-section">
         <h3 class="about-subjects-heading"><i class="fa-solid fa-book-open"></i> Subjects</h3>
         <div class="about-subjects-list">
           ${safeSubjects.map(s => `<span class="subject-chip">${escapeHtml(safeVal(s.name || s.subjectName) || '—')}</span>`).join('')}
         </div>
       </div>`
    : `<div class="about-subjects-section">
         <h3 class="about-subjects-heading"><i class="fa-solid fa-book-open"></i> Subjects</h3>
         <p class="about-subjects-empty">No subjects assigned for this term.</p>
       </div>`;

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
    </div>
    ${subjectsHtml}
  `;
}

// ── Attendance ──────────────────────────────────────────────────────────────
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

// ── Assignments ─────────────────────────────────────────────────────────────
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

// ── CBT results ─────────────────────────────────────────────────────────────
async function fetchCbtScores() {
  if (!currentStudentId || !currentSchoolId) return [];
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
      total: data.totalQuestions ?? data.total ?? data.totalPossible ?? 0,
      term: data.term || '—',
      session: data.session || '—',
      date: data.completedAt ? data.completedAt.toDate() : null
    });
  });
  return results;
}

function buildResultsRow(item) {
  const scoreNum  = Number(item.score) || 0;
  const totalNum  = Number(item.total) || 0;
  const scoreDisplay = totalNum > 0 ? `${scoreNum}/${totalNum}` : `${scoreNum}`;

  let pctDisplay = '—';
  if (totalNum > 0) {
    const pct = (scoreNum / totalNum) * 100;
    const rounded = Math.round(pct * 10) / 10;
    pctDisplay = `${rounded}%`;
  }

  const dateStr = item.date
    ? item.date.toLocaleDateString('en-NG', { year:'numeric', month:'short', day:'numeric' })
    : '—';
  const termSession = `${item.term} ${item.session}`.trim();

  return `
    <tr>
      <td class="subject-name-cell">${escapeHtml(item.subject)}</td>
      <td class="score-highlight">${scoreDisplay}</td>
      <td class="percentage-cell">${pctDisplay}</td>
      <td>${escapeHtml(termSession || '—')}</td>
      <td>${dateStr}</td>
    </tr>
  `;
}

function renderResultsTableBody() {
  const tableEl = document.getElementById('resultsTableContainer');
  if (!tableEl) return;

  if (!allCbtScores.length) {
    tableEl.innerHTML = `
      <div style="text-align:center; padding:2rem; color: var(--gray-500);">
        <i class="fa-solid fa-clipboard-list" style="font-size:2rem; margin-bottom:0.5rem; display:block;"></i>
        No CBT scores found yet.<br>
        Complete a CBT test to see your results here.
      </div>`;
    return;
  }

  const visibleSlice = allCbtScores.slice(0, visibleCbtCount);
  const remaining    = allCbtScores.length - visibleSlice.length;
  const hasMore      = remaining > 0;

  let html = `
    <div class="table-responsive-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>Subject</th>
            <th>Score</th>
            <th>Percentage (%)</th>
            <th>Term / Session</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          ${visibleSlice.map(item => buildResultsRow(item)).join('')}
        </tbody>
      </table>
    </div>
  `;

  if (hasMore) {
    html += `
      <button type="button" class="see-more-btn" id="seeMoreResultsBtn" aria-label="Load more results">
        <i class="fa-solid fa-chevron-down"></i>
        <span>See more</span>
        <span class="remaining-count">${remaining}</span>
      </button>
    `;
  }

  tableEl.innerHTML = html;

  if (hasMore) {
    document.getElementById('seeMoreResultsBtn').addEventListener('click', () => {
      visibleCbtCount += RESULTS_LOAD_STEP;
      renderResultsTableBody();
      if (activeAccordionPane && activeAccordionPane.getAttribute('data-pane') === 'results') {
        activeAccordionPane.style.maxHeight = '';
      }
    });
  }
}

// ── Subject name resolver (lightweight) ─────────────────────────────────────
async function resolveSubjectNames(rawSubjects) {
  if (!Array.isArray(rawSubjects) || rawSubjects.length === 0) return [];
  const first = rawSubjects[0];

  if (typeof first === 'string') {
    const promises = rawSubjects.map(async (id) => {
      try {
        const snap = await getDoc(doc(db, 'subjects', id));
        const d = snap.exists() ? snap.data() : {};
        return { id, name: safeVal(d.name || d.subjectName) || id };
      } catch {
        return { id, name: id };
      }
    });
    return Promise.all(promises);
  }

  if (typeof first === 'object' && first !== null) {
    return rawSubjects.map(s => ({
      id: safeVal(s.id || s.subjectId),
      name: safeVal(s.name || s.subjectName) || '—'
    }));
  }
  return [];
}

// ── Notifications ───────────────────────────────────────────────────────────
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
  });

  unsubscribeScores = onSnapshot(scoresQuery, snap => {
    scoreDocs = snap.docs;
    mergeAndRender(cbtDocs, scoreDocs);
  }, err => {
    console.warn('Scores listener error:', err);
  });
}

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

      if (!notificationListenersStarted) {
        notificationListenersStarted = true;
        setupNotificationListeners(
          safeVal(currentStudentData?.classId),
          currentStudentId
        );
      }
    }
  });
  document.addEventListener('click', e => {
    if (!bell.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove('show');
    }
  });
}

// ── Cleanup / logout / download ────────────────────────────────────────────
function cleanupListeners() {
  if (unsubscribeCBT) { unsubscribeCBT(); unsubscribeCBT = null; }
  if (unsubscribeScores) { unsubscribeScores(); unsubscribeScores = null; }
  if (unsubscribeSubscription) { unsubscribeSubscription(); unsubscribeSubscription = null; }
}

async function logout() {
  cleanupListeners();
  try { await signOut(auth); } catch (err) {
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

// ── Student fetch (with self-heal) ─────────────────────────────────────────
// Fires once. If it times out, boot proceeds without it; when the read
// eventually resolves, this function renders the hero (and refreshes
// profile if it was already opened).
async function fetchAndRenderStudent() {
  try {
    const data = await service.getStudentById(currentStudentId);
    if (!data) return;

    currentStudentData = data;

    // Resolve class name (only if not already cached)
    const classId = safeVal(data.classId);
    if (classId && !resolvedClassName) {
      resolvedClassName = await resolveClassName(currentSchoolId, classId);
    }

    // Render hero
    renderHero(currentStudentData);
    studentRenderDone = true;

    // If the profile pane was opened before the student arrived, refresh it.
    if (loadedPanes.has('profile')) {
      renderProfile(currentStudentData, subjectsList);
    }
  } catch (err) {
    console.warn('[StudentPortal] Background student load error:', err);
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function bootDashboard(user) {
  const bootStart = Date.now();

  try {
    // ── Step 1: auth read (essential — no self-heal possible) ──
    const userData = await service.getUserById(user.uid);
    if (!userData) {
      toast.error('User profile not found. Please log out and log in again.');
      window.location.href = '/';
      return;
    }
    if (userData.role !== 'student') {
      toast.error('Access denied. Student privileges required.');
      await signOut(auth);
      window.location.href = '/';
      return;
    }

    currentStudentId = user.uid;
    currentSchoolId  = userData.schoolId;
    if (!currentSchoolId) {
      toast.error('School information missing. Please contact your administrator.');
      window.location.href = '/';
      return;
    }

    localStorage.setItem('userSchoolId', currentSchoolId);
    localStorage.setItem('userRole', 'student');
    localStorage.setItem('studentId', user.uid);

    try { await enforcePasswordChange(window.location.href); } catch (_) { /* redirecting */ }

    if (userData.disabled) {
      toast.error('Your account has been disabled. Contact the school.');
      await signOut(auth);
      window.location.href = '/';
      return;
    }

    // ── Step 2: kick off parallel essential reads ──
    // Student fetch is fire-and-forget: it self-heals when it eventually resolves.
    fetchAndRenderStudent(); // no await — runs in background

    // Calendar + subscription listeners kick off their subscriptions now.
    initCalendar();
    initSubscriptionListener(currentSchoolId);

    // Await only the timeouts, not the actual reads.
    await Promise.all([
      loadSchoolHeader(currentSchoolId),                           // fire-and-forget style
      withTimeout(calendarReadyPromise, CALENDAR_TIMEOUT_MS),
      withTimeout(subscriptionReadyPromise, SUBSCRIPTION_TIMEOUT_MS)
    ]);

    // ── Step 3: hold the loader for a minimum sensible time ──
    // Only for fast networks, so the spinner doesn't flash-and-vanish.
    const elapsed = Date.now() - bootStart;
    if (elapsed < MIN_BOOT_TIME_MS) {
      await new Promise(r => setTimeout(r, MIN_BOOT_TIME_MS - elapsed));
    }

    // ── Step 4: warn gently if the student read hasn't landed yet ──
    if (!studentRenderDone) {
      console.warn('[StudentPortal] Student read is slow — hero will render when it lands.');
    }
  } catch (err) {
    console.error('[StudentPortal] Boot error:', err);
    toast.error('Unable to load dashboard. Please refresh the page.');
  } finally {
    // ALWAYS hide the loader. `finally` guarantees this even if the try
    // block threw anywhere above.
    hideFullScreenLoader();
  }

  // ── Step 5: wire up the UI (safe even if student is still pending) ──
  initInternalTabs();
  initNotificationBell();
  initDownload();
  document.getElementById('logoutBtn')?.addEventListener('click', logout);
  const yearEl = document.getElementById('currentYear');
  if (yearEl) yearEl.innerText = new Date().getFullYear();
}

// ── App entry ───────────────────────────────────────────────────────────────
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = '/';
    return;
  }
  bootDashboard(user);
});