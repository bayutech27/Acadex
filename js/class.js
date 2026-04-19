// class.js - Teacher report card page with subscription checks
import { db } from './firebase-config.js';
import {
  collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getTeacherData } from './teacher-dashboard.js';
import { renderReportCardUI } from './reportCardRenderer.js';
import { canEnterScores } from './plan.js';

let currentSchoolId = null;
let teacherData = null;
let classId = null;
let classNameCache = '';
let currentGrading = { ca: 40, exam: 60 };
let classesMap = new Map();
let subjectsMap = new Map();
let studentsList = [];
let allSubjectsList = [];
let isSubscriptionAllowed = false;   // NEW: subscription flag

const psychomotorSkillsList = ['Handling of tools', 'Public Speaking', 'Speech Fluency', 'Handwriting', 'Sport and Game', 'Drawing/Painting'];
const affectiveSkillsList = ['Attentiveness', 'Neatness', 'Honesty', 'Politeness', 'Punctuality', 'Self-control/Calmness', 'Obedience', 'Reliability', 'Relationship with others', 'Leadership'];

let reportState = {
  selectedStudent: null,
  term: '1',
  session: '',
  psychomotor: {},
  teacherComment: '',
  principalComment: '',
  savedReportId: null
};

// Initialize psychomotor with defaults
[...psychomotorSkillsList, ...affectiveSkillsList].forEach(skill => {
  const key = skill.toLowerCase().replace(/[^a-z]/g, '');
  reportState.psychomotor[key] = 3;
});

// ------------------- Helper Functions -------------------
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

function calculateGrade(total) {
  if (total >= 85) return 'A1';
  if (total >= 75) return 'B2';
  if (total >= 70) return 'B3';
  if (total >= 65) return 'C4';
  if (total >= 60) return 'C5';
  if (total >= 50) return 'C6';
  if (total >= 45) return 'D7';
  if (total >= 40) return 'E8';
  return 'F9';
}

function getGradeRemark(grade) {
  const remarks = { A1:'Excellent', B2:'Very Good', B3:'Good', C4:'Credit', C5:'Credit', C6:'Credit', D7:'Pass', E8:'Pass', F9:'Fail' };
  return remarks[grade] || '';
}

function getTermSuffix(t) {
  return t === '1' ? 'st' : t === '2' ? 'nd' : 'rd';
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

// ------------------- Data Loading -------------------
async function fetchClassName() {
  try {
    const classRef = doc(db, 'classes', classId);
    const classSnap = await getDoc(classRef);
    classNameCache = classSnap.exists() ? classSnap.data().name : classId;
  } catch(e) {
    classNameCache = classId;
  }
}

async function loadSubjectsAndClasses() {
  const subjSnap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId)));
  subjectsMap.clear();
  allSubjectsList = [];
  subjSnap.forEach(doc => {
    subjectsMap.set(doc.id, doc.data().name);
    allSubjectsList.push({ id: doc.id, name: doc.data().name });
  });
  const classSnap = await getDocs(query(collection(db, 'classes'), where('schoolId', '==', currentSchoolId)));
  classesMap.clear();
  classSnap.forEach(doc => classesMap.set(doc.id, doc.data().name));
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
  const snap = await getDocs(query(
    collection(db, 'scores'),
    where('studentId', '==', studentId),
    where('schoolId', '==', currentSchoolId),
    where('term', '==', term),
    where('session', '==', session)
  ));
  return snap.docs.map(doc => ({ subjectId: doc.data().subjectId, ca: doc.data().ca, exam: doc.data().exam }));
}

async function loadGradingSetting(session, term) {
  const docId = getScoringDocId(session, term);
  const docSnap = await getDoc(doc(db, 'scoring', docId));
  let grading = '40/60';
  if (docSnap.exists()) grading = docSnap.data().grading;
  const [ca, exam] = grading.split('/').map(Number);
  currentGrading = { ca, exam };
}

// ------------------- Subject Stats -------------------
async function computeSubjectStats(classId, term, session) {
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return new Map();
  const studentIds = classStudents.map(s => s.id);
  const allScores = [];
  for (let i = 0; i < studentIds.length; i += 30) {
    const chunk = studentIds.slice(i, i + 30);
    const q = query(
      collection(db, 'scores'),
      where('studentId', 'in', chunk),
      where('schoolId', '==', currentSchoolId),
      where('term', '==', term),
      where('session', '==', session)
    );
    const snap = await getDocs(q);
    snap.forEach(doc => allScores.push(doc.data()));
  }
  const subjectMap = new Map();
  for (const subjId of subjectsMap.keys()) {
    subjectMap.set(subjId, { totals: [], classAverage: 0, rankMap: new Map() });
  }
  for (const score of allScores) {
    const total = (score.ca || 0) + (score.exam || 0);
    const stat = subjectMap.get(score.subjectId);
    if (stat) stat.totals.push({ studentId: score.studentId, total });
  }
  for (const [subjId, stat] of subjectMap.entries()) {
    if (stat.totals.length) {
      stat.totals.sort((a,b) => b.total - a.total);
      const avg = stat.totals.reduce((s,t) => s + t.total, 0) / stat.totals.length;
      stat.classAverage = avg.toFixed(1);
      let rank = 1;
      for (let i=0; i<stat.totals.length; i++) {
        if (i>0 && stat.totals[i].total < stat.totals[i-1].total) rank = i+1;
        stat.rankMap.set(stat.totals[i].studentId, rank);
      }
    }
  }
  return subjectMap;
}

