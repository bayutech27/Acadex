/**
 * teacher-attendance.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Admin engine for:
 *   • Setting up the school geofence (GPS lat/lng + radius)
 *   • Viewing real-time teacher attendance records from Firestore
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
// GEOFENCE SETUP
// ─────────────────────────────────────────────────────────────────────────────
async function loadGeofenceSettings(schoolId) {
  try {
    const snap = await getDoc(doc(db, 'schools', schoolId));
    if (!snap.exists()) return null;
    const data = snap.data();
    return data.geofence || null;
  } catch (err) {
    handleError(err, 'Failed to load geofence settings.');
    return null;
  }
}

function renderGeofenceStatus(geofence) {
  const el   = document.getElementById('geofenceStatus');
  const text = document.getElementById('geofenceStatusText');
  if (!el || !text) return;
  if (geofence && geofence.lat && geofence.lng) {
    el.className   = 'geofence-status set';
    el.innerHTML   = `<i class="fa-solid fa-circle-check"></i>
      <span>Geofence active — Centre: ${geofence.lat.toFixed(5)}, ${geofence.lng.toFixed(5)} |
      Radius: ${geofence.radiusMetres}m |
      Late after: ${geofence.lateThresholdMinutes} min past 8 AM</span>`;
  } else {
    el.className   = 'geofence-status notset';
    el.innerHTML   = `<i class="fa-solid fa-circle-exclamation"></i>
      <span>Geofence not configured yet — please set your school location below.</span>`;
  }
}

function populateGeofenceForm(geofence) {
  if (!geofence) return;
  const latEl   = document.getElementById('geofenceLat');
  const lngEl   = document.getElementById('geofenceLng');
  const radEl   = document.getElementById('geofenceRadius');
  const lateEl  = document.getElementById('geofenceLateThreshold');
  if (latEl)  latEl.value  = geofence.lat  || '';
  if (lngEl)  lngEl.value  = geofence.lng  || '';
  if (radEl)  radEl.value  = geofence.radiusMetres  || 150;
  if (lateEl) lateEl.value = geofence.lateThresholdMinutes ?? 30;
}

function setupGeofenceUI(schoolId) {
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
            Click Save Geofence to confirm.</span>`;
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

  // ── Save geofence button ─────────────────────────────────
  document.getElementById('saveGeofenceBtn')?.addEventListener('click', async () => {
    const lat    = parseFloat(document.getElementById('geofenceLat')?.value);
    const lng    = parseFloat(document.getElementById('geofenceLng')?.value);
    const radius = parseInt(document.getElementById('geofenceRadius')?.value, 10);
    const late   = parseInt(document.getElementById('geofenceLateThreshold')?.value, 10);

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
          lateThresholdMinutes: isNaN(late) ? 30 : late,
          enabled: true,
          updatedAt: serverTimestamp(),
        }
      });
      renderGeofenceStatus({ lat, lng, radiusMetres: radius, lateThresholdMinutes: late });
      const msg = document.getElementById('geofenceSaveMsg');
      if (msg) { msg.style.display = 'inline-flex'; setTimeout(() => { msg.style.display = 'none'; }, 3500); }
      showNotification('Geofence saved successfully!', 'success');
    } catch (err) {
      handleError(err, 'Failed to save geofence.');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Geofence'; }
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

    // 3 – Build full list (present + absent)
    let countPresent = 0, countLate = 0, countAbsent = 0;
    const rows = [];

    Object.entries(allTeachers).forEach(([tid, teacher]) => {
      const uid = teacher.uid || teacher.authUid || tid;
      const rec = records[uid] || null;
      let status = 'absent';
      if (rec) {
        status = rec.status || (rec.clockIn && !rec.clockOut ? 'clockedin' : 'present');
        if (rec.adminOverride) status = 'override';
      }
      if (status === 'present' || status === 'override') countPresent++;
      else if (status === 'late') countLate++;
      else if (status === 'clockedin') { /* in school, not yet clocked out */ }
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

    // Sort: present first, then late, then clockedin, then absent
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
// EXPORT CSV
// ─────────────────────────────────────────────────────────────────────────────
function exportToCSV(data, filename) {
  if (!data || data.length === 0) {
    showNotification('No data to export.', 'error');
    return;
  }
  const headers = Object.keys(data[0]);
  const csv = [
    headers.join(','),
    ...data.map(row =>
      headers.map(h => {
        const val = row[h] == null ? '' : String(row[h]);
        return val.includes(',') ? `"${val}"` : val;
      }).join(',')
    )
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// POPULATE OVERRIDE SELECT
// ─────────────────────────────────────────────────────────────────────────────
async function populateTeacherSelect(schoolId) {
  const sel = document.getElementById('overrideTeacherSelect');
  if (!sel) return;
  try {
    const snap = await getDocs(
      query(collection(db, 'teachers'), where('schoolId', '==', schoolId))
    );
    sel.innerHTML = '<option value="">— Select teacher —</option>';
    snap.forEach(d => {
      const t   = d.data();
      const uid = t.uid || t.authUid || d.id;
      const name = t.name || t.fullName || 'Unknown';
      sel.innerHTML += `<option value="${uid}">${name}</option>`;
    });
  } catch (err) {
    handleError(err, 'Failed to load teacher list for override.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN OVERRIDE
// ─────────────────────────────────────────────────────────────────────────────
async function setupOverrideUI(schoolId) {
  document.getElementById('applyOverrideBtn')?.addEventListener('click', async () => {
    const uid    = document.getElementById('overrideTeacherSelect')?.value;
    const date   = document.getElementById('overrideDateInput')?.value;
    const status = document.getElementById('overrideStatusSelect')?.value;
    const note   = document.getElementById('overrideNote')?.value?.trim();
    const msgEl  = document.getElementById('overrideMsg');

    if (!uid)   { showMsg(msgEl, '<i class="fa-solid fa-exclamation"></i> Please select a teacher.', 'error'); return; }
    if (!date)  { showMsg(msgEl, '<i class="fa-solid fa-exclamation"></i> Please select a date.', 'error'); return; }
    if (!note)  { showMsg(msgEl, '<i class="fa-solid fa-exclamation"></i> A reason is required for override.', 'error'); return; }

    const btn = document.getElementById('applyOverrideBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }

    try {
      // Check if a record exists for this teacher+date
      const existSnap = await getDocs(
        query(
          collection(db, 'teacher_attendance'),
          where('schoolId', '==', schoolId),
          where('uid', '==', uid),
          where('date', '==', date)
        )
      );

      const currentAdminUser = getCurrentUser();
      const overridePayload = {
        schoolId,
        uid,
        date,
        status,
        adminOverride:      true,
        adminOverrideBy:    currentAdminUser?.uid || 'admin',
        adminOverrideNote:  note,
        adminOverrideAt:    serverTimestamp(), // server-side — cannot be faked
        updatedAt:          serverTimestamp(),
      };

      if (!existSnap.empty) {
        // Update existing record
        await updateDoc(doc(db, 'teacher_attendance', existSnap.docs[0].id), overridePayload);
      } else {
        // Create new override record
        await addDoc(collection(db, 'teacher_attendance'), {
          ...overridePayload,
          clockIn:       null,
          clockOut:      null,
          method:        'admin_override',
          withinFence:   null,
          createdAt:     serverTimestamp(),
        });
      }

      showMsg(msgEl,
        `<i class="fa-solid fa-circle-check"></i> Override applied — ${status} recorded for ${date}.`,
        'success');
      showNotification('Override saved successfully.', 'success');

      // Refresh table if same date is displayed
      const filterDate = document.getElementById('attendanceDateFilter')?.value;
      if (filterDate === date) {
        await loadAttendanceForDate(schoolId, date);
      }
    } catch (err) {
      handleError(err, 'Override failed. Please try again.');
      showMsg(msgEl,
        `<i class="fa-solid fa-circle-xmark"></i> Error: ${err.message}`,
        'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-pen-ruler"></i> Apply Override'; }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN INIT
// ─────────────────────────────────────────────────────────────────────────────
export async function initTeacherAttendancePage() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) {
    showNotification('School ID not found. Please log in again.', 'error');
    return;
  }

  // Load and display existing geofence
  const geofence = await loadGeofenceSettings(schoolId);
  renderGeofenceStatus(geofence);
  populateGeofenceForm(geofence);
  setupGeofenceUI(schoolId);

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

  // Export button
  document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
    const date = document.getElementById('attendanceDateFilter')?.value || todayStr();
    exportToCSV(
      window.__attendanceExportData || [],
      `teacher_attendance_${date}.csv`
    );
  });
}