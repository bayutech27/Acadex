// class.js - Teacher report card with academic calendar defaults
import { db } from './firebase-config.js';
import { collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getTeacherData } from './teacher-dashboard.js';

let currentSchoolId = null, teacherData = null, classId = null, classNameCache = '';
let currentGrading = { ca: 40, exam: 60 };
let classesMap = new Map();
let subjectsMap = new Map();
let studentsList = [];

const psychomotorSkillsList = ['Handling of tools', 'Public Speaking', 'Speech Fluency', 'Handwriting', 'Sport and Game', 'Drawing/Painting'];
const affectiveSkillsList = ['Attentiveness', 'Neatness', 'Honesty', 'Politeness', 'Punctuality', 'Self-control/Calmness', 'Obedience', 'Reliability', 'Relationship with others', 'Leadership'];

let reportState = { selectedStudent: null, term: '1', session: '', psychomotor: {}, teacherComment: '', principalComment: '', savedReportId: null };
[...psychomotorSkillsList, ...affectiveSkillsList].forEach(skill => { const key = skill.toLowerCase().replace(/[^a-z]/g, ''); reportState.psychomotor[key] = 3; });

// ------------------- Helper Functions -------------------
function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'); }
function calculateGrade(total) {
  if (total >= 85) return 'A1'; if (total >= 75) return 'B2'; if (total >= 70) return 'B3';
  if (total >= 65) return 'C4'; if (total >= 60) return 'C5'; if (total >= 50) return 'C6';
  if (total >= 45) return 'D7'; if (total >= 40) return 'E8'; return 'F9';
}
function getGradeRemark(grade) { const remarks = { A1:'Excellent', B2:'Very Good', B3:'Good', C4:'Credit', C5:'Credit', C6:'Credit', D7:'Pass', E8:'Pass', F9:'Fail' }; return remarks[grade] || ''; }
function getTermSuffix(t) { return t === '1' ? 'st' : t === '2' ? 'nd' : 'rd'; }
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

// ------------------- Data Loading -------------------
async function fetchClassName() {
  try { const classRef = doc(db, 'classes', classId); const classSnap = await getDoc(classRef); classNameCache = classSnap.exists() ? classSnap.data().name : classId; } catch(e) { classNameCache = classId; }
}
async function loadSubjectsAndClasses() {
  const subjSnap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId)));
  subjectsMap.clear(); subjSnap.forEach(doc => subjectsMap.set(doc.id, doc.data().name));
  const classSnap = await getDocs(query(collection(db, 'classes'), where('schoolId', '==', currentSchoolId)));
  classesMap.clear(); classSnap.forEach(doc => classesMap.set(doc.id, doc.data().name));
}
async function loadStudentsList() {
  const snap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', currentSchoolId)));
  studentsList = snap.docs.map(doc => ({
    id: doc.id, name: doc.data().name, classId: doc.data().classId,
    admissionNumber: doc.data().admissionNumber, gender: doc.data().gender,
    dob: doc.data().dob, club: doc.data().club, passport: doc.data().passport || null
  }));
}
async function fetchScores(studentId, term, session) {
  const snap = await getDocs(query(collection(db, 'scores'), where('studentId', '==', studentId), where('schoolId', '==', currentSchoolId), where('term', '==', term), where('session', '==', session)));
  return snap.docs.map(doc => ({ subjectId: doc.data().subjectId, ca: doc.data().ca, exam: doc.data().exam }));
}
async function loadGradingSetting(session, term) {
  const docId = `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}`;
  const docSnap = await getDoc(doc(db, 'scoring', docId));
  let grading = '40/60';
  if (docSnap.exists()) grading = docSnap.data().grading;
  const [ca, exam] = grading.split('/').map(Number);
  currentGrading = { ca, exam };
}

// ------------------- Subject Stats & Report Rendering (same as original) -------------------
async function computeSubjectStats(classId, term, session) { /* ... full original ... */ }
function getGradeScaleHtml() { /* ... original ... */ }
function createTickRating(skillKey, currentValue) { /* ... original ... */ }
function calculateAge(dob) { /* ... original ... */ }
function getCommentOptionsByGrade(grade) { /* ... original ... */ }
async function loadExistingReport(studentId) { /* ... original ... */ }
async function saveReportCard() { /* ... original ... */ }
async function loadReportCard(studentId, studentName) { /* ... original ... */ }

// ------------------- Load Class Students & Init -------------------
async function loadClassStudents() {
  reportState.term = document.getElementById('termSelect').value;
  reportState.session = document.getElementById('sessionSelect').value;
  await loadGradingSetting(reportState.session, reportState.term);
  const classStudents = studentsList.filter(s => s.classId === classId);
  const container = document.getElementById('studentListContainer');
  if (!classStudents.length) { container.innerHTML = '<p>No students</p>'; return; }
  let html = '';
  classStudents.forEach(s => { html += `<div class="student-list-item" data-id="${s.id}">${escapeHtml(s.name)}</div>`; });
  container.innerHTML = html;
  document.querySelectorAll('.student-list-item').forEach(el => {
    el.addEventListener('click', async () => {
      document.querySelectorAll('.student-list-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      await loadReportCard(el.dataset.id, el.textContent);
    });
  });
}

export async function initClassReportPage() {
  teacherData = getTeacherData();
  if (!teacherData) return;
  classId = teacherData.hostClassId || teacherData.classTeacherId;
  if (!classId) { alert('Not a class teacher.'); window.location.href = 'teacher-dashboard.html'; return; }
  currentSchoolId = teacherData.schoolId || localStorage.getItem('userSchoolId');
  if (!currentSchoolId) { alert('School ID missing.'); return; }
  
  await fetchClassName();
  await loadSubjectsAndClasses();
  await loadStudentsList();
  
  const academic = await getSchoolAcademicInfo();
  const defaultSession = academic?.currentSession || generateSessionOptions()[0];
  const defaultTerm = academic?.currentTerm || '1';
  
  const sessionSelect = document.getElementById('sessionSelect');
  sessionSelect.innerHTML = generateSessionOptions().map(s => `<option value="${s}" ${s === defaultSession ? 'selected' : ''}>${s}</option>`).join('');
  document.getElementById('termSelect').value = defaultTerm;
  
  await loadGradingSetting(defaultSession, defaultTerm);
  await loadClassStudents();
  
  document.getElementById('termSelect').addEventListener('change', () => loadClassStudents());
  document.getElementById('sessionSelect').addEventListener('change', () => loadClassStudents());
  document.getElementById('refreshStudentsBtn')?.addEventListener('click', () => loadClassStudents());
  document.getElementById('saveReportBtn')?.addEventListener('click', saveReportCard);
}