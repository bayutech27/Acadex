// results.js - Admin report card page using shared renderer + subscription check
import { db } from './firebase-config.js';
import { collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, setDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId, getAcademicContext, initAcademicCalendar } from './admin.js';
import { renderReportCardUI } from './reportCardRenderer.js';
import { canEnterScores } from './plan.js';

// ------------------- Global State -------------------
let currentSchoolId = null;
let classesMap = new Map();
let studentsList = [];
let subjectsMap = new Map();
let allSubjectsList = [];
let currentGrading = { ca: 40, exam: 60 };
let isSubscriptionAllowed = false;

let editorState = {
  selectedStudent: null,
  term: '1',
  session: '',
  psychomotor: {},
  teacherComment: '',
  principalComment: '',
  savedReportId: null
};

const psychomotorSkillsList = ['Handling of tools', 'Public Speaking', 'Speech Fluency', 'Handwriting', 'Sport and Game', 'Drawing/Painting'];
const affectiveSkillsList = ['Attentiveness', 'Neatness', 'Honesty', 'Politeness', 'Punctuality', 'Self-control/Calmness', 'Obedience', 'Reliability', 'Relationship with others', 'Leadership'];

// ------------------- Utility Functions (fully preserved) -------------------
function getSkillKey(skill) { return skill.toLowerCase().replace(/[^a-z]/g, ''); }
function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'); }
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
function getDefaultRatings() {
  const defaults = {};
  [...psychomotorSkillsList, ...affectiveSkillsList].forEach(skill => { defaults[getSkillKey(skill)] = 3; });
  return defaults;
}
function resetRatingsToDefaults() { editorState.psychomotor = getDefaultRatings(); }
function getTermSuffix(term) { return term === '1' ? 'st' : term === '2' ? 'nd' : 'rd'; }
function calculateAge(dobString) {
  if (!dobString) return null;
  const birthDate = new Date(dobString);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
  return age;
}
function getCommentOptionsByGrade(grade) {
  const generalComments = [
    'Keep up the great work!', 'Your effort is commendable.', 'Consistent practice will yield even better results.',
    'You have shown improvement this term.', 'Stay focused and keep pushing forward.', 'Your positive attitude is appreciated.',
    'Continue to participate actively in class.', 'You are capable of achieving even more.', 'Great teamwork and collaboration skills.',
    'Your curiosity and willingness to learn are assets.'
  ];
  const gradeSpecific = {
    'A1': ['Excellent performance! Keep setting high standards.', 'Outstanding achievement across all subjects.', 'Your dedication is truly exceptional.', 'You are a role model for your peers.', 'Maintain this brilliant performance.', 'Your hard work has paid off remarkably.'],
    'B2': ['Very good performance. Aim for excellence next term.', 'You are doing well; a little more effort can push you to the top.', 'Consistent good work – keep it up!', 'You have strong understanding of the subjects.', 'Well done! Strive for even greater heights.'],
    'B3': ['Good performance. Continue to build on this foundation.', 'You have the potential to move up to a higher grade.', 'Keep working hard; you are on the right track.', 'Good understanding, but aim for deeper mastery.', 'Solid performance. Stay motivated.'],
    'C4': ['Credit level performance. Focus on areas needing improvement.', 'You are capable of better results with more revision.', 'Good effort, but consistency is key to moving up.', 'Identify weak topics and work on them diligently.', 'Keep practicing; you are making steady progress.'],
    'C5': ['Credit level. More attention to detail will help.', 'You have the ability; apply yourself more consistently.', 'Work on completing assignments on time.', 'Seek help when you find topics challenging.', 'Your effort is noted; increase revision time.'],
    'C6': ['Credit performance. A little more push will yield better grades.', 'You are capable of higher scores with extra practice.', 'Avoid distractions and stay focused on your studies.', 'Consistent hard work is needed to improve.', 'You can do better; believe in yourself.'],
    'D7': ['Pass grade. Significant improvement is required.', 'You need to dedicate more time to your studies.', 'Attend extra lessons if possible to catch up.', 'Do not be discouraged; work harder next term.', 'Focus on building your foundational knowledge.'],
    'E8': ['Pass, but serious effort is needed to progress.', 'You must prioritize your academic work.', 'Seek assistance from teachers and peers.', 'There is room for major improvement.', 'Commit to a regular study schedule.'],
    'F9': ['Fail grade. Urgent attention and effort are required.', 'This is a wake-up call to change your approach.', 'You need to attend remedial classes.', 'Do not give up; you can turn this around with hard work.', 'Please meet with your teacher for a study plan.']
  };
  const gradeComments = gradeSpecific[grade] || ['Keep working hard.', 'Your effort matters.', 'Stay positive and persistent.'];
  let allComments = [...generalComments, ...gradeComments];
  const extraComments = [
    'Your participation in class discussions is valued.', 'You have shown growth in problem-solving skills.', 'Excellent punctuality and attendance.',
    'You are a pleasure to have in class.', 'Continue to ask questions when in doubt.', 'Your homework assignments are improving.',
    'You have a bright future ahead.', 'Remember that learning is a journey.', 'Celebrate your small victories.', 'Stay curious and never stop learning.'
  ];
  while (allComments.length < 30) allComments.push(extraComments[allComments.length % extraComments.length]);
  return [...new Set(allComments)];
}
function getGradeScaleHtml() {
  const scale = [['A1','85-100','Excellent'],['B2','75-84.9','Very Good'],['B3','70-74.9','Good'],['C4','65-69.9','Credit'],['C5','60-64.9','Credit'],['C6','50-59.9','Credit'],['D7','45-49.9','Pass'],['E8','40-44.9','Pass'],['F9','0-39.9','Fail']];
  return `<table class="grade-scale-table"><thead><tr><th>Grade</th><th>Score Range</th><th>Remark</th></tr></thead><tbody>${scale.map(s=>`<tr><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td>`).join('')}</tbody></table>`;
}
function createTickRating(skillKey, currentValue) {
  const container = document.createElement('div');
  container.className = 'rating-tick';
  for (let i = 1; i <= 5; i++) {
    const tick = document.createElement('span');
    tick.className = 'tick' + (i === currentValue ? ' selected' : '');
    tick.textContent = i;
    tick.addEventListener('click', (e) => {
      e.stopPropagation();
      const parent = tick.parentNode;
      Array.from(parent.children).forEach(t => t.classList.remove('selected'));
      tick.classList.add('selected');
      editorState.psychomotor[skillKey] = i;
      const ratingContainer = parent.closest('.rating-container');
      if (ratingContainer) {
        const printSpan = ratingContainer.querySelector('.print-value');
        if (printSpan) printSpan.textContent = i;
      }
    });
    container.appendChild(tick);
  }
  return container;
}

