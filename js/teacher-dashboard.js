// teacher-dashboard.js - Complete with school address loading and Central Academic Calendar
// MODIFIED: No redirect when teacher document is missing – creates minimal record instead.
// FULLY INTEGRATED with Central Academic Calendar Engine
// EXTENDED: Added getCurrentTeacherId(), getCurrentSchoolId(), getHostClassId() exports
//           for attendance.js consumption. All existing functions are UNTOUCHED.
// MODIFIED: displayTeacherName now shows dynamic time‑based greeting (Good morning/afternoon/evening).
//
// All Firestore operations go through service.js where possible.
// TODO: service.js does not yet support teacher doc creation (setDoc) for minimal teacher record,
// logo upload (updateSchool), some scoring config queries, and direct score addDoc/updateDoc.
// These remain as direct Firestore calls.

import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { doc, getDoc, updateDoc, collection, getDocs, query, where, addDoc, setDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { logoutUser } from './auth.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';
import { initAcademicCalendar, getCurrentTerm, getCurrentSession } from './academic-calendar.js';
import * as service from './service.js';

let currentTeacherId = null;
let currentSchoolId = null;
let teacherData = null;
let userRoleData = null;
let teacherName = null;

// ------------------- Helper: Time-based greeting -------------------
function getTimeBasedGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// ------------------- Auth Protection (using service.getUserById) -------------------
export async function protectTeacherPage() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        console.warn("No authenticated user. Redirecting to login.");
        window.location.href = '/';
        reject(new Error('Not authenticated'));
        return;
      }

      try {
        const userData = await service.getUserById(user.uid);
        if (!userData) {
          console.error("User document missing. Redirecting.");
          window.location.href = '/';
          return;
        }
        userRoleData = userData;

        if (userRoleData.role !== 'teacher') {
          console.error("Access denied – not a teacher.");
          window.location.href = '/';
          return;
        }

        currentSchoolId = userRoleData.schoolId;
        if (!currentSchoolId) {
          console.error("School ID missing. Redirecting.");
          window.location.href = '/';
          return;
        }

        // Initialise Central Academic Calendar for teacher pages
        await initAcademicCalendar();

        // Try to fetch teacher document, but do NOT redirect if missing
        let teacher = null;
        try {
          teacher = await service.getTeacherById(user.uid);
        } catch (e) {
          console.warn('Teacher document fetch error', e);
        }

        if (teacher) {
          teacherData = teacher;
          teacherName = teacher.name || teacher.email?.split('@')[0] || 'Teacher';
        } else {
          // No teacher document? Create a default one on the fly (no redirect)
          console.warn("Teacher document missing – creating minimal record to avoid redirect.");
          teacherData = {
            email: userRoleData.email,
            schoolId: currentSchoolId,
            subjectIds: userRoleData.subjects || [],
            isClassTeacher: true,
            hostClassId: null,
            classIds: []
          };
          teacherName = userRoleData.email?.split('@')[0] || 'Teacher';
          try {
            // TODO: service.createTeacher does not exist – use direct setDoc
            await setDoc(doc(db, 'teachers', user.uid), teacherData);
          } catch (e) {
            console.warn("Could not create teacher document automatically:", e.message);
          }
        }

        currentTeacherId = user.uid;
        resolve({ user, userData: userRoleData, teacherData, teacherName });

      } catch (error) {
        console.error("Authorization error, but page will try to load:", error);
        if (userRoleData && currentSchoolId) {
          teacherData = {
            email: userRoleData.email,
            schoolId: currentSchoolId,
            subjectIds: userRoleData.subjects || [],
            classIds: [],
            isClassTeacher: false
          };
          teacherName = userRoleData.email?.split('@')[0] || 'Teacher';
          currentTeacherId = user.uid;
          resolve({ user, userData: userRoleData, teacherData, teacherName });
        } else {
          window.location.href = '/';
          reject(error);
        }
      }
    });
  });
}

// MODIFIED: Now uses dynamic time-based greeting (Good morning/afternoon/evening)
export function displayTeacherName(name) {
  if (!name) name = 'Teacher';
  const greeting = getTimeBasedGreeting();
  const fullGreeting = `${greeting}, ${name}`;
  const welcomeHeading = document.getElementById('welcomeHeading');
  if (welcomeHeading) {
    welcomeHeading.textContent = fullGreeting;
  } else {
    const fallback = document.querySelector('.welcome-card h1');
    if (fallback) fallback.textContent = fullGreeting;
  }
}

