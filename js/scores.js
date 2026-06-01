// scores.js - Teacher score entry with direct Firestore subscription check
// FIXED: Duplicate scores – bypass cache for fetching existing scores and saving.
// All other operations (subjects, classes, students, grading) still use service.js.
// All user-facing errors now show clear, friendly messages without technical jargon.

import { auth } from './firebase-config.js';
import {
  collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { db } from './firebase-config.js';
import { getTeacherData } from './teacher-dashboard.js';
import { showNotification, handleError, showLoader, hideLoader, toast } from './error-handler.js';
import { initAcademicCalendar, getCurrentTerm, getCurrentSession } from './academic-calendar.js';
import { createBulkNotifications } from './notification-service.js';
import * as service from './service.js';

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

// ------------------- Direct subscription check (via service) -------------------
async function checkSubscription() {
  try {
    const subData = await service.getSubscription(currentSchoolId);
    isScoreEntryAllowed = subData ? (subData.status === 'active' && subData.locked !== true) : false;
    updateSubscriptionUI();
    return isScoreEntryAllowed;
  } catch (err) {
    console.error('Subscription check error:', err);
    toast.error('Unable to verify subscription status. Please refresh the page.');
    isScoreEntryAllowed = false;
    updateSubscriptionUI();
    return false;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

// ==================== Dynamic session loading via service ====================
async function loadSessionOptions(schoolId) {
  return await service.loadSessionOptions(schoolId);
}

// ------------------- Grading loading (using service) -------------------
async function loadGradingSettingByClassLevel(classId, session, term) {
  if (!classId) {
    currentGrading = { ca: 40, exam: 60 };
    return;
  }

  try {
    const classData = await service.getClassById(classId);
    if (!classData) {
      console.warn(`Class ${classId} not found, using default grading 40/60`);
      currentGrading = { ca: 40, exam: 60 };
      return;
    }
    const classLevel = classData.level;

    const scoringConfigs = await service.getScoringConfig(currentSchoolId, classLevel);
    let grading = null;
    if (scoringConfigs && scoringConfigs.length > 0) {
      const data = scoringConfigs[0];
      grading = data.grading || `${data.caWeight}/${data.examWeight}`;
    }

    if (!grading) {
      const fallbackConfigs = await service.getScoringConfig(currentSchoolId);
      if (fallbackConfigs && fallbackConfigs.length > 0) {
        const data = fallbackConfigs[0];
        grading = data.grading || `${data.caWeight}/${data.examWeight}`;
      }
    }

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
      toast.warning('Unable to load grading settings – using default values (CA=40, Exam=60).');
    }
  }
}

async function loadGradingSetting(session, term) {
  if (selectedClassId) {
    await loadGradingSettingByClassLevel(selectedClassId, session, term);
  } else {
    try {
      const docId = `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}`;
      const docSnap = await getDoc(doc(db, 'scoring', docId));
      let grading = '40/60';
      if (docSnap.exists()) grading = docSnap.data().grading;
      const [ca, exam] = grading.split('/').map(Number);
      currentGrading = { ca, exam };
    } catch (err) {
      console.error('Grading setting error:', err);
      currentGrading = { ca: 40, exam: 60 };
      toast.warning('Unable to load grading settings. Using default values.');
    }
  }
}

// ------------------- Data loading via service -------------------
async function loadAllSubjects() {
  try {
    const subjects = await service.getSubjectsBySchool(currentSchoolId);
    subjectsMap.clear();
    subjects.forEach(subj => subjectsMap.set(subj.id, subj.name));
  } catch (err) {
    console.error('Load subjects error:', err);
    toast.error('Unable to load subjects. Please refresh the page.');
  }
}

async function loadAllClasses() {
  try {
    const classes = await service.getClassesBySchool(currentSchoolId);
    classesMap.clear();
    classes.forEach(cls => {
      classesMap.set(cls.id, { name: cls.name, level: cls.level });
    });
  } catch (err) {
    console.error('Load classes error:', err);
    toast.error('Unable to load classes. Please refresh the page.');
  }
}

async function loadTeacherAssignedSubjectsAndClasses() {
  if (!teacherId) return;
  try {
    const teacher = await service.getTeacherById(teacherId);
    if (teacher) {
      teacherSubjectIds = teacher.subjectIds || [];
      teacherClassIds = teacher.classIds || [];
      console.log("Teacher assigned subjects:", teacherSubjectIds);
      console.log("Teacher assigned classes:", teacherClassIds);
    } else {
      console.warn("Teacher document not found for UID:", teacherId);
    }
  } catch (err) {
    console.error('Load teacher assignments error:', err);
    toast.warning('Unable to load teacher assignments. Please refresh the page.');
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
    const students = await service.getStudentsByClass(currentSchoolId, classId);
    studentsList = students.map(s => ({
      id: s.id,
      name: s.name,
      locked: s.locked === true
    }));
  } catch (err) {
    console.error('Load students for class error:', err);
    toast.error('Unable to load students for this class. Please refresh.');
    studentsList = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchExistingScores – direct Firestore query (bypass cache)
// ─────────────────────────────────────────────────────────────────────────────
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
    console.error('Fetch existing scores error:', err);
    toast.warning('Unable to load existing scores. Please refresh.');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// saveAllScores – use direct Firestore batch with proper existing ID lookup
// ─────────────────────────────────────────────────────────────────────────────
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

  // Invalidate scores cache so that any cached reads see the updated data
  service.invalidateScores();
}

// ------------------- UI control based on subscription -------------------
function updateSubscriptionUI() {
  const saveBtn = document.getElementById('saveScoresBtn');
  const container = document.getElementById('scoresContainer');
  const existingBanner = document.getElementById('subscriptionBanner');

  if (!isScoreEntryAllowed) {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.5';
      saveBtn.title = 'Subscription inactive – cannot save scores';
    }
    if (container && !existingBanner) {
      const banner = document.createElement('div');
      banner.id = 'subscriptionBanner';
      banner.className = 'subscription-banner';
      banner.style.cssText = 'background: #fee2e2; color: #991b1b; padding: 12px; margin-bottom: 16px; border-radius: 8px;';
      banner.innerHTML = `
        <strong>⚠️ Subscription Required</strong><br>
        Your school subscription is inactive. You cannot add or edit student scores. 
        Please contact your school administrator to renew.
      `;
      container.prepend(banner);
    }
    document.querySelectorAll('.ca-input, .exam-input').forEach(input => input.disabled = true);
  } else {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.style.opacity = '1';
      saveBtn.title = '';
    }
    if (existingBanner) existingBanner.remove();
    document.querySelectorAll('.ca-input, .exam-input').forEach(input => {
      const row = input.closest('tr');
      const isLocked = row?.dataset.locked === 'true';
      input.disabled = isLocked;
    });
  }
}

// ------------------- Score table rendering -------------------
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

  let tableHtml = `<table class="scores-table">
    <thead>
      <tr><th>Student Name</th><th>CA (${currentGrading.ca})</th><th>Exam (${currentGrading.exam})</th><th>Total</th><th>Status</th></tr>
    </thead>
    <tbody>`;
  for (const student of studentsList) {
    const existing = await fetchExistingScores(student.id, selectedSubjectId, selectedTerm, selectedSession);
    const ca = existing?.ca ?? '';
    const exam = existing?.exam ?? '';
    const total = (ca !== '' && exam !== '') ? (parseInt(ca) + parseInt(exam)) : '';
    const isLocked = student.locked === true;
    const disabledAttr = (!isScoreEntryAllowed || isLocked) ? 'disabled' : '';
    const statusText = isLocked ? '🔒 Not Approved' : '✅ Approved';
    tableHtml += `<tr data-student-id="${student.id}" data-locked="${isLocked}" data-student-name="${escapeHtml(student.name)}">
      <td>${escapeHtml(student.name)}</td>
      <td><input type="number" class="score-input ca-input" value="${ca}" min="0" max="${currentGrading.ca}" ${disabledAttr}></td>
      <td><input type="number" class="score-input exam-input" value="${exam}" min="0" max="${currentGrading.exam}" ${disabledAttr}></td>
      <td class="total-cell">${total}</td>
      <td class="status-cell">${statusText}</td>
    </tr>`;
  }
  tableHtml += `</tbody></table>`;
  
  const wrapperHtml = `<div class="table-responsive-wrapper">${tableHtml}</div>`;
  container.innerHTML = wrapperHtml;

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

// ------------------- Save scores -------------------
async function saveScores() {
  const active = await checkSubscription();
  if (!active) {
    toast.error('School subscription is inactive. Cannot save scores. Please contact your school administrator to renew.');
    return;
  }

  if (!selectedClassId || !selectedSubjectId) {
    toast.error('Please select a class and subject first.');
    return;
  }

  if (teacherSubjectIds.length > 0 && !teacherSubjectIds.includes(selectedSubjectId)) {
    toast.error(`You are not assigned to teach the subject "${subjectsMap.get(selectedSubjectId) || selectedSubjectId}".`);
    return;
  }

  if (teacherClassIds.length > 0 && !teacherClassIds.includes(selectedClassId)) {
    toast.error(`You are not assigned to teach the class "${classesMap.get(selectedClassId)?.name || selectedClassId}".`);
    return;
  }

  const rows = document.querySelectorAll('#scoresTableContainer tbody tr');
  if (!rows.length) {
    toast.error('No students found. Please refresh the class list.');
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
      toast.error(`Invalid scores for ${studentName}. CA max = ${currentGrading.ca}, Exam max = ${currentGrading.exam}`);
      return;
    }

    if (isLocked) {
      lockedStudentNames.push(studentName);
      continue;
    }

    unlockedScores.push({ studentId, subjectId: selectedSubjectId, ca, exam });
  }

  if (lockedStudentNames.length) {
    toast.warning(`Scores not saved for locked students: ${lockedStudentNames.join(', ')}`);
  }

  if (unlockedScores.length === 0) {
    toast.info('No scores were saved because all students are locked.');
    return;
  }

  showLoader();
  try {
    await saveAllScores(unlockedScores);
    if (unlockedScores.length > 0) {
      try {
        const subjectName = subjectsMap.get(selectedSubjectId) || '';
        const notifications = unlockedScores.map(score => ({
          studentId: score.studentId,
          schoolId: currentSchoolId,
          title: 'New Score Uploaded',
          message: `Your ${subjectName} score has been uploaded.`,
          type: 'score',
          relatedId: null
        }));
        await createBulkNotifications(notifications);
      } catch (notifErr) {
        console.error('Failed to create score notifications:', notifErr);
      }
    }
    toast.success(`Scores saved successfully for ${unlockedScores.length} student(s).`);
    await renderScoreTable();
  } catch (err) {
    console.error("Full error object:", err);
    if (err.code === 'permission-denied') {
      toast.error('Permission denied. Make sure you are assigned to this subject and class, and that the students are approved (unlocked).');
    } else if (err.message === 'subscription_inactive') {
      toast.error('School subscription is inactive. Please renew to save scores.');
    } else {
      toast.error('Failed to save scores. Please try again.');
    }
  } finally {
    hideLoader();
  }
}