// ------------------- Firestore Helpers -------------------
function getScoringDocId(session, term) {
  return `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}`;
}
function generateSessionOptionsFromCurrent(currentSession) {
  if (!currentSession || typeof currentSession !== 'string') return [];
  const parts = currentSession.split('/');
  if (parts.length !== 2) return [];
  const startYear = parseInt(parts[0], 10);
  if (isNaN(startYear)) return [];
  const sessions = [];
  for (let i = 0; i < 5; i++) {
    const year = startYear - i;
    sessions.push(`${year}/${year + 1}`);
  }
  return sessions;
}

// ------------------- Data Loading -------------------
async function loadClassesAndSubjects() {
  try {
    const classesSnap = await getDocs(query(collection(db, 'classes'), where('schoolId', '==', currentSchoolId)));
    classesMap.clear();
    classesSnap.forEach(doc => classesMap.set(doc.id, doc.data().name));
    const subjSnap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId)));
    subjectsMap.clear();
    allSubjectsList = [];
    subjSnap.forEach(doc => {
      subjectsMap.set(doc.id, doc.data().name);
      allSubjectsList.push({ id: doc.id, name: doc.data().name });
    });
  } catch (err) {
    console.error('Failed to load classes/subjects:', err);
    alert('Unable to load classes/subjects. Check your permissions.');
    throw err;
  }
}

