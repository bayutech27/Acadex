// scores.js - Teacher score entry with subscription check and UI blocking
import { db } from './firebase-config.js';
import {
  collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getTeacherData } from './teacher-dashboard.js';
import { canEnterScores } from './plan.js';

let currentSchoolId = null;
let teacherData = null;
let subjectsMap = new Map();
let studentsList = [];
let selectedClassId = null;
let selectedSubjectId = null;
let selectedTerm = '1';
let selectedSession = '';
let currentGrading = { ca: 40, exam: 60 };
let isScoreEntryAllowed = false;

// ------------------- Helper Functions -------------------
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
  const snap = await getDoc(doc(db, 'schools', currentSchoolId));
  if (snap.exists()) return { currentSession: snap.data().currentSession, currentTerm: snap.data().currentTerm };
  return null;
}

function getScoringDocId(session, term) {
  return `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}`;
}

async function loadGradingSetting(session, term) {
  const docId = getScoringDocId(session, term);
  const docSnap = await getDoc(doc(db, 'scoring', docId));
  let grading = '40/60';
  if (docSnap.exists()) grading = docSnap.data().grading;
  const [ca, exam] = grading.split('/').map(Number);
  currentGrading = { ca, exam };
}

async function loadSubjects() {
  const snap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId)));
  subjectsMap.clear();
  snap.forEach(doc => subjectsMap.set(doc.id, doc.data().name));
}

async function loadStudentsForClass(classId) {
  const snap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', currentSchoolId), where('classId', '==', classId)));
  studentsList = snap.docs.map(doc => ({ id: doc.id, name: doc.data().name }));
}

async function fetchExistingScores(studentId, subjectId, term, session) {
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
      <tr><th>Student Name</th><th>CA (${currentGrading.ca})</th><th>Exam (${currentGrading.exam})</th><th>Total</th></tr>
    </thead>
    <tbody>`;
  for (const student of studentsList) {
    const existing = await fetchExistingScores(student.id, selectedSubjectId, selectedTerm, selectedSession);
    const ca = existing?.ca || '';
    const exam = existing?.exam || '';
    const total = (ca && exam) ? (parseInt(ca) + parseInt(exam)) : '';
    html += `<tr data-student-id="${student.id}">
      <td>${escapeHtml(student.name)}</td>
      <td><input type="number" class="ca-input" value="${ca}" min="0" max="${currentGrading.ca}" ${!isScoreEntryAllowed ? 'disabled' : ''}></td>
      <td><input type="number" class="exam-input" value="${exam}" min="0" max="${currentGrading.exam}" ${!isScoreEntryAllowed ? 'disabled' : ''}></td>
      <td class="total-cell">${total}</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  container.innerHTML = html;

  if (isScoreEntryAllowed) {
    document.querySelectorAll('.ca-input, .exam-input').forEach(input => {
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
    alert('❌ Score entry is disabled because the school subscription is inactive. Please contact your administrator to renew.');
    return;
  }
  if (!selectedClassId || !selectedSubjectId) {
    alert('Select class and subject first');
    return;
  }
  const scoresData = [];
  const rows = document.querySelectorAll('#scoresTableContainer tbody tr');
  for (const row of rows) {
    const studentId = row.dataset.studentId;
    const ca = parseInt(row.querySelector('.ca-input').value) || 0;
    const exam = parseInt(row.querySelector('.exam-input').value) || 0;
    if (ca > currentGrading.ca || exam > currentGrading.exam) {
      alert(`Invalid scores for ${row.querySelector('td:first-child').textContent}. CA max = ${currentGrading.ca}, Exam max = ${currentGrading.exam}`);
      return;
    }
    scoresData.push({ studentId, subjectId: selectedSubjectId, ca, exam });
  }
  try {
    await saveAllScores(scoresData);
    alert('Scores saved successfully');
  } catch (err) {
    if (err.message === 'subscription_inactive' || err.code === 'permission-denied') {
      alert('❌ Permission denied. School subscription is inactive. Please renew to save scores.');
    } else {
      console.error(err);
      alert('Failed to save scores. Check console.');
    }
  }
}

async function initScoresPage() {
  teacherData = getTeacherData();
  if (!teacherData) return;
  currentSchoolId = teacherData.schoolId;
  if (!currentSchoolId) return;

  // Check subscription status
  isScoreEntryAllowed = await canEnterScores(currentSchoolId);

  await loadSubjects();
  const academic = await getSchoolAcademicInfo();
  const defaultSession = academic?.currentSession || generateSessionOptions()[0];
  const defaultTerm = academic?.currentTerm || '1';

  // Populate class dropdown (from teacher's assigned classes)
  const classSelect = document.getElementById('classSelect');
  const teacherClasses = teacherData.classes || [];
  classSelect.innerHTML = '<option value="">Select Class</option>';
  for (const clsId of teacherClasses) {
    const classDoc = await getDoc(doc(db, 'classes', clsId));
    const className = classDoc.exists() ? classDoc.data().name : clsId;
    classSelect.innerHTML += `<option value="${clsId}">${escapeHtml(className)}</option>`;
  }

  const subjectSelect = document.getElementById('subjectSelect');
  const teacherSubjects = teacherData.subjects || [];
  subjectSelect.innerHTML = '<option value="">Select Subject</option>';
  teacherSubjects.forEach(subjId => {
    const subjName = subjectsMap.get(subjId) || subjId;
    subjectSelect.innerHTML += `<option value="${subjId}">${escapeHtml(subjName)}</option>`;
  });

  const sessionSelect = document.getElementById('sessionSelect');
  const sessions = generateSessionOptions();
  sessionSelect.innerHTML = sessions.map(s => `<option value="${s}" ${s === defaultSession ? 'selected' : ''}>${s}</option>`).join('');
  document.getElementById('termSelect').value = defaultTerm;

  await loadGradingSetting(defaultSession, defaultTerm);

  classSelect.addEventListener('change', () => {
    selectedClassId = classSelect.value;
    renderScoreTable();
  });
  subjectSelect.addEventListener('change', () => {
    selectedSubjectId = subjectSelect.value;
    renderScoreTable();
  });
  sessionSelect.addEventListener('change', () => {
    selectedSession = sessionSelect.value;
    loadGradingSetting(selectedSession, selectedTerm);
    renderScoreTable();
  });
  document.getElementById('termSelect').addEventListener('change', (e) => {
    selectedTerm = e.target.value;
    loadGradingSetting(selectedSession, selectedTerm);
    renderScoreTable();
  });
  document.getElementById('saveScoresBtn').addEventListener('click', saveScores);

  // If subscription inactive, show a persistent banner and disable save button
  if (!isScoreEntryAllowed) {
    const saveBtn = document.getElementById('saveScoresBtn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.5';
      saveBtn.title = 'Subscription inactive – cannot save scores';
    }
    // Add banner at the top of the scores container
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