// super-admin.js
import { db, auth } from './firebase-config.js';
import { collection, getDocs, doc, getDoc, updateDoc, query, where, orderBy, limit, writeBatch } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { showLoading, hideLoading, showPageLoader, hidePageLoader } from './loading.js';
import { approveExtraStudents, lockSchool, unlockSchool, updateSubscriptionAmount, autoLockExpiredSubscriptions } from './plan.js';

let currentUser = null;
let schoolsData = [];

// Auth guard
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = '/'; return; }
  const userDoc = await getDoc(doc(db, 'users', user.uid));
  const userData = userDoc.data();
  if (userData.role !== 'super-admin') { window.location.href = '/'; return; }
  currentUser = { uid: user.uid, ...userData };
  loadDashboard();
});

async function loadDashboard() {
  showPageLoader();
  await autoLockExpiredSubscriptions(); // enforce term-based expiry
  await loadStats();
  await loadSchools();
  hidePageLoader();
}

async function loadStats() {
  const schoolsSnap = await getDocs(collection(db, 'schools'));
  const total = schoolsSnap.size;
  let activeSubs = 0, expiredSubs = 0, totalStudents = 0;
  for (const schoolDoc of schoolsSnap.docs) {
    const subSnap = await getDoc(doc(db, 'schools', schoolDoc.id, 'subscription'));
    if (subSnap.exists()) {
      const sub = subSnap.data();
      if (sub.status === 'active') activeSubs++;
      else if (sub.status === 'expired') expiredSubs++;
    }
    const studentsSnap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', schoolDoc.id)));
    totalStudents += studentsSnap.size;
  }
  document.getElementById('totalSchools').innerText = total;
  document.getElementById('activeSubscriptions').innerText = activeSubs;
  document.getElementById('expiredSubscriptions').innerText = expiredSubs;
  document.getElementById('totalStudentsSuper').innerText = totalStudents;
}

async function loadSchools() {
  const search = document.getElementById('searchSchool').value.toLowerCase();
  const statusFilter = document.getElementById('filterStatus').value;
  const schoolsSnap = await getDocs(collection(db, 'schools'));
  schoolsData = [];
  for (const schoolDoc of schoolsSnap.docs) {
    const school = { id: schoolDoc.id, ...schoolDoc.data() };
    const subSnap = await getDoc(doc(db, 'schools', school.id, 'subscription'));
    school.subscription = subSnap.exists() ? subSnap.data() : null;
    schoolsData.push(school);
  }
  // Filter
  let filtered = schoolsData.filter(s => 
    (s.name?.toLowerCase().includes(search) || s.email?.toLowerCase().includes(search)) &&
    (!statusFilter || (s.subscription?.status === statusFilter || (statusFilter === 'active' && s.subscription?.status === 'active')))
  );
  renderTable(filtered);
}

function renderTable(schools) {
  const tbody = document.getElementById('schoolsTableBody');
  if (!schools.length) { tbody.innerHTML = '<tr><td colspan="9">No schools found</td></tr>'; return; }
  tbody.innerHTML = schools.map(s => `
    <tr>
      <td>${escapeHtml(s.name || '—')}</td>
      <td>${escapeHtml(s.email || '—')}</td>
      <td><span class="status-badge status-${s.subscription?.status || 'expired'}">${s.subscription?.status || 'expired'}</span></td>
      <td>${s.subscription?.plan || 'basic'}</td>
      <td>${s.subscription?.totalStudents || 0}</td>
      <td>${s.subscription?.coveredStudents || 0}</td>
      <td>${s.subscription?.extraStudentsPendingApproval || 0}</td>
      <td>${s.subscription?.endDate ? new Date(s.subscription.endDate.toDate()).toLocaleDateString() : '—'}</td>
      <td>
        <button class="btn-primary manage-sub" data-id="${s.id}">Manage</button>
        <button class="btn-warning approve-extra" data-id="${s.id}" ${!s.subscription?.extraStudentsPendingApproval ? 'disabled' : ''}>Approve Extra</button>
        <button class="btn-danger suspend-school" data-id="${s.id}" data-status="${s.subscription?.status}">${s.subscription?.status === 'active' ? 'Suspend' : 'Activate'}</button>
      </td>
    </tr>
  `).join('');
  // Attach events
  document.querySelectorAll('.manage-sub').forEach(btn => btn.addEventListener('click', () => openSubscriptionModal(btn.dataset.id)));
  document.querySelectorAll('.approve-extra').forEach(btn => btn.addEventListener('click', () => openApproveModal(btn.dataset.id)));
  document.querySelectorAll('.suspend-school').forEach(btn => btn.addEventListener('click', async (e) => {
    const schoolId = btn.dataset.id;
    const currentStatus = btn.dataset.status;
    const btnEl = e.target;
    showLoading(btnEl);
    if (currentStatus === 'active') await lockSchool(schoolId);
    else await unlockSchool(schoolId);
    hideLoading(btnEl);
    await loadDashboard();
  }));
}

function openSubscriptionModal(schoolId) {
  const school = schoolsData.find(s => s.id === schoolId);
  if (!school) return;
  const modal = document.getElementById('subscriptionModal');
  document.getElementById('modalSchoolInfo').innerHTML = `<strong>${escapeHtml(school.name)}</strong><br>Status: ${school.subscription?.status}<br>Expires: ${school.subscription?.endDate ? new Date(school.subscription.endDate.toDate()).toLocaleDateString() : 'N/A'}`;
  modal.style.display = 'flex';
  document.getElementById('extendSubscriptionBtn').onclick = async () => {
    const terms = parseInt(document.getElementById('extendTerms').value);
    await extendSubscription(schoolId, terms);
    modal.style.display = 'none';
    await loadDashboard();
  };
  document.getElementById('closeModalBtn').onclick = () => modal.style.display = 'none';
}

async function extendSubscription(schoolId, terms) {
  const subRef = doc(db, 'schools', schoolId, 'subscription');
  const sub = await getDoc(subRef);
  if (!sub.exists()) return;
  const data = sub.data();
  const currentEnd = data.endDate.toDate();
  let newEnd = new Date(currentEnd);
  for (let i = 0; i < terms; i++) {
    // Add 4 months
    newEnd.setMonth(newEnd.getMonth() + 4);
  }
  await updateDoc(subRef, {
    endDate: newEnd,
    status: 'active',
    locked: false,
    lastUpdated: new Date()
  });
  alert('Subscription extended');
}

function openApproveModal(schoolId) {
  const school = schoolsData.find(s => s.id === schoolId);
  if (!school) return;
  const pending = school.subscription?.extraStudentsPendingApproval || 0;
  document.getElementById('pendingCount').innerText = pending;
  document.getElementById('approveCount').value = pending;
  const modal = document.getElementById('approveExtraModal');
  modal.style.display = 'flex';
  document.getElementById('confirmApproveBtn').onclick = async () => {
    const count = parseInt(document.getElementById('approveCount').value);
    if (count > 0) {
      await approveExtraStudents(schoolId, count);
      alert(`${count} students approved.`);
    }
    modal.style.display = 'none';
    await loadDashboard();
  };
  document.getElementById('closeApproveModal').onclick = () => modal.style.display = 'none';
}

function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'); }

// Refresh and filter listeners
document.getElementById('refreshBtn').addEventListener('click', loadDashboard);
document.getElementById('searchSchool').addEventListener('input', loadSchools);
document.getElementById('filterStatus').addEventListener('change', loadSchools);
document.getElementById('logoutBtn').addEventListener('click', async () => { await auth.signOut(); window.location.href = '/'; });