async function loadAllStudents() {
  try {
    const snap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', currentSchoolId)));
    studentsList = snap.docs.map(doc => ({
      id: doc.id, name: doc.data().name, classId: doc.data().classId,
      admissionNumber: doc.data().admissionNumber, gender: doc.data().gender,
      dob: doc.data().dob, club: doc.data().club, passport: doc.data().passport || null
    }));
  } catch (err) {
    console.error('Failed to load students:', err);
    alert('Unable to load students. Check your permissions.');
    throw err;
  }
}

async function fetchClassScores(classId, term, session) {
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return [];
  const studentIds = classStudents.map(s => s.id);
  const scores = [];
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
    snap.forEach(doc => scores.push({ ...doc.data(), id: doc.id }));
  }
  return scores;
}

async function fetchStudentScores(studentId, term, session) {
  const q = query(
    collection(db, 'scores'),
    where('studentId', '==', studentId),
    where('schoolId', '==', currentSchoolId),
    where('term', '==', term),
    where('session', '==', session)
  );
  const snap = await getDocs(q);
  return snap.docs.map(doc => ({ subjectId: doc.data().subjectId, ca: doc.data().ca, exam: doc.data().exam }));
}

async function loadGradingSetting(session, term) {
  const gradingSelect = document.getElementById('gradingSelect');
  if (!gradingSelect) { currentGrading = { ca: 40, exam: 60 }; return; }
  try {
    const docId = getScoringDocId(session, term);
    const docSnap = await getDoc(doc(db, 'scoring', docId));
    let grading = '40/60';
    if (docSnap.exists()) grading = docSnap.data().grading;
    gradingSelect.value = grading;
    const [ca, exam] = grading.split('/').map(Number);
    currentGrading = { ca, exam };
  } catch (err) { console.error(err); currentGrading = { ca: 40, exam: 60 }; }
}

async function saveGradingSetting() {
  if (!isSubscriptionAllowed) {
    alert('Subscription inactive. Cannot save grading settings.');
    return;
  }
  const gradingSelect = document.getElementById('gradingSelect');
  if (!gradingSelect) return;
  const grading = gradingSelect.value;
  let session = document.getElementById('editorSessionSelect')?.value;
  let term = document.getElementById('editorTermSelect')?.value;
  if (!session || !term) {
    session = document.getElementById('broadsheetSessionSelect')?.value;
    term = document.getElementById('broadsheetTermSelect')?.value;
  }
  if (!session || !term) {
    alert('Session/Term not set. Please select a session and term first.');
    return;
  }
  const docId = getScoringDocId(session, term);
  try {
    await setDoc(doc(db, 'scoring', docId), { grading, schoolId: currentSchoolId, session, term });
    const [ca, exam] = grading.split('/').map(Number);
    currentGrading = { ca, exam };
    alert('Grading saved.');
    if (editorState.selectedStudent) await renderReportCard(editorState.selectedStudent.id, editorState.selectedStudent.name);
  } catch (err) {
    if (err.code === 'permission-denied') {
      alert('Permission denied. Subscription required to save grading.');
    } else {
      console.error(err);
      alert('Failed to save grading. Check console.');
    }
  }
}

// ------------------- Compute Subject Stats -------------------
async function computeSubjectStats(classId, term, session) {
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return new Map();
  const allScores = await fetchClassScores(classId, term, session);
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
      stat.totals.sort((a, b) => b.total - a.total);
      const avg = stat.totals.reduce((s, t) => s + t.total, 0) / stat.totals.length;
      stat.classAverage = avg.toFixed(1);
      let rank = 1;
      for (let i = 0; i < stat.totals.length; i++) {
        if (i > 0 && stat.totals[i].total < stat.totals[i - 1].total) rank = i + 1;
        stat.rankMap.set(stat.totals[i].studentId, rank);
      }
    }
  }
  return subjectMap;
}

