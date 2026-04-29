// scores.js - Teacher score entry with subscription check, locked student restrictions,
// and dynamic subject dropdown based on teacher's assigned subjects (from Firestore)
// UPDATED: Grading is loaded based on the selected class's level (primary/secondary).
import { db, auth } from './firebase-config.js';
import {
  collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getTeacherData } from './teacher-dashboard.js';
import { canEnterScores } from './plan.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

let currentSchoolId = null;
let teacherData = null;
let teacherId = null;
let teacherSubjectIds = [];
let teacherClassIds = [];
let subjectsMap = new Map();
let classesMap = new Map();          // classId -> { name, level }
let studentsList = [];
let selectedClassId = null;
let selectedSubjectId = null;
let selectedTerm = '1';
let selectedSession = '';
let currentGrading = { ca: 40, exam: 60 };
let isScoreEntryAllowed = false;

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

function generateSessionOptions() {
  const year = new Date().getFullYear();
  let opts = [];
  for (let i = 0; i < 5; i++) opts.push(`${year - i}/${year - i + 1}`);
  return opts;
}

async function getSchoolAcademicInfo() {
  try {
    const snap = await getDoc(doc(db, 'schools', currentSchoolId));
    if (snap.exists()) return { currentSession: snap.data().currentSession, currentTerm: snap.data().currentTerm };
    return null;
  } catch (err) {
    handleError(err, "Failed to load academic info.");
    return null;
  }
}

function getScoringDocId(session, term) {
  return `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}`;
}

// NEW: Load grading based on class level (primary/secondary)
// Falls back to school‑wide or default 40/60 if level‑specific config missing.
async function loadGradingSettingByClassLevel(classId, session, term) {
  if (!classId) {
    currentGrading = { ca: 40, exam: 60 };
    return;
  }

  try {
    // 1. Get class level
    const classDoc = await getDoc(doc(db, 'classes', classId));
    if (!classDoc.exists()) {
      console.warn(`Class ${classId} not found, using default grading 40/60`);
      currentGrading = { ca: 40, exam: 60 };
      return;
    }
    const classLevel = classDoc.data().level; // 'primary' or 'secondary'

    // 2. Query scoring collection for schoolId + level
    const scoringQuery = query(
      collection(db, 'scoring'),
      where('schoolId', '==', currentSchoolId),
      where('level', '==', classLevel)
    );
    const scoringSnap = await getDocs(scoringQuery);

    let grading = null;
    if (!scoringSnap.empty) {
      const data = scoringSnap.docs[0].data();
      if (data.grading) {
        grading = data.grading; // e.g. "40/60"
      } else if (data.caWeight !== undefined && data.examWeight !== undefined) {
        grading = `${data.caWeight}/${data.examWeight}`;
      }
    }

    // 3. Fallback: try school‑wide scoring (no level)
    if (!grading) {
      const fallbackQuery = query(
        collection(db, 'scoring'),
        where('schoolId', '==', currentSchoolId)
      );
      const fallbackSnap = await getDocs(fallbackQuery);
      if (!fallbackSnap.empty) {
        const data = fallbackSnap.docs[0].data();
        if (data.grading) grading = data.grading;
        else if (data.caWeight !== undefined && data.examWeight !== undefined) {
          grading = `${data.caWeight}/${data.examWeight}`;
        }
      }
    }

    // 4. Parse and set
    if (grading) {
      const [ca, exam] = grading.split('/').map(Number);
      currentGrading = { ca, exam };
      console.log(`Grading loaded for level ${classLevel}: CA=${ca}, Exam=${exam}`);
    } else {
      console.warn(`No grading found for level ${classLevel}, using default 40/60`);
      currentGrading = { ca: 40, exam: 60 };
    }
  } catch (err) {
    console.error("Failed to load grading by class level:", err);
    currentGrading = { ca: 40, exam: 60 };
    if (err.code === 'permission-denied') {
      showNotification("Unable to load grading settings – using default CA=40, Exam=60.", "warning");
    }
  }
}

