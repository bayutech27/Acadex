import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import {
  doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs,
  onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { logoutUser } from './auth.js';
import {
  enforceAccessGuard,
  isSubscriptionActive,
  handleNewStudentAddition,
  autoLockExpiredSubscriptions,
  syncAcademicSession,
  getSubscriptionStatus,
  approveExtraStudents
} from './plan.js';

// ------------------- Auth State -------------------
let currentUser = null;
let currentUserData = null;
let unsubscribeAuth = null;
let authInitialised = false;
let authResolve = null;
const authReadyPromise = new Promise((resolve) => { authResolve = resolve; });

function initAuthListener() {
  if (unsubscribeAuth) return;
  unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        currentUserData = userDoc.exists() ? userDoc.data() : null;
      } catch (err) {
        console.error('Failed to fetch user document:', err);
        currentUserData = null;
      }
    } else {
      currentUserData = null;
    }
    if (!authInitialised) {
      authInitialised = true;
      if (authResolve) authResolve();
    }
  });
}
initAuthListener();

async function waitForAuth() {
  if (authInitialised) return;
  await authReadyPromise;
}

export function getCurrentUser() { return currentUser; }
export function getCurrentUserData() { return currentUserData; }

export async function getCurrentSchoolId() {
  await waitForAuth();
  if (!currentUserData) return null;
  return currentUserData.schoolId || null;
}

// ------------------- Admin Page Protection -------------------
export async function protectAdminPage() {
  await waitForAuth();

  if (!currentUser) {
    window.location.href = '/';
    return null;
  }
  if (!currentUserData || currentUserData.role !== 'admin') {
    window.location.href = '/';
    return null;
  }

  const schoolId = currentUserData.schoolId;
  if (!schoolId) {
    console.error('Admin user has no schoolId');
    window.location.href = '/';
    return null;
  }

  // Ensure school document has academic session/term
  await initAcademicCalendar(schoolId);

  const lastCheck = localStorage.getItem(`autoLockLastCheck_${schoolId}`);
  const today = new Date().toDateString();
  if (lastCheck !== today) {
    await autoLockExpiredSubscriptions();
    localStorage.setItem(`autoLockLastCheck_${schoolId}`, today);
  }

  const access = await enforceAccessGuard(currentUserData, schoolId);
  
  if (!access.allowed) {
    if (access.onboardingOnly) {
      window.__subscriptionExpired = true;
      showSubscriptionExpiredBanner();
    } else {
      window.location.href = '/subscription-required.html';
      return null;
    }
  }

  // Create subscription UI elements if missing
  injectSubscriptionUI();
  updateSubscriptionBadge(schoolId);
  initSubscriptionUI(schoolId);
  
  return { user: currentUser, userData: currentUserData };
}

// Non-dismissible banner
function showSubscriptionExpiredBanner() {
  const existingBanner = document.getElementById('subscriptionExpiredBanner');
  if (existingBanner) existingBanner.remove();

  const banner = document.createElement('div');
  banner.id = 'subscriptionExpiredBanner';
  banner.style.cssText = `
    background: #fef3c7;
    color: #92400e;
    padding: 12px 20px;
    text-align: center;
    font-weight: 500;
    border-bottom: 1px solid #fbbf24;
    position: sticky;
    top: 0;
    z-index: 1000;
  `;
  banner.innerHTML = `⚠️ You have not subscribed for this term. You can still manage students and teachers onboarding, but other features are restricted. Subscribe now to unlock all Features.`;
  document.body.prepend(banner);
}

function hideSubscriptionExpiredBanner() {
  const banner = document.getElementById('subscriptionExpiredBanner');
  if (banner) banner.remove();
}

function injectSubscriptionUI() {
  if (!document.getElementById('subscriptionBadge')) {
    const headerRight = document.querySelector('.header .school-header')?.parentElement;
    if (headerRight) {
      const badge = document.createElement('div');
      badge.id = 'subscriptionBadge';
      badge.style.marginLeft = 'auto';
      badge.style.marginRight = '20px';
      badge.style.fontWeight = 'bold';
      headerRight.appendChild(badge);
    }
  }
  if (!document.getElementById('subscriptionFeeContainer')) {
    const contentDiv = document.querySelector('.content');
    if (contentDiv) {
      const feeDiv = document.createElement('div');
      feeDiv.id = 'subscriptionFeeContainer';
      feeDiv.style.margin = '16px 0';
      contentDiv.insertBefore(feeDiv, contentDiv.firstChild);
    }
  }
  if (!document.getElementById('pendingExtraContainer')) {
    const contentDiv = document.querySelector('.content');
    if (contentDiv) {
      const pendingDiv = document.createElement('div');
      pendingDiv.id = 'pendingExtraContainer';
      pendingDiv.style.margin = '16px 0';
      const feeDiv = document.getElementById('subscriptionFeeContainer');
      if (feeDiv && feeDiv.nextSibling) contentDiv.insertBefore(pendingDiv, feeDiv.nextSibling);
      else contentDiv.appendChild(pendingDiv);
    }
  }
}

