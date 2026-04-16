// admin.js - Single auth listener with proper promise initialisation
import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { logoutUser } from './auth.js';

// ------------------- Single Auth Listener (Module Level) -------------------
let currentUser = null;
let currentUserData = null;
let unsubscribeAuth = null;
let authInitialised = false;
let authResolve = null;
const authReadyPromise = new Promise((resolve) => {
  authResolve = resolve;
});

// Initialize the listener once
function initAuthListener() {
  if (unsubscribeAuth) return;
  unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      const userDoc = await getDoc(doc(db, 'users', user.uid));
      currentUserData = userDoc.exists() ? userDoc.data() : null;
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

// Wait for auth to be ready (used by protectAdminPage)
async function waitForAuth() {
  if (authInitialised) return;
  await authReadyPromise;
}

export function getCurrentUser() {
  return currentUser;
}

export function getCurrentUserData() {
  return currentUserData;
}

export async function getCurrentSchoolId() {
  await waitForAuth(); // ensure auth is ready
  if (!currentUserData) return null;
  return currentUserData.schoolId || null;
}

// ------------------- Admin Page Protection (no busy loops) -------------------
export async function protectAdminPage() {
  await waitForAuth(); // wait for the first auth state

  if (!currentUser) {
    window.location.href = '/';
    return null;
  }
  if (!currentUserData || currentUserData.role !== 'admin') {
    window.location.href = '/';
    return null;
  }
  return { user: currentUser, userData: currentUserData };
}

// ------------------- Academic Calendar Helpers (unchanged) -------------------
export function getCurrentAcademicSessionAndTerm() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  let session = '';
  let term = '';

  if (month >= 9) {
    session = `${year}/${year + 1}`;
  } else {
    session = `${year - 1}/${year}`;
  }

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

// ------------------- Logo & UI Helpers (unchanged, with null safety) -------------------
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
    if (academicDiv) {
      academicDiv.textContent = `${currentSession || 'N/A'} • ${termNames[currentTerm] || ''}`;
    }
  } catch (err) {
    console.warn('Could not load academic info', err);
  }
}

export async function loadSchoolInfo() {
  const userData = currentUserData;
  if (!userData) return;
  const school = await getSchoolById(userData.schoolId);
  const schoolNameEl = document.getElementById('schoolName');
  const adminEmailEl = document.getElementById('adminEmail');
  if (schoolNameEl) schoolNameEl.textContent = school ? school.name : 'Unknown School';
  if (adminEmailEl) adminEmailEl.textContent = userData.email;

  const logoImg = document.getElementById('schoolLogoImg');
  if (logoImg && school && school.logo) logoImg.src = school.logo;
  else if (logoImg) logoImg.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 24 24" fill="%23e2e8f0"%3E%3Ccircle cx="12" cy="12" r="12"/%3E%3C/svg%3E';

  await loadAcademicInfo();
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

export async function loadDashboardCounts() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  try {
    const teachersSnap = await getDocs(query(collection(db, 'teachers'), where('schoolId', '==', schoolId)));
    const totalTeachersEl = document.getElementById('totalTeachers');
    if (totalTeachersEl) totalTeachersEl.textContent = teachersSnap.size;

    const studentsSnap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', schoolId)));
    const totalStudentsEl = document.getElementById('totalStudents');
    if (totalStudentsEl) totalStudentsEl.textContent = studentsSnap.size;

    // Requires composite index (schoolId, status)
    const activeQuery = query(collection(db, 'students'), where('schoolId', '==', schoolId), where('status', '==', 'active'));
    const activeSnap = await getDocs(activeQuery);
    const activeStudentsEl = document.getElementById('activeStudents');
    if (activeStudentsEl) activeStudentsEl.textContent = activeSnap.size;
  } catch (error) {
    console.error(error);
    const activeStudentsEl = document.getElementById('activeStudents');
    if (activeStudentsEl) activeStudentsEl.textContent = error.code === 'failed-precondition' ? '⚠️ Index needed' : 'Error';
  }
  const subjectsSnap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', schoolId)));
  const totalSubjectsEl = document.getElementById('totalSubjects');
  if (totalSubjectsEl) totalSubjectsEl.textContent = subjectsSnap.size;
}

export function setupSidebar() {
  const currentPage = window.location.pathname.split('/').pop();
  document.querySelectorAll('.sidebar-nav a').forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPage) link.classList.add('active');
    else link.classList.remove('active');
  });
}

export function setupLogout() {
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await logoutUser();
    });
  }
}

async function getSchoolById(schoolId) {
  const snap = await getDoc(doc(db, 'schools', schoolId));
  return snap.exists() ? snap.data() : null;
}