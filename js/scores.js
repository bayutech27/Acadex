// scores.js - Teacher score entry with subscription check and locked student restrictions
import { db } from './firebase-config.js';
import {
  collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getTeacherData } from './teacher-dashboard.js';
import { canEnterScores } from './plan.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

let currentSchoolId = null;
let teacherData = null;
let subjectsMap = new Map();
let classesMap = new Map();
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

async function loadGradingSetting(session, term) {
  try {
    const docId = getScoringDocId(session, term);
    const docSnap = await getDoc(doc(db, 'scoring', docId));
    let grading = '40/60';
    if (docSnap.exists()) grading = docSnap.data().grading;
    const [ca, exam] = grading.split('/').map(Number);
    currentGrading = { ca, exam };
  } catch (err) {
    handleError(err, "Failed to load grading settings.");
    currentGrading = { ca: 40, exam: 60 };
  }
}

async function loadSubjects() {
  try {
    const snap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId)));
    subjectsMap.clear();
    snap.forEach(doc => subjectsMap.set(doc.id, doc.data().name));
  } catch (err) {
    handleError(err, "Failed to load subjects.");
  }
}

async function loadClasses() {
  try {
    const snap = await getDocs(query(collection(db, 'classes'), where('schoolId', '==', currentSchoolId)));
    classesMap.clear();
    snap.forEach(doc => classesMap.set(doc.id, doc.data().name));
  } catch (err) {
    handleError(err, "Failed to load classes.");
  }
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
    if (!snap.empty) return snap.docs[0].data();
    return null;
  } catch (err) {
    handleError(err, "Failed to fetch existing scores.");
    return null;
  }
}