// ------------------- Report Card Helpers -------------------
async function loadExistingReport(studentId) {
  const q = query(
    collection(db, 'reports'),
    where('studentId', '==', studentId),
    where('schoolId', '==', currentSchoolId),
    where('term', '==', reportState.term),
    where('session', '==', reportState.session)
  );
  const snap = await getDocs(q);
  if (!snap.empty) {
    const data = snap.docs[0].data();
    if (data.psychomotor) Object.assign(reportState.psychomotor, data.psychomotor);
    reportState.teacherComment = data.teacherComment || '';
    reportState.principalComment = data.principalComment || '';
    reportState.savedReportId = snap.docs[0].id;
  } else {
    reportState.savedReportId = null;
  }
}

async function saveReportCard() {
  if (!isSubscriptionAllowed) {
    alert('Cannot save report – subscription inactive.');
    return;
  }
  if (!reportState.selectedStudent) return alert('Select a student.');

  const totalScore = parseInt(document.querySelector('.summary-table tr:nth-child(1) td')?.textContent) || 0;
  const totalObtainable = parseInt(document.querySelector('.summary-table tr:nth-child(2) td')?.textContent) || 0;
  const average = parseFloat(document.querySelector('.summary-table tr:nth-child(4) td')?.textContent) || 0;
  const overallGrade = document.querySelector('.summary-table tr:nth-child(5) td')?.textContent || 'N/A';

  const reportData = {
    studentId: reportState.selectedStudent.id,
    classId,
    schoolId: currentSchoolId,
    term: reportState.term,
    session: reportState.session,
    totalScore,
    maxTotal: totalObtainable,
    average,
    overallGrade,
    psychomotor: reportState.psychomotor,
    teacherComment: reportState.teacherComment,
    principalComment: reportState.principalComment,
    updatedAt: new Date()
  };
  try {
    if (reportState.savedReportId) {
      await updateDoc(doc(db, 'reports', reportState.savedReportId), reportData);
    } else {
      const newRef = await addDoc(collection(db, 'reports'), { ...reportData, createdAt: new Date() });
      reportState.savedReportId = newRef.id;
    }
    alert('Report saved.');
  } catch (err) {
    if (err.code === 'permission-denied') {
      alert('Permission denied. Subscription required to save reports.');
    } else {
      console.error(err);
      alert('Save failed.');
    }
  }
}