export function setupSidebar() {
  const currentPage = window.location.pathname.split('/').pop();
  document.querySelectorAll('.sidebar-nav a').forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPage) link.classList.add('active');
    else link.classList.remove('active');
  });
}

async function updateSubscriptionBadge(schoolId) {
  const active = await isSubscriptionActive(schoolId);
  const badge = document.getElementById('subscriptionBadge');
  if (badge) {
    badge.innerText = active ? '✅ Active' : '⚠️ Expired';
    badge.style.color = active ? '#10b981' : '#ef4444';
  }
}

let subscriptionListenerUnsubscribe = null;

export function initSubscriptionUI(schoolId) {
  if (!schoolId) return;
  if (subscriptionListenerUnsubscribe) subscriptionListenerUnsubscribe();

  const subRef = doc(db, 'schools', schoolId, 'subscription', 'current');
  subscriptionListenerUnsubscribe = onSnapshot(subRef, async (snap) => {
    if (!snap.exists()) return;
    const sub = snap.data();
    await updateFeeDisplay(schoolId, sub);
    updatePendingExtraDisplay(sub);

    const isActive = sub.status === 'active' && sub.locked === false;
    if (isActive) hideSubscriptionExpiredBanner();
    else if (!document.getElementById('subscriptionExpiredBanner')) showSubscriptionExpiredBanner();
  }, (err) => console.error('Subscription listener error:', err));
}

async function updateFeeDisplay(schoolId, sub) {
  const feeContainer = document.getElementById('subscriptionFeeContainer');
  if (!feeContainer) return;

  const isActive = sub.status === 'active' && sub.locked === false;
  const costPerStudent = sub.costPerStudent || 1000;

  let totalActiveStudents = 0;
  try {
    const studentsQuery = query(collection(db, 'students'), where('schoolId', '==', schoolId), where('status', '==', 'active'));
    const studentsSnap = await getDocs(studentsQuery);
    totalActiveStudents = studentsSnap.size;
  } catch (err) {
    console.error('Failed to count active students:', err);
  }

  const totalFee = totalActiveStudents * costPerStudent;

  if (!isActive) {
    feeContainer.innerHTML = `
      <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
        <strong>💰 Subscription Fee Due</strong><br>
        Active students: ${totalActiveStudents} × ₦${costPerStudent} = <strong>₦${totalFee.toLocaleString()}</strong><br>
        <small>Your subscription is currently ${sub.status}. Please renew to unlock all features.</small>
      </div>
    `;
  } else {
    feeContainer.innerHTML = `
      <div style="background: #dcfce7; border-left: 4px solid #10b981; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
        <strong>✅ Subscription Active</strong><br>
        Active students: ${totalActiveStudents} × ₦${costPerStudent} = <strong>₦${totalFee.toLocaleString()}</strong><br>
        <small>Your subscription is active and up to date.</small>
      </div>
    `;
  }
}

function updatePendingExtraDisplay(sub) {
  const pendingContainer = document.getElementById('pendingExtraContainer');
  if (!pendingContainer) return;
  const pending = sub.extraStudentsPendingApproval || 0;
  const costPerStudent = sub.costPerStudent || 1000;
  const pendingFee = pending * costPerStudent;
  if (pending > 0) {
    pendingContainer.innerHTML = `
      <div style="background: #e0f2fe; border-left: 4px solid #0284c7; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
        <strong>⏳ Pending Extra Students</strong><br>
        ${pending} extra student(s) awaiting super-admin approval.<br>
        Pending fee: ₦${pendingFee.toLocaleString()}<br>
        <small>These students are already added but will be covered once approved.</small>
      </div>
    `;
  } else {
    pendingContainer.innerHTML = '';
  }
}

// ------------------- Academic Calendar -------------------
export function getCurrentAcademicSessionAndTerm() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  let session = '';
  let term = '';
  if (month >= 9) session = `${year}/${year + 1}`;
  else session = `${year - 1}/${year}`;
  if (month >= 9 && month <= 12) term = '1';
  else if (month >= 1 && month <= 4) term = '2';
  else if (month >= 5 && month <= 8) term = '3';
  return { session, term };
}

export async function getAcademicContext(schoolId) {
  if (!schoolId) throw new Error('No school ID');
  const schoolRef = doc(db, 'schools', schoolId);
  const snap = await getDoc(schoolRef);
  if (!snap.exists()) throw new Error('School document not found');
  return {
    currentSession: snap.data().currentSession,
    currentTerm: snap.data().currentTerm
  };
}

export async function initAcademicCalendar(schoolId) {
  if (!schoolId) return;
  const schoolRef = doc(db, 'schools', schoolId);
  const { session: computedSession, term: computedTerm } = getCurrentAcademicSessionAndTerm();
  const now = new Date();
  try {
    const schoolSnap = await getDoc(schoolRef);
    if (!schoolSnap.exists()) {
      await setDoc(schoolRef, {
        currentSession: computedSession,
        currentTerm: computedTerm,
        lastUpdated: now
      }, { merge: true });
      return;
    }
    const data = schoolSnap.data();
    if (data.currentSession !== computedSession || data.currentTerm !== computedTerm) {
      await updateDoc(schoolRef, {
        currentSession: computedSession,
        currentTerm: computedTerm,
        lastUpdated: now
      });
    }
  } catch (err) {
    console.error('initAcademicCalendar error:', err);
  }
}