async function saveAllScores(scoresData) {
  if (!isScoreEntryAllowed) {
    throw new Error('subscription_inactive');
  }
  const batch = writeBatch(db);
  for (const score of scoresData) {
    const existing = await fetchExistingScores(score.studentId, score.subjectId, selectedTerm, selectedSession);
    const scoreRef = existing ? doc(db, 'scores', existing.id) : doc(collection(db, 'scores'));
    const data = {
      studentId: score.studentId,
      subjectId: score.subjectId,
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
    html += `<tr data-student-id="${student.id}" data-locked="${isLocked}">
      <td>${escapeHtml(student.name)}</td>
      <td><input type="number" class="ca-input" value="${ca}" min="0" max="${currentGrading.ca}" ${disabledAttr}></td>
      <td><input type="number" class="exam-input" value="${exam}" min="0" max="${currentGrading.exam}" ${disabledAttr}></td>
      <td class="total-cell">${total}</td>
      <td class="status-cell">${statusText}</td>
    </table>`;
  }
  html += `</tbody></table>`;
  container.innerHTML = html;

  if (isScoreEntryAllowed) {
    document.querySelectorAll('.ca-input:not([disabled]), .exam-input:not([disabled])').forEach(input => {
      input.addEventListener('input', function() {
        const row = this.closest('tr');
        const ca = parseInt(row.querySelector('.ca-input').value) || 0;
        const exam = parseInt(row.querySelector('.exam-input').value) || 0;
        const totalCell = row.querySelector('.total-cell');
        totalCell.textContent = ca + exam;
      });
    });
  }
}

async function saveScores() {
  if (!isScoreEntryAllowed) {
    showNotification("❌ Score entry is disabled because the school subscription is inactive. Please contact your administrator to renew.", "error");
    return;
  }
  if (!selectedClassId || !selectedSubjectId) {
    showNotification("Select class and subject first", "error");
    return;
  }

  const rows = document.querySelectorAll('#scoresTableContainer tbody tr');
  const scoresData = [];
  const lockedStudents = [];

  for (const row of rows) {
    const studentId = row.dataset.studentId;
    const isLocked = row.dataset.locked === 'true';
    const ca = parseInt(row.querySelector('.ca-input').value) || 0;
    const exam = parseInt(row.querySelector('.exam-input').value) || 0;

    if (isLocked) {
      const studentName = row.querySelector('td:first-child').textContent;
      lockedStudents.push(studentName);
      continue;
    }

    if (ca > currentGrading.ca || exam > currentGrading.exam) {
      showNotification(`Invalid scores for ${row.querySelector('td:first-child').textContent}. CA max = ${currentGrading.ca}, Exam max = ${currentGrading.exam}`, "error");
      return;
    }
    scoresData.push({ studentId, subjectId: selectedSubjectId, ca, exam });
  }

  if (lockedStudents.length > 0) {
    showNotification(`Cannot save scores for the following students because they are not approved:\n${lockedStudents.join('\n')}\n\nPlease contact your school administrator to unlock these students.`, "error");
    return;
  }

  if (scoresData.length === 0) {
    showNotification("No score changes to save.", "info");
    return;
  }

  showLoader();
  try {
    await saveAllScores(scoresData);
    showNotification("Scores saved successfully", "success");
  } catch (err) {
    if (err.message === 'subscription_inactive' || err.code === 'permission-denied') {
      showNotification("❌ Permission denied. School subscription is inactive. Please renew to save scores.", "error");
    } else {
      handleError(err, "Failed to save scores.");
    }
  } finally {
    hideLoader();
  }
}

async function initScoresPage() {
  teacherData = getTeacherData();
  if (!teacherData) return;
  currentSchoolId = teacherData.schoolId;
  if (!currentSchoolId) return;

  isScoreEntryAllowed = await canEnterScores(currentSchoolId);

  await Promise.all([loadSubjects(), loadClasses()]);

  const academic = await getSchoolAcademicInfo();
  const defaultSession = academic?.currentSession || generateSessionOptions()[0];
  const defaultTerm = academic?.currentTerm || '1';

  // Populate class dropdown
  const classSelect = document.getElementById('classSelect');
  if (classSelect) {
    let teacherClasses = teacherData.classes || [];
    if (!teacherClasses.length) {
      teacherClasses = Array.from(classesMap.keys());
    }
    classSelect.innerHTML = '<option value="">Select Class</option>';
    for (const clsId of teacherClasses) {
      const className = classesMap.get(clsId) || clsId;
      classSelect.innerHTML += `<option value="${clsId}">${escapeHtml(className)}</option>`;
    }
  }

  // Populate subject dropdown - use teacher's assigned subjects if available, otherwise all subjects
  const subjectSelect = document.getElementById('subjectSelect');
  if (subjectSelect) {
    let teacherSubjects = teacherData.subjects || [];
    if (!teacherSubjects.length) {
      teacherSubjects = Array.from(subjectsMap.keys());
    }
    subjectSelect.innerHTML = '<option value="">Select Subject</option>';
    for (const subjId of teacherSubjects) {
      const subjName = subjectsMap.get(subjId) || subjId;
      subjectSelect.innerHTML += `<option value="${subjId}">${escapeHtml(subjName)}</option>`;
    }
  }

  const sessionSelect = document.getElementById('sessionSelect');
  const sessions = generateSessionOptions();
  if (sessionSelect) {
    sessionSelect.innerHTML = sessions.map(s => `<option value="${s}" ${s === defaultSession ? 'selected' : ''}>${s}</option>`).join('');
  }
  const termSelect = document.getElementById('termSelect');
  if (termSelect) termSelect.value = defaultTerm;

  await loadGradingSetting(defaultSession, defaultTerm);

  if (classSelect) {
    classSelect.addEventListener('change', () => {
      selectedClassId = classSelect.value;
      renderScoreTable();
    });
  }
  if (subjectSelect) {
    subjectSelect.addEventListener('change', () => {
      selectedSubjectId = subjectSelect.value;
      renderScoreTable();
    });
  }
  if (sessionSelect) {
    sessionSelect.addEventListener('change', () => {
      selectedSession = sessionSelect.value;
      loadGradingSetting(selectedSession, selectedTerm);
      renderScoreTable();
    });
  }
  if (termSelect) {
    termSelect.addEventListener('change', (e) => {
      selectedTerm = e.target.value;
      loadGradingSetting(selectedSession, selectedTerm);
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
  await loadGradingSetting(defaultSession, defaultTerm);
  renderScoreTable();
}

export { initScoresPage };