// Legacy function kept for compatibility, but we will use loadGradingSettingByClassLevel
async function loadGradingSetting(session, term) {
  // Called when session/term changes; we may also need to reload based on current class
  if (selectedClassId) {
    await loadGradingSettingByClassLevel(selectedClassId, session, term);
  } else {
    // fallback to old method (document with composite ID)
    try {
      const docId = getScoringDocId(session, term);
      const docSnap = await getDoc(doc(db, 'scoring', docId));
      let grading = '40/60';
      if (docSnap.exists()) grading = docSnap.data().grading;
      const [ca, exam] = grading.split('/').map(Number);
      currentGrading = { ca, exam };
    } catch (err) {
      currentGrading = { ca: 40, exam: 60 };
    }
  }
}

async function loadAllSubjects() {
  try {
    const snap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId)));
    subjectsMap.clear();
    snap.forEach(doc => subjectsMap.set(doc.id, doc.data().name));
  } catch (err) {
    handleError(err, "Failed to load subjects.");
  }
}

async function loadAllClasses() {
  try {
    const snap = await getDocs(query(collection(db, 'classes'), where('schoolId', '==', currentSchoolId)));
    classesMap.clear();
    snap.forEach(doc => {
      classesMap.set(doc.id, { name: doc.data().name, level: doc.data().level });
    });
  } catch (err) {
    handleError(err, "Failed to load classes.");
  }
}

async function loadTeacherAssignedSubjectsAndClasses() {
  if (!teacherId) return;
  try {
    const teacherDoc = await getDoc(doc(db, 'teachers', teacherId));
    if (teacherDoc.exists()) {
      const data = teacherDoc.data();
      teacherSubjectIds = data.subjectIds || [];
      teacherClassIds = data.classIds || [];
      console.log("Teacher assigned subjects:", teacherSubjectIds);
      console.log("Teacher assigned classes:", teacherClassIds);
    } else {
      console.warn("Teacher document not found for UID:", teacherId);
    }
  } catch (err) {
    handleError(err, "Failed to retrieve teacher assignments.");
  }
}

function populateSubjectDropdown() {
  const subjectSelect = document.getElementById('subjectSelect');
  if (!subjectSelect) return;

  subjectSelect.innerHTML = '<option value="">Select Subject</option>';
  let subjectsToShow = teacherSubjectIds.length ? teacherSubjectIds : Array.from(subjectsMap.keys());
  if (!subjectsToShow.length) {
    const option = document.createElement('option');
    option.disabled = true;
    option.textContent = 'No subjects available';
    subjectSelect.appendChild(option);
    subjectSelect.disabled = true;
    return;
  }

  for (const subjId of subjectsToShow) {
    const subjectName = subjectsMap.get(subjId);
    if (subjectName) {
      const option = document.createElement('option');
      option.value = subjId;
      option.textContent = subjectName;
      subjectSelect.appendChild(option);
    }
  }
  subjectSelect.disabled = false;
}

function populateClassDropdown() {
  const classSelect = document.getElementById('classSelect');
  if (!classSelect) return;

  let teacherClasses = teacherClassIds.length ? teacherClassIds : Array.from(classesMap.keys());
  classSelect.innerHTML = '<option value="">Select Class</option>';
  for (const clsId of teacherClasses) {
    const classInfo = classesMap.get(clsId);
    const className = classInfo ? classInfo.name : clsId;
    const option = document.createElement('option');
    option.value = clsId;
    option.textContent = className;
    classSelect.appendChild(option);
  }
  classSelect.disabled = false;
}

async function loadStudentsForClass(classId) {
  try {
    const snap = await getDocs(query(
      collection(db, 'students'),
      where('schoolId', '==', currentSchoolId),
      where('classId', '==', classId)
    ));
    studentsList = snap.docs.map(doc => ({
      id: doc.id,
      name: doc.data().name,
      locked: doc.data().locked === true
    }));
  } catch (err) {
    handleError(err, "Failed to load students for class.");
    studentsList = [];
  }
}

