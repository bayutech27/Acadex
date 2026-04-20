import { db, auth } from './firebase-config.js';
import { 
  collection, getDocs, doc, getDoc, updateDoc, query, where, 
  writeBatch
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { autoLockExpiredSubscriptions } from './plan.js';

let currentUser = null;
let schoolsData = [];

function showPageLoader() {
  let loader = document.getElementById('pageLoader');
  if (!loader) {
    loader = document.createElement('div');
    loader.id = 'pageLoader';
    loader.className = 'loading-overlay';
    loader.innerHTML = '<div style="background:white; padding:20px; border-radius:8px;">Loading...</div>';
    document.body.appendChild(loader);
  }
  loader.style.display = 'flex';
}
function hidePageLoader() {
  const loader = document.getElementById('pageLoader');
  if (loader) loader.style.display = 'none';
}

// Auth guard
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = '/'; return; }
  const userDoc = await getDoc(doc(db, 'users', user.uid));
  const userData = userDoc.data();
  if (!userData || userData.role !== 'super-admin') { window.location.href = '/'; return; }
  currentUser = { uid: user.uid, ...userData };
  loadDashboard();
});

async function loadDashboard() {
  showPageLoader();
  try {
    await autoLockExpiredSubscriptions();
    await Promise.all([loadStats(), loadSchools()]);
  } catch (err) {
    console.error('Dashboard load error:', err);
    alert('Error loading data. Check console.');
  } finally {
    hidePageLoader();
  }
}

async function loadStats() {
  const schoolsSnap = await getDocs(collection(db, 'schools'));
  let total = schoolsSnap.size;
  let activeSubs = 0, expiredSubs = 0, totalStudents = 0;

  const promises = [];
  schoolsSnap.forEach(schoolDoc => {
    promises.push((async () => {
      const subRef = doc(db, 'schools', schoolDoc.id, 'subscription', 'current');
      const subSnap = await getDoc(subRef);
      if (subSnap.exists()) {
        const sub = subSnap.data();
        if (sub.status === 'active') activeSubs++;
        else if (sub.status === 'expired') expiredSubs++;
      }
      const studentsSnap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', schoolDoc.id)));
      totalStudents += studentsSnap.size;
    })());
  });
  await Promise.all(promises);

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
    // Get admin email
    const adminQuery = query(
      collection(db, 'users'),
      where('schoolId', '==', school.id),
      where('role', '==', 'admin')
    );
    const adminSnap = await getDocs(adminQuery);
    school.adminEmail = adminSnap.empty ? '—' : adminSnap.docs[0].data().email;

    // Get subscription
    const subRef = doc(db, 'schools', school.id, 'subscription', 'current');
    const subSnap = await getDoc(subRef);
    school.subscription = subSnap.exists() ? subSnap.data() : null;

    // Get student counts
    const allStudentsQuery = query(collection(db, 'students'), where('schoolId', '==', school.id));
    const allStudentsSnap = await getDocs(allStudentsQuery);
    school.totalStudents = allStudentsSnap.size;

    const activeStudentsQuery = query(
      collection(db, 'students'),
      where('schoolId', '==', school.id),
      where('status', '==', 'active')
    );
    const activeStudentsSnap = await getDocs(activeStudentsQuery);
    school.activeStudents = activeStudentsSnap.size;

    const lockedStudentsQuery = query(
      collection(db, 'students'),
      where('schoolId', '==', school.id),
      where('locked', '==', true)
    );
    const lockedStudentsSnap = await getDocs(lockedStudentsQuery);
    school.lockedCount = lockedStudentsSnap.size;

    schoolsData.push(school);
  }

  let filtered = schoolsData.filter(s => {
    const matchesSearch = (s.name?.toLowerCase().includes(search) || s.adminEmail?.toLowerCase().includes(search));
    const matchesStatus = !statusFilter || (s.subscription?.status === statusFilter);
    return matchesSearch && matchesStatus;
  });
  renderTable(filtered);
}

