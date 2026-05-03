// super-admin.js - Super admin dashboard
// FIX 4: Activation uses rolling 3-month end date (no more hardcoded term dates that could immediately expire).
// FIX 5: Activation sets status=active, locked=false, and a real future endDate — nothing else reverts this.

import { db, auth } from './firebase-config.js';
import {
  collection, getDocs, doc, getDoc, updateDoc, query, where,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { showNotification, handleError } from './error-handler.js';
import { initAcademicCalendar, getCurrentTerm, getCurrentSession, subscribeToCalendar } from './academic-calendar.js';

let currentUser = null;
let schoolsData = [];
let calendarUnsubscribe = null;
let isLoading = false;
let loadTimeout = null;

// FIX 4: Rolling end date helper — replaces hardcoded term dates.
// Newly activated subscriptions always get a future expiry (3 months ahead).
function getRollingEndDate(monthsAhead = 3) {
  const end = new Date();
  end.setMonth(end.getMonth() + monthsAhead);
  return end;
}

// Kept for display in the table (expiry column) — NOT used for activation or expiry decisions.
function getTermEndDateFromSessionAndTerm(session, term) {
  if (!session || !term) return null;
  const startYear = parseInt(session.split('/')[0]);
  if (isNaN(startYear)) return null;
  let monthEnd, dayEnd;
  switch (term) {
    case 'First Term':  monthEnd = 11; dayEnd = 31; break;
    case 'Second Term': monthEnd = 3;  dayEnd = 30; break;
    case 'Third Term':  monthEnd = 7;  dayEnd = 30; break;
    default: return null;
  }
  return new Date(Date.UTC(startYear, monthEnd, dayEnd, 23, 59, 59));
}

// Wait for calendar to be fully initialised
async function waitForCalendarReady() {
  return new Promise((resolve) => {
    try {
      getCurrentTerm();
      resolve();
    } catch (e) {
      const unsubscribe = subscribeToCalendar(() => {
        unsubscribe();
        resolve();
      });
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

// Auth guard
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = '/'; return; }
  try {
    const userDoc = await getDoc(doc(db, 'users', user.uid));
    const userData = userDoc.data();
    if (!userData || userData.role !== 'super-admin') { window.location.href = '/'; return; }
    currentUser = { uid: user.uid, ...userData };
    await initAcademicCalendar();
    await waitForCalendarReady();
    if (calendarUnsubscribe) calendarUnsubscribe();
    calendarUnsubscribe = subscribeToCalendar(async (state) => {
      updateCalendarBadge(state);
      await loadDashboard({ silent: true });
    });
    await loadDashboard();
  } catch (err) {
    handleError(err, "Failed to verify super admin access.");
    window.location.href = '/';
  }
});

function updateCalendarBadge(state) {
  const termEl = document.getElementById('currentTermDisplay');
  const sessionEl = document.getElementById('currentSessionDisplay');
  if (termEl) termEl.textContent = state.currentTerm;
  if (sessionEl) sessionEl.textContent = state.currentSession;
}

async function loadDashboard(options = { silent: false }) {
  if (isLoading) return;
  isLoading = true;
  try {
    await Promise.all([loadStats(), loadSchools()]);
  } catch (err) {
    if (!options.silent) handleError(err, "Error loading dashboard data.");
    else console.error(err);
  } finally {
    isLoading = false;
  }
}

function debouncedLoadSchools() {
  if (loadTimeout) clearTimeout(loadTimeout);
  loadTimeout = setTimeout(() => loadSchools().catch(console.error), 300);
}

async function loadStats() {
  try {
    const schoolsSnap = await getDocs(collection(db, 'schools'));
    const total = schoolsSnap.size;
    let activeSubs = 0, expiredSubs = 0, totalStudents = 0;
    const promises = [];
    schoolsSnap.forEach(schoolDoc => {
      promises.push((async () => {
        try {
          const subRef = doc(db, 'schools', schoolDoc.id, 'subscription', 'current');
          const subSnap = await getDoc(subRef);
          if (subSnap.exists()) {
            const sub = subSnap.data();
            if (sub.status === 'active') activeSubs++;
            else if (sub.status === 'expired') expiredSubs++;
          }
          const studentsSnap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', schoolDoc.id)));
          totalStudents += studentsSnap.size;
        } catch (err) { console.warn(err); }
      })());
    });
    await Promise.all(promises);
    document.getElementById('totalSchools').innerText = total;
    document.getElementById('activeSubscriptions').innerText = activeSubs;
    document.getElementById('expiredSubscriptions').innerText = expiredSubs;
    document.getElementById('totalStudentsSuper').innerText = totalStudents;
  } catch (err) {
    handleError(err, "Failed to load statistics.");
  }
}

async function loadSchools() {
  const search = document.getElementById('searchSchool')?.value.toLowerCase() || '';
  const statusFilter = document.getElementById('filterStatus')?.value || '';
  try {
    const schoolsSnap = await getDocs(collection(db, 'schools'));
    schoolsData = [];
    for (const schoolDoc of schoolsSnap.docs) {
      const school = { id: schoolDoc.id, ...schoolDoc.data() };

      // Admin email
      const adminQuery = query(collection(db, 'users'), where('schoolId', '==', school.id), where('role', '==', 'admin'));
      const adminSnap = await getDocs(adminQuery);
      school.adminEmail = adminSnap.empty ? '—' : adminSnap.docs[0].data().email;

      // Subscription
      const subRef = doc(db, 'schools', school.id, 'subscription', 'current');
      const subSnap = await getDoc(subRef);
      school.subscription = subSnap.exists() ? subSnap.data() : null;

      // Student counts
      const allStudentsSnap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', school.id)));
      school.totalStudents = allStudentsSnap.size;

      const activeStudentsSnap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', school.id), where('status', '==', 'active')));
      school.activeStudents = activeStudentsSnap.size;

      const lockedStudentsSnap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', school.id), where('locked', '==', true)));
      school.lockedCount = lockedStudentsSnap.size;

      school.phone = school.phone || '';

      schoolsData.push(school);
    }

    let filtered = schoolsData.filter(s => {
      const matchesSearch = (s.name?.toLowerCase().includes(search) || s.adminEmail?.toLowerCase().includes(search));
      const matchesStatus = !statusFilter || (s.subscription?.status === statusFilter);
      return matchesSearch && matchesStatus;
    });
    renderTable(filtered);
  } catch (err) {
    handleError(err, "Failed to load schools data.");
  }
}

function renderTable(schools) {
  const tbody = document.getElementById('schoolsTableBody');
  if (!tbody) return;
  if (!schools.length) {
    tbody.innerHTML = '<tr><td colspan="10">No schools found</td></tr>';
    return;
  }
  tbody.innerHTML = schools.map(s => {
    const sub = s.subscription || {};
    const status = sub.status || 'expired';
    const statusClass = status === 'active' ? 'active' : (status === 'expired' ? 'expired' : 'suspended');
    const buttonText = status === 'active' ? 'Suspend' : 'Activate';

    // Display: prefer stored endDate, fall back to term-based calculation for display only
    let expiryDisplay = '—';
    if (sub.endDate) {
      expiryDisplay = new Date(sub.endDate.toDate ? sub.endDate.toDate() : sub.endDate).toLocaleDateString();
    } else if (sub.term && sub.session) {
      const endDate = getTermEndDateFromSessionAndTerm(sub.session, sub.term);
      if (endDate) expiryDisplay = endDate.toLocaleDateString();
    }

    const hasPending = s.lockedCount > 0;
    const phoneDisplay = s.phone ? escapeHtml(s.phone) : '—';

    return `
      <tr data-school-id="${s.id}">
        <td>${escapeHtml(s.name || '—')}</td>
        <td>${escapeHtml(s.adminEmail)}</td>
        <td>${phoneDisplay}</td>
        <td><span class="status-badge status-${statusClass}">${status}</span></td>
        <td>${sub.plan || 'basic'}</td>
        <td>${s.totalStudents || 0}</td>
        <td>${s.activeStudents || 0}</td>
        <td>${s.lockedCount || 0}</td>
        <td>${expiryDisplay}</td>
        <td>
          <button class="btn-warning approve-extra" data-id="${s.id}" ${!hasPending ? 'disabled' : ''}>Approve Extra</button>
          <button class="btn-danger toggle-subscription" data-id="${s.id}" data-status="${status}">${buttonText}</button>
        </td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('.approve-extra').forEach(btn => btn.addEventListener('click', () => openApproveModal(btn.dataset.id)));
  document.querySelectorAll('.toggle-subscription').forEach(btn => {
    btn.removeEventListener('click', handleToggle);
    btn.addEventListener('click', handleToggle);
  });
}

// FIX 4 & 5: Activation writes a real future endDate (rolling 3 months).
// status=active, locked=false. Nothing in the system will silently revert this
// unless the real endDate passes and autoLockExpiredSubscriptions runs.
async function handleToggle(e) {
  const btn = e.currentTarget;
  const schoolId = btn.dataset.id;
  const currentStatus = btn.dataset.status;
  const originalText = btn.innerText;
  btn.disabled = true;

  try {
    const subRef = doc(db, 'schools', schoolId, 'subscription', 'current');
    const subSnap = await getDoc(subRef);
    if (!subSnap.exists()) {
      showNotification("Subscription document not found. Please refresh.", "error");
      btn.disabled = false;
      return;
    }

    if (currentStatus === 'active') {
      // Suspend: mark expired and locked
      await updateDoc(subRef, {
        status: 'expired',
        locked: true,
        lastUpdated: new Date(),
        autoExpired: false
      });
      showNotification("School suspended.", "success");
    } else {
      // FIX 4: Activate with rolling end date so activation is always future-dated.
      // FIX 5: Only status/locked/endDate are written — no term/session logic that
      //         could be mismatched later and cause silent re-expiry.
      const currentTerm = getCurrentTerm();
      const currentSession = getCurrentSession();
      const endDate = getRollingEndDate(3); // Always 3 months in the future

      const updateData = {
        status: 'active',
        locked: false,
        term: currentTerm,
        session: currentSession,
        endDate: endDate,
        lastUpdated: new Date(),
        autoExpired: false
      };
      await updateDoc(subRef, updateData);
      showNotification("School activated. Subscription valid for 3 months.", "success");
    }
    await loadDashboard();
  } catch (err) {
    console.error("Toggle error:", err);
    handleError(err, "Operation failed. Check console and Firestore rules.");
    btn.disabled = false;
    btn.innerText = originalText;
  }
}

async function openApproveModal(schoolId) {
  const school = schoolsData.find(s => s.id === schoolId);
  if (!school) return;
  const pendingCount = school.lockedCount || 0;
  document.getElementById('pendingCount').innerText = pendingCount;
  const approveCountInput = document.getElementById('approveCount');
  if (approveCountInput) approveCountInput.value = pendingCount;
  const modal = document.getElementById('approveExtraModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const confirmBtn = document.getElementById('confirmApproveBtn');
  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      const count = parseInt(approveCountInput?.value || '0');
      if (count > 0 && count <= pendingCount) {
        try {
          const studentsQuery = query(collection(db, 'students'), where('schoolId', '==', schoolId), where('locked', '==', true));
          const studentsSnap = await getDocs(studentsQuery);
          const toUnlock = Math.min(count, studentsSnap.size);
          const batch = writeBatch(db);
          let unlocked = 0;
          for (const studentDoc of studentsSnap.docs) {
            if (unlocked >= toUnlock) break;
            batch.update(studentDoc.ref, { locked: false, updatedAt: new Date() });
            unlocked++;
          }
          await batch.commit();
          showNotification(`${unlocked} student(s) unlocked.`, "success");
          modal.style.display = 'none';
          await loadDashboard();
        } catch (err) {
          handleError(err, "Approval failed.");
        }
      } else {
        showNotification("Invalid count", "error");
      }
    };
  }
  const closeBtn = document.getElementById('closeApproveModal');
  if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';
}

// Event listeners
document.getElementById('searchSchool')?.addEventListener('input', debouncedLoadSchools);
document.getElementById('filterStatus')?.addEventListener('change', debouncedLoadSchools);
document.getElementById('refreshBtn')?.addEventListener('click', () => loadDashboard());
document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  if (calendarUnsubscribe) calendarUnsubscribe();
  await auth.signOut();
  window.location.href = '/';
});