async function fetchExistingScores(studentId, subjectId, term, session) {
  try {
    const q = query(
      collection(db, 'scores'),
      where('studentId', '==', studentId),
      where('subjectId', '==', subjectId),
      where('schoolId', '==', currentSchoolId),
      where('term', '==', term),
      where('session', '==', session)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      const docSnap = snap.docs[0];
      return { id: docSnap.id, ...docSnap.data() };
    }
    return null;
  } catch (err) {
    handleError(err, "Failed to fetch existing scores.");
    return null;
  }
}

async function saveAllScores(scoresData) {
  if (!isScoreEntryAllowed) throw new Error('subscription_inactive');
  if (scoresData.length === 0) return;
  const batch = writeBatch(db);
  for (const score of scoresData) {
    const existing = await fetchExistingScores(score.studentId, score.subjectId, selectedTerm, selectedSession);
    const scoreRef = existing ? doc(db, 'scores', existing.id) : doc(collection(db, 'scores'));
    const subjectName = subjectsMap.get(score.subjectId) || '';
    const data = {
      studentId: score.studentId,
      subjectId: score.subjectId,
      subjectName: subjectName,
      schoolId: currentSchoolId,
      term: selectedTerm,
      session: selectedSession,
      ca: score.ca,
      exam: score.exam,
      updatedAt: new Date()
    };
    if (!existing) data.createdAt = new Date();
    batch.set(scoreRef, data, { merge: true });
  }
  await batch.commit();
}

async function isSubscriptionActiveNow() {
  try {
    const subRef = doc(db, 'schools', currentSchoolId, 'subscription', 'current');
    const subSnap = await getDoc(subRef);
    if (!subSnap.exists()) return false;
    const sub = subSnap.data();
    const statusActive = String(sub.status).toLowerCase().trim() === 'active';
    const notLocked = sub.locked !== true;
    return statusActive && notLocked;
  } catch (err) {
    console.error("Error checking subscription:", err);
    return false;
  }
}

async function renderScoreTable() {
  const container = document.getElementById('scoresTableContainer');
  if (!container) return;
  if (!selectedClassId || !selectedSubjectId) {
    container.innerHTML = '<p>Select class and subject</p>';
    return;
  }

  await loadStudentsForClass(selectedClassId);
  if (studentsList.length === 0) {
    container.innerHTML = '<p>No students in this class</p>';
    return;
  }

  let html = `<table class="scores-table">
    <thead>
      <tr><th>Student Name</th><th>CA (${currentGrading.ca})</th><th>Exam (${currentGrading.exam})</th><th>Total</th><th>Status</th></tr>
    </thead>
    <tbody>`;
  for (const student of studentsList) {
    const existing = await fetchExistingScores(student.id, selectedSubjectId, selectedTerm, selectedSession);
    const ca = existing?.ca || '';
    const exam = existing?.exam || '';
    const total = (ca && exam) ? (parseInt(ca) + parseInt(exam)) : '';
    const isLocked = student.locked === true;
    const disabledAttr = (!isScoreEntryAllowed || isLocked) ? 'disabled' : '';
    const statusText = isLocked ? '🔒 Not Approved' : '✅ Approved';
    html += `<tr data-student-id="${student.id}" data-locked="${isLocked}" data-student-name="${escapeHtml(student.name)}">
      <td>${escapeHtml(student.name)}</td>
      <td><input type="number" class="ca-input" value="${ca}" min="0" max="${currentGrading.ca}" ${disabledAttr}></td>
      <td><input type="number" class="exam-input" value="${exam}" min="0" max="${currentGrading.exam}" ${disabledAttr}></td>
      <td class="total-cell">${total}</td>
      <td class="status-cell">${statusText}</td>
    </tr>`;
  }
  html += `</tbody>${'</tr>'}`;
  container.innerHTML = html;

  if (isScoreEntryAllowed) {
    document.querySelectorAll('.ca-input:not([disabled]), .exam-input:not([disabled])').forEach(input => {
      input.addEventListener('input', function() {
        const row = this.closest('tr');
        if (!row) return;
        const caInput = row.querySelector('.ca-input');
        const examInput = row.querySelector('.exam-input');
        const totalCell = row.querySelector('.total-cell');
        if (!caInput || !examInput || !totalCell) return;
        const ca = parseInt(caInput.value) || 0;
        const exam = parseInt(examInput.value) || 0;
        totalCell.textContent = ca + exam;
      });
    });
  }
}

