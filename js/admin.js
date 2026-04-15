import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { doc, getDoc, updateDoc, collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId, getUserData, getSchoolById, getCurrentAcademicSessionAndTerm, archiveCurrentTermIfNeeded } from './app.js';
import { logoutUser } from './auth.js';

export async function protectAdminPage() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        window.location.href = '/';
        return;
      }
      const userData = await getUserData();
      if (!userData || userData.role !== 'admin') {
        window.location.href = '/';
        return;
      }
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
        let width = img.width;
        let height = img.height;
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
  const { session, term } = getCurrentAcademicSessionAndTerm();
  const termNames = { 1: 'First Term', 2: 'Second Term', 3: 'Third Term' };
  const academicDiv = document.getElementById('academicInfo');
  if (academicDiv) {
    academicDiv.textContent = `${session} • ${termNames[term]}`;
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
  if (logoImg && school && school.logo) {
    logoImg.src = school.logo;
  } else if (logoImg) {
    logoImg.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 24 24" fill="%23e2e8f0"%3E%3Ccircle cx="12" cy="12" r="12"/%3E%3C/svg%3E';
  }
  
  await archiveCurrentTermIfNeeded(userData.schoolId);
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
      } else if (file) {
        alert('Please select a valid image file.');
      }
      fileInput.value = '';
    });
  }
}

export async function loadDashboardCounts() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;

  try {
    // Total Teachers
    const teachersQuery = query(collection(db, 'teachers'), where('schoolId', '==', schoolId));
    const teachersSnap = await getDocs(teachersQuery);
    document.getElementById('totalTeachers').textContent = teachersSnap.size;

    // Total Students
    const studentsQuery = query(collection(db, 'students'), where('schoolId', '==', schoolId));
    const studentsSnap = await getDocs(studentsQuery);
    document.getElementById('totalStudents').textContent = studentsSnap.size;

    // Active Students (requires composite index on (schoolId, status))
    const activeStudentsQuery = query(
      collection(db, 'students'),
      where('schoolId', '==', schoolId),
      where('status', '==', 'active')
    );
    const activeStudentsSnap = await getDocs(activeStudentsQuery);
    document.getElementById('activeStudents').textContent = activeStudentsSnap.size;
  } catch (error) {
    console.error('Error loading dashboard counts:', error);
    if (error.code === 'failed-precondition') {
      document.getElementById('activeStudents').textContent = '⚠️ Index needed';
      console.warn('Create composite index for students (schoolId, status)');
    } else {
      document.getElementById('activeStudents').textContent = 'Error';
    }
  }

  // Total Subjects (always works)
  const subjectsQuery = query(collection(db, 'subjects'), where('schoolId', '==', schoolId));
  const subjectsSnap = await getDocs(subjectsQuery);
  document.getElementById('totalSubjects').textContent = subjectsSnap.size;
}

export function setupSidebar() {
  const currentPage = window.location.pathname.split('/').pop();
  const links = document.querySelectorAll('.sidebar-nav a');
  links.forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPage) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
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