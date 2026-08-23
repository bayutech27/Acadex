/**
 * teacher-attendance.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Admin engine for:
 *   • Setting up the school geofence (GPS lat/lng + radius)
 *   • Configuring official resumption time & late threshold
 *   • Viewing real‑time teacher attendance records from Firestore
 *   • Summary stats (present / late / absent / total expected)
 *   • Separate handling for full-time and part-time teachers
 *   • Part-time teacher schedule management (working days + start time)
 *   • Weekends (Saturday/Sunday) are excluded from attendance processing
 *   • Exporting attendance to CSV
 *   • Admin override (manually mark a teacher's status)
 *
 * Firestore collection: teacher_attendance
 * School geofence stored in: schools/{schoolId}  →  geofence: { ... }
 * Teacher type and part-time schedule stored in teacher document:
 *   type: 'full-time' or 'part-time'  (missing type defaults to full-time)
 *   partTimeDays: array of day names e.g. ['Monday','Wednesday']
 *   partTimeStartTime: string e.g. '09:00'
 *
 * All Firestore operations go through service.js where possible.
 * TODO: service.js does not yet support teacher attendance queries, teacher list retrieval
 * (getTeachersBySchool exists? Yes, service.getTeachersBySchool), and admin override updates.
 * Those remain as direct Firestore calls.
 * All user-facing errors now show clear, friendly messages without technical jargon.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import * as service from './service.js';
import { db, auth } from './firebase-config.js';
import {
  collection, query, where, getDocs, getDoc,
  doc, updateDoc, addDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentUser, getCurrentUserData, getCurrentSchoolId } from './admin.js';
import { handleError, showNotification, showLoader, hideLoader, toast } from './error-handler.js';

// ─────────────────────────────────────────────────────────────────────────────
// HAVERSINE – distance between two GPS points in metres (unchanged)
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
function computeTeacherStatus(clockIn, officialResumeTime, lateAfterMinutes) {
  if (!clockIn) return 'absent';
  const [h, m] = officialResumeTime.split(':').map(Number);
  const clockInDate = clockIn.toDate ? clockIn.toDate() : new Date(clockIn);
  const cutoff = new Date(clockInDate);
  cutoff.setHours(h, m, 0, 0);
  cutoff.setMinutes(cutoff.getMinutes() + lateAfterMinutes);
  return clockInDate <= cutoff ? 'present' : 'late';
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Determine if a date is a weekend (Saturday or Sunday)
// ─────────────────────────────────────────────────────────────────────────────
function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Get day name (Monday, Tuesday, etc.) from date string
// ─────────────────────────────────────────────────────────────────────────────
function getDayName(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return days[d.getDay()];
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: escape HTML
// ─────────────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
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

function statusPill(status) {
  const map = {
    present:  ['status-present',   '<i class="fa-solid fa-circle-check"></i>',  'Present'],
    late:     ['status-late',      '<i class="fa-solid fa-clock"></i>',          'Late'],
    absent:   ['status-absent',    '<i class="fa-solid fa-circle-xmark"></i>',   'Absent'],
    override: ['status-override',  '<i class="fa-solid fa-pen-ruler"></i>',      'Override'],
    clockedin:['status-clockedin', '<i class="fa-solid fa-right-to-bracket"></i>','In School'],
    notscheduled: ['status-notscheduled', '<i class="fa-solid fa-ban"></i>', 'Not Scheduled'],
  };
  const [cls, icon, label] = map[status] || ['status-absent', '', status || '—'];
  return `<span class="status-pill ${cls}">${icon} ${label}</span>`;
}

function showMsg(el, text, type = 'success') {
  if (!el) return;
  const colors = { success: '#065f46', error: '#991b1b', info: '#0369a1' };
  el.style.display = 'block';
  el.style.color = colors[type] || colors.success;
  el.innerHTML = text;
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ─────────────────────────────────────────────────────────────────────────────
// GEOFENCE & ATTENDANCE SETTINGS (using service.getSchoolById + service.updateGeofence)
// ─────────────────────────────────────────────────────────────────────────────

async function loadAttendanceSettings(schoolId) {
  try {
    const school = await service.getSchoolById(schoolId);
    if (!school) return null;
    const gf = school.geofence || {};
    return {
      lat: gf.lat || null,
      lng: gf.lng || null,
      radiusMetres: gf.radiusMetres || 150,
      enabled: gf.enabled || false,
      officialResumeTime: gf.officialResumeTime || '08:00',
      lateAfterMinutes: gf.lateAfterMinutes ?? 30,
      updatedAt: gf.updatedAt || null,
    };
  } catch (err) {
    console.error('Load attendance settings error:', err);
    toast.warning('Unable to load attendance settings. Using default values.');
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
  const officialEl = document.getElementById('officialResumeTime');
  if (officialEl) officialEl.value = settings.officialResumeTime || '08:00';
  const lateEl = document.getElementById('geofenceLateThreshold');
  if (lateEl) lateEl.value = settings.lateAfterMinutes ?? 30;
}

function setupSettingsUI(schoolId) {
  document.getElementById('useMyLocationBtn')?.addEventListener('click', () => {
    const status = document.getElementById('geofenceStatus');
    if (status) {
      status.className = 'geofence-status saving';
      status.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin gps-pulse"></i>
        <span>Requesting GPS location…</span>`;
    }
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by this browser.');
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
        toast.error(`GPS error: ${err.message}`);
        if (status) {
          status.className = 'geofence-status notset';
          status.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i>
            <span>GPS failed: ${err.message}. Please enter coordinates manually.</span>`;
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });

  document.getElementById('saveGeofenceBtn')?.addEventListener('click', async () => {
    const lat     = parseFloat(document.getElementById('geofenceLat')?.value);
    const lng     = parseFloat(document.getElementById('geofenceLng')?.value);
    const radius  = parseInt(document.getElementById('geofenceRadius')?.value, 10);
    const officialTime = document.getElementById('officialResumeTime')?.value || '08:00';
    const lateMin = parseInt(document.getElementById('geofenceLateThreshold')?.value, 10);

    if (isNaN(lat) || isNaN(lng)) {
      toast.error('Please enter valid latitude and longitude values.');
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      toast.error('Coordinates out of valid range.');
      return;
    }

    const saveBtn = document.getElementById('saveGeofenceBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }

    try {
      await service.updateGeofence(schoolId, {
        lat,
        lng,
        radiusMetres: radius || 150,
        enabled: true,
        officialResumeTime: officialTime,
        lateAfterMinutes: isNaN(lateMin) ? 30 : lateMin,
        updatedAt: new Date()
      });
      const newSettings = { lat, lng, radiusMetres: radius, officialResumeTime: officialTime, lateAfterMinutes: isNaN(lateMin) ? 30 : lateMin };
      renderGeofenceStatus(newSettings);
      const msg = document.getElementById('geofenceSaveMsg');
      if (msg) { msg.style.display = 'inline-flex'; setTimeout(() => { msg.style.display = 'none'; }, 3500); }
      toast.success('Settings saved successfully!');
    } catch (err) {
      console.error('Save geofence error:', err);
      toast.error('Failed to save settings. Please try again.');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Settings'; }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PART-TIME TEACHER SCHEDULE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
async function loadPartTimeScheduleManagement(schoolId) {
  const tbody = document.getElementById('partTimeScheduleBody');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:1.5rem;">
    <i class="fa-solid fa-spinner fa-spin"></i> Loading…</td></tr>`;

  try {
    const teachers = await service.getTeachersBySchool(schoolId);
    const partTimers = teachers
      .filter(t => (t.type || 'full-time').trim().toLowerCase() === 'part-time')
      .sort((a, b) => (a.name || a.fullName || '').localeCompare(b.name || b.fullName || ''));

    if (partTimers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:2rem;">
        No part-time teachers found. Add part-time teachers in the Teachers page.</td></tr>`;
      return;
    }

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

    const rows = partTimers.map(t => {
      const teacherId = t.id || t.uid || t.authUid;
      const name = t.name || t.fullName || t.displayName || 'Unknown';
      const savedDays = t.partTimeDays || [];
      const savedStart = t.partTimeStartTime || '08:00';

      const dayCheckboxes = days.map(day => `
        <label style="margin-right:0.6rem; white-space:nowrap;">
          <input type="checkbox" class="pt-day" data-day="${day}" ${savedDays.includes(day) ? 'checked' : ''}> ${day.slice(0,3)}
        </label>`).join('');

      return `
        <tr data-id="${teacherId}">
          <td style="font-weight:700;color:#0d1b2a;">${escapeHtml(name)}</td>
          <td>${dayCheckboxes}</td>
          <td><input type="time" class="pt-time" value="${escapeHtml(savedStart)}"></td>
          <td>
            <button class="btn-primary save-pt-schedule" style="padding:.3rem .8rem;font-size:.75rem;">
              <i class="fa-solid fa-floppy-disk"></i> Save
            </button>
          </td>
        </tr>`;
    }).join('');

    tbody.innerHTML = rows;

    tbody.querySelectorAll('.save-pt-schedule').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('tr');
        const teacherId = row.dataset.id;
        const checkedDays = Array.from(row.querySelectorAll('.pt-day:checked')).map(cb => cb.dataset.day);
        const startTime = row.querySelector('.pt-time')?.value || '08:00';

        if (checkedDays.length === 0) {
          toast.error('Please select at least one working day.');
          return;
        }

        showLoader();
        try {
          await updateDoc(doc(db, 'teachers', teacherId), {
            partTimeDays: checkedDays,
            partTimeStartTime: startTime,
            updatedAt: new Date()
          });
          toast.success('Part-time schedule saved successfully.');
        } catch (err) {
          console.error('Save part-time schedule error:', err);
          toast.error('Failed to save part-time schedule. Please try again.');
        } finally {
          hideLoader();
        }
      });
    });

  } catch (err) {
    console.error('Load part-time schedule error:', err);
    toast.error('Unable to load part-time teachers. Please refresh the page.');
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#ef4444;padding:2rem;">
      Error loading part-time teachers. Please try again.</td></tr>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE LOADING (separates full-time and part-time)
// ─────────────────────────────────────────────────────────────────────────────
async function loadAttendanceForDate(schoolId, dateStr) {
  const fullTimeBody = document.getElementById('attendanceTableBody');
  const partTimeBody = document.getElementById('partTimeAttendanceTableBody');
  if (!fullTimeBody || !partTimeBody) return;

  // Reset summary
  document.getElementById('countPresent').textContent = 0;
  document.getElementById('countLate').textContent = 0;
  document.getElementById('countAbsent').textContent = 0;
  document.getElementById('countTotal').textContent = 0;

  if (isWeekend(dateStr)) {
    const message = 'Weekend — No school. Attendance is not processed on Saturday or Sunday.';
    fullTimeBody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:2rem;">
      <i class="fa-solid fa-calendar-xmark"></i> ${message}</td></tr>`;
    partTimeBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:2rem;">
      <i class="fa-solid fa-calendar-xmark"></i> ${message}</td></tr>`;
    return;
  }

  // Set loading states
  fullTimeBody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:1.5rem;">
    <i class="fa-solid fa-spinner fa-spin"></i> Loading full-time…</td></tr>`;
  partTimeBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:1.5rem;">
    <i class="fa-solid fa-spinner fa-spin"></i> Loading part-time…</td></tr>`;

  const settings = await loadAttendanceSettings(schoolId);
  const officialResumeTime = settings?.officialResumeTime || '08:00';
  const lateAfterMinutes   = settings?.lateAfterMinutes ?? 30;
  const dayName = getDayName(dateStr);

  try {
    const teachers = await service.getTeachersBySchool(schoolId);

    // Categorize teachers. Missing type defaults to full-time.
    const fullTimeTeachers = teachers
      .filter(t => {
        const type = (t.type || 'full-time').trim().toLowerCase();
        return type !== 'part-time';
      })
      .sort((a, b) => (a.name || a.fullName || '').localeCompare(b.name || b.fullName || ''));

    const partTimeTeachers = teachers
      .filter(t => (t.type || 'full-time').trim().toLowerCase() === 'part-time')
      .sort((a, b) => (a.name || a.fullName || '').localeCompare(b.name || b.fullName || ''));

    // Helper to resolve teacher UID candidates for matching attendance records
    function getUidCandidates(teacher) {
      return [teacher.uid, teacher.authUid, teacher.id].filter(Boolean);
    }

    // Fetch attendance records for selected date
    const attSnap = await getDocs(
      query(
        collection(db, 'teacher_attendance'),
        where('schoolId', '==', schoolId),
        where('date', '==', dateStr)
      )
    );

    const recordsByUid = {};
    attSnap.forEach(d => {
      const data = d.data();
      if (data.uid) recordsByUid[data.uid] = { id: d.id, ...data };
      if (data.teacherDbId) recordsByUid[data.teacherDbId] = { id: d.id, ...data };
    });

    function findRecord(teacher) {
      for (const candidate of getUidCandidates(teacher)) {
        if (recordsByUid[candidate]) return recordsByUid[candidate];
      }
      return null;
    }

    let countPresent = 0, countLate = 0, countAbsent = 0, expectedCount = 0;

    // Full-time rows
    const fullTimeRows = fullTimeTeachers.map((teacher, i) => {
      expectedCount++;
      const rec = findRecord(teacher);
      let status = 'absent';

      if (rec) {
        if (rec.adminOverride) {
          status = 'override';
        } else {
          status = computeTeacherStatus(rec.clockIn, officialResumeTime, lateAfterMinutes);
          if (status === 'present' && rec.clockIn && !rec.clockOut) {
            status = 'clockedin';
          }
        }
      }

      if (status === 'present' || status === 'override') countPresent++;
      else if (status === 'late') countLate++;
      else countAbsent++;

      const name = teacher.name || teacher.fullName || teacher.displayName || 'Unknown';
      const clockIn  = rec ? formatTime(rec.clockIn)  : '—';
      const clockOut = rec ? formatTime(rec.clockOut) : '—';
      const hours    = rec ? formatHours(rec.clockIn, rec.clockOut) : '—';
      const dist     = rec?.distanceAtClockIn != null
        ? `<span class="dist-badge">${Math.round(rec.distanceAtClockIn)}m</span>`
        : '—';
      const overrideMark = rec?.adminOverride
        ? ' <i class="fa-solid fa-pen-ruler" style="color:#0369a1;font-size:.7rem;" title="Admin override"></i>'
        : '';
      const uid = getUidCandidates(teacher)[0] || '';

      return `
        <tr>
          <td style="color:#94a3b8;font-size:.75rem;">${i + 1}</td>
          <td style="font-weight:700;color:#0d1b2a;">${escapeHtml(name)}${overrideMark}</td>
          <td>${clockIn}</td>
          <td>${clockOut}</td>
          <td>${dist}</td>
          <td>${hours}</td>
          <td>${statusPill(status)}</td>
          <td>
            <button class="btn-secondary override-trigger" style="padding:.3rem .7rem;font-size:.73rem;"
              data-uid="${escapeHtml(uid)}" data-name="${escapeHtml(name)}">
              <i class="fa-solid fa-pen"></i> Override
            </button>
          </td>
        </tr>`;
    });

    fullTimeBody.innerHTML = fullTimeRows.length
      ? fullTimeRows.join('')
      : `<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:2rem;">No full-time teachers found.</td></tr>`;

    // Part-time rows
    const partTimeRows = partTimeTeachers.map((teacher, i) => {
      const assignedDays = teacher.partTimeDays || [];
      const assignedDayMatch = assignedDays.includes(dayName);
      const startTime = teacher.partTimeStartTime || officialResumeTime;
      const rec = assignedDayMatch ? findRecord(teacher) : null;

      if (!assignedDayMatch) {
        return `
          <tr>
            <td style="color:#94a3b8;font-size:.75rem;">${i + 1}</td>
            <td style="font-weight:700;color:#0d1b2a;">${escapeHtml(teacher.name || 'Unknown')}</td>
            <td>${escapeHtml(assignedDays.join(', ') || '—')}</td>
            <td>${escapeHtml(startTime)}</td>
            <td>—</td>
            <td>—</td>
            <td>${statusPill('notscheduled')}</td>
          </tr>`;
      }

      expectedCount++;
      let status = 'absent';

      if (rec) {
        if (rec.adminOverride) {
          status = 'override';
        } else {
          status = computeTeacherStatus(rec.clockIn, startTime, lateAfterMinutes);
          if (status === 'present' && rec.clockIn && !rec.clockOut) {
            status = 'clockedin';
          }
        }
      }

      if (status === 'present' || status === 'override') countPresent++;
      else if (status === 'late') countLate++;
      else countAbsent++;

      const name = teacher.name || teacher.fullName || teacher.displayName || 'Unknown';
      const clockIn  = rec ? formatTime(rec.clockIn)  : '—';
      const clockOut = rec ? formatTime(rec.clockOut) : '—';
      const overrideMark = rec?.adminOverride
        ? ' <i class="fa-solid fa-pen-ruler" style="color:#0369a1;font-size:.7rem;" title="Admin override"></i>'
        : '';

      return `
        <tr>
          <td style="color:#94a3b8;font-size:.75rem;">${i + 1}</td>
          <td style="font-weight:700;color:#0d1b2a;">${escapeHtml(name)}${overrideMark}</td>
          <td>${escapeHtml(assignedDays.join(', ') || '—')}</td>
          <td>${escapeHtml(startTime)}</td>
          <td>${clockIn}</td>
          <td>${clockOut}</td>
          <td>${statusPill(status)}</td>
        </tr>`;
    });

    partTimeBody.innerHTML = partTimeRows.length
      ? partTimeRows.join('')
      : `<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:2rem;">No part-time teachers found.</td></tr>`;

    // Update summary
    document.getElementById('countPresent').textContent = countPresent;
    document.getElementById('countLate').textContent = countLate;
    document.getElementById('countAbsent').textContent = countAbsent;
    document.getElementById('countTotal').textContent = expectedCount;

    // Store export data
    window.__attendanceExportData = [
      ...fullTimeTeachers.map(t => {
        const rec = findRecord(t);
        const status = rec?.adminOverride ? 'override' : computeTeacherStatus(rec?.clockIn, officialResumeTime, lateAfterMinutes);
        return {
          Name: t.name || 'Unknown',
          Date: dateStr,
          Type: 'Full-time',
          ClockIn: rec ? formatTime(rec.clockIn) : '',
          ClockOut: rec ? formatTime(rec.clockOut) : '',
          Hours: rec ? formatHours(rec.clockIn, rec.clockOut) : '',
          Distance_m: rec?.distanceAtClockIn != null ? Math.round(rec.distanceAtClockIn) : '',
          Status: status,
        };
      }),
      ...partTimeTeachers.filter(t => (t.partTimeDays || []).includes(dayName)).map(t => {
        const rec = findRecord(t);
        const startTime = t.partTimeStartTime || officialResumeTime;
        const status = rec?.adminOverride ? 'override' : computeTeacherStatus(rec?.clockIn, startTime, lateAfterMinutes);
        return {
          Name: t.name || 'Unknown',
          Date: dateStr,
          Type: 'Part-time',
          ClockIn: rec ? formatTime(rec.clockIn) : '',
          ClockOut: rec ? formatTime(rec.clockOut) : '',
          Hours: rec ? formatHours(rec.clockIn, rec.clockOut) : '',
          Distance_m: rec?.distanceAtClockIn != null ? Math.round(rec.distanceAtClockIn) : '',
          Status: status,
        };
      })
    ];

    // Attach override events
    document.querySelectorAll('.override-trigger').forEach(btn => {
      btn.addEventListener('click', () => {
        const uid = btn.dataset.uid;
        const sel = document.getElementById('overrideTeacherSelect');
        if (sel) {
          for (const opt of sel.options) {
            if (opt.value === uid) { sel.value = uid; break; }
          }
        }
        document.getElementById('overrideNote')?.focus();
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      });
    });

  } catch (err) {
    console.error('Load attendance error:', err);
    toast.error('Failed to load attendance records. Please refresh the page.');
    fullTimeBody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#ef4444;padding:2rem;">
      Error loading records. Please try again. </td></tr>`;
    partTimeBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#ef4444;padding:2rem;">
      Error loading records. Please try again. </td></tr>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT CSV (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function exportToCSV(data, filename) {
  if (!data || !data.length) {
    toast.error('No data to export.');
    return;
  }
  const headers = Object.keys(data[0]);
  const csvRows = [];
  csvRows.push(headers.join(','));
  for (const row of data) {
    const values = headers.map(header => {
      const val = row[header] ?? '';
      return `"${String(val).replace(/"/g, '""')}"`;
    });
    csvRows.push(values.join(','));
  }
  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast.success('CSV exported successfully.');
}

// ─────────────────────────────────────────────────────────────────────────────
// POPULATE OVERRIDE SELECT
// ─────────────────────────────────────────────────────────────────────────────
async function populateTeacherSelect(schoolId) {
  const select = document.getElementById('overrideTeacherSelect');
  if (!select) return;
  try {
    const teachers = await service.getTeachersBySchool(schoolId);
    const sorted = teachers.sort((a, b) => (a.name || a.fullName || '').localeCompare(b.name || b.fullName || ''));
    select.innerHTML = '<option value="">-- Select Teacher --</option>';
    sorted.forEach(t => {
      const name = t.name || t.fullName || t.displayName || 'Unknown';
      const uid = t.uid || t.authUid || t.id;
      const option = document.createElement('option');
      option.value = uid;
      option.textContent = name;
      select.appendChild(option);
    });
  } catch (err) {
    console.error('Populate teacher select error:', err);
    toast.error('Unable to load teacher list. Please refresh the page.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN OVERRIDE
// ─────────────────────────────────────────────────────────────────────────────
async function setupOverrideUI(schoolId) {
  const overrideBtn = document.getElementById('applyOverrideBtn');
  if (!overrideBtn) return;

  overrideBtn.addEventListener('click', async () => {
    const teacherUid = document.getElementById('overrideTeacherSelect')?.value;
    const status = document.getElementById('overrideStatus')?.value;
    const note = document.getElementById('overrideNote')?.value.trim() || 'Admin override';
    if (!teacherUid || !status) {
      toast.error('Please select a teacher and choose a status.');
      return;
    }

    const date = document.getElementById('attendanceDateFilter')?.value || todayStr();

    showLoader();
    try {
      const q = query(
        collection(db, 'teacher_attendance'),
        where('schoolId', '==', schoolId),
        where('uid', '==', teacherUid),
        where('date', '==', date)
      );
      const snap = await getDocs(q);
      if (!snap.empty) {
        const ref = doc(db, 'teacher_attendance', snap.docs[0].id);
        await updateDoc(ref, {
          adminOverride: true,
          overrideStatus: status,
          overrideNote: note,
          overrideBy: auth.currentUser?.uid || 'admin',
          updatedAt: serverTimestamp()
        });
      } else {
        await addDoc(collection(db, 'teacher_attendance'), {
          uid: teacherUid,
          schoolId,
          date,
          adminOverride: true,
          overrideStatus: status,
          overrideNote: note,
          overrideBy: auth.currentUser?.uid || 'admin',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }
      toast.success('Override applied successfully.');
      await loadAttendanceForDate(schoolId, date);
    } catch (err) {
      console.error('Override error:', err);
      toast.error('Failed to apply override. Please try again.');
    } finally {
      hideLoader();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN INIT
// ─────────────────────────────────────────────────────────────────────────────
export async function initTeacherAttendancePage() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) {
    toast.error('School ID not found. Please log in again.');
    return;
  }

  const settings = await loadAttendanceSettings(schoolId);
  renderGeofenceStatus(settings);
  populateSettingsForm(settings);
  setupSettingsUI(schoolId);

  await populateTeacherSelect(schoolId);
  await setupOverrideUI(schoolId);

  // Load part-time schedule management
  await loadPartTimeScheduleManagement(schoolId);

  const today = todayStr();
  document.getElementById('attendanceDateFilter').value = today;
  await loadAttendanceForDate(schoolId, today);

  document.getElementById('loadAttendanceBtn')?.addEventListener('click', async () => {
    const date = document.getElementById('attendanceDateFilter')?.value || todayStr();
    await loadAttendanceForDate(schoolId, date);
  });

  document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
    const date = document.getElementById('attendanceDateFilter')?.value || todayStr();
    exportToCSV(
      window.__attendanceExportData || [],
      `teacher_attendance_${date}.csv`
    );
  });
}
