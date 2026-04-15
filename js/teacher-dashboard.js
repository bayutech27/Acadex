import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { 
  doc, getDoc, updateDoc, 
  collection, getDocs, query, where, addDoc 
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getSchoolById, getCurrentAcademicSessionAndTerm } from './app.js';
import { logoutUser } from './auth.js';

let currentTeacherId = null;
let currentSchoolId = null;
let teacherData = null;
let userRoleData = null;
let teacherName = null;

// ========== EXISTING FUNCTIONS (protected page, info, etc.) ==========

export async function protectTeacherPage() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        window.location.href = '/';
        reject(new Error('Not authenticated'));
        return;
      }

      try {
        const userDocRef = doc(db, 'users', user.uid);
        const userDocSnap = await getDoc(userDocRef);
        
        if (!userDocSnap.exists()) {
          alert('User profile not found. Please contact admin.');
          window.location.href = '/';
          return;
        }
        
        userRoleData = userDocSnap.data();
        
        if (userRoleData.role !== 'teacher') {
          alert('Access denied. Teachers only.');
          window.location.href = '/';
          return;
        }
        
        currentSchoolId = userRoleData.schoolId;
        if (!currentSchoolId) {
          alert('School association missing. Contact admin.');
          window.location.href = '/';
          return;
        }
        
        const teacherDocRef = doc(db, 'teachers', user.uid);
        const teacherDocSnap = await getDoc(teacherDocRef);
        
        if (teacherDocSnap.exists()) {
          teacherData = teacherDocSnap.data();
          teacherName = teacherData.name || teacherData.email?.split('@')[0] || 'Teacher';
        } else {
          console.warn('Teacher document missing, using users data');
          teacherData = {
            email: userRoleData.email,
            schoolId: currentSchoolId,
            subjectIds: userRoleData.subjects || [],
            isClassTeacher: userRoleData.isClassTeacher || false,
            hostClassId: userRoleData.classId || null,
            classIds: userRoleData.classId ? [userRoleData.classId] : []
          };
          teacherName = userRoleData.email?.split('@')[0] || 'Teacher';
        }
        
        currentTeacherId = user.uid;
        resolve({ user, userData: userRoleData, teacherData, teacherName });
        
      } catch (error) {
        console.error('Error protecting teacher page:', error);
        alert('Authorization error. Please log in again.');
        window.location.href = '/';
        reject(error);
      }
    });
  });
}

export function displayTeacherName(name) {
  const welcomeHeading = document.getElementById('welcomeHeading');
  if (welcomeHeading) {
    welcomeHeading.textContent = `Welcome, ${name}`;
  } else {
    const fallback = document.querySelector('.welcome-card h1');
    if (fallback) fallback.textContent = `Welcome, ${name}`;
  }
}

export async function loadSchoolInfo() {
  if (!currentSchoolId) return;
  const school = await getSchoolById(currentSchoolId);
  const schoolNameEl = document.getElementById('schoolName');
  if (schoolNameEl) schoolNameEl.textContent = school ? school.name : 'Unknown School';
  
  const logoImg = document.getElementById('schoolLogoImg');
  if (logoImg && school?.logo) {
    logoImg.src = school.logo;
  } else if (logoImg) {
    logoImg.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 24 24" fill="%23e2e8f0"%3E%3Ccircle cx="12" cy="12" r="12"/%3E%3C/svg%3E';
  }
  
  await loadAcademicInfo();
}

async function loadAcademicInfo() {
  const { session, term } = getCurrentAcademicSessionAndTerm();
  const termNames = { 1: 'First Term', 2: 'Second Term', 3: 'Third Term' };
  const academicDiv = document.getElementById('academicInfo');
  if (academicDiv) {
    academicDiv.textContent = `${session} • ${termNames[term]}`;
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
        const compressed = await compressImage(file);
        if (compressed) {
          await updateDoc(doc(db, 'schools', currentSchoolId), { logo: compressed });
          document.getElementById('schoolLogoImg').src = compressed;
        }
      }
      fileInput.value = '';
    });
  }
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