async function saveScores() {
  const subscriptionActive = await isSubscriptionActiveNow();
  if (!subscriptionActive) {
    showNotification("❌ School subscription is inactive or expired. Cannot save scores. Please contact your school administrator to renew.", "error");
    return;
  }

  if (!isScoreEntryAllowed) {
    showNotification("Score entry is currently disabled. Please contact administrator.", "error");
    return;
  }

  if (!selectedClassId || !selectedSubjectId) {
    showNotification("Select class and subject first", "error");
    return;
  }

  if (teacherSubjectIds.length > 0 && !teacherSubjectIds.includes(selectedSubjectId)) {
    showNotification(`❌ You are not assigned to teach the subject "${subjectsMap.get(selectedSubjectId) || selectedSubjectId}".`, "error");
    return;
  }

  if (teacherClassIds.length > 0 && !teacherClassIds.includes(selectedClassId)) {
    showNotification(`❌ You are not assigned to teach the class "${classesMap.get(selectedClassId)?.name || selectedClassId}".`, "error");
    return;
  }

  const rows = document.querySelectorAll('#scoresTableContainer tbody tr');
  if (!rows.length) {
    showNotification("No students found. Please refresh the class list.", "error");
    return;
  }

  const unlockedScores = [];
  const lockedStudentNames = [];

  for (const row of rows) {
    const studentId = row.dataset.studentId;
    const studentName = row.dataset.studentName || row.querySelector('td:first-child')?.textContent || 'Unknown';
    const isLocked = row.dataset.locked === 'true';
    const caInput = row.querySelector('.ca-input');
    const examInput = row.querySelector('.exam-input');
    if (!caInput || !examInput) continue;
    const ca = parseInt(caInput.value) || 0;
    const exam = parseInt(examInput.value) || 0;

    if (ca > currentGrading.ca || exam > currentGrading.exam) {
      showNotification(`Invalid scores for ${studentName}. CA max = ${currentGrading.ca}, Exam max = ${currentGrading.exam}`, "error");
      return;
    }

    if (isLocked) {
      lockedStudentNames.push(studentName);
      continue;
    }

    unlockedScores.push({ studentId, subjectId: selectedSubjectId, ca, exam });
  }

  if (lockedStudentNames.length) {
    showNotification(`⚠️ Scores not saved for locked students: ${lockedStudentNames.join(', ')}`, "warning");
  }

  if (unlockedScores.length === 0) {
    showNotification("No scores were saved because all students are locked.", "info");
    return;
  }

  showLoader();
  try {
    await saveAllScores(unlockedScores);
    showNotification(`Scores saved successfully for ${unlockedScores.length} student(s).`, "success");
    await renderScoreTable();
  } catch (err) {
    console.error("Full error object:", err);
    if (err.code === 'permission-denied') {
      showNotification("❌ You don't have permission to save these scores. Make sure you are assigned to this subject and class, and that the students are approved (unlocked).", "error");
    } else if (err.message === 'subscription_inactive') {
      showNotification("❌ School subscription is inactive. Please renew to save scores.", "error");
    } else {
      handleError(err, "Failed to save scores.");
    }
  } finally {
    hideLoader();
  }
}

