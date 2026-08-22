// super-admin.js - Super admin dashboard
// FIX 4: Activation uses rolling 3-month end date (no more hardcoded term dates that could immediately expire).
// FIX 5: Activation sets status=active, locked=false, and a real future endDate — nothing else reverts this.
// FIX 9: endDate is now always the end of the current term from the academic calendar.
// NEW: School names are clickable and open a detail modal with school information.
// All user-facing errors now show clear, friendly messages without technical jargon.

import { db, auth } from './firebase-config.js';
import {
  collection, getDocs, doc, getDoc, updateDoc, query, where,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { showNotification, handleError, toast } from './error-handler.js';
import { initAcademicCalendar, getCurrentTerm, getCurrentSession, getTermDates, subscribeToCalendar } from './academic-calendar.js';

let currentUser = null;
let schoolsData = [];
let calendarUnsubscribe = null;
let isLoading = false;
let loadTimeout = null;

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
    console.error('Auth guard error:', err);
    toast.error('Unable to verify super admin access. Please log in again.');
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
    if (!options.silent) {
      console.error('Dashboard load error:', err);
      toast.error('Unable to load dashboard data. Please refresh the page.');
    } else {
      console.error(err);
    }
  } finally {
    isLoading = false;
  }
}

function debouncedLoadSchools() {
  if (loadTimeout) clearTimeout(loadTimeout);
  loadTimeout = setTimeout(() => loadSchools().catch(err => {
    console.error(err);
    toast.error('Unable to load schools. Please refresh.');
  }), 300);
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
        } catch (err) { 
          console.warn('Stats sub-error:', err); 
        }
      })());
    });
    await Promise.all(promises);
    document.getElementById('totalSchools').innerText = total;
    document.getElementById('activeSubscriptions').innerText = activeSubs;
    document.getElementById('expiredSubscriptions').innerText = expiredSubs;
    document.getElementById('totalStudentsSuper').innerText = totalStudents;
  } catch (err) {
    console.error('Load stats error:', err);
    toast.error('Unable to load statistics. Please refresh.');
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
    console.error('Load schools error:', err);
    toast.error('Unable to load schools data. Please refresh.');
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
        <td><button class="school-link" data-id="${s.id}">${escapeHtml(s.name || '—')}</button></td>
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

  // Add event listeners
  document.querySelectorAll('.approve-extra').forEach(btn => btn.addEventListener('click', () => openApproveModal(btn.dataset.id)));
  document.querySelectorAll('.toggle-subscription').forEach(btn => {
    btn.removeEventListener('click', handleToggle);
    btn.addEventListener('click', handleToggle);
  });
  document.querySelectorAll('.school-link').forEach(btn => {
    btn.addEventListener('click', () => openSchoolDetailsModal(btn.dataset.id));
  });
}