// ------------------- School Info with Address (using service.getSchoolById) -------------------
export async function loadSchoolInfo() {
  if (!currentSchoolId) return;
  try {
    const school = await service.getSchoolById(currentSchoolId);
    const schoolNameEl    = document.getElementById('schoolName');
    const schoolAddressEl = document.getElementById('schoolAddress');
    if (schoolNameEl)    schoolNameEl.textContent    = school ? school.name : 'Unknown School';
    if (schoolAddressEl && school) schoolAddressEl.textContent = school.address || 'No address provided';
    
    const logoImg = document.getElementById('schoolLogoImg');
    if (logoImg && school?.logo) {
      logoImg.src = school.logo;
    } else if (logoImg) {
      logoImg.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 24 24" fill="%23e2e8f0"%3E%3Ccircle cx="12" cy="12" r="12"/%3E%3C/svg%3E';
    }
    
    await loadAcademicInfo();
  } catch (err) {
    handleError(err, "Failed to load school information.");
  }
}

async function loadAcademicInfo() {
  const session   = getCurrentSession();
  const term      = getCurrentTerm();
  const academicDiv = document.getElementById('academicInfo');
  if (academicDiv) academicDiv.textContent = `${session} • ${term}`;
}

// ------------------- Logo Upload (direct Firestore – service.updateSchool exists) -------------------
export function setupLogoUpload() {
  const cameraIcon = document.getElementById('cameraIcon');
  const fileInput  = document.getElementById('logoUploadInput');
  if (cameraIcon && fileInput) {
    cameraIcon.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file && file.type.startsWith('image/')) {
        showLoader();
        try {
          const compressed = await compressImage(file);
          if (compressed) {
            // Use service.updateSchool
            await service.updateSchool(currentSchoolId, { logo: compressed });
            const logoImg = document.getElementById('schoolLogoImg');
            if (logoImg) logoImg.src = compressed;
            showNotification("Logo updated successfully.", "success");
          }
        } catch (err) {
          handleError(err, "Failed to upload logo.");
        } finally {
          hideLoader();
        }
      }
      fileInput.value = '';
    });
  }
}

async function compressImage(file, maxSizeKB = 500, maxWidth = 500) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width, height = img.height;
        if (width > maxWidth) { height = (height * maxWidth) / width; width = maxWidth; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        let quality = 0.9;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length > maxSizeKB * 1024 && quality > 0.1) {
          quality -= 0.1;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error("Image loading failed"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("File reading failed"));
    reader.readAsDataURL(file);
  });
}

// ------------------- UI Helpers (unchanged) -------------------
export function setupSidebar() {
  const currentPage = window.location.pathname.split('/').pop();
  document.querySelectorAll('.sidebar-nav a').forEach(link => {
    const href = link.getAttribute('href');
    link.classList.toggle('active', href === currentPage);
  });
}

export function setupLogout() {
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try { await logoutUser(); } catch (err) { handleError(err, "Logout failed."); }
    });
  }
}

export async function checkClassTeacherStatus() {
  if (teacherData) return teacherData.isClassTeacher === true;
  return userRoleData?.isClassTeacher === true;
}

export function getTeacherData()     { return teacherData; }
export function getTeacherSubjects() { return teacherData?.subjectIds || userRoleData?.subjects || []; }

// ------------------- Scores Page Functions (refactored where possible) -------------------
let scoresState = {
  students: [],
  scoringConfig: null,
  currentClassId: null,
  currentSubjectId: null,
  currentTerm: null,
  currentSession: null,
  scoresData: {}
};

export async function initScoresPage() {
  if (!currentSchoolId) { console.error('School ID not loaded'); return; }
  await loadSessionOptions();
  await loadClassesForTeacher();
  await loadSubjectsForTeacher();
  await loadScoringConfig();
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
    options.push(`${start}/${start + 1}`);
  }
  sessionSelect.innerHTML = '<option value="">-- Select Session --</option>' +
    options.map(opt => `<option value="${opt}">${opt}</option>`).join('');
}