// ------------------- Report Card Rendering (with subscription block) -------------------
async function renderReportCard(studentId, studentName) {
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
  editorState.selectedStudent = { id: studentId, name: studentName };
  editorState.term = document.getElementById('editorTermSelect')?.value || '1';
  editorState.session = document.getElementById('editorSessionSelect')?.value || '';
  const classId = document.getElementById('editorClassSelect')?.value;
  const className = classesMap.get(classId) || 'Class';

  const schoolDoc = await getDoc(doc(db, 'schools', currentSchoolId));
  const school = {
    name: schoolDoc.exists() ? schoolDoc.data().name : 'School Name',
    address: schoolDoc.exists() ? schoolDoc.data().address : '',
    logo: schoolDoc.exists() ? schoolDoc.data().logo : null
  };
  const student = studentsList.find(s => s.id === studentId) || {};
  const scoresRaw = await fetchStudentScores(studentId, editorState.term, editorState.session);
  const scoresWithNames = scoresRaw.map(score => ({
    subjectId: score.subjectId,
    subjectName: subjectsMap.get(score.subjectId) || score.subjectId,
    ca: score.ca,
    exam: score.exam
  }));

  let subjectStats = new Map();
  if (classId) subjectStats = await computeSubjectStats(classId, editorState.term, editorState.session);
  await loadExistingEditorReport(studentId);

  const studentData = {
    id: studentId,
    name: studentName,
    admissionNumber: student.admissionNumber || '—',
    gender: student.gender || '—',
    dob: student.dob || '',
    club: student.club || '—',
    passport: student.passport || null
  };

  const comments = {
    teacherComment: editorState.teacherComment,
    principalComment: editorState.principalComment
  };

  renderReportCardUI({
    student: studentData,
    scores: scoresWithNames,
    className,
    school,
    grading: currentGrading,
    psychomotor: editorState.psychomotor,
    comments,
    term: editorState.term,
    session: editorState.session,
    subjectStats,
    container: document.getElementById('reportCardContent'),
    onRatingChange: (skillKey, newValue) => {
      editorState.psychomotor[skillKey] = newValue;
    },
    onTeacherCommentChange: (newComment) => {
      editorState.teacherComment = newComment;
    },
    onPrincipalCommentChange: (newComment) => {
      editorState.principalComment = newComment;
    }
  });

  document.getElementById('reportActions').style.display = 'flex';
}

async function loadExistingEditorReport(studentId) {
  resetRatingsToDefaults();
  const reportsRef = collection(db, 'reports');
  const q = query(
    reportsRef,
    where('studentId', '==', studentId),
    where('schoolId', '==', currentSchoolId),
    where('term', '==', editorState.term),
    where('session', '==', editorState.session)
  );
  const snap = await getDocs(q);
  if (!snap.empty) {
    const data = snap.docs[0].data();
    if (data.psychomotor) Object.assign(editorState.psychomotor, data.psychomotor);
    editorState.teacherComment = data.teacherComment || '';
    editorState.principalComment = data.principalComment || '';
    editorState.savedReportId = snap.docs[0].id;
  } else {
    editorState.savedReportId = null;
  }
}

async function saveEditorReport() {
  if (!isSubscriptionAllowed) {
    alert('Cannot save report – subscription inactive.');
    return;
  }
  if (!editorState.selectedStudent) return alert('Select a student.');
  const totalScore = parseInt(document.querySelector('.summary-table tr:nth-child(1) td')?.textContent) || 0;
  const totalObtainable = parseInt(document.querySelector('.summary-table tr:nth-child(2) td')?.textContent) || 0;
  const subjectCount = parseInt(document.querySelector('.summary-table tr:nth-child(3) td')?.textContent) || 0;
  const average = parseFloat(document.querySelector('.summary-table tr:nth-child(4) td')?.textContent) || 0;
  const overallGrade = document.querySelector('.summary-table tr:nth-child(5) td')?.textContent || 'N/A';
  const reportData = {
    studentId: editorState.selectedStudent.id,
    classId: document.getElementById('editorClassSelect')?.value,
    schoolId: currentSchoolId,
    term: editorState.term,
    session: editorState.session,
    totalScore,
    maxTotal: totalObtainable,
    average,
    overallGrade,
    psychomotor: editorState.psychomotor,
    teacherComment: editorState.teacherComment,
    principalComment: editorState.principalComment,
    updatedAt: new Date()
  };
  try {
    if (editorState.savedReportId) {
      await updateDoc(doc(db, 'reports', editorState.savedReportId), reportData);
    } else {
      const newRef = await addDoc(collection(db, 'reports'), { ...reportData, createdAt: new Date() });
      editorState.savedReportId = newRef.id;
    }
    alert('Report saved.');
  } catch (error) {
    if (error.code === 'permission-denied') {
      alert('Permission denied. Subscription required to save reports.');
    } else {
      console.error(error);
      alert('Save failed.');
    }
  }
}

