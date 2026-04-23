// super-admin.js - Super admin dashboard
import { db, auth } from './firebase-config.js';
import { 
  collection, getDocs, doc, getDoc, updateDoc, query, where, 
  writeBatch
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { autoLockExpiredSubscriptions } from './plan.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

let currentUser = null;
let schoolsData = [];

// Auth guard
onAuthStateChanged(auth, async (user) => {
  if (!user) { 
    window.location.href = '/'; 
    return; 
  }
  try {
    const userDoc = await getDoc(doc(db, 'users', user.uid));
    const userData = userDoc.data();
    if (!userData || userData.role !== 'super-admin') { 
      window.location.href = '/'; 
      return; 
    }
    currentUser = { uid: user.uid, ...userData };
    loadDashboard();
  } catch (err) {
    handleError(err, "Failed to verify super admin access.");
    window.location.href = '/';
  }
});

async function loadDashboard() {
  showLoader();
  try {
    await autoLockExpiredSubscriptions();
    await Promise.all([loadStats(), loadSchools()]);
  } catch (err) {
    handleError(err, "Error loading dashboard data.");
  } finally {
    hideLoader();
  }
}

async function loadStats() {
  try {
    const schoolsSnap = await getDocs(collection(db, 'schools'));
    let total = schoolsSnap.size;
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
          console.warn(`Error processing school ${schoolDoc.id}:`, err);
        }
      })());
    });
    await Promise.all(promises);

    const totalSchoolsEl = document.getElementById('totalSchools');
    if (totalSchoolsEl) totalSchoolsEl.innerText = total;
    const activeSubsEl = document.getElementById('activeSubscriptions');
    if (activeSubsEl) activeSubsEl.innerText = activeSubs;
    const expiredSubsEl = document.getElementById('expiredSubscriptions');
    if (expiredSubsEl) expiredSubsEl.innerText = expiredSubs;
    const totalStudentsEl = document.getElementById('totalStudentsSuper');
    if (totalStudentsEl) totalStudentsEl.innerText = totalStudents;
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
  } catch (err) {
    handleError(err, "Failed to load schools data.");
  }
}

function renderTable(schools) {
  const tbody = document.getElementById('schoolsTableBody');
  if (!tbody) return;
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
    showLoader();
    try {
      const subRef = doc(db, 'schools', schoolId, 'subscription', 'current');
      if (currentStatus === 'active') {
        await updateDoc(subRef, { status: 'expired', locked: true, lastUpdated: new Date() });
        showNotification("School suspended.", "success");
      } else {
        await updateDoc(subRef, { status: 'active', locked: false, lastUpdated: new Date() });
        showNotification("School activated.", "success");
      }
      await loadDashboard();
    } catch (err) {
      handleError(err, "Operation failed.");
    } finally {
      btn.disabled = false;
      btn.innerText = originalText;
      hideLoader();
    }
  }));
}

async function openApproveModal(schoolId) {
  const school = schoolsData.find(s => s.id === schoolId);
  if (!school) return;
  const pendingCount = school.lockedCount || 0;
  const pendingCountSpan = document.getElementById('pendingCount');
  const approveCountInput = document.getElementById('approveCount');
  if (pendingCountSpan) pendingCountSpan.innerText = pendingCount;
  if (approveCountInput) approveCountInput.value = pendingCount;
  const modal = document.getElementById('approveExtraModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const confirmBtn = document.getElementById('confirmApproveBtn');
  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      const count = approveCountInput ? parseInt(approveCountInput.value) : 0;
      if (count > 0 && count <= pendingCount) {
        showLoader();
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
          showNotification(`${studentsSnap.size} student(s) unlocked.`, "success");
          modal.style.display = 'none';
          await loadDashboard();
        } catch (err) {
          handleError(err, "Approval failed.");
        } finally {
          hideLoader();
        }
      } else {
        showNotification("Invalid count", "error");
      }
    };
  }
  const closeBtn = document.getElementById('closeApproveModal');
  if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

// Event listeners
const refreshBtn = document.getElementById('refreshBtn');
if (refreshBtn) refreshBtn.addEventListener('click', loadDashboard);
const searchInput = document.getElementById('searchSchool');
if (searchInput) searchInput.addEventListener('input', loadSchools);
const filterSelect = document.getElementById('filterStatus');
if (filterSelect) filterSelect.addEventListener('change', loadSchools);
const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      await auth.signOut();
      window.location.href = '/';
    } catch (err) {
      handleError(err, "Logout failed.");
    }
  });
}