// admin.js - Academic calendar engine with Firestore as single source of truth
import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { logoutUser } from './auth.js';

// ------------------- Academic Calendar Helpers -------------------
export function getCurrentAcademicSessionAndTerm() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12

  let session = '';
  let term = '';

  // Session: Sep-Dec -> year/year+1, Jan-Aug -> (year-1)/year
  if (month >= 9) {
    session = `${year}/${year + 1}`;
  } else {
    session = `${year - 1}/${year}`;
  }

  // Term: 1 = Sep-Dec, 2 = Jan-Apr, 3 = May-Aug
  if (month >= 9 && month <= 12) term = '1';
  else if (month >= 1 && month <= 4) term = '2';
  else if (month >= 5 && month <= 8) term = '3';

  return { session, term };
}

// Firestore read: always fresh academic context (single source of truth)
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

// Firestore write: updates only if changed, safe creation with setDoc merge
export async function initAcademicCalendar(schoolId) {
  if (!schoolId) return;
  const schoolRef = doc(db, 'schools', schoolId);
  const { session: computedSession, term: computedTerm } = getCurrentAcademicSessionAndTerm();
  const now = new Date();

  try {
    const schoolSnap = await getDoc(schoolRef);
    if (!schoolSnap.exists()) {
      // Create document with initial values
      await setDoc(schoolRef, {
        currentSession: computedSession,
        currentTerm: computedTerm,
        lastUpdated: now
      }, { merge: true });
      console.log(`Academic calendar initialised: ${computedSession} - Term ${computedTerm}`);
      return;
    }

    const data = schoolSnap.data();
    const currentSession = data.currentSession;
    const currentTerm = data.currentTerm;

    if (currentSession !== computedSession || currentTerm !== computedTerm) {
      await updateDoc(schoolRef, {
        currentSession: computedSession,
        currentTerm: computedTerm,
        lastUpdated: now
      });
      console.log(`Academic calendar updated: ${computedSession} - Term ${computedTerm}`);
    }
  } catch (err) {
    console.error('initAcademicCalendar error:', err);
  }
}

// ------------------- Existing Admin Functions (preserved & improved) -------------------
export async function protectAdminPage() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) { window.location.href = '/'; return; }
      const userData = await getUserData();
      if (!userData || userData.role !== 'admin') { window.location.href = '/'; return; }
      resolve({ user, userData });
    });
  });
}

async function compressImage(file, maxSizeKB = 500, maxWidth = 500) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width, height = img.height;
        if (width > maxWidth) { height = (height * maxWidth) / width; width = maxWidth; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
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
  try {
    const schoolId = await getCurrentSchoolId();
    if (!schoolId) return;
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
  const userData = await getUserData();
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
        const userData = await getUserData();
        const newLogo = await uploadSchoolLogo(userData.schoolId, file);
        if (newLogo) {
          const logoImg = document.getElementById('schoolLogoImg');
          if (logoImg) logoImg.src = newLogo;
        }
      } else if (file) alert('Please select a valid image file.');
      fileInput.value = '';
    });
  }
}

export async function loadDashboardCounts() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  try {
    const teachersSnap = await getDocs(query(collection(db, 'teachers'), where('schoolId', '==', schoolId)));
    document.getElementById('totalTeachers').textContent = teachersSnap.size;
    const studentsSnap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', schoolId)));
    document.getElementById('totalStudents').textContent = studentsSnap.size;
    const activeQuery = query(collection(db, 'students'), where('schoolId', '==', schoolId), where('status', '==', 'active'));
    const activeSnap = await getDocs(activeQuery);
    document.getElementById('activeStudents').textContent = activeSnap.size;
  } catch (error) {
    console.error(error);
    document.getElementById('activeStudents').textContent = error.code === 'failed-precondition' ? '⚠️ Index needed' : 'Error';
  }
  const subjectsSnap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', schoolId)));
  document.getElementById('totalSubjects').textContent = subjectsSnap.size;
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
  if (logoutBtn) logoutBtn.addEventListener('click', async () => { await logoutUser(); });
}

// ------------------- Helper Functions -------------------
async function getUserData() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) resolve(null);
      else {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        resolve(userDoc.exists() ? userDoc.data() : null);
      }
    });
  });
}

async function getCurrentSchoolId() {
  const userData = await getUserData();
  return userData?.schoolId || localStorage.getItem('userSchoolId');
}

async function getSchoolById(schoolId) {
  const snap = await getDoc(doc(db, 'schools', schoolId));
  return snap.exists() ? snap.data() : null;
}