// ========== FIXED PRINT HANDLER (unchanged) ==========
function handlePrint() {
  const teacherText = document.getElementById('teacherCommentText');
  const printTeacher = document.getElementById('printTeacherComment');
  if (teacherText && printTeacher) printTeacher.textContent = escapeHtml(teacherText.value);

  const principalText = document.getElementById('principalCommentText');
  const printPrincipal = document.getElementById('printPrincipalComment');
  if (principalText && printPrincipal) printPrincipal.textContent = escapeHtml(principalText.value);

  const reportContent = document.getElementById('reportCardContent');
  if (!reportContent || reportContent.children.length === 0 ||
      (reportContent.children.length === 1 && reportContent.children[0].tagName === 'P' &&
       reportContent.children[0].textContent.includes('Select a student'))) {
    alert('Report not ready yet. Please select a student and ensure the report is loaded.');
    return;
  }

  const clonedReport = reportContent.cloneNode(true);
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups for this site to print the report.');
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
      <title>Report Card - ${escapeHtml(editorState.selectedStudent?.name || 'Student')}</title>
      <link rel="stylesheet" href="${externalCssUrl}">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: white; margin: 0; padding: 0; display: flex; justify-content: center; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .print-container { width: 210mm; margin: 0 auto; background: white; }
        @page { size: A4; margin: 10mm; }
        .rating-tick, select, textarea, button, .comment-controls, .tick { display: none !important; }
        .print-value, .print-comment-text { display: block !important; }
        .report-card { page-break-after: avoid; page-break-inside: avoid; overflow: visible; }
        .subject-table th:not(:first-child) { height: 50px; }
        .student-details-grid { padding: 4px 8px; }
        .skills-table td, .skills-table th { padding: 2px 4px; }
        .summary-grading-wrapper { margin: 6px 0; }
        ${inlineStyles}
      </style>
    </head>
    <body>
      <div class="print-container">
        ${clonedReport.outerHTML}
      </div>
    </body>
    </html>
  `);

  printWindow.document.close();
  setTimeout(() => {
    printWindow.focus();
    printWindow.print();
  }, 300);
}

// ------------------- Broadsheet Engine (with subscription check) -------------------
async function generateBroadsheet() {
  if (!isSubscriptionAllowed) {
    const container = document.getElementById('broadsheetContainer');
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; background: #fef3c7; border-radius: 8px;">
        <h3>⚠️ Subscription Required</h3>
        <p>Broadsheets are unavailable because the school subscription is inactive.</p>
      </div>
    `;
    document.getElementById('broadsheetActions').style.display = 'none';
    return;
  }
  const classId = document.getElementById('broadsheetClassSelect')?.value;
  const session = document.getElementById('broadsheetSessionSelect')?.value;
  const term = document.getElementById('broadsheetTermSelect')?.value;
  if (!classId || !session || !term) { alert('Please select Class, Session and Term'); return; }

  const className = classesMap.get(classId) || 'Class';
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) {
    const container = document.getElementById('broadsheetContainer');
    if (container) container.innerHTML = '<div class="alert">No students found in this class.</div>';
    return;
  }

  const allScores = await fetchClassScores(classId, term, session);
  const scoresByStudent = new Map();
  for (const score of allScores) {
    if (!scoresByStudent.has(score.studentId)) scoresByStudent.set(score.studentId, []);
    scoresByStudent.get(score.studentId).push(score);
  }

  const studentResults = [];
  for (const student of classStudents) {
    const scores = scoresByStudent.get(student.id) || [];
    const scoreMap = new Map();
    scores.forEach(s => { scoreMap.set(s.subjectId, { ca: s.ca, exam: s.exam, total: s.ca + s.exam }); });
    let totalScore = 0;
    const subjectDetails = [];
    for (const subj of allSubjectsList) {
      const score = scoreMap.get(subj.id) || { ca: 0, exam: 0, total: 0 };
      totalScore += score.total;
      subjectDetails.push({ subjectName: subj.name, ca: score.ca, exam: score.exam, total: score.total });
    }
    const totalObtainable = allSubjectsList.length * 100;
    const average = totalObtainable ? (totalScore / totalObtainable) * 100 : 0;
    const grade = calculateGrade(average);
    const remark = getGradeRemark(grade);
    studentResults.push({
      studentId: student.id,
      studentName: student.name,
      totalScore,
      average,
      grade,
      remark,
      subjectDetails
    });
  }

  studentResults.sort((a, b) => b.totalScore - a.totalScore);
  let rank = 1;
  for (let i = 0; i < studentResults.length; i++) {
    if (i > 0 && studentResults[i].totalScore < studentResults[i - 1].totalScore) rank = i + 1;
    studentResults[i].position = rank;
  }

  let html = `<div style="margin-bottom: 1rem;"><h3>BROADSHEET – ${escapeHtml(className)} – ${session} – ${term}</h3></div>`;
  html += `<div style="overflow-x: auto;"><table class="broadsheet-table" border="1" cellpadding="5" cellspacing="0">`;
  html += `<thead><tr><th>S/N</th><th>Student Name</th>`;
  for (const subj of allSubjectsList) html += `<th colspan="3">${escapeHtml(subj.name)}</th>`;
  html += `<th>% Avg</th><th>Grade</th><th>Remark</th><th>Position</th></tr>`;
  html += `<tr><th></th><th></th>`;
  for (let i = 0; i < allSubjectsList.length; i++) html += `<th>CA</th><th>Exam</th><th>Total</th>`;
  html += `<th></th><th></th><th></th><th></th></tr></thead><tbody>`;

  for (let i = 0; i < studentResults.length; i++) {
    const r = studentResults[i];
    html += `<tr>`;
    html += `<td>${i + 1}</td>`;
    html += `<td class="student-name-cell">${escapeHtml(r.studentName)}</td>`;
    for (const sub of r.subjectDetails) html += `<td>${sub.ca}</td><td>${sub.exam}</td><td>${sub.total}</td>`;
    html += `<td>${r.average.toFixed(1)}%</td>`;
    html += `<td>${r.grade}</td>`;
    html += `<td>${r.remark}</td>`;
    html += `<td>${r.position}${r.position === 1 ? 'st' : r.position === 2 ? 'nd' : r.position === 3 ? 'rd' : 'th'}</td>`;
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;

  const container = document.getElementById('broadsheetContainer');
  if (container) container.innerHTML = html;
  const actions = document.getElementById('broadsheetActions');
  if (actions) actions.style.display = 'flex';
  window.currentBroadsheetData = { classId, session, term, studentResults, subjects: allSubjectsList };
}