async function loadClassesForTeacher() {
  const classSelect = document.getElementById('classSelect');
  if (!classSelect) return;
  try {
    const classes = await service.getClassesBySchool(currentSchoolId);
    classSelect.innerHTML = '<option value="">-- Select Class --</option>' +
      classes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  } catch (err) { handleError(err, "Failed to load classes."); }
}

async function loadSubjectsForTeacher() {
  const subjectSelect = document.getElementById('subjectSelect');
  if (!subjectSelect) return;
  const teacherSubjects = getTeacherSubjects();
  if (!teacherSubjects.length) {
    subjectSelect.innerHTML = '<option value="">-- No subjects assigned --</option>';
    return;
  }
  try {
    const allSubjects = await service.getSubjectsBySchool(currentSchoolId);
    const allSubjectsMap = {};
    allSubjects.forEach(s => { allSubjectsMap[s.id] = s.name; });
    const options = teacherSubjects.map(id =>
      `<option value="${id}">${escapeHtml(allSubjectsMap[id] || id)}</option>`
    ).join('');
    subjectSelect.innerHTML = '<option value="">-- Select Subject --</option>' + options;
  } catch (err) { handleError(err, "Failed to load subjects."); }
}

async function loadScoringConfig() {
  try {
    const configs = await service.getScoringConfig(currentSchoolId);
    let caWeight = 30, examWeight = 70;
    if (configs && configs.length > 0) {
      const data = configs[0];
      if (data.grading && typeof data.grading === 'string') {
        const parts = data.grading.split('/');
        if (parts.length === 2) { caWeight = parseInt(parts[0], 10) || 30; examWeight = parseInt(parts[1], 10) || 70; }
      } else if (data.caWeight !== undefined && data.examWeight !== undefined) {
        caWeight = data.caWeight; examWeight = data.examWeight;
      }
    }
    scoresState.scoringConfig = { caWeight, examWeight };
  } catch (err) {
    handleError(err, "Failed to load scoring configuration.");
    scoresState.scoringConfig = { caWeight: 30, examWeight: 70 };
  }
}

function updateScoringInfoDisplay() {
  const infoDiv = document.getElementById('scoringInfo');
  if (infoDiv && scoresState.scoringConfig) {
    const { caWeight, examWeight } = scoresState.scoringConfig;
    infoDiv.innerHTML = `<strong>Grading System:</strong> CA = ${caWeight}%, Exam = ${examWeight}%`;
  }
}

async function loadStudents() {
  const classId   = document.getElementById('classSelect')?.value;
  const subjectId = document.getElementById('subjectSelect')?.value;
  const term      = document.getElementById('termSelect')?.value;
  const session   = document.getElementById('sessionSelect')?.value;
  if (!classId || !subjectId || !term || !session) {
    showNotification("Please select class, subject, term and session.", "error"); return;
  }
  scoresState.currentClassId   = classId;
  scoresState.currentSubjectId = subjectId;
  scoresState.currentTerm      = term;
  scoresState.currentSession   = session;
  showLoader();
  try {
    // Use service.getStudentsByClass then filter by subject list
    const allStudents = await service.getStudentsByClass(currentSchoolId, classId);
    const filteredStudents = allStudents.filter(s =>
      s.subjects && Array.isArray(s.subjects) && s.subjects.includes(subjectId)
    );
    if (filteredStudents.length === 0) {
      showNotification("No students found for this class and subject.", "error");
      const container = document.getElementById('studentsTableContainer');
      if (container) container.innerHTML = '<p>No students assigned to this subject in this class.</p>';
      const actions = document.getElementById('actionButtons');
      if (actions) actions.style.display = 'none';
      return;
    }
    scoresState.students = filteredStudents;
    await loadExistingScores();
    renderStudentsTable();
    const actions = document.getElementById('actionButtons');
    if (actions) actions.style.display = 'block';
    showNotification(`${filteredStudents.length} students loaded.`, "success");
  } catch (err) { handleError(err, "Failed to load students."); }
  finally { hideLoader(); }
}

async function loadExistingScores() {
  try {
    // Use service.getScoresByClass? But we need subjectId filter. Use getScoresByClass and filter client-side.
    const allScores = await service.getScoresByClass(scoresState.currentClassId, currentSchoolId, scoresState.currentTerm, scoresState.currentSession);
    const filtered = allScores.filter(s => s.subjectId === scoresState.currentSubjectId);
    scoresState.scoresData = {};
    filtered.forEach(score => {
      scoresState.scoresData[score.studentId] = { ca: score.ca || 0, exam: score.exam || 0, total: (score.ca || 0) + (score.exam || 0), scoreId: score.id };
    });
  } catch (err) { handleError(err, "Failed to load existing scores."); }
}

