/**
 * teacher-attendance.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Admin engine for:
 *   • Setting up the school geofence (GPS lat/lng + radius)
 *   • Configuring official resumption time & late threshold
 *   • Viewing real‑time teacher attendance records from Firestore
 *   • Summary stats (present / late / absent / total)
 *   • Exporting attendance to CSV
 *   • Admin override (manually mark a teacher's status)
 *
 * Firestore collection: teacher_attendance
 * School geofence stored in: schools/{schoolId}  →  geofence: { ... }
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { auth, db } from './firebase-config.js';
import {
  collection, query, where, getDocs, getDoc,
  doc, updateDoc, addDoc, serverTimestamp, orderBy
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentUser, getCurrentUserData, getCurrentSchoolId } from './admin.js';
import { handleError, showNotification } from './error-handler.js';

// ─────────────────────────────────────────────────────────────────────────────
// HAVERSINE – distance between two GPS points in metres
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
// HELPER: Compute teacher status from server timestamp + school settings
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {Timestamp|null} clockIn - Firestore Timestamp or null
 * @param {string} officialResumeTime - "HH:mm" e.g. "08:00"
 * @param {number} lateAfterMinutes - grace minutes after official time
 * @returns {string} 'present', 'late', or 'absent'
 */
function computeTeacherStatus(clockIn, officialResumeTime, lateAfterMinutes) {
  if (!clockIn) return 'absent';
  // Parse official time
  const [h, m] = officialResumeTime.split(':').map(Number);
  // Create a Date object for the same day as the clockIn, but set hours/minutes to official time + grace
  const clockInDate = clockIn.toDate(); // Firestore Timestamp → JS Date
  const cutoff = new Date(clockInDate);
  cutoff.setHours(h, m, 0, 0);                         // set to official time
  cutoff.setMinutes(cutoff.getMinutes() + lateAfterMinutes); // add grace period

  return clockInDate <= cutoff ? 'present' : 'late';
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
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

function statusPill(status) {
  const map = {
    present:  ['status-present',   '<i class="fa-solid fa-circle-check"></i>',  'Present'],
    late:     ['status-late',      '<i class="fa-solid fa-clock"></i>',          'Late'],
    absent:   ['status-absent',    '<i class="fa-solid fa-circle-xmark"></i>',   'Absent'],
    override: ['status-override',  '<i class="fa-solid fa-pen-ruler"></i>',      'Override'],
    clockedin:['status-clockedin', '<i class="fa-solid fa-right-to-bracket"></i>','In School'],
  };
  const [cls, icon, label] = map[status] || ['status-absent', '', status || '—'];
  return `<span class="status-pill ${cls}">${icon} ${label}</span>`;
}

function showMsg(el, text, type = 'success') {
  if (!el) return;
  const colors = {
    success: '#065f46',
    error:   '#991b1b',
    info:    '#0369a1',
  };
  el.style.display     = 'block';
  el.style.color       = colors[type] || colors.success;
  el.innerHTML         = text;
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ─────────────────────────────────────────────────────────────────────────────
// GEOFENCE & ATTENDANCE SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the school's full geofence + attendance settings.
 * Returns an object with the new fields or sensible defaults.
 */
async function loadAttendanceSettings(schoolId) {
  try {
    const snap = await getDoc(doc(db, 'schools', schoolId));
    if (!snap.exists()) return null;
    const data = snap.data();
    const gf = data.geofence || {};
    return {
      lat: gf.lat || null,
      lng: gf.lng || null,
      radiusMetres: gf.radiusMetres || 150,
      enabled: gf.enabled || false,
      officialResumeTime: gf.officialResumeTime || '08:00',   // ★ NEW
      lateAfterMinutes: gf.lateAfterMinutes ?? 30,            // ★ NEW
      updatedAt: gf.updatedAt || null,
    };
  } catch (err) {
    handleError(err, 'Failed to load attendance settings.');
    return null;
  }
}

function renderGeofenceStatus(settings) {
  const el   = document.getElementById('geofenceStatus');
  const text = document.getElementById('geofenceStatusText');
  if (!el || !text) return;
  if (settings && settings.lat && settings.lng) {
    el.className = 'geofence-status set';
    el.innerHTML = `<i class="fa-solid fa-circle-check"></i>
      <span>Geofence active — Centre: ${settings.lat.toFixed(5)}, ${settings.lng.toFixed(5)} |
      Radius: ${settings.radiusMetres}m |
      Official time: ${settings.officialResumeTime} (late after ${settings.lateAfterMinutes} min)</span>`;
  } else {
    el.className = 'geofence-status notset';
    el.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i>
      <span>Geofence not configured yet — please set your school location below.</span>`;
  }
}

function populateSettingsForm(settings) {
  if (!settings) return;
  document.getElementById('geofenceLat').value            = settings.lat  || '';
  document.getElementById('geofenceLng').value            = settings.lng  || '';
  document.getElementById('geofenceRadius').value         = settings.radiusMetres || 150;
  // ★ NEW: official time and late minutes
  const officialEl = document.getElementById('officialResumeTime');
  if (officialEl) officialEl.value = settings.officialResumeTime || '08:00';
  const lateEl = document.getElementById('geofenceLateThreshold');
  if (lateEl) lateEl.value = settings.lateAfterMinutes ?? 30;
}

function setupSettingsUI(schoolId) {
  // ── Use my current location button ──────────────────────
  document.getElementById('useMyLocationBtn')?.addEventListener('click', () => {
    const status = document.getElementById('geofenceStatus');
    if (status) {
      status.className = 'geofence-status saving';
      status.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin gps-pulse"></i>
        <span>Requesting GPS location…</span>`;
    }
    if (!navigator.geolocation) {
      showNotification('Geolocation is not supported by this browser.', 'error');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        document.getElementById('geofenceLat').value = pos.coords.latitude.toFixed(7);
        document.getElementById('geofenceLng').value = pos.coords.longitude.toFixed(7);
        if (status) {
          status.className = 'geofence-status set';
          status.innerHTML = `<i class="fa-solid fa-location-dot"></i>
            <span>Location detected — Lat: ${pos.coords.latitude.toFixed(5)},
            Lng: ${pos.coords.longitude.toFixed(5)} (±${Math.round(pos.coords.accuracy)}m accuracy).
            Click Save to confirm.</span>`;
        }
      },
      (err) => {
        showNotification(`GPS error: ${err.message}`, 'error');
        if (status) {
          status.className = 'geofence-status notset';
          status.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i>
            <span>GPS failed: ${err.message}. Please enter coordinates manually.</span>`;
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });

  // ── Save button ─────────────────────────────────────────
  document.getElementById('saveGeofenceBtn')?.addEventListener('click', async () => {
    const lat     = parseFloat(document.getElementById('geofenceLat')?.value);
    const lng     = parseFloat(document.getElementById('geofenceLng')?.value);
    const radius  = parseInt(document.getElementById('geofenceRadius')?.value, 10);
    const officialTime = document.getElementById('officialResumeTime')?.value || '08:00'; // ★ NEW
    const lateMin = parseInt(document.getElementById('geofenceLateThreshold')?.value, 10);

    if (isNaN(lat) || isNaN(lng)) {
      showNotification('Please enter valid latitude and longitude values.', 'error');
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      showNotification('Coordinates out of valid range.', 'error');
      return;
    }

    const saveBtn = document.getElementById('saveGeofenceBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }

    try {
      await updateDoc(doc(db, 'schools', schoolId), {
        geofence: {
          lat,
          lng,
          radiusMetres: radius || 150,
          enabled: true,
          officialResumeTime: officialTime,   // ★ NEW
          lateAfterMinutes: isNaN(lateMin) ? 30 : lateMin,  // ★ UPDATED
          updatedAt: serverTimestamp(),
        }
      });
      const newSettings = { lat, lng, radiusMetres: radius, officialResumeTime: officialTime, lateAfterMinutes: isNaN(lateMin) ? 30 : lateMin };
      renderGeofenceStatus(newSettings);
      const msg = document.getElementById('geofenceSaveMsg');
      if (msg) { msg.style.display = 'inline-flex'; setTimeout(() => { msg.style.display = 'none'; }, 3500); }
      showNotification('Settings saved successfully!', 'success');
    } catch (err) {
      handleError(err, 'Failed to save settings.');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Settings'; }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE TABLE
// ─────────────────────────────────────────────────────────────────────────────
async function loadAttendanceForDate(schoolId, dateStr) {
  const tbody = document.getElementById('attendanceTableBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:1.5rem;">
    <i class="fa-solid fa-spinner fa-spin"></i> Loading…</td></tr>`;

  // ★ Load school settings for official time
  const settings = await loadAttendanceSettings(schoolId);
  const officialResumeTime = settings?.officialResumeTime || '08:00';
  const lateAfterMinutes   = settings?.lateAfterMinutes ?? 30;

  try {
    // 1 – Get all teachers in this school
    const teachersSnap = await getDocs(
      query(collection(db, 'teachers'), where('schoolId', '==', schoolId))
    );
    const allTeachers = {};
    teachersSnap.forEach(d => { allTeachers[d.id] = d.data(); });
    const totalCount = Object.keys(allTeachers).length;
    document.getElementById('countTotal').textContent = totalCount;

    // 2 – Get attendance records for this date
    const attSnap = await getDocs(
      query(
        collection(db, 'teacher_attendance'),
        where('schoolId', '==', schoolId),
        where('date', '==', dateStr)
      )
    );
    const records = {};
    attSnap.forEach(d => {
      const data = d.data();
      records[data.uid] = { id: d.id, ...data };
    });

    // 3 – Build full list (present + absent) with dynamic status
    let countPresent = 0, countLate = 0, countAbsent = 0;
    const rows = [];

    Object.entries(allTeachers).forEach(([tid, teacher]) => {
      const uid = teacher.uid || teacher.authUid || tid;
      const rec = records[uid] || null;
      let status = 'absent';

      if (rec) {
        if (rec.adminOverride) {
          status = 'override';
        } else {
          // ★ Compute real status from server timestamp + school settings
          status = computeTeacherStatus(rec.clockIn, officialResumeTime, lateAfterMinutes);
          // If clocked in but not out yet, mark as 'clockedin' (still at school)
          if (status === 'present' && rec.clockIn && !rec.clockOut) {
            status = 'clockedin';
          }
        }
      }

      // Count for summary
      if (status === 'present' || status === 'override') countPresent++;
      else if (status === 'late') countLate++;
      else if (status === 'clockedin') { /* counted separately if desired, here as present */ }
      else countAbsent++;

      rows.push({ tid, teacher, rec, status });
    });

    document.getElementById('countPresent').textContent = countPresent;
    document.getElementById('countLate').textContent    = countLate;
    document.getElementById('countAbsent').textContent  = countAbsent;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:2rem;">
        No teachers found for this school.</td></tr>`;
      return;
    }

    // Sort: present/override first, then late, then clockedin, then absent
    const order = { present:0, override:0, clockedin:1, late:2, absent:3 };
    rows.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

    tbody.innerHTML = rows.map((r, i) => {
      const name  = r.teacher.name || r.teacher.fullName || r.teacher.displayName || 'Unknown';
      const clockIn  = r.rec ? formatTime(r.rec.clockIn)  : '—';
      const clockOut = r.rec ? formatTime(r.rec.clockOut) : '—';
      const hours    = r.rec ? formatHours(r.rec.clockIn, r.rec.clockOut) : '—';
      const dist     = r.rec?.distanceAtClockIn != null
        ? `<span class="dist-badge">${Math.round(r.rec.distanceAtClockIn)}m</span>`
        : '—';
      const overrideMark = r.rec?.adminOverride
        ? ' <i class="fa-solid fa-pen-ruler" style="color:#0369a1;font-size:.7rem;" title="Admin override"></i>'
        : '';
      return `
        <tr>
          <td style="color:#94a3b8;font-size:.75rem;">${i + 1}</td>
          <td style="font-weight:700;color:#0d1b2a;">${name}${overrideMark}</td>
          <td>${clockIn}</td>
          <td>${clockOut}</td>
          <td>${dist}</td>
          <td>${hours}</td>
          <td>${statusPill(r.status)}</td>
          <td>
            <button class="btn-secondary" style="padding:.3rem .7rem;font-size:.73rem;"
              onclick="window.__openOverride('${r.teacher.uid || r.tid}','${name}')">
              <i class="fa-solid fa-pen"></i> Override
            </button>
          </td>
        </tr>`;
    }).join('');

    // Expose quick override trigger on window
    window.__openOverride = (uid, name) => {
      const sel = document.getElementById('overrideTeacherSelect');
      if (sel) {
        for (const opt of sel.options) {
          if (opt.value === uid) { sel.value = uid; break; }
        }
      }
      document.getElementById('overrideNote')?.focus();
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    };

    // Export data stored globally for CSV
    window.__attendanceExportData = rows.map(r => ({
      Name:       r.teacher.name || r.teacher.fullName || 'Unknown',
      Date:       dateStr,
      ClockIn:    r.rec ? formatTime(r.rec.clockIn) : '',
      ClockOut:   r.rec ? formatTime(r.rec.clockOut) : '',
      Hours:      r.rec ? formatHours(r.rec.clockIn, r.rec.clockOut) : '',
      Distance_m: r.rec?.distanceAtClockIn != null ? Math.round(r.rec.distanceAtClockIn) : '',
      Status:     r.status,
    }));

  } catch (err) {
    handleError(err, 'Failed to load attendance records.');
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#ef4444;padding:2rem;">
      Error loading records. Please try again.</td></tr>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT CSV (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function exportToCSV(data, filename) { /* … same as before … */ }

// ─────────────────────────────────────────────────────────────────────────────
// POPULATE OVERRIDE SELECT (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
async function populateTeacherSelect(schoolId) { /* … same as before … */ }

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN OVERRIDE (updated to not touch status computation)
// ─────────────────────────────────────────────────────────────────────────────
async function setupOverrideUI(schoolId) { /* … same as before … */ }

// ─────────────────────────────────────────────────────────────────────────────
// MAIN INIT
// ─────────────────────────────────────────────────────────────────────────────
export async function initTeacherAttendancePage() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) {
    showNotification('School ID not found. Please log in again.', 'error');
    return;
  }

  // Load and display existing settings (geofence + new fields)
  const settings = await loadAttendanceSettings(schoolId);
  renderGeofenceStatus(settings);
  populateSettingsForm(settings);
  setupSettingsUI(schoolId);

  // Populate teacher select for override
  await populateTeacherSelect(schoolId);
  await setupOverrideUI(schoolId);

  // Load today's attendance by default
  const today = todayStr();
  document.getElementById('attendanceDateFilter').value = today;
  await loadAttendanceForDate(schoolId, today);

  // Load button
  document.getElementById('loadAttendanceBtn')?.addEventListener('click', async () => {
    const date = document.getElementById('attendanceDateFilter')?.value || todayStr();
    await loadAttendanceForDate(schoolId, date);
  });

  // Export button (unchanged)
  document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
    const date = document.getElementById('attendanceDateFilter')?.value || todayStr();
    exportToCSV(
      window.__attendanceExportData || [],
      `teacher_attendance_${date}.csv`
    );
  });
}