export function setupSidebar() {
  const currentPage = window.location.pathname.split('/').pop();
  const links = document.querySelectorAll('.sidebar-nav a');
  links.forEach(link => {
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

export async function checkClassTeacherStatus() {
  if (teacherData) return teacherData.isClassTeacher === true;
  return userRoleData?.isClassTeacher === true;
}

export function getTeacherData() {
  return teacherData;
}

export function getTeacherSubjects() {
  return teacherData?.subjectIds || userRoleData?.subjects || [];
}

// ========== SCORES PAGE FUNCTIONS (DYNAMIC GRADING FROM FIRESTORE) ==========

let scoresState = {
  students: [],
  scoringConfig: null,    // { caWeight, examWeight }
  currentClassId: null,
  currentSubjectId: null,
  currentTerm: null,
  currentSession: null,
  scoresData: {}
};

export async function initScoresPage() {
  if (!currentSchoolId) {
    console.error('School ID not loaded');
    return;
  }

  await loadSessionOptions();
  await loadClassesForTeacher();
  await loadSubjectsForTeacher();
  await loadScoringConfig();   // loads grading from Firestore

  const loadBtn = document.getElementById('loadStudentsBtn');
  const saveBtn = document.getElementById('saveScoresBtn');
  if (loadBtn) loadBtn.addEventListener('click', loadStudents);
  if (saveBtn) saveBtn.addEventListener('click', saveAllScores);
  
  updateScoringInfoDisplay();
}

async function loadSessionOptions() {
  const sessionSelect = document.getElementById('sessionSelect');
  if (!sessionSelect) return;
  
  const currentYear = new Date().getFullYear();
  const options = [];
  for (let i = 0; i < 5; i++) {
    const start = currentYear - i;
    const end = start + 1;
    options.push(`${start}/${end}`);
  }
  sessionSelect.innerHTML = '<option value="">-- Select Session --</option>' +
    options.map(opt => `<option value="${opt}">${opt}</option>`).join('');
}

async function loadClassesForTeacher() {
  const classSelect = document.getElementById('classSelect');
  if (!classSelect) return;
  
  const q = query(collection(db, 'classes'), where('schoolId', '==', currentSchoolId));
  const snapshot = await getDocs(q);
  const classes = snapshot.docs.map(doc => ({ id: doc.id, name: doc.data().name }));
  
  classSelect.innerHTML = '<option value="">-- Select Class --</option>' +
    classes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

async function loadSubjectsForTeacher() {
  const subjectSelect = document.getElementById('subjectSelect');
  if (!subjectSelect) return;
  
  const teacherSubjects = getTeacherSubjects();
  if (!teacherSubjects.length) {
    subjectSelect.innerHTML = '<option value="">-- No subjects assigned --</option>';
    return;
  }
  
  const q = query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId));
  const snapshot = await getDocs(q);
  const allSubjects = {};
  snapshot.docs.forEach(doc => {
    allSubjects[doc.id] = doc.data().name;
  });
  
  const options = teacherSubjects.map(subjId => {
    const name = allSubjects[subjId] || subjId;
    return `<option value="${subjId}">${escapeHtml(name)}</option>`;
  }).join('');
  
  subjectSelect.innerHTML = '<option value="">-- Select Subject --</option>' + options;
}

/**
 * Load grading configuration from Firestore 'scoring' collection.
 * Expected document format: { grading: "30/70", schoolId, ... }
 * Also supports direct caWeight/examWeight fields for backward compatibility.
 */
async function loadScoringConfig() {
  const q = query(collection(db, 'scoring'), where('schoolId', '==', currentSchoolId));
  const snapshot = await getDocs(q);
  
  let caWeight = 30, examWeight = 70; // defaults
  
  if (!snapshot.empty) {
    const data = snapshot.docs[0].data();
    
    // Check for the 'grading' string format (used by admin result.js)
    if (data.grading && typeof data.grading === 'string') {
      const parts = data.grading.split('/');
      if (parts.length === 2) {
        caWeight = parseInt(parts[0], 10) || 30;
        examWeight = parseInt(parts[1], 10) || 70;
      }
    }
    // Also support separate fields if they exist
    else if (data.caWeight !== undefined && data.examWeight !== undefined) {
      caWeight = data.caWeight;
      examWeight = data.examWeight;
    }
  } else {
    console.warn('No scoring config found, using defaults 30/70');
  }
  
  scoresState.scoringConfig = { caWeight, examWeight };
}

function updateScoringInfoDisplay() {
  const infoDiv = document.getElementById('scoringInfo');
  if (infoDiv && scoresState.scoringConfig) {
    const { caWeight, examWeight } = scoresState.scoringConfig;
    infoDiv.innerHTML = `<strong>Grading System:</strong> CA = ${caWeight}%, Exam = ${examWeight}%`;
  }
}

async function loadStudents() {
  const classId = document.getElementById('classSelect').value;
  const subjectId = document.getElementById('subjectSelect').value;
  const term = document.getElementById('termSelect').value;
  const session = document.getElementById('sessionSelect').value;
  
  if (!classId || !subjectId || !term || !session) {
    showMessage('Please select class, subject, term and session.', 'error');
    return;
  }
  
  scoresState.currentClassId = classId;
  scoresState.currentSubjectId = subjectId;
  scoresState.currentTerm = term;
  scoresState.currentSession = session;
  
  const studentsRef = collection(db, 'students');
  const q = query(
    studentsRef,
    where('schoolId', '==', currentSchoolId),
    where('classId', '==', classId)
  );
  const snapshot = await getDocs(q);
  const allStudents = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  
  const filteredStudents = allStudents.filter(s => 
    s.subjects && Array.isArray(s.subjects) && s.subjects.includes(subjectId)
  );
  
  if (filteredStudents.length === 0) {
    showMessage('No students found for this class and subject.', 'error');
    document.getElementById('studentsTableContainer').innerHTML = '<p>No students assigned to this subject in this class.</p>';
    document.getElementById('actionButtons').style.display = 'none';
    return;
  }
  
  scoresState.students = filteredStudents;
  await loadExistingScores();
  renderStudentsTable();
  document.getElementById('actionButtons').style.display = 'block';
  showMessage(`${filteredStudents.length} students loaded.`, 'success');
}

async function loadExistingScores() {
  const scoresRef = collection(db, 'scores');
  const q = query(
    scoresRef,
    where('schoolId', '==', currentSchoolId),
    where('subjectId', '==', scoresState.currentSubjectId),
    where('classId', '==', scoresState.currentClassId),
    where('term', '==', scoresState.currentTerm),
    where('session', '==', scoresState.currentSession)
  );
  const snapshot = await getDocs(q);
  scoresState.scoresData = {};
  snapshot.docs.forEach(doc => {
    const data = doc.data();
    scoresState.scoresData[data.studentId] = {
      ca: data.ca || 0,
      exam: data.exam || 0,
      total: data.total || 0,
      scoreId: doc.id
    };
  });
}

function renderStudentsTable() {
  const container = document.getElementById('studentsTableContainer');
  const { caWeight, examWeight } = scoresState.scoringConfig;
  
  let html = `
    <table class="scores-table">
      <thead>
        <tr><th>Student Name</th><th>CA (max ${caWeight})</th><th>Exam (max ${examWeight})</th><th>Total</th></tr>
      </thead>
      <tbody>
  `;
  
  scoresState.students.forEach(student => {
    const existing = scoresState.scoresData[student.id] || { ca: '', exam: '', total: '' };
    html += `
      <tr data-student-id="${student.id}">
        <td>${escapeHtml(student.name)}</td>
        <td><input type="number" class="score-input ca-input" value="${existing.ca}" min="0" max="${caWeight}" step="1"></td>
        <td><input type="number" class="score-input exam-input" value="${existing.exam}" min="0" max="${examWeight}" step="1"></td>
        <td class="total-cell">${existing.total || ''}</td>
      </tr>
    `;
  });
  
  html += `</tbody>
    </table>`;
  container.innerHTML = html;
  
  document.querySelectorAll('.ca-input, .exam-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const row = e.target.closest('tr');
      updateRowTotal(row);
    });
  });
}