async function saveBroadsheetToFirestore() {
  if (!isSubscriptionAllowed) {
    alert('Cannot save broadsheet – subscription inactive.');
    return;
  }
  if (!window.currentBroadsheetData) { alert('No broadsheet data to save. Generate first.'); return; }
  const { classId, session, term, studentResults, subjects } = window.currentBroadsheetData;
  const docId = `${currentSchoolId}_${classId}_${session.replace(/\//g, '_')}_${term}`;
  const broadsheetData = {
    schoolId: currentSchoolId,
    classId,
    session,
    term,
    students: studentResults.map(s => ({
      studentId: s.studentId,
      studentName: s.studentName,
      totalScore: s.totalScore,
      average: s.average,
      grade: s.grade,
      remark: s.remark,
      position: s.position,
      subjectDetails: s.subjectDetails
    })),
    subjects: subjects.map(s => ({ id: s.id, name: s.name })),
    createdAt: new Date(),
    updatedAt: new Date()
  };
  try {
    await setDoc(doc(db, 'broadsheets', docId), broadsheetData, { merge: true });
    alert('Broadsheet saved successfully.');
  } catch (err) {
    if (err.code === 'permission-denied') {
      alert('Permission denied. Subscription required to save broadsheets.');
    } else {
      console.error(err);
      alert('Save failed.');
    }
  }
}