// ========== PRINT HANDLER (clone to new window) ==========
function printReportCard() {
  const teacherText = document.getElementById('teacherCommentText');
  const printTeacher = document.getElementById('printTeacherComment');
  if (teacherText && printTeacher) printTeacher.textContent = escapeHtml(teacherText.value);

  const principalText = document.getElementById('principalCommentText');
  const printPrincipal = document.getElementById('printPrincipalComment');
  if (principalText && printPrincipal) printPrincipal.textContent = escapeHtml(principalText.value);

  const reportContent = document.getElementById('reportCardContent');
  if (!reportContent || reportContent.children.length === 0) {
    alert('Report not ready.');
    return;
  }

  const clonedReport = reportContent.cloneNode(true);
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to print.');
    return;
  }

  const externalCssUrl = new URL('../css/styles.css', window.location.href).href;
  const inlineStyles = Array.from(document.querySelectorAll('style'))
    .map(style => style.innerHTML)
    .join('\n');

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Report Card - ${escapeHtml(reportState.selectedStudent?.name || 'Student')}</title>
      <link rel="stylesheet" href="${externalCssUrl}">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: white; margin: 0; padding: 0; display: flex; justify-content: center; font-family: 'Segoe UI', sans-serif; }
        .print-container { width: 210mm; margin: 0 auto; background: white; }
        @page { size: A4; margin: 10mm; }
        .rating-tick, select, textarea, button, .comment-controls, .tick { display: none !important; }
        .print-value, .print-comment-text { display: block !important; }
        .report-card { page-break-after: avoid; page-break-inside: avoid; overflow: visible; }
        ${inlineStyles}
      </style>
    </head>
    <body>
      <div class="print-container">${clonedReport.outerHTML}</div>
    </body>
    </html>
  `);
  printWindow.document.close();
  setTimeout(() => {
    printWindow.focus();
    printWindow.print();
  }, 300);
}

// ------------------- Load Report Card using shared renderer -------------------
async function loadReportCard(studentId, studentName) {
  // Block if subscription not active
  if (!isSubscriptionAllowed) {
    const container = document.getElementById('reportCardContent');
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; background: #fef3c7; border-radius: 8px; margin: 20px;">
        <h3>⚠️ Subscription Required</h3>
        <p>Report cards are unavailable because the school subscription is inactive.</p>
        <p>Please contact your administrator to renew.</p>
      </div>
    `;
    document.getElementById('reportActions').style.display = 'none';
    return;
  }

  reportState.selectedStudent = { id: studentId, name: studentName };
  reportState.term = document.getElementById('termSelect').value;
  reportState.session = document.getElementById('sessionSelect').value;

  const schoolDoc = await getDoc(doc(db, 'schools', currentSchoolId));
  const school = {
    name: schoolDoc.exists() ? schoolDoc.data().name : 'School Name',
    address: schoolDoc.exists() ? schoolDoc.data().address : '',
    logo: schoolDoc.exists() ? schoolDoc.data().logo : null
  };
  const student = studentsList.find(s => s.id === studentId) || {};
  const rawScores = await fetchScores(studentId, reportState.term, reportState.session);
  const scoresWithNames = rawScores.map(score => ({
    subjectId: score.subjectId,
    subjectName: subjectsMap.get(score.subjectId) || score.subjectId,
    ca: score.ca,
    exam: score.exam
  }));

  const subjectStats = await computeSubjectStats(classId, reportState.term, reportState.session);
  await loadExistingReport(studentId);

  const studentData = {
    id: studentId,
    name: studentName,
    admissionNumber: student.admissionNumber || '—',
    gender: student.gender || '—',
    dob: student.dob || '',
    club: student.club || '—',
    passport: student.passport || null
  };

  renderReportCardUI({
    student: studentData,
    scores: scoresWithNames,
    className: classNameCache,
    school,
    grading: currentGrading,
    psychomotor: reportState.psychomotor,
    comments: { teacherComment: reportState.teacherComment, principalComment: reportState.principalComment },
    term: reportState.term,
    session: reportState.session,
    subjectStats,
    container: document.getElementById('reportCardContent'),
    onRatingChange: (skillKey, newValue) => {
      reportState.psychomotor[skillKey] = newValue;
    },
    onTeacherCommentChange: (newComment) => {
      reportState.teacherComment = newComment;
    },
    onPrincipalCommentChange: (newComment) => {
      reportState.principalComment = newComment;
    }
  });

  document.getElementById('reportActions').style.display = 'flex';
}

async function loadClassStudents() {
  reportState.term = document.getElementById('termSelect').value;
  reportState.session = document.getElementById('sessionSelect').value;
  await loadGradingSetting(reportState.session, reportState.term);
  const classStudents = studentsList.filter(s => s.classId === classId);
  const container = document.getElementById('studentListContainer');
  if (!classStudents.length) {
    container.innerHTML = '<p>No students</p>';
    return;
  }
  let html = '';
  classStudents.forEach(s => {
    html += `<div class="student-list-item" data-id="${s.id}">${escapeHtml(s.name)}</div>`;
  });
  container.innerHTML = html;
  document.querySelectorAll('.student-list-item').forEach(el => {
    el.addEventListener('click', async () => {
      document.querySelectorAll('.student-list-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      await loadReportCard(el.dataset.id, el.textContent);
    });
  });
}

// ------------------- Initialisation -------------------
export async function initClassReportPage() {
  teacherData = getTeacherData();
  if (!teacherData) return;
  classId = teacherData.hostClassId || teacherData.classTeacherId;
  if (!classId) {
    alert('Not a class teacher.');
    window.location.href = 'teacher-dashboard.html';
    return;
  }
  currentSchoolId = teacherData.schoolId || localStorage.getItem('userSchoolId');
  if (!currentSchoolId) {
    alert('School ID missing.');
    return;
  }

  // Check subscription status
  isSubscriptionAllowed = await canEnterScores(currentSchoolId);

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

  // Event listeners
  document.getElementById('termSelect').addEventListener('change', () => loadClassStudents());
  document.getElementById('sessionSelect').addEventListener('change', () => loadClassStudents());
  document.getElementById('refreshStudentsBtn')?.addEventListener('click', () => loadClassStudents());
  document.getElementById('saveReportBtn')?.addEventListener('click', saveReportCard);
  const printBtn = document.getElementById('printReportBtn');
  if (printBtn) printBtn.addEventListener('click', printReportCard);

  // Disable features if subscription not active
  if (!isSubscriptionAllowed) {
    const saveBtn = document.getElementById('saveReportBtn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.5';
    }
    if (printBtn) {
      printBtn.disabled = true;
      printBtn.style.opacity = '0.5';
    }
    const warningDiv = document.createElement('div');
    warningDiv.className = 'subscription-warning';
    warningDiv.style.cssText = 'background: #fee2e2; color: #991b1b; padding: 12px; margin-bottom: 16px; border-radius: 8px;';
    warningDiv.innerHTML = '⚠️ Subscription inactive. Report card editing and printing are disabled. Please contact your administrator to renew.';
    const container = document.querySelector('.report-card-area');
    if (container) container.prepend(warningDiv);
  }
}