function updateRowTotal(row) {
  const caInput = row.querySelector('.ca-input');
  const examInput = row.querySelector('.exam-input');
  const totalCell = row.querySelector('.total-cell');
  
  let ca = parseFloat(caInput.value) || 0;
  let exam = parseFloat(examInput.value) || 0;
  const { caWeight, examWeight } = scoresState.scoringConfig;
  
  if (ca > caWeight) {
    ca = caWeight;
    caInput.value = caWeight;
  }
  if (exam > examWeight) {
    exam = examWeight;
    examInput.value = examWeight;
  }
  
  const total = ca + exam;
  totalCell.textContent = total;
  
  const studentId = row.dataset.studentId;
  if (!scoresState.scoresData[studentId]) {
    scoresState.scoresData[studentId] = {};
  }
  scoresState.scoresData[studentId].ca = ca;
  scoresState.scoresData[studentId].exam = exam;
  scoresState.scoresData[studentId].total = total;
}

async function saveAllScores() {
  if (scoresState.students.length === 0) {
    showMessage('No students to save. Please load students first.', 'error');
    return;
  }
  
  const rows = document.querySelectorAll('#studentsTableContainer tbody tr');
  for (const row of rows) {
    const studentId = row.dataset.studentId;
    const caInput = row.querySelector('.ca-input');
    const examInput = row.querySelector('.exam-input');
    let ca = parseFloat(caInput.value) || 0;
    let exam = parseFloat(examInput.value) || 0;
    const total = ca + exam;
    
    const { caWeight, examWeight } = scoresState.scoringConfig;
    if (ca > caWeight) ca = caWeight;
    if (exam > examWeight) exam = examWeight;
    
    const scoreData = {
      studentId,
      subjectId: scoresState.currentSubjectId,
      classId: scoresState.currentClassId,
      schoolId: currentSchoolId,
      term: scoresState.currentTerm,
      session: scoresState.currentSession,
      ca: ca,
      exam: exam,
      total: total,
      teacherId: currentTeacherId,
      updatedAt: new Date()
    };
    
    const existing = scoresState.scoresData[studentId];
    if (existing && existing.scoreId) {
      const scoreRef = doc(db, 'scores', existing.scoreId);
      await updateDoc(scoreRef, { ...scoreData, updatedAt: new Date() });
    } else {
      const scoresRef = collection(db, 'scores');
      const newDocRef = await addDoc(scoresRef, { ...scoreData, createdAt: new Date() });
      if (!scoresState.scoresData[studentId]) scoresState.scoresData[studentId] = {};
      scoresState.scoresData[studentId].scoreId = newDocRef.id;
    }
  }
  
  showMessage('All scores saved successfully!', 'success');
}

function showMessage(msg, type) {
  const msgDiv = document.getElementById('message');
  if (!msgDiv) return;
  msgDiv.textContent = msg;
  msgDiv.className = `message ${type}`;
  msgDiv.style.display = 'block';
  setTimeout(() => {
    msgDiv.style.display = 'none';
    msgDiv.className = 'message';
  }, 3000);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}

