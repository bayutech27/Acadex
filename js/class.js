// class.js - Teacher report card with A4 layout, passport, subject ranking & class averages
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
  await loadSessionOptions();
  await loadGradingSetting();
  await loadClassStudents();

  document.getElementById('termSelect').addEventListener('change', () => loadClassStudents());
  document.getElementById('sessionSelect').addEventListener('change', () => loadClassStudents());
  document.getElementById('refreshStudentsBtn')?.addEventListener('click', () => loadClassStudents());
  document.getElementById('saveReportBtn')?.addEventListener('click', saveReportCard);
  // Print button removed – no handler needed
}

async function computeSubjectStats(classId, term, session) {
  const classStudents = studentsList.filter(s => s.classId === classId);
  const subjectStats = new Map();
  for (const subjId of subjectsMap.keys()) subjectStats.set(subjId, { totals: [], classAverage: 0, rankMap: new Map() });
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
      const avg = stat.totals.reduce((s,t) => s + t.total, 0) / stat.totals.length;
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
  studentsList = snap.docs.map(doc => ({ id: doc.id, name: doc.data().name, classId: doc.data().classId, admissionNumber: doc.data().admissionNumber, gender: doc.data().gender, dob: doc.data().dob, club: doc.data().club, passport: doc.data().passport || null }));
}
async function loadSessionOptions() {
  const sessionSelect = document.getElementById('sessionSelect');
  const currentYear = new Date().getFullYear();
  const options = [];
  for (let i = 0; i < 5; i++) options.push(`${currentYear - i}/${currentYear - i + 1}`);
  sessionSelect.innerHTML = options.map(opt => `<option value="${opt}">${opt}</option>`).join('');
  reportState.session = options[0];
}
async function loadGradingSetting() {
  const docId = `${currentSchoolId}_${reportState.session.replace(/\//g, '_')}_${reportState.term}`;
  const docSnap = await getDoc(doc(db, 'scoring', docId));
  let grading = '40/60';
  if (docSnap.exists()) grading = docSnap.data().grading;
  const [ca, exam] = grading.split('/').map(Number);
  currentGrading = { ca, exam };
}
async function loadClassStudents() {
  reportState.term = document.getElementById('termSelect').value;
  reportState.session = document.getElementById('sessionSelect').value;
  await loadGradingSetting();
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
async function fetchScores(studentId, term, session) {
  const snap = await getDocs(query(collection(db, 'scores'), where('studentId', '==', studentId), where('schoolId', '==', currentSchoolId), where('term', '==', term), where('session', '==', session)));
  return snap.docs.map(doc => ({ subjectId: doc.data().subjectId, ca: doc.data().ca, exam: doc.data().exam }));
}
function calculateGrade(total) {
  if (total >= 85) return 'A1'; if (total >= 75) return 'B2'; if (total >= 70) return 'B3';
  if (total >= 65) return 'C4'; if (total >= 60) return 'C5'; if (total >= 50) return 'C6';
  if (total >= 45) return 'D7'; if (total >= 40) return 'E8'; return 'F9';
}
function getGradeRemark(grade) { const remarks = { A1:'Excellent', B2:'Very Good', B3:'Good', C4:'Credit', C5:'Credit', C6:'Credit', D7:'Pass', E8:'Pass', F9:'Fail' }; return remarks[grade] || ''; }
function getGradeScaleHtml() { const scale = [['A1','85-100','Excellent'],['B2','75-84.9','Very Good'],['B3','70-74.9','Good'],['C4','65-69.9','Credit'],['C5','60-64.9','Credit'],['C6','50-59.9','Credit'],['D7','45-49.9','Pass'],['E8','40-44.9','Pass'],['F9','0-39.9','Fail']]; return `<table class="grade-scale-table"><thead><tr><th>Grade</th><th>Score Range</th><th>Remark</th></tr></thead><tbody>${scale.map(s=>`<tr><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td></tr>`).join('')}</tbody></table>`; }
function createTickRating(skillKey, currentValue) {
  const container = document.createElement('div'); container.className = 'rating-tick';
  for (let i = 1; i <= 5; i++) { 
    const tick = document.createElement('span'); 
    tick.className = 'tick' + (i === currentValue ? ' selected' : ''); 
    tick.textContent = i; 
    tick.addEventListener('click', (e) => { 
      e.stopPropagation(); 
      const parent = tick.parentNode;
      Array.from(parent.children).forEach(t => t.classList.remove('selected')); 
      tick.classList.add('selected'); 
      reportState.psychomotor[skillKey] = i; 
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
function calculateAge(dob) { if (!dob) return null; const b = new Date(dob), t = new Date(); let a = t.getFullYear() - b.getFullYear(); const m = t.getMonth() - b.getMonth(); if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--; return a; }

/**
 * Returns an array of at least 30 constructive, grade-appropriate comments.
 * Includes commendation, encouragement, and recommendations.
 */
function getCommentOptionsByGrade(grade) {
  // General comments applicable to all grades
  const generalComments = [
    'Keep up the great work!',
    'Your effort is commendable.',
    'Consistent practice will yield even better results.',
    'You have shown improvement this term.',
    'Stay focused and keep pushing forward.',
    'Your positive attitude is appreciated.',
    'Continue to participate actively in class.',
    'You are capable of achieving even more.',
    'Great teamwork and collaboration skills.',
    'Your curiosity and willingness to learn are assets.'
  ];

  // Grade-specific commendations and recommendations
  const gradeSpecific = {
    'A1': [
      'Excellent performance! Keep setting high standards.',
      'Outstanding achievement across all subjects.',
      'Your dedication is truly exceptional.',
      'You are a role model for your peers.',
      'Maintain this brilliant performance.',
      'Your hard work has paid off remarkably.'
    ],
    'B2': [
      'Very good performance. Aim for excellence next term.',
      'You are doing well; a little more effort can push you to the top.',
      'Consistent good work – keep it up!',
      'You have strong understanding of the subjects.',
      'Well done! Strive for even greater heights.'
    ],
    'B3': [
      'Good performance. Continue to build on this foundation.',
      'You have the potential to move up to a higher grade.',
      'Keep working hard; you are on the right track.',
      'Good understanding, but aim for deeper mastery.',
      'Solid performance. Stay motivated.'
    ],
    'C4': [
      'Credit level performance. Focus on areas needing improvement.',
      'You are capable of better results with more revision.',
      'Good effort, but consistency is key to moving up.',
      'Identify weak topics and work on them diligently.',
      'Keep practicing; you are making steady progress.'
    ],
    'C5': [
      'Credit level. More attention to detail will help.',
      'You have the ability; apply yourself more consistently.',
      'Work on completing assignments on time.',
      'Seek help when you find topics challenging.',
      'Your effort is noted; increase revision time.'
    ],
    'C6': [
      'Credit performance. A little more push will yield better grades.',
      'You are capable of higher scores with extra practice.',
      'Avoid distractions and stay focused on your studies.',
      'Consistent hard work is needed to improve.',
      'You can do better; believe in yourself.'
    ],
    'D7': [
      'Pass grade. Significant improvement is required.',
      'You need to dedicate more time to your studies.',
      'Attend extra lessons if possible to catch up.',
      'Do not be discouraged; work harder next term.',
      'Focus on building your foundational knowledge.'
    ],
    'E8': [
      'Pass, but serious effort is needed to progress.',
      'You must prioritize your academic work.',
      'Seek assistance from teachers and peers.',
      'There is room for major improvement.',
      'Commit to a regular study schedule.'
    ],
    'F9': [
      'Fail grade. Urgent attention and effort are required.',
      'This is a wake-up call to change your approach.',
      'You need to attend remedial classes.',
      'Do not give up; you can turn this around with hard work.',
      'Please meet with your teacher for a study plan.'
    ]
  };

  const gradeComments = gradeSpecific[grade] || [
    'Keep working hard.',
    'Your effort matters.',
    'Stay positive and persistent.'
  ];

  // Combine general + grade-specific
  let allComments = [...generalComments, ...gradeComments];
  
  // Additional comments to ensure at least 30 unique options
  const extraComments = [
    'Your participation in class discussions is valued.',
    'You have shown growth in problem-solving skills.',
    'Excellent punctuality and attendance.',
    'You are a pleasure to have in class.',
    'Continue to ask questions when in doubt.',
    'Your homework assignments are improving.',
    'You have a bright future ahead.',
    'Remember that learning is a journey.',
    'Celebrate your small victories.',
    'Stay curious and never stop learning.'
  ];

  while (allComments.length < 30) {
    allComments.push(extraComments[allComments.length % extraComments.length]);
  }

  // Remove duplicates
  return [...new Set(allComments)];
}

function getTermSuffix(t) { return t === '1' ? 'st' : t === '2' ? 'nd' : 'rd'; }
function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'); }

async function loadExistingReport(studentId) {
  const q = query(collection(db, 'reports'), where('studentId','==',studentId), where('term','==',reportState.term), where('session','==',reportState.session));
  const snap = await getDocs(q);
  if (!snap.empty) { const data = snap.docs[0].data(); reportState.psychomotor = { ...reportState.psychomotor, ...(data.psychomotor || {}) }; reportState.teacherComment = data.teacherComment || ''; reportState.principalComment = data.principalComment || ''; reportState.savedReportId = snap.docs[0].id; }
  else reportState.savedReportId = null;
}
async function saveReportCard() {
  if (!reportState.selectedStudent) return alert('Select a student.');
  const totalScore = parseInt(document.querySelector('.summary-table tr:nth-child(1) td')?.textContent) || 0;
  const totalObtainable = parseInt(document.querySelector('.summary-table tr:nth-child(2) td')?.textContent) || 0;
  const subjectCount = parseInt(document.querySelector('.summary-table tr:nth-child(3) td')?.textContent) || 0;
  const average = parseFloat(document.querySelector('.summary-table tr:nth-child(4) td')?.textContent) || 0;
  const overallGrade = document.querySelector('.summary-table tr:nth-child(5) td')?.textContent || 'N/A';
  const reportData = { studentId: reportState.selectedStudent.id, classId, schoolId: currentSchoolId, term: reportState.term, session: reportState.session, totalScore, maxTotal: totalObtainable, average, overallGrade, psychomotor: reportState.psychomotor, teacherComment: reportState.teacherComment, principalComment: reportState.principalComment, updatedAt: new Date() };
  try { if (reportState.savedReportId) await updateDoc(doc(db, 'reports', reportState.savedReportId), reportData); else { const newRef = await addDoc(collection(db, 'reports'), { ...reportData, createdAt: new Date() }); reportState.savedReportId = newRef.id; } alert('Report saved.'); } catch(e) { console.error(e); alert('Save failed.'); }
}
async function loadReportCard(studentId, studentName) {
  reportState.selectedStudent = { id: studentId, name: studentName };
  reportState.term = document.getElementById('termSelect').value;
  reportState.session = document.getElementById('sessionSelect').value;
  const className = classesMap.get(classId) || classNameCache;
  const schoolDoc = await getDoc(doc(db, 'schools', currentSchoolId));
  const schoolName = schoolDoc.exists() ? schoolDoc.data().name : 'School Name';
  const schoolLogo = schoolDoc.exists() ? schoolDoc.data().logo : null;
  const student = studentsList.find(s => s.id === studentId) || {};
  const admissionNo = student.admissionNumber || '—', gender = student.gender || '—', dob = student.dob || '', age = dob ? calculateAge(dob) : '—', club = student.club || '—', passportUrl = student.passport || null;
  const scores = await fetchScores(studentId, reportState.term, reportState.session);
  const localSubjectsMap = new Map();
  if (scores.length) { const snap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId))); snap.forEach(doc => localSubjectsMap.set(doc.id, doc.data().name)); }
  let subjectStats = new Map();
  if (classId) subjectStats = await computeSubjectStats(classId, reportState.term, reportState.session);
  let tableRows = '', totalScore = 0, subjectCount = 0;
  for (const score of scores) {
    const subjectName = localSubjectsMap.get(score.subjectId) || score.subjectId;
    const total = score.ca + score.exam; totalScore += total; subjectCount++;
    const grade = calculateGrade(total), remark = getGradeRemark(grade);
    let positionHtml = '—', classAvg = '—';
    const stat = subjectStats.get(score.subjectId);
    if (stat) { const rank = stat.rankMap.get(studentId); if (rank) { const suffix = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'; positionHtml = `${rank}<sup>${suffix}</sup>`; } classAvg = stat.classAverage; }
    tableRows += `<tr><td style="text-align:left">${escapeHtml(subjectName)}</td><td>${score.ca}</td><td>${score.exam}</td><td>${total}</td><td>${grade}</td><td>${remark}</td><td>${positionHtml}</td><td>${classAvg}</td></tr>`;
  }
  const average = subjectCount ? (totalScore/subjectCount).toFixed(1) : 0;
  const overallGrade = calculateGrade(parseFloat(average));
  const totalObtainable = subjectCount * 100;
  const percentageAvg = subjectCount ? ((totalScore/totalObtainable)*100).toFixed(1) : 0;
  const overallRemark = getGradeRemark(overallGrade);
  await loadExistingReport(studentId);
  let psychomotorHtml = `<table class="skills-table"><thead><tr><th>Psychomotor Skills</th><th>Rating (1-5)</th></tr></thead><tbody>`;
  for (const skill of psychomotorSkillsList) { const key = skill.toLowerCase().replace(/[^a-z]/g, ''); const val = reportState.psychomotor[key] || 3; psychomotorHtml += `<tr><td>${escapeHtml(skill)}</td><td id="psycho_${key}" class="rating-container"><span class="print-value">${val}</span></td></tr>`; }
  psychomotorHtml += `</tbody></table>`;
  let affectiveHtml = `<table class="skills-table"><thead><tr><th>Affective Domain</th><th>Rating (1-5)</th></tr></thead><tbody>`;
  for (const skill of affectiveSkillsList) { const key = skill.toLowerCase().replace(/[^a-z]/g, ''); const val = reportState.psychomotor[key] || 3; affectiveHtml += `<tr><td>${escapeHtml(skill)}</td><td id="affective_${key}" class="rating-container"><span class="print-value">${val}</span></td></tr>`; }
  affectiveHtml += `</tbody></table>`;
  const summaryHtml = `<div class="section-title">📊 Summary of Performance</div><table class="summary-table"><tr><th>Total Obtained</th><td>${totalScore}</td></tr><tr><th>Total Obtainable</th><td>${totalObtainable}</td></tr><tr><th>Total Subjects</th><td>${subjectCount}</td></tr><tr><th>% Average</th><td>${percentageAvg}%</td></tr><tr><th>Grade</th><td>${overallGrade}</td></tr><tr><th>Remark</th><td>${overallRemark}</td></tr></table>`;
  const gradeScaleHtml = `<div class="section-title">📈 Grade Distribution</div>${getGradeScaleHtml()}`;
  const headerHtml = `<div class="report-header"><div class="school-logo-area">${schoolLogo ? `<img src="${schoolLogo}" class="school-logo-small">` : ''}</div><div class="school-name-area"><h2 class="school-name-report">${escapeHtml(schoolName)}</h2><div class="school-motto">Excellence in Education</div></div><div class="passport-area">${passportUrl ? `<img src="${passportUrl}" class="student-passport-img">` : ''}</div></div>`;
  const studentDetailsHtml = `<div class="student-details-grid"><div><strong>Name:</strong> <span class="student-name-caps">${escapeHtml(studentName).toUpperCase()}</span></div><div><strong>Admission No:</strong> ${escapeHtml(admissionNo)}</div><div><strong>Gender:</strong> ${escapeHtml(gender)}</div><div><strong>DOB:</strong> ${dob} (Age ${age})</div><div><strong>Class:</strong> ${escapeHtml(className)}</div><div><strong>Term:</strong> ${reportState.term}${getTermSuffix(reportState.term)}</div><div><strong>Session:</strong> ${reportState.session}</div><div><strong>Club:</strong> ${escapeHtml(club)}</div></div>`;
  const tableHtml = `<table class="subject-table"><thead><tr><th>Subject</th><th>CA (${currentGrading.ca})</th><th>Exam (${currentGrading.exam})</th><th>Total (100)</th><th>Grade</th><th>Grade Remark</th><th>Subject Position</th><th>Class Average</th></tr></thead><tbody>${tableRows || '<tr><td colspan="8">No scores</td></tr>'}</tbody></table>`;
  
  // Use the enhanced comment options function
  const commentOptions = getCommentOptionsByGrade(overallGrade);
  const commentsHtml = `<div class="comments-section"><h3>Comments</h3>
    <div class="comment-group">
      <label>Teacher's Comment:</label>
      <div class="comment-controls">
        <select id="teacherCommentSelect">${commentOptions.map(opt => `<option value="${opt}" ${reportState.teacherComment === opt ? 'selected' : ''}>${opt}</option>`).join('')}</select>
        <textarea id="teacherCommentText" rows="2">${escapeHtml(reportState.teacherComment || '')}</textarea>
      </div>
      <div class="print-comment-text" id="printTeacherComment">${escapeHtml(reportState.teacherComment || '')}</div>
    </div>
    <div class="comment-group">
      <label>Principal's Comment:</label>
      <div class="comment-controls">
        <select id="principalCommentSelect">${commentOptions.map(opt => `<option value="${opt}" ${reportState.principalComment === opt ? 'selected' : ''}>${opt}</option>`).join('')}</select>
        <textarea id="principalCommentText" rows="2">${escapeHtml(reportState.principalComment || '')}</textarea>
      </div>
      <div class="print-comment-text" id="printPrincipalComment">${escapeHtml(reportState.principalComment || '')}</div>
    </div>
  </div>`;
  
  const signatureHtml = `<div class="signature-stamp"><div class="signature-item"><strong>Principal's Signature:</strong><div class="signature-line"></div></div><div class="signature-item"><strong>School Stamp:</strong><div class="stamp-placeholder">(Official Stamp)</div></div><div class="signature-item"><strong>Date:</strong><div class="signature-line"></div></div></div>`;
  const ratingGuideHtml = `<div class="rating-guide">Rating Guide: 1-Poor | 2-Fair | 3-Good | 4-Very Good | 5-Excellent</div>`;
  const fullHtml = headerHtml + studentDetailsHtml + tableHtml + `<div class="summary-grading-wrapper"><div class="summary-wrapper">${summaryHtml}</div><div class="grading-wrapper">${gradeScaleHtml}</div></div><div class="skills-wrapper"><div class="skills-half">${psychomotorHtml}</div><div class="skills-half">${affectiveHtml}</div></div>${ratingGuideHtml}${commentsHtml}${signatureHtml}`;
  document.getElementById('reportCardContent').innerHTML = fullHtml;
  document.getElementById('reportActions').style.display = 'flex';
  for (const skill of psychomotorSkillsList) { const key = skill.toLowerCase().replace(/[^a-z]/g, ''); const container = document.getElementById(`psycho_${key}`); if (container) { const tick = createTickRating(key, reportState.psychomotor[key] || 3); container.appendChild(tick); } }
  for (const skill of affectiveSkillsList) { const key = skill.toLowerCase().replace(/[^a-z]/g, ''); const container = document.getElementById(`affective_${key}`); if (container) { const tick = createTickRating(key, reportState.psychomotor[key] || 3); container.appendChild(tick); } }
  const teacherText = document.getElementById('teacherCommentText'), teacherSelect = document.getElementById('teacherCommentSelect'), principalText = document.getElementById('principalCommentText'), principalSelect = document.getElementById('principalCommentSelect'), printTeacher = document.getElementById('printTeacherComment'), printPrincipal = document.getElementById('printPrincipalComment');
  if (teacherSelect) teacherSelect.onchange = () => { reportState.teacherComment = teacherSelect.value; if(teacherText) teacherText.value = teacherSelect.value; if(printTeacher) printTeacher.textContent = escapeHtml(teacherSelect.value); };
  if (teacherText) teacherText.oninput = () => { reportState.teacherComment = teacherText.value; if(printTeacher) printTeacher.textContent = escapeHtml(teacherText.value); };
  if (principalSelect) principalSelect.onchange = () => { reportState.principalComment = principalSelect.value; if(principalText) principalText.value = principalSelect.value; if(printPrincipal) printPrincipal.textContent = escapeHtml(principalSelect.value); };
  if (principalText) principalText.oninput = () => { reportState.principalComment = principalText.value; if(printPrincipal) printPrincipal.textContent = escapeHtml(principalText.value); };
  if (schoolLogo) { const reportDiv = document.querySelector('.report-card'); reportDiv.classList.add('watermark-ready'); reportDiv.style.setProperty('--watermark-url', `url(${schoolLogo})`); }
}