function renderTable(schools) {
  const tbody = document.getElementById('schoolsTableBody');
  if (!schools.length) {
    tbody.innerHTML = '<tr><td colspan="9">No schools found</td></tr>';
    return;
  }
  tbody.innerHTML = schools.map(s => {
    const sub = s.subscription || {};
    const status = sub.status || 'expired';
    const statusClass = status === 'active' ? 'active' : (status === 'expired' ? 'expired' : 'suspended');
    const endDate = sub.endDate ? new Date(sub.endDate.toDate()).toLocaleDateString() : '—';
    const hasPending = s.lockedCount > 0;
    return `
      <tr>
        <td>${escapeHtml(s.name || '—')}</td>
        <td>${escapeHtml(s.adminEmail)}</td>
        <td><span class="status-badge status-${statusClass}">${status}</span></td>
        <td>${sub.plan || 'basic'}</td>
        <td>${s.totalStudents || 0}</td>
        <td>${s.activeStudents || 0}</td>
        <td>${s.lockedCount || 0}</td>
        <td>${endDate}</td>
        <td>
          <button class="btn-warning approve-extra" data-id="${s.id}" ${!hasPending ? 'disabled' : ''}>Approve Extra</button>
          <button class="btn-danger suspend-school" data-id="${s.id}" data-status="${status}">${status === 'active' ? 'Suspend' : 'Activate'}</button>
        </td>
      </tr>
    `;
  }).join('');

  // Attach event listeners (only for Approve Extra and Suspend/Activate)
  document.querySelectorAll('.approve-extra').forEach(btn => btn.addEventListener('click', () => openApproveModal(btn.dataset.id)));
  document.querySelectorAll('.suspend-school').forEach(btn => btn.addEventListener('click', async (e) => {
    const schoolId = btn.dataset.id;
    const currentStatus = btn.dataset.status;
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = '...';
    try {
      const subRef = doc(db, 'schools', schoolId, 'subscription', 'current');
      if (currentStatus === 'active') {
        // Suspend: set status to 'expired' and locked = true
        await updateDoc(subRef, { status: 'expired', locked: true, lastUpdated: new Date() });
      } else {
        // Activate: set status to 'active' and locked = false
        await updateDoc(subRef, { status: 'active', locked: false, lastUpdated: new Date() });
      }
      await loadDashboard();
    } catch (err) {
      alert('Operation failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.innerText = originalText;
    }
  }));
}

async function openApproveModal(schoolId) {
  const school = schoolsData.find(s => s.id === schoolId);
  if (!school) return;
  const pendingCount = school.lockedCount || 0;
  document.getElementById('pendingCount').innerText = pendingCount;
  document.getElementById('approveCount').value = pendingCount;
  const modal = document.getElementById('approveExtraModal');
  modal.style.display = 'flex';
  document.getElementById('confirmApproveBtn').onclick = async () => {
    const count = parseInt(document.getElementById('approveCount').value);
    if (count > 0 && count <= pendingCount) {
      try {
        // Unlock all students with locked == true for this school
        const studentsQuery = query(
          collection(db, 'students'),
          where('schoolId', '==', schoolId),
          where('locked', '==', true)
        );
        const studentsSnap = await getDocs(studentsQuery);
        const batch = writeBatch(db);
        studentsSnap.forEach(studentDoc => {
          batch.update(studentDoc.ref, { locked: false, updatedAt: new Date() });
        });
        await batch.commit();
        alert(`${studentsSnap.size} student(s) unlocked.`);
        modal.style.display = 'none';
        await loadDashboard();
      } catch (err) {
        alert('Approval failed: ' + err.message);
      }
    } else {
      alert('Invalid count');
    }
  };
  document.getElementById('closeApproveModal').onclick = () => modal.style.display = 'none';
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

// Event listeners
document.getElementById('refreshBtn').addEventListener('click', loadDashboard);
document.getElementById('searchSchool').addEventListener('input', loadSchools);
document.getElementById('filterStatus').addEventListener('change', loadSchools);
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await auth.signOut();
  window.location.href = '/';
});