// Open school details modal
async function openSchoolDetailsModal(schoolId) {
  const school = schoolsData.find(s => s.id === schoolId);
  if (!school) return;

  const modal = document.getElementById('schoolDetailsModal');
  if (!modal) return;
  modal.style.display = 'flex';

  const body = document.getElementById('schoolDetailsBody');
  body.innerHTML = '<p>Loading school details...</p>';

  // Fetch additional counts
  let teacherCount = 0, parentCount = 0, subjectCount = 0;
  try {
    const [teachersSnap, parentsSnap, subjectsSnap] = await Promise.all([
      getDocs(query(collection(db, 'teachers'), where('schoolId', '==', schoolId))),
      getDocs(query(collection(db, 'parents'), where('schoolId', '==', schoolId))),
      getDocs(query(collection(db, 'subjects'), where('schoolId', '==', schoolId)))
    ]);
    teacherCount = teachersSnap.size;
    parentCount = parentsSnap.size;
    subjectCount = subjectsSnap.size;
  } catch (err) {
    console.error('Failed to load school details:', err);
  }

  const sub = school.subscription || {};
  const status = sub.status || 'expired';
  const expiryDisplay = sub.endDate
    ? new Date(sub.endDate.toDate ? sub.endDate.toDate() : sub.endDate).toLocaleDateString()
    : '—';

  body.innerHTML = `
    <div class="detail-row"><span class="detail-label">School Name:</span><span class="detail-value">${escapeHtml(school.name || '—')}</span></div>
    <div class="detail-row"><span class="detail-label">Admin Email:</span><span class="detail-value">${escapeHtml(school.adminEmail)}</span></div>
    <div class="detail-row"><span class="detail-label">Phone:</span><span class="detail-value">${escapeHtml(school.phone || '—')}</span></div>
    <div class="detail-row"><span class="detail-label">Status:</span><span class="detail-value">${escapeHtml(status)}</span></div>
    <div class="detail-row"><span class="detail-label">Plan:</span><span class="detail-value">${escapeHtml(sub.plan || 'basic')}</span></div>
    <div class="detail-row"><span class="detail-label">Total Students:</span><span class="detail-value">${school.totalStudents || 0}</span></div>
    <div class="detail-row"><span class="detail-label">Active Students:</span><span class="detail-value">${school.activeStudents || 0}</span></div>
    <div class="detail-row"><span class="detail-label">Pending Extra:</span><span class="detail-value">${school.lockedCount || 0}</span></div>
    <div class="detail-row"><span class="detail-label">Teachers:</span><span class="detail-value">${teacherCount}</span></div>
    <div class="detail-row"><span class="detail-label">Parents:</span><span class="detail-value">${parentCount}</span></div>
    <div class="detail-row"><span class="detail-label">Subjects:</span><span class="detail-value">${subjectCount}</span></div>
    <div class="detail-row"><span class="detail-label">Expires:</span><span class="detail-value">${expiryDisplay}</span></div>
  `;

  document.getElementById('schoolDetailsTitle').textContent = school.name || 'School Details';
}

// FIX 4 & 5 & 9: Activation now uses the current term's end date from the academic calendar.
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
      toast.error('Subscription record not found. Please refresh the page.');
      btn.disabled = false;
      return;
    }

    if (currentStatus === 'active') {
      await updateDoc(subRef, {
        status: 'expired',
        locked: true,
        lastUpdated: new Date(),
        autoExpired: false
      });
      toast.success('School suspended successfully.');
    } else {
      const currentTerm = getCurrentTerm();
      const currentSession = getCurrentSession();
      const termDates = getTermDates();
      const termEndDate = new Date(termDates.end + 'T23:59:59.999Z');

      const updateData = {
        status: 'active',
        locked: false,
        term: currentTerm,
        session: currentSession,
        endDate: termEndDate,
        lastUpdated: new Date(),
        autoExpired: false
      };
      await updateDoc(subRef, updateData);
      toast.success('School activated. Subscription valid until end of current term.');
    }
    await loadDashboard();
  } catch (err) {
    console.error('Toggle error:', err);
    if (err.code === 'permission-denied') {
      toast.error('Permission denied. Please check your super-admin privileges.');
    } else {
      toast.error('Operation failed. Please try again.');
    }
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
          toast.success(`${unlocked} student(s) unlocked successfully.`);
          modal.style.display = 'none';
          await loadDashboard();
        } catch (err) {
          console.error('Approve extra error:', err);
          toast.error('Failed to approve extra students. Please try again.');
        }
      } else {
        toast.error('Invalid count. Please enter a number between 1 and the pending count.');
      }
    };
  }
  const closeBtn = document.getElementById('closeApproveModal');
  if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';
}

// School details modal close
document.getElementById('closeSchoolDetailsModal')?.addEventListener('click', () => {
  const modal = document.getElementById('schoolDetailsModal');
  if (modal) modal.style.display = 'none';
});

// Event listeners
document.getElementById('searchSchool')?.addEventListener('input', debouncedLoadSchools);
document.getElementById('filterStatus')?.addEventListener('change', debouncedLoadSchools);
document.getElementById('refreshBtn')?.addEventListener('click', () => loadDashboard());
document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  if (calendarUnsubscribe) calendarUnsubscribe();
  await auth.signOut();
  window.location.href = '/';
});