// ------------------- Page initialisation -------------------
async function initScoresPage() {
  const user = auth.currentUser;
  if (!user) {
    toast.error('User not logged in. Please refresh the page.');
    return;
  }
  teacherId = user.uid;

  teacherData = getTeacherData();
  if (!teacherData) {
    toast.error('Teacher data not found. Please contact your administrator.');
    return;
  }
  currentSchoolId = teacherData.schoolId;
  if (!currentSchoolId) {
    toast.error('School ID missing. Please log out and log in again.');
    return;
  }

  await initAcademicCalendar();
  await checkSubscription();

  await Promise.all([loadAllSubjects(), loadAllClasses()]);
  await loadTeacherAssignedSubjectsAndClasses();

  populateSubjectDropdown();
  populateClassDropdown();

  const currentSession = getCurrentSession();
  const currentTermName = getCurrentTerm();
  const termMap = { 'First Term': '1', 'Second Term': '2', 'Third Term': '3' };
  const defaultTermNum = termMap[currentTermName] || '1';

  const distinctSessions = await loadSessionOptions(currentSchoolId);
  if (!distinctSessions.includes(currentSession)) {
    distinctSessions.unshift(currentSession);
  }

  const sessionSelect = document.getElementById('sessionSelect');
  if (sessionSelect) {
    sessionSelect.innerHTML = distinctSessions.map(s =>
      `<option value="${s}" ${s === currentSession ? 'selected' : ''}>${s}</option>`
    ).join('');
  }
  const termSelect = document.getElementById('termSelect');
  if (termSelect) termSelect.value = defaultTermNum;

  await loadGradingSetting(currentSession, defaultTermNum);

  const classSelect = document.getElementById('classSelect');
  const subjectSelect = document.getElementById('subjectSelect');
  if (classSelect) {
    classSelect.addEventListener('change', async () => {
      selectedClassId = classSelect.value;
      if (selectedClassId) {
        const currentSessionVal = document.getElementById('sessionSelect')?.value || currentSession;
        const currentTermVal = document.getElementById('termSelect')?.value || defaultTermNum;
        await loadGradingSettingByClassLevel(selectedClassId, currentSessionVal, currentTermVal);
        if (selectedSubjectId) await renderScoreTable();
      } else {
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
        const currentTermVal = document.getElementById('termSelect')?.value || defaultTermNum;
        await loadGradingSettingByClassLevel(selectedClassId, selectedSession, currentTermVal);
      } else {
        await loadGradingSetting(selectedSession, defaultTermNum);
      }
      renderScoreTable();
    });
  }
  if (termSelect) {
    termSelect.addEventListener('change', async (e) => {
      selectedTerm = e.target.value;
      if (selectedClassId) {
        const currentSessionVal = document.getElementById('sessionSelect')?.value || currentSession;
        await loadGradingSettingByClassLevel(selectedClassId, currentSessionVal, selectedTerm);
      } else {
        await loadGradingSetting(currentSession, selectedTerm);
      }
      renderScoreTable();
    });
  }

  const saveBtn = document.getElementById('saveScoresBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveScores);

  selectedSession = currentSession;
  selectedTerm = defaultTermNum;
  if (selectedClassId) {
    await loadGradingSettingByClassLevel(selectedClassId, selectedSession, selectedTerm);
  } else {
    await loadGradingSetting(selectedSession, selectedTerm);
  }
  renderScoreTable();
  updateSubscriptionUI();
}

export { initScoresPage };