// ------------------- Logo Upload -------------------
async function compressImage(file, maxSizeKB = 500, maxWidth = 500) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width, height = img.height;
        if (width > maxWidth) {
          height = (height * maxWidth) / width;
          width = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        let quality = 0.9;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length > maxSizeKB * 1024 && quality > 0.1) {
          quality -= 0.1;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(dataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function uploadSchoolLogo(schoolId, file) {
  try {
    let compressed = await compressImage(file, 500, 500);
    await updateDoc(doc(db, 'schools', schoolId), { logo: compressed });
    return compressed;
  } catch (error) {
    console.error('Logo upload error:', error);
    alert('Failed to upload logo. Please try again.');
    return null;
  }
}

export async function loadAcademicInfo() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  try {
    const { currentSession, currentTerm } = await getAcademicContext(schoolId);
    const termNames = { 1: 'First Term', 2: 'Second Term', 3: 'Third Term' };
    const academicDiv = document.getElementById('academicInfo');
    if (academicDiv) academicDiv.textContent = `${currentSession || 'N/A'} • ${termNames[currentTerm] || ''}`;
  } catch (err) {
    console.warn('Could not load academic info', err);
  }
}

export async function loadSchoolInfo() {
  const userData = currentUserData;
  if (!userData) return;
  const school = await getSchoolById(userData.schoolId);
  const schoolNameEl = document.getElementById('schoolName');
  const schoolAddressEl = document.getElementById('schoolAddress');
  const adminEmailEl = document.getElementById('adminEmail');
  
  if (schoolNameEl) schoolNameEl.textContent = school ? school.name : 'Unknown School';
  if (schoolAddressEl && school) schoolAddressEl.textContent = school.address || 'No address provided';
  if (adminEmailEl) adminEmailEl.textContent = userData.email;

  const logoImg = document.getElementById('schoolLogoImg');
  if (logoImg && school && school.logo) logoImg.src = school.logo;
  else if (logoImg) logoImg.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 24 24" fill="%23e2e8f0"%3E%3Ccircle cx="12" cy="12" r="12"/%3E%3C/svg%3E';

  await loadAcademicInfo();
  const schoolId = userData.schoolId;
  if (schoolId) {
    updateSubscriptionBadge(schoolId);
    initSubscriptionUI(schoolId);
  }
}

async function getSchoolById(schoolId) {
  try {
    const snap = await getDoc(doc(db, 'schools', schoolId));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error('getSchoolById error:', err);
    return null;
  }
}

export function setupLogoUpload() {
  const cameraIcon = document.getElementById('cameraIcon');
  const fileInput = document.getElementById('logoUploadInput');
  if (cameraIcon && fileInput) {
    cameraIcon.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file && file.type.startsWith('image/')) {
        const schoolId = await getCurrentSchoolId();
        if (!schoolId) return;
        const newLogo = await uploadSchoolLogo(schoolId, file);
        if (newLogo) {
          const logoImg = document.getElementById('schoolLogoImg');
          if (logoImg) logoImg.src = newLogo;
        }
      } else if (file) alert('Please select a valid image file.');
      if (fileInput) fileInput.value = '';
    });
  }
}

export function setupLogout() {
  const logoutBtn = document.getElementById('logoutBtn');
  if (!logoutBtn) return;
  logoutBtn.addEventListener('click', async () => {
    try {
      await logoutUser();
    } catch (err) {
      console.error('Logout failed:', err);
    }
  });
}

export async function loadDashboardCounts() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;

  // Teachers
  try {
    const snap = await getDocs(query(collection(db, 'teachers'), where('schoolId', '==', schoolId)));
    const el = document.getElementById('totalTeachers');
    if (el) el.textContent = snap.size;
  } catch (err) { console.error('Teachers count error:', err); }

  // Total Students
  try {
    const snap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', schoolId)));
    const el = document.getElementById('totalStudents');
    if (el) el.textContent = snap.size;
  } catch (err) { console.error('Total students error:', err); }

  // Active Students
  try {
    const snap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', schoolId), where('status', '==', 'active')));
    const el = document.getElementById('activeStudents');
    if (el) el.textContent = snap.size;
  } catch (err) {
    console.error('Active students error:', err);
    const el = document.getElementById('activeStudents');
    if (el) el.textContent = err.code === 'failed-precondition' ? '⚠️ Create Index' : 'Error';
  }

  // Subjects
  try {
    const snap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', schoolId)));
    const el = document.getElementById('totalSubjects');
    if (el) el.textContent = snap.size;
  } catch (err) { console.error('Subjects error:', err); }
}