/**
 * teacher-clock.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Teacher-side engine for:
 *   • Live clock display
 *   • GPS / geofence validation against school's saved fence
 *   • Clock In (creates new Firestore doc in teacher_attendance)
 *   • Clock Out (updates existing doc)
 *   • Today's status display
 *   • Last 7-day history table
 *
 * SECURITY NOTES:
 *   • All timestamps use serverTimestamp() — client clock is NEVER trusted.
 *   • schoolId and teacherId are read from Firestore (authenticated user's
 *     profile), NOT from localStorage or URL parameters.
 *   • GPS coordinates are logged for admin audit; the fence check runs on
 *     both client (UX feedback) and can be enforced via Firestore Security
 *     Rules + Cloud Functions for production hardening.
 *
 * Firestore collection: teacher_attendance
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * All Firestore operations go through service.js where possible.
 * TODO: service.js does not yet support teacher attendance operations (addDoc, updateDoc, getDocs for teacher_attendance).
 * These remain as direct Firestore calls.
 * All user-facing errors now show clear, friendly messages without technical jargon.
 */

import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import {
  collection, query, where, getDocs, getDoc,
  doc, addDoc, updateDoc, serverTimestamp, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { handleError, showNotification, toast } from './error-handler.js';
import * as service from './service.js';

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
let _schoolId      = null;
let _teacherUid    = null;
let _teacherDbId   = null;
let _teacherName   = '';
let _geofence      = null;
let _todayRecord   = null;
let _lastGps       = null;
let _clockTimer    = null;

// ─────────────────────────────────────────────────────────────────────────────
// HAVERSINE
// ─────────────────────────────────────────────────────────────────────────────
function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatHours(inTs, outTs) {
  if (!inTs || !outTs) return '—';
  const inD  = inTs.toDate  ? inTs.toDate()  : new Date(inTs);
  const outD = outTs.toDate ? outTs.toDate() : new Date(outTs);
  const diff = (outD - inD) / 3600000;
  if (diff < 0) return '—';
  const h = Math.floor(diff);
  const m = Math.round((diff - h) * 60);
  return `${h}h ${m}m`;
}

function derivedStatus(clockInTs, lateThresholdMinutes = 30) {
  if (!clockInTs) return 'absent';
  const d = clockInTs.toDate ? clockInTs.toDate() : new Date(clockInTs);
  const cutoff = new Date(d);
  cutoff.setHours(8, lateThresholdMinutes, 0, 0);
  return d <= cutoff ? 'present' : 'late';
}

function statusPill(status) {
  const map = {
    present:   ['status-present',   '<i class="fa-solid fa-circle-check"></i>',       'Present'],
    late:      ['status-late',      '<i class="fa-solid fa-clock"></i>',              'Late'],
    absent:    ['status-absent',    '<i class="fa-solid fa-circle-xmark"></i>',        'Absent'],
    clockedin: ['status-clockedin', '<i class="fa-solid fa-right-to-bracket"></i>',   'In School'],
    override:  ['status-override',  '<i class="fa-solid fa-pen-ruler"></i>',          'Override'],
  };
  const [cls, icon, label] = map[status] || ['', '', status || '—'];
  return `<span class="status-pill ${cls}">${icon} ${label}</span>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE CLOCK
// ─────────────────────────────────────────────────────────────────────────────
function startLiveClock() {
  const timeEl = document.getElementById('liveTime');
  const dateEl = document.getElementById('liveDate');
  if (!timeEl && !dateEl) return;

  function tick() {
    const now = new Date();
    if (timeEl) {
      timeEl.textContent = now.toLocaleTimeString('en-NG', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
      });
    }
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString('en-NG', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
    }
  }
  tick();
  _clockTimer = setInterval(tick, 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// GPS BAR
// ─────────────────────────────────────────────────────────────────────────────
function setGpsBar(state, message) {
  const bar  = document.getElementById('gpsBar');
  const text = document.getElementById('gpsText');
  const icon = document.getElementById('gpsIcon');
  if (!bar) return;
  bar.className = `gps-bar ${state}`;
  if (text) text.textContent = message;
  const icons = {
    checking:  'fa-solid fa-circle-notch fa-spin',
    within:    'fa-solid fa-circle-check',
    outside:   'fa-solid fa-location-dot',
    error:     'fa-solid fa-triangle-exclamation',
    disabled:  'fa-solid fa-location-slash',
  };
  if (icon) icon.className = `${icons[state] || 'fa-solid fa-location-dot'} gps-icon`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FEEDBACK TOAST (inline feedback, not to be confused with the global toast system)
// ─────────────────────────────────────────────────────────────────────────────
function showFeedback(type, text) {
  const el   = document.getElementById('clockFeedback');
  const span = document.getElementById('clockFeedbackText');
  if (!el || !span) return;
  el.className  = `clock-feedback ${type}`;
  span.textContent = text;
  const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info' };
  el.querySelector('i').className = `fa-solid ${icons[type] || 'fa-circle-info'}`;
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => { el.style.display = 'none'; }, 6000);
}

// ─────────────────────────────────────────────────────────────────────────────
// LOAD TEACHER PROFILE (using service)
// ─────────────────────────────────────────────────────────────────────────────
async function loadTeacherProfile(uid) {
  try {
    const user = await service.getUserById(uid);
    if (!user) {
      throw new Error('User profile not found.');
    }
    if (user.role !== 'teacher') {
      throw new Error('User is not a teacher.');
    }

    const schoolId = user.schoolId;
    const name = user.name || user.fullName || 'Teacher';

    let dbId = null;
    try {
      const teacher = await service.getTeacherById(uid);
      if (teacher) {
        dbId = uid;
      }
    } catch (e) {
      console.warn('Teacher metadata document not found; continuing with user profile only.', e);
    }

    return { schoolId, name, dbId };
  } catch (err) {
    console.error('Load teacher profile error:', err);
    toast.error('Unable to load your profile. Please refresh the page.');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOAD SCHOOL GEOFENCE (using service.getSchoolById)
// ─────────────────────────────────────────────────────────────────────────────
async function loadGeofence(schoolId) {
  try {
    const school = await service.getSchoolById(schoolId);
    if (!school) return null;
    return school.geofence || null;
  } catch (err) {
    console.error('Load geofence error:', err);
    toast.error('Unable to load geofence settings. Please refresh.');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GPS CHECK (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function getCurrentGps() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not supported by this browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({
        lat:      pos.coords.latitude,
        lng:      pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      err => reject(new Error(
        err.code === 1 ? 'Location permission denied. Please allow location access.'
        : err.code === 2 ? 'Location unavailable. Please try again outdoors.'
        : err.code === 3 ? 'Location request timed out. Please try again.'
        : err.message
      )),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

async function performGpsCheck() {
  if (!_geofence || !_geofence.lat) {
    setGpsBar('disabled', 'Geofence not configured by admin yet.');
    return { valid: false, distance: null };
  }

  setGpsBar('checking', 'Getting your GPS location…');

  try {
    const gps = await getCurrentGps();
    _lastGps  = gps;
    const dist = haversineMetres(gps.lat, gps.lng, _geofence.lat, _geofence.lng);
    const distRounded = Math.round(dist);
    const within = dist <= _geofence.radiusMetres;

    if (within) {
      setGpsBar('within',
        `You are ${distRounded}m from school — within the ${_geofence.radiusMetres}m fence ✓`);
    } else {
      setGpsBar('outside',
        `You are ${distRounded}m from school — outside the ${_geofence.radiusMetres}m fence. Please be on school premises.`);
    }
    return { valid: within, distance: distRounded, lat: gps.lat, lng: gps.lng };
  } catch (err) {
    setGpsBar('error', err.message);
    return { valid: false, distance: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOAD TODAY'S RECORD (direct Firestore – not in service)
// ─────────────────────────────────────────────────────────────────────────────
async function loadTodayRecord() {
  try {
    const today = todayStr();
    const snap  = await getDocs(
      query(
        collection(db, 'teacher_attendance'),
        where('uid',      '==', _teacherUid),
        where('schoolId', '==', _schoolId),
        where('date',     '==', today)
      )
    );
    if (!snap.empty) {
      _todayRecord = { id: snap.docs[0].id, ...snap.docs[0].data() };
    } else {
      _todayRecord = null;
    }
    renderTodayStatus();
    updateButtonStates();
  } catch (err) {
    console.error('Load today record error:', err);
    toast.error('Unable to load today\'s attendance. Please refresh.');
  }
}

function renderTodayStatus() {
  const r = _todayRecord;
  const statusEl   = document.getElementById('todayStatus');
  const clockInEl  = document.getElementById('todayClockIn');
  const clockOutEl = document.getElementById('todayClockOut');
  const hoursEl    = document.getElementById('todayHours');
  const distEl     = document.getElementById('todayDistance');

  if (!r) {
    if (statusEl)   statusEl.innerHTML = statusPill('absent');
    if (clockInEl)  { clockInEl.textContent = '—'; clockInEl.className = 'value'; }
    if (clockOutEl) { clockOutEl.textContent = '—'; clockOutEl.className = 'value'; }
    if (hoursEl)    hoursEl.textContent = '—';
    if (distEl)     distEl.textContent  = '—';
    return;
  }

  let display = r.status;
  if (!r.clockOut && r.clockIn) display = 'clockedin';
  if (r.adminOverride) display = 'override';

  if (statusEl)   statusEl.innerHTML = statusPill(display);
  if (clockInEl)  {
    clockInEl.textContent  = formatTime(r.clockIn);
    clockInEl.className    = 'value green';
  }
  if (clockOutEl) {
    clockOutEl.textContent = formatTime(r.clockOut) || 'Not yet';
    clockOutEl.className   = 'value' + (r.clockOut ? ' green' : ' amber');
  }
  if (hoursEl)    hoursEl.textContent = formatHours(r.clockIn, r.clockOut);
  if (distEl)     distEl.textContent  = r.distanceAtClockIn != null
    ? `${Math.round(r.distanceAtClockIn)}m`
    : '—';
}

function updateButtonStates() {
  const inBtn  = document.getElementById('clockInBtn');
  const outBtn = document.getElementById('clockOutBtn');
  if (!inBtn || !outBtn) return;

  const hasClockedIn  = _todayRecord?.clockIn  != null;
  const hasClockedOut = _todayRecord?.clockOut != null;

  inBtn.disabled  = hasClockedIn;
  outBtn.disabled = !hasClockedIn || hasClockedOut;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOCK IN (direct Firestore – not in service)
// ─────────────────────────────────────────────────────────────────────────────
async function performClockIn() {
  const inBtn = document.getElementById('clockInBtn');
  if (inBtn) { inBtn.disabled = true; inBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><br>Checking…'; }

  showFeedback('info', 'Checking your GPS location…');

  const gpsResult = await performGpsCheck();

  if (!gpsResult.valid) {
    showFeedback('error',
      _geofence
        ? `Clock-in failed — you are ${gpsResult.distance ?? '?'}m from school. You must be within ${_geofence.radiusMetres}m.`
        : 'Geofence not set up yet. Contact your admin.');
    if (inBtn) {
      inBtn.disabled = false;
      inBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i><br>Clock In';
    }
    return;
  }

  await loadTodayRecord();
  if (_todayRecord?.clockIn) {
    showFeedback('info', `You already clocked in today at ${formatTime(_todayRecord.clockIn)}.`);
    if (inBtn) { inBtn.disabled = true; inBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i><br>Clock In'; }
    return;
  }

  try {
    const today = todayStr();

    const docRef = await addDoc(collection(db, 'teacher_attendance'), {
      uid:          _teacherUid,
      teacherDbId:  _teacherDbId,
      teacherName:  _teacherName,
      schoolId:     _schoolId,
      date:         today,
      clockIn:      serverTimestamp(),
      clockOut:     null,
      clockInLat:          gpsResult.lat,
      clockInLng:          gpsResult.lng,
      distanceAtClockIn:   gpsResult.distance,
      withinFenceAtClockIn: true,
      clockOutLat:           null,
      clockOutLng:           null,
      distanceAtClockOut:    null,
      withinFenceAtClockOut: null,
      status:        null,
      method:        'geofence',
      adminOverride: false,
      adminOverrideBy:   null,
      adminOverrideNote: null,
      createdAt:    serverTimestamp(),
      updatedAt:    serverTimestamp(),
    });

    _todayRecord = { id: docRef.id };
    showFeedback('success',
      `Clocked in successfully — ${gpsResult.distance}m from school. Have a great day!`);
    toast.success('Clock-in recorded!');
    await loadTodayRecord();
    await loadHistory();
  } catch (err) {
    console.error('Clock-in error:', err);
    toast.error('Clock-in failed. Please try again.');
    showFeedback('error', `Error: ${err.message}`);
    if (inBtn) {
      inBtn.disabled = false;
      inBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i><br>Clock In';
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOCK OUT (direct Firestore – not in service)
// ─────────────────────────────────────────────────────────────────────────────
async function performClockOut() {
  const outBtn = document.getElementById('clockOutBtn');
  if (outBtn) { outBtn.disabled = true; outBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><br>Checking…'; }

  showFeedback('info', 'Checking your GPS location for clock-out…');

  const gpsResult = await performGpsCheck();

  if (!gpsResult.valid) {
    showFeedback('error',
      `Clock-out failed — you are ${gpsResult.distance ?? '?'}m from school. Please be on school premises.`);
    if (outBtn) {
      outBtn.disabled = false;
      outBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i><br>Clock Out';
    }
    return;
  }

  if (!_todayRecord?.id) {
    showFeedback('error', 'No clock-in record found for today.');
    if (outBtn) { outBtn.disabled = false; outBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i><br>Clock Out'; }
    return;
  }

  try {
    await updateDoc(doc(db, 'teacher_attendance', _todayRecord.id), {
      clockOut:              serverTimestamp(),
      clockOutLat:           gpsResult.lat,
      clockOutLng:           gpsResult.lng,
      distanceAtClockOut:    gpsResult.distance,
      withinFenceAtClockOut: true,
      updatedAt:             serverTimestamp(),
    });

    showFeedback('success', `Clocked out successfully — ${gpsResult.distance}m from school. See you tomorrow!`);
    toast.success('Clock-out recorded!');
    await loadTodayRecord();
    await loadHistory();
  } catch (err) {
    console.error('Clock-out error:', err);
    toast.error('Clock-out failed. Please try again.');
    showFeedback('error', `Error: ${err.message}`);
    if (outBtn) {
      outBtn.disabled = false;
      outBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i><br>Clock Out';
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOAD HISTORY (direct Firestore – not in service)
// ─────────────────────────────────────────────────────────────────────────────
async function loadHistory() {
  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;
  try {
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    const snap = await getDocs(
      query(
        collection(db, 'teacher_attendance'),
        where('uid',      '==', _teacherUid),
        where('schoolId', '==', _schoolId)
      )
    );

    const records = {};
    snap.forEach(d => {
      const data = d.data();
      if (data.date) records[data.date] = data;
    });

    const lateMin = _geofence?.lateThresholdMinutes ?? 30;

    tbody.innerHTML = dates.map(dateStr => {
      const rec     = records[dateStr];
      const isToday = dateStr === todayStr();
      const clockIn  = rec ? formatTime(rec.clockIn)  : '—';
      const clockOut = rec ? formatTime(rec.clockOut) : '—';
      const hours    = rec ? formatHours(rec.clockIn, rec.clockOut) : '—';
      let   status   = 'absent';
      if (rec) {
        status = rec.status || (rec.clockIn && !rec.clockOut ? 'clockedin' : derivedStatus(rec.clockIn, lateMin));
        if (rec.adminOverride) status = 'override';
      }
      const todayBadge = isToday
        ? '<span style="background:#e0f2fe;color:#0369a1;border-radius:6px;padding:1px 6px;font-size:.65rem;font-weight:800;margin-left:4px;">TODAY</span>'
        : '';
      return `
        <tr>
          <td style="font-weight:700;white-space:nowrap;">
            ${new Date(dateStr + 'T12:00:00').toLocaleDateString('en-NG',{ weekday:'short', day:'numeric', month:'short' })}
            ${todayBadge}
          </td>
          <td>${clockIn}</td>
          <td>${clockOut}</td>
          <td>${hours}</td>
          <td>${statusPill(status)}</td>
        </tr>`;
    }).join('');
  } catch (err) {
    console.error('Load history error:', err);
    toast.error('Failed to load attendance history. Please refresh.');
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#ef4444;">Failed to load history.您</td><td>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BUTTON RIPPLE EFFECT
// ─────────────────────────────────────────────────────────────────────────────
function addRipple(btn) {
  btn.classList.add('ripple');
  setTimeout(() => btn.classList.remove('ripple'), 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN INIT
// ─────────────────────────────────────────────────────────────────────────────
export async function initTeacherClockPage(passedTeacherName = '') {
  startLiveClock();

  const uid = await new Promise(resolve => {
    const unsub = onAuthStateChanged(auth, user => {
      unsub();
      resolve(user ? user.uid : null);
    });
  });

  if (!uid) {
    toast.error('You are not logged in. Please log in again.');
    return;
  }
  _teacherUid = uid;

  const profile = await loadTeacherProfile(uid);
  if (!profile) {
    toast.error('Teacher profile not found. Please contact your administrator.');
    return;
  }
  _schoolId    = profile.schoolId;
  _teacherName = profile.name;
  _teacherDbId = profile.dbId;

  const nameEl = document.getElementById('teacherDisplayName');
  if (nameEl) nameEl.textContent = _teacherName;

  if (!_schoolId) {
    toast.error('School not linked to your profile. Please contact your administrator.');
    return;
  }

  _geofence = await loadGeofence(_schoolId);
  if (!_geofence || !_geofence.enabled) {
    setGpsBar('disabled', 'Geofence not yet configured by your admin. Clock-in is unavailable.');
    showFeedback('info', 'Your school admin has not set up the geofence yet. Please check back later.');
    return;
  }

  await loadTodayRecord();
  await loadHistory();

  document.getElementById('checkGpsBtn')?.addEventListener('click', async () => {
    const result = await performGpsCheck();
    updateButtonStates();
    const inBtn  = document.getElementById('clockInBtn');
    const outBtn = document.getElementById('clockOutBtn');
    const hasClockedIn  = _todayRecord?.clockIn  != null;
    const hasClockedOut = _todayRecord?.clockOut != null;
    if (inBtn)  inBtn.disabled  = !result.valid || hasClockedIn;
    if (outBtn) outBtn.disabled = !result.valid || !hasClockedIn || hasClockedOut;
  });

  document.getElementById('clockInBtn')?.addEventListener('click', async (e) => {
    addRipple(e.currentTarget);
    await performClockIn();
  });

  document.getElementById('clockOutBtn')?.addEventListener('click', async (e) => {
    addRipple(e.currentTarget);
    await performClockOut();
  });
}