async function initScoresPage() {
  const user = auth.currentUser;
  if (!user) {
    showNotification("User not logged in. Please refresh.", "error");
    return;
  }
  teacherId = user.uid;

  teacherData = getTeacherData();
  if (!teacherData) {
    showNotification("Teacher data not found. Please contact admin.", "error");
    return;
  }
  currentSchoolId = teacherData.schoolId;
  if (!currentSchoolId) {
    showNotification("School ID missing.", "error");
    return;
  }

  isScoreEntryAllowed = await canEnterScores(currentSchoolId);

  await Promise.all([loadAllSubjects(), loadAllClasses()]);
  await loadTeacherAssignedSubjectsAndClasses();

  populateSubjectDropdown();
  populateClassDropdown();

  const academic = await getSchoolAcademicInfo();
  const defaultSession = academic?.currentSession || generateSessionOptions()[0];
  const defaultTerm = academic?.currentTerm || '1';

  const sessionSelect = document.getElementById('sessionSelect');
  const sessions = generateSessionOptions();
  if (sessionSelect) {
    sessionSelect.innerHTML = sessions.map(s => `<option value="${s}" ${s === defaultSession ? 'selected' : ''}>${s}</option>`).join('');
  }
  const termSelect = document.getElementById('termSelect');
  if (termSelect) termSelect.value = defaultTerm;

  // Initially set grading (may be overridden when class is selected)
  await loadGradingSetting(defaultSession, defaultTerm);

  const classSelect = document.getElementById('classSelect');
  const subjectSelect = document.getElementById('subjectSelect');
  if (classSelect) {
    classSelect.addEventListener('change', async () => {
      selectedClassId = classSelect.value;
      if (selectedClassId) {
        // Reload grading based on the class level
        await loadGradingSettingByClassLevel(selectedClassId, selectedSession, selectedTerm);
        // If subject is already selected, re‑render the table with new grading
        if (selectedSubjectId) await renderScoreTable();
        else renderScoreTable(); // shows "select subject" message
      } else {
        // No class selected – reset grading to default
        currentGrading = { ca: 40, exam: 60 };
        renderScoreTable();
      }
    });
  }
  if (subjectSelect) {
    subjectSelect.addEventListener('change', () => {
      selectedSubjectId = subjectSelect.value;
      renderScoreTable();
    });
  }
  if (sessionSelect) {
    sessionSelect.addEventListener('change', async () => {
      selectedSession = sessionSelect.value;
      if (selectedClassId) {
        await loadGradingSettingByClassLevel(selectedClassId, selectedSession, selectedTerm);
      } else {
        await loadGradingSetting(selectedSession, selectedTerm);
      }
      renderScoreTable();
    });
  }
  if (termSelect) {
    termSelect.addEventListener('change', async (e) => {
      selectedTerm = e.target.value;
      if (selectedClassId) {
        await loadGradingSettingByClassLevel(selectedClassId, selectedSession, selectedTerm);
      } else {
        await loadGradingSetting(selectedSession, selectedTerm);
      }
      renderScoreTable();
    });
  }

  const saveBtn = document.getElementById('saveScoresBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveScores);

  if (!isScoreEntryAllowed) {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.5';
      saveBtn.title = 'Subscription inactive – cannot save scores';
    }
    const container = document.getElementById('scoresContainer');
    if (container && !document.getElementById('subscriptionBanner')) {
      const banner = document.createElement('div');
      banner.id = 'subscriptionBanner';
      banner.className = 'subscription-banner';
      banner.innerHTML = `
        <strong>⚠️ Subscription Required</strong><br>
        Your school subscription is inactive. You cannot add or edit student scores. 
        Please contact your school administrator to renew.
      `;
      container.prepend(banner);
    }
  }

  selectedSession = defaultSession;
  selectedTerm = defaultTerm;
  // If a class is already selected (e.g., from previous load), apply its grading
  if (selectedClassId) {
    await loadGradingSettingByClassLevel(selectedClassId, selectedSession, selectedTerm);
  } else {
    await loadGradingSetting(defaultSession, defaultTerm);
  }
  renderScoreTable();
}

export { initScoresPage };