function printBroadsheet() {
  const container = document.getElementById('broadsheetContainer');
  if (!container || !container.innerHTML.trim()) { alert('No broadsheet to print.'); return; }
  const originalContent = container.cloneNode(true);
  const title = document.querySelector('#broadsheetContainer h3')?.innerText || 'Class Broadsheet';
  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head><title>${title}</title>
    <style>
      body { font-family: 'Segoe UI', sans-serif; margin: 20px; }
      .broadsheet-table { width: 100%; border-collapse: collapse; font-size: 11px; }
      .broadsheet-table th, .broadsheet-table td { border: 1px solid #000; padding: 6px 4px; text-align: center; }
      .student-name-cell { text-align: left; }
      @media print { @page { size: landscape; margin: 1cm; } body { margin: 0; } }
    </style>
    </head>
    <body>${originalContent.outerHTML}</body>
    </html>
  `);
  printWindow.document.close();
  printWindow.print();
}

// ------------------- Editor Filter Handlers -------------------
async function onEditorClassChange() {
  const classId = document.getElementById('editorClassSelect')?.value;
  const studentContainer = document.getElementById('studentListContainer');
  const reportContent = document.getElementById('reportCardContent');
  const reportActions = document.getElementById('reportActions');

  if (!classId) {
    if (studentContainer) studentContainer.innerHTML = '<p>Select a class</p>';
    if (reportContent) reportContent.innerHTML = '<p>Select a student</p>';
    if (reportActions) reportActions.style.display = 'none';
    return;
  }
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) {
    if (studentContainer) studentContainer.innerHTML = '<p>No students</p>';
    return;
  }
  let html = '';
  classStudents.forEach(student => { html += `<div class="student-list-item" data-id="${student.id}">${escapeHtml(student.name)}</div>`; });
  if (studentContainer) studentContainer.innerHTML = html;

  const firstStudent = classStudents[0];
  if (firstStudent) {
    const firstEl = document.querySelector('.student-list-item');
    if (firstEl) firstEl.classList.add('active');
    resetRatingsToDefaults();
    await renderReportCard(firstStudent.id, firstStudent.name);
  }

  document.querySelectorAll('.student-list-item').forEach(el => {
    el.addEventListener('click', async () => {
      document.querySelectorAll('.student-list-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      resetRatingsToDefaults();
      await renderReportCard(el.dataset.id, el.textContent);
    });
  });
  await onEditorFilterChange();
}

async function onEditorFilterChange() {
  editorState.term = document.getElementById('editorTermSelect')?.value || '1';
  editorState.session = document.getElementById('editorSessionSelect')?.value || '';
  if (editorState.selectedStudent) await renderReportCard(editorState.selectedStudent.id, editorState.selectedStudent.name);
}

// ------------------- Initialisation (EXPORTED) -------------------
export async function initResultsPage() {
  if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));

  currentSchoolId = await getCurrentSchoolId();
  if (!currentSchoolId) {
    alert('School ID missing. Please log out and log in again.');
    return;
  }

  // Check subscription status
  isSubscriptionAllowed = await canEnterScores(currentSchoolId);

  await initAcademicCalendar(currentSchoolId);

  let academic;
  try {
    academic = await getAcademicContext(currentSchoolId);
  } catch (err) {
    console.warn('Failed to read academic context, computing fallback', err);
    const { getCurrentAcademicSessionAndTerm } = await import('./admin.js');
    const computed = getCurrentAcademicSessionAndTerm();
    academic = { currentSession: computed.session, currentTerm: computed.term };
    const schoolRef = doc(db, 'schools', currentSchoolId);
    await setDoc(schoolRef, {
      currentSession: academic.currentSession,
      currentTerm: academic.currentTerm,
      lastUpdated: new Date()
    }, { merge: true });
  }

  const { currentSession, currentTerm } = academic;

  try {
    await loadClassesAndSubjects();
    await loadAllStudents();
  } catch (err) {
    console.error('Data loading failed', err);
    return;
  }

  const classSelect = document.getElementById('broadsheetClassSelect');
  if (classSelect) {
    classSelect.innerHTML = '<option value="">-- Select Class --</option>' + Array.from(classesMap.entries()).map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
  }

  const sessionOptions = generateSessionOptionsFromCurrent(currentSession);
  const sessionSelect = document.getElementById('broadsheetSessionSelect');
  if (sessionSelect) {
    sessionSelect.innerHTML = sessionOptions.map(s => `<option value="${s}" ${s === currentSession ? 'selected' : ''}>${s}</option>`).join('');
  }
  const termSelect = document.getElementById('broadsheetTermSelect');
  if (termSelect) termSelect.value = currentTerm;

  const editorClassSelect = document.getElementById('editorClassSelect');
  if (editorClassSelect) {
    editorClassSelect.innerHTML = '<option value="">-- Select Class --</option>' + Array.from(classesMap.entries()).map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
  }
  const editorSessionSelect = document.getElementById('editorSessionSelect');
  if (editorSessionSelect) {
    editorSessionSelect.innerHTML = sessionOptions.map(s => `<option value="${s}" ${s === currentSession ? 'selected' : ''}>${s}</option>`).join('');
  }
  const editorTermSelect = document.getElementById('editorTermSelect');
  if (editorTermSelect) editorTermSelect.value = currentTerm;

  await loadGradingSetting(currentSession, currentTerm);

  const generateBtn = document.getElementById('generateBroadsheetBtn');
  if (generateBtn) generateBtn.addEventListener('click', generateBroadsheet);
  const saveBroadsheetBtn = document.getElementById('saveBroadsheetBtn');
  if (saveBroadsheetBtn) saveBroadsheetBtn.addEventListener('click', saveBroadsheetToFirestore);
  const printBroadsheetBtn = document.getElementById('printBroadsheetBtn');
  if (printBroadsheetBtn) printBroadsheetBtn.addEventListener('click', printBroadsheet);
  const saveGradingBtn = document.getElementById('saveGradingBtn');
  if (saveGradingBtn) saveGradingBtn.addEventListener('click', saveGradingSetting);
  const refreshBtn = document.getElementById('refreshEditorBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => onEditorClassChange());
  const saveReportBtn = document.getElementById('saveReportBtn');
  if (saveReportBtn) saveReportBtn.addEventListener('click', saveEditorReport);
  const printReportBtn = document.getElementById('printReportBtn');
  if (printReportBtn) printReportBtn.addEventListener('click', handlePrint);

  if (editorClassSelect) editorClassSelect.addEventListener('change', onEditorClassChange);
  if (editorSessionSelect) editorSessionSelect.addEventListener('change', onEditorFilterChange);
  if (editorTermSelect) editorTermSelect.addEventListener('change', onEditorFilterChange);

  // Disable features if subscription not allowed
  if (!isSubscriptionAllowed) {
    if (saveGradingBtn) saveGradingBtn.disabled = true;
    if (generateBtn) generateBtn.disabled = true;
    if (saveBroadsheetBtn) saveBroadsheetBtn.disabled = true;
    if (printBroadsheetBtn) printBroadsheetBtn.disabled = true;
    if (printReportBtn) printReportBtn.disabled = true;
    if (saveReportBtn) saveReportBtn.disabled = true;
    const warningBanner = document.createElement('div');
    warningBanner.className = 'subscription-warning-banner';
    warningBanner.style.cssText = 'background: #fee2e2; color: #991b1b; padding: 12px; text-align: center; margin-bottom: 16px; border-radius: 8px;';
    warningBanner.innerHTML = '⚠️ Subscription inactive. Report cards and broadsheets are disabled. Please renew to access these features.';
    const contentDiv = document.querySelector('.content');
    if (contentDiv) contentDiv.insertBefore(warningBanner, contentDiv.firstChild);
  }

  await onEditorClassChange();
}