// results.js - Admin report card with A4 optimized layout, reliable print & data loading
import { db } from './firebase-config.js';
import { collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, setDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

let currentSchoolId = null;
let currentSession = '';
let currentTerm = '1';
let classesMap = new Map();
let studentsList = [];
let subjectsMap = new Map();
let currentGrading = { ca: 40, exam: 60 };

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

function getSkillKey(skill) {
  return skill.toLowerCase().replace(/[^a-z]/g, '');
}

function getDefaultRatings() {
  const defaults = {};
  [...psychomotorSkillsList, ...affectiveSkillsList].forEach(skill => {
    defaults[getSkillKey(skill)] = 3;
  });
  return defaults;
}

function resetRatingsToDefaults() {
  editorState.psychomotor = getDefaultRatings();
}

export async function initResultsPage() {
  if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
  currentSchoolId = localStorage.getItem('userSchoolId') || await getCurrentSchoolId();
  if (!currentSchoolId) { alert('School ID missing.'); return; }
  await loadClassesAndSubjects();
  await loadSessionOptions();
  await loadGradingSetting();
  await loadAllStudents();

  const saveGradingBtn = document.getElementById('saveGradingBtn');
  if (saveGradingBtn) saveGradingBtn.addEventListener('click', saveGradingSetting);
  const generateBroadsheetBtn = document.getElementById('generateBroadsheetBtn');
  if (generateBroadsheetBtn) generateBroadsheetBtn.addEventListener('click', generateBroadsheet);
  const broadsheetClassSelect = document.getElementById('broadsheetClassSelect');
  if (broadsheetClassSelect) {
    broadsheetClassSelect.innerHTML = '<option value="">-- Select Class --</option>' +
      Array.from(classesMap.entries()).map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
  }

  const editorClassSelect = document.getElementById('editorClassSelect');
  const editorTermSelect = document.getElementById('editorTermSelect');
  const editorSessionSelect = document.getElementById('editorSessionSelect');
  const refreshEditorBtn = document.getElementById('refreshEditorBtn');
  const saveReportBtn = document.getElementById('saveReportBtn');
  const printReportBtn = document.getElementById('printReportBtn');

  if (editorClassSelect) {
    editorClassSelect.innerHTML = '<option value="">-- Select Class --</option>' +
      Array.from(classesMap.entries()).map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
    editorClassSelect.addEventListener('change', onEditorClassChange);
  }
  if (editorTermSelect) {
    editorTermSelect.value = '1';
    editorTermSelect.addEventListener('change', onEditorFilterChange);
  }
  if (editorSessionSelect) {
    editorSessionSelect.innerHTML = getSessionOptionsHtml();
    editorSessionSelect.addEventListener('change', onEditorFilterChange);
  }
  if (refreshEditorBtn) refreshEditorBtn.addEventListener('click', () => onEditorClassChange());
  if (saveReportBtn) saveReportBtn.addEventListener('click', saveEditorReport);
  if (printReportBtn) printReportBtn.addEventListener('click', handlePrint);

  const closeBroadsheet = document.querySelector('.close-broadsheet');
  if (closeBroadsheet) closeBroadsheet.onclick = () => { const modal = document.getElementById('broadsheetModal'); if (modal) modal.style.display = 'none'; };
  window.onclick = (e) => { const modal = document.getElementById('broadsheetModal'); if (e.target === modal && modal) modal.style.display = 'none'; };
  const printBroadsheetBtn = document.getElementById('printBroadsheetBtn');
  if (printBroadsheetBtn) printBroadsheetBtn.onclick = () => window.print();

  await onEditorClassChange();
}

async function computeSubjectStats(classId, term, session) {
  const classStudents = studentsList.filter(s => s.classId === classId);
  const subjectStats = new Map();
  for (const subjId of subjectsMap.keys()) {
    subjectStats.set(subjId, { totals: [], classAverage: 0, rankMap: new Map() });
  }
  for (const student of classStudents) {
    const scores = await fetchScores(student.id, term, session);
    for (const score of scores) {
      const total = score.ca + score.exam;
      const stat = subjectStats.get(score.subjectId);
      if (stat) stat.totals.push({ studentId: student.id, total });
    }
  }
  for (const [subjId, stat] of subjectStats.entries()) {
    if (stat.totals.length) {
      stat.totals.sort((a,b) => b.total - a.total);
      const avg = stat.totals.reduce((s, t) => s + t.total, 0) / stat.totals.length;
      stat.classAverage = avg.toFixed(1);
      let rank = 1;
      for (let i = 0; i < stat.totals.length; i++) {
        if (i > 0 && stat.totals[i].total < stat.totals[i-1].total) rank = i+1;
        stat.rankMap.set(stat.totals[i].studentId, rank);
      }
    }
  }
  return subjectStats;
}

async function loadGradingSetting() {
  const gradingSelect = document.getElementById('gradingSelect');
  if (!gradingSelect) { currentGrading = { ca: 40, exam: 60 }; return; }
  if (!currentSession || !currentTerm) { currentGrading = { ca: 40, exam: 60 }; gradingSelect.value = '40/60'; return; }
  try {
    const docId = getScoringDocId(currentSchoolId, currentSession, currentTerm);
    const scoringRef = doc(db, 'scoring', docId);
    const docSnap = await getDoc(scoringRef);
    let grading = '40/60';
    if (docSnap.exists()) grading = docSnap.data().grading;
    gradingSelect.value = grading;
    const [ca, exam] = grading.split('/').map(Number);
    currentGrading = { ca, exam };
  } catch (err) { console.error(err); currentGrading = { ca: 40, exam: 60 }; }
}

async function saveGradingSetting() {
  const gradingSelect = document.getElementById('gradingSelect');
  if (!gradingSelect) return;
  const grading = gradingSelect.value;
  const docId = getScoringDocId(currentSchoolId, currentSession, currentTerm);
  await setDoc(doc(db, 'scoring', docId), { grading, schoolId: currentSchoolId, session: currentSession, term: currentTerm });
  const [ca, exam] = grading.split('/').map(Number);
  currentGrading = { ca, exam };
  alert('Grading saved.');
  if (editorState.selectedStudent) await renderReportCard(editorState.selectedStudent.id, editorState.selectedStudent.name);
}

function getScoringDocId(schoolId, session, term) {
  return `${schoolId}_${session.replace(/\//g, '_')}_${term}`;
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

function getGradeScaleHtml() {
  const scale = [['A1','85-100','Excellent'],['B2','75-84.9','Very Good'],['B3','70-74.9','Good'],['C4','65-69.9','Credit'],['C5','60-64.9','Credit'],['C6','50-59.9','Credit'],['D7','45-49.9','Pass'],['E8','40-44.9','Pass'],['F9','0-39.9','Fail']];
  return `<table class="grade-scale-table"><thead><tr><th>Grade</th><th>Score Range</th><th>Remark</th></tr></thead><tbody>${scale.map(s=>`<tr><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td></tr>`).join('')}</tbody></table>`;
}

async function loadClassesAndSubjects() {
  const classesRef = collection(db, 'classes');
  const qClasses = query(classesRef, where('schoolId', '==', currentSchoolId));
  const classesSnap = await getDocs(qClasses);
  classesMap.clear();
  classesSnap.forEach(doc => classesMap.set(doc.id, doc.data().name));
  const subjectsRef = collection(db, 'subjects');
  const qSubj = query(subjectsRef, where('schoolId', '==', currentSchoolId));
  const subjSnap = await getDocs(qSubj);
  subjectsMap.clear();
  subjSnap.forEach(doc => subjectsMap.set(doc.id, doc.data().name));
}

async function loadAllStudents() {
  const studentsRef = collection(db, 'students');
  const qStudents = query(studentsRef, where('schoolId', '==', currentSchoolId));
  const studentsSnap = await getDocs(qStudents);
  studentsList = studentsSnap.docs.map(doc => ({
    id: doc.id,
    name: doc.data().name,
    classId: doc.data().classId,
    admissionNumber: doc.data().admissionNumber,
    gender: doc.data().gender,
    dob: doc.data().dob,
    club: doc.data().club,
    passport: doc.data().passport || null
  }));
}

async function loadSessionOptions() {
  const currentYear = new Date().getFullYear();
  currentSession = `${currentYear}/${currentYear + 1}`;
  currentTerm = '1';
}

function getSessionOptionsHtml() {
  const currentYear = new Date().getFullYear();
  let options = [];
  for (let i = 0; i < 5; i++) {
    const start = currentYear - i;
    const end = start + 1;
    options.push(`${start}/${end}`);
  }
  return options.map(opt => `<option value="${opt}">${opt}</option>`).join('');
}

async function fetchScores(studentId, term, session) {
  const scoresRef = collection(db, 'scores');
  const q = query(scoresRef, where('studentId', '==', studentId), where('schoolId', '==', currentSchoolId), where('term', '==', term), where('session', '==', session));
  const snap = await getDocs(q);
  return snap.docs.map(doc => ({ subjectId: doc.data().subjectId, ca: doc.data().ca, exam: doc.data().exam }));
}

async function renderReportCard(studentId, studentName) {
  editorState.selectedStudent = { id: studentId, name: studentName };
  editorState.term = document.getElementById('editorTermSelect')?.value || '1';
  editorState.session = document.getElementById('editorSessionSelect')?.value || '';
  const classId = document.getElementById('editorClassSelect')?.value;
  const className = classesMap.get(classId) || 'Class';

  const schoolDoc = await getDoc(doc(db, 'schools', currentSchoolId));
  const schoolName = schoolDoc.exists() ? schoolDoc.data().name : 'School Name';
  const schoolLogo = schoolDoc.exists() ? schoolDoc.data().logo : null;
  const student = studentsList.find(s => s.id === studentId) || {};
  const admissionNo = student.admissionNumber || '—';
  const gender = student.gender || '—';
  const dob = student.dob || '';
  const age = dob ? calculateAge(dob) : '—';
  const club = student.club || '—';
  const passportUrl = student.passport || null;

  const scores = await fetchScores(studentId, editorState.term, editorState.session);
  const localSubjectsMap = new Map();
  if (scores.length) {
    const snap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId)));
    snap.forEach(doc => localSubjectsMap.set(doc.id, doc.data().name));
  }

  let subjectStats = new Map();
  if (classId) subjectStats = await computeSubjectStats(classId, editorState.term, editorState.session);

  let tableRows = '', totalScore = 0, subjectCount = 0;
  for (const score of scores) {
    const subjectName = localSubjectsMap.get(score.subjectId) || score.subjectId;
    const total = score.ca + score.exam;
    totalScore += total; subjectCount++;
    const grade = calculateGrade(total);
    const remark = getGradeRemark(grade);
    let positionHtml = '—', classAvg = '—';
    const stat = subjectStats.get(score.subjectId);
    if (stat) {
      const rank = stat.rankMap.get(studentId);
      if (rank) {
        const suffix = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th';
        positionHtml = `${rank}<sup>${suffix}</sup>`;
      }
      classAvg = stat.classAverage;
    }
    tableRows += `<tr><td style="text-align:left">${escapeHtml(subjectName)}</td><td>${score.ca}</td><td>${score.exam}</td><td>${total}</td><td>${grade}</td><td>${remark}</td><td>${positionHtml}</td><td>${classAvg}</td></tr>`;
  }
  const average = subjectCount ? (totalScore/subjectCount).toFixed(1) : 0;
  const overallGrade = calculateGrade(parseFloat(average));
  const totalObtainable = subjectCount * 100;
  const percentageAvg = subjectCount ? ((totalScore/totalObtainable)*100).toFixed(1) : 0;
  const overallRemark = getGradeRemark(overallGrade);

  await loadExistingEditorReport(studentId);

  let psychomotorHtml = `<table class="skills-table"><thead><tr><th>Psychomotor Skills</th><th>Rating (1-5)</th></tr></thead><tbody>`;
  for (const skill of psychomotorSkillsList) {
    const key = getSkillKey(skill);
    const val = editorState.psychomotor[key] || 3;
    psychomotorHtml += `<tr><td>${escapeHtml(skill)}</td><td class="rating-container" data-skill-key="${key}"><span class="print-value">${val}</span></td></tr>`;
  }
  psychomotorHtml += `</tbody></table>`;

  let affectiveHtml = `<table class="skills-table"><thead><tr><th>Affective Domain</th><th>Rating (1-5)</th></tr></thead><tbody>`;
  for (const skill of affectiveSkillsList) {
    const key = getSkillKey(skill);
    const val = editorState.psychomotor[key] || 3;
    affectiveHtml += `<tr><td>${escapeHtml(skill)}</td><td class="rating-container" data-skill-key="${key}"><span class="print-value">${val}</span></td></tr>`;
  }
  affectiveHtml += `</tbody></table>`;

  const summaryHtml = `<div class="section-title">📊 Summary of Performance</div><table class="summary-table"><tr><th>Total Obtained</th><td>${totalScore}</td></tr><tr><th>Total Obtainable</th><td>${totalObtainable}</td></tr><tr><th>Total Subjects</th><td>${subjectCount}</td></tr><tr><th>% Average</th><td>${percentageAvg}%</td></tr><tr><th>Grade</th><td>${overallGrade}</td></tr><tr><th>Remark</th><td>${overallRemark}</td></tr></table>`;
  const gradeScaleHtml = `<div class="section-title">📈 Grade Distribution</div>${getGradeScaleHtml()}`;

  const headerHtml = `<div class="report-header">
    <div class="school-logo-area">${schoolLogo ? `<img src="${schoolLogo}" class="school-logo-small" alt="Logo">` : ''}</div>
    <div class="school-name-area"><h1 class="school-name-report">${escapeHtml(schoolName)}</h1><div class="school-motto">Excellence in Education</div></div>
    <div class="passport-area">${passportUrl ? `<img src="${passportUrl}" class="student-passport-img" alt="Passport">` : ''}</div>
  </div>`;
  const studentDetailsHtml = `<div class="student-details-grid">
    <div><strong>Name:</strong> <span class="student-name-caps">${escapeHtml(studentName).toUpperCase()}</span></div>
    <div><strong>Admission No:</strong> ${escapeHtml(admissionNo)}</div>
    <div><strong>Gender:</strong> ${escapeHtml(gender)}</div>
    <div><strong>DOB:</strong> ${dob} (Age ${age})</div>
    <div><strong>Class:</strong> ${escapeHtml(className)}</div>
    <div><strong>Term:</strong> ${editorState.term}${getTermSuffix(editorState.term)}</div>
    <div><strong>Session:</strong> ${editorState.session}</div>
    <div><strong>Club:</strong> ${escapeHtml(club)}</div>
  </div>`;
  // Updated table headers: "Remark", "Position", "Class Ave."
  const tableHtml = `<table class="subject-table"><thead><tr><th>Subject</th><th>CA (${currentGrading.ca})</th><th>Exam (${currentGrading.exam})</th><th>Total (100)</th><th>Grade</th><th>Remark</th><th>Position</th><th>Class Ave.</th></tr></thead><tbody>${tableRows || '<tr><td colspan="8">No scores found</td></tr>'}</tbody></table>`;
  
  const commentOptions = getCommentOptionsByGrade(overallGrade);
  const commentsHtml = `<div class="comments-section"><h3>Comments</h3>
    <div class="comment-group">
      <label>Teacher's Comment:</label>
      <div class="comment-controls">
        <select id="teacherCommentSelect">${commentOptions.map(opt => `<option value="${opt}" ${editorState.teacherComment === opt ? 'selected' : ''}>${opt}</option>`).join('')}</select>
        <textarea id="teacherCommentText" rows="2" style="width:100%">${escapeHtml(editorState.teacherComment || '')}</textarea>
      </div>
      <div class="print-comment-text" id="printTeacherComment">${escapeHtml(editorState.teacherComment || '')}</div>
    </div>
    <div class="comment-group">
      <label>Principal's Comment:</label>
      <div class="comment-controls">
        <select id="principalCommentSelect">${commentOptions.map(opt => `<option value="${opt}" ${editorState.principalComment === opt ? 'selected' : ''}>${opt}</option>`).join('')}</select>
        <textarea id="principalCommentText" rows="2" style="width:100%">${escapeHtml(editorState.principalComment || '')}</textarea>
      </div>
      <div class="print-comment-text" id="printPrincipalComment">${escapeHtml(editorState.principalComment || '')}</div>
    </div>
  </div>`;
  
  const signatureHtml = `<div class="signature-stamp"><div class="signature-item"><strong>Principal's Signature:</strong><div class="signature-line"></div></div><div class="signature-item"><strong>School Stamp:</strong><div class="stamp-placeholder">(Official Stamp)</div></div><div class="signature-item"><strong>Date:</strong><div class="signature-line"></div></div></div>`;
  const ratingGuideHtml = `<div class="rating-guide">Rating Guide: 1 - Poor | 2 - Fair | 3 - Good | 4 - Very Good | 5 - Excellent</div>`;

  const fullHtml = headerHtml + studentDetailsHtml + tableHtml +
    `<div class="summary-grading-wrapper"><div class="summary-wrapper">${summaryHtml}</div><div class="grading-wrapper">${gradeScaleHtml}</div></div>` +
    `<div class="skills-wrapper"><div class="skills-half">${psychomotorHtml}</div><div class="skills-half">${affectiveHtml}</div></div>` +
    ratingGuideHtml + commentsHtml + signatureHtml;

  const reportCardContent = document.getElementById('reportCardContent');
  if (reportCardContent) reportCardContent.innerHTML = fullHtml;
  const reportActions = document.getElementById('reportActions');
  if (reportActions) reportActions.style.display = 'flex';

  document.querySelectorAll('.rating-container').forEach(container => {
    const skillKey = container.dataset.skillKey;
    if (skillKey) {
      const currentVal = editorState.psychomotor[skillKey] || 3;
      const widget = createTickRating(skillKey, currentVal);
      container.appendChild(widget);
    }
  });

  const teacherText = document.getElementById('teacherCommentText');
  const teacherSelect = document.getElementById('teacherCommentSelect');
  const principalText = document.getElementById('principalCommentText');
  const principalSelect = document.getElementById('principalCommentSelect');
  const printTeacher = document.getElementById('printTeacherComment');
  const printPrincipal = document.getElementById('printPrincipalComment');
  if (teacherSelect) teacherSelect.onchange = () => { editorState.teacherComment = teacherSelect.value; if(teacherText) teacherText.value = teacherSelect.value; if(printTeacher) printTeacher.textContent = escapeHtml(teacherSelect.value); };
  if (teacherText) teacherText.oninput = () => { editorState.teacherComment = teacherText.value; if(printTeacher) printTeacher.textContent = escapeHtml(teacherText.value); };
  if (principalSelect) principalSelect.onchange = () => { editorState.principalComment = principalSelect.value; if(principalText) principalText.value = principalSelect.value; if(printPrincipal) printPrincipal.textContent = escapeHtml(principalSelect.value); };
  if (principalText) principalText.oninput = () => { editorState.principalComment = principalText.value; if(printPrincipal) printPrincipal.textContent = escapeHtml(principalText.value); };

  if (schoolLogo) {
    const reportDiv = document.querySelector('.report-card');
    reportDiv.classList.add('watermark-ready');
    reportDiv.style.setProperty('--watermark-url', `url(${schoolLogo})`);
  }
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
  while (allComments.length < 30) {
    allComments.push(extraComments[allComments.length % extraComments.length]);
  }
  return [...new Set(allComments)];
}