function renderStudentsTable() {
  const container = document.getElementById('studentsTableContainer');
  if (!container) return;
  const { caWeight, examWeight } = scoresState.scoringConfig;
  let html = `
    <table class="scores-table">
      <thead>
        <tr><th>Student Name</th><th>CA (max ${caWeight})</th><th>Exam (max ${examWeight})</th><th>Total</th></tr>
      </thead><tbody>`;
  scoresState.students.forEach(student => {
    const existing = scoresState.scoresData[student.id] || { ca: '', exam: '', total: '' };
    html += `
      <tr data-student-id="${student.id}">
        <td>${escapeHtml(student.name)}</td>
        <td><input type="number" class="score-input ca-input"   value="${existing.ca}"   min="0" max="${caWeight}"   step="1"></td>
        <td><input type="number" class="score-input exam-input" value="${existing.exam}" min="0" max="${examWeight}" step="1"></td>
        <td class="total-cell">${existing.total || ''}</td>
      </tr>`;
  });
  html += `</tbody></table>`;
  container.innerHTML = html;
  document.querySelectorAll('.ca-input, .exam-input').forEach(input => {
    input.addEventListener('input', e => updateRowTotal(e.target.closest('tr')));
  });
}

function updateRowTotal(row) {
  if (!row) return;
  const caInput   = row.querySelector('.ca-input');
  const examInput = row.querySelector('.exam-input');
  const totalCell = row.querySelector('.total-cell');
  if (!caInput || !examInput || !totalCell) return;
  let ca   = parseFloat(caInput.value)   || 0;
  let exam = parseFloat(examInput.value) || 0;
  const { caWeight, examWeight } = scoresState.scoringConfig;
  if (ca   > caWeight)   { ca   = caWeight;   caInput.value   = caWeight; }
  if (exam > examWeight) { exam = examWeight; examInput.value = examWeight; }
  const total = ca + exam;
  totalCell.textContent = total;
  const studentId = row.dataset.studentId;
  if (!scoresState.scoresData[studentId]) scoresState.scoresData[studentId] = {};
  scoresState.scoresData[studentId].ca    = ca;
  scoresState.scoresData[studentId].exam  = exam;
  scoresState.scoresData[studentId].total = total;
}

async function saveAllScores() {
  if (scoresState.students.length === 0) {
    showNotification("No students to save. Please load students first.", "error"); return;
  }
  showLoader();
  try {
    const rows = document.querySelectorAll('#studentsTableContainer tbody tr');
    for (const row of rows) {
      const studentId = row.dataset.studentId;
      let ca   = parseFloat(row.querySelector('.ca-input')?.value)   || 0;
      let exam = parseFloat(row.querySelector('.exam-input')?.value) || 0;
      const { caWeight, examWeight } = scoresState.scoringConfig;
      if (ca   > caWeight)   ca   = caWeight;
      if (exam > examWeight) exam = examWeight;
      const total = ca + exam;
      const existing = scoresState.scoresData[studentId];
      // Use service.saveScore
      await service.saveScore({
        studentId, subjectId: scoresState.currentSubjectId,
        classId: scoresState.currentClassId, schoolId: currentSchoolId,
        term: scoresState.currentTerm, session: scoresState.currentSession,
        ca, exam, teacherId: currentTeacherId
      }, existing?.scoreId);
    }
    showNotification("All scores saved successfully!", "success");
  } catch (err) { handleError(err, "Failed to save scores."); }
  finally { hideLoader(); }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

// =============================================================================
// NEW EXPORTS — added for attendance.js. Do NOT remove or rename these.
// =============================================================================

/** Returns the currently authenticated teacher's Firebase UID. */
export function getCurrentTeacherId() { return currentTeacherId; }

/** Returns the school ID bound to the current authenticated teacher. */
export function getCurrentSchoolId()  { return currentSchoolId;  }

/**
 * Returns the host class ID assigned to this teacher, or null if the teacher
 * is not a class teacher or does not have a host class set.
 */
export function getHostClassId() { return teacherData?.hostClassId || null; }