function getTermSuffix(term) { return term === '1' ? 'st' : term === '2' ? 'nd' : 'rd'; }
function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'); }
async function getCurrentSchoolId() { const user = JSON.parse(localStorage.getItem('user') || '{}'); return user.schoolId || localStorage.getItem('userSchoolId'); }

async function onEditorClassChange() {
  const classId = document.getElementById('editorClassSelect')?.value;
  if (!classId) { document.getElementById('studentListContainer').innerHTML = '<p>Select a class</p>'; document.getElementById('reportCardContent').innerHTML = '<p>Select a student</p>'; document.getElementById('reportActions').style.display = 'none'; return; }
  const classStudents = studentsList.filter(s => s.classId === classId);
  const container = document.getElementById('studentListContainer');
  if (!classStudents.length) { container.innerHTML = '<p>No students</p>'; return; }
  let html = '';
  classStudents.forEach(student => { html += `<div class="student-list-item" data-id="${student.id}">${escapeHtml(student.name)}</div>`; });
  container.innerHTML = html;
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

async function loadExistingEditorReport(studentId) {
  resetRatingsToDefaults();
  const reportsRef = collection(db, 'reports');
  const q = query(reportsRef, where('studentId', '==', studentId), where('term', '==', editorState.term), where('session', '==', editorState.session));
  const snap = await getDocs(q);
  if (!snap.empty) {
    const data = snap.docs[0].data();
    if (data.psychomotor) {
      Object.assign(editorState.psychomotor, data.psychomotor);
    }
    editorState.teacherComment = data.teacherComment || '';
    editorState.principalComment = data.principalComment || '';
    editorState.savedReportId = snap.docs[0].id;
  } else {
    editorState.savedReportId = null;
  }
}

async function saveEditorReport() {
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
    if (editorState.savedReportId) await updateDoc(doc(db, 'reports', editorState.savedReportId), reportData);
    else { const newRef = await addDoc(collection(db, 'reports'), { ...reportData, createdAt: new Date() }); editorState.savedReportId = newRef.id; }
    alert('Report saved.');
  } catch (error) { console.error(error); alert('Save failed.'); }
}

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

  void reportContent.offsetHeight;
  requestAnimationFrame(() => {
    setTimeout(() => {
      window.print();
    }, 300);
  });
}

async function generateBroadsheet() {
  const classId = document.getElementById('broadsheetClassSelect')?.value;
  if (!classId) { alert('Select a class'); return; }
  const className = classesMap.get(classId) || 'Class';
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) { alert('No students'); return; }
  let html = `<h2>Class Broadsheet - ${escapeHtml(className)}</h2><p>Session: ${currentSession} | Term: ${currentTerm}</p><table border="1" cellpadding="5" style="width:100%; border-collapse:collapse;"><thead><tr><th>#</th><th>Student Name</th>${Array.from(subjectsMap.values()).map(s => `<th>${escapeHtml(s)}</th>`).join('')}<th>Total</th><th>Avg</th><th>Grade</th></tr></thead><tbody>`;
  for (let i = 0; i < classStudents.length; i++) {
    const student = classStudents[i];
    const scores = await fetchScores(student.id, currentTerm, currentSession);
    const scoreMap = new Map(); let total = 0;
    for (const sc of scores) { scoreMap.set(sc.subjectId, sc.ca + sc.exam); total += sc.ca + sc.exam; }
    const avg = scores.length ? (total / scores.length).toFixed(2) : 0;
    html += `<tr><td>${i+1}</td><td>${escapeHtml(student.name)}</td>`;
    for (const subId of subjectsMap.keys()) { const val = scoreMap.get(subId) || '-'; html += `<td>${val}</td>`; }
    html += `<td>${total}</td><td>${avg}</td><td>${calculateGrade(parseFloat(avg))}</td></tr>`;
  }
  html += `</tbody></table>`;
  document.getElementById('broadsheetContent').innerHTML = html;
  document.getElementById('broadsheetModal').style.display = 'flex';
}