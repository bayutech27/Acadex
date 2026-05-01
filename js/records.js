// records.js - Archive viewer with identical rendering to results.js + level‑based subjects + one‑page print
import { db } from './firebase-config.js';
import {
  collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, setDoc, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId } from './admin.js';
import { renderReportCardUI } from './reportCardRenderer.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

// ------------------- Global State -------------------
let currentSchoolId = null;
let classesMap = new Map();          // id -> { name, level }
let subjectsMap = new Map();          // id -> { name, level }
let allSubjectsList = [];              // Array of { id, name, level }
let studentsList = [];
let unsubscribeSub = null;

let currentReportState = {
  selectedStudent: null, term: '', session: '', psychomotor: {},
  teacherComment: '', principalComment: '', attendance: { schoolOpened: 0, present: 0, absent: 0 }, savedReportId: null
};

// ------------------- Helper Functions -------------------
function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'); }
function getTermSuffix(t) { return t === '1' ? 'st' : t === '2' ? 'nd' : 'rd'; }
function calculateAge(dobString) {
  if (!dobString) return null;
  const birthDate = new Date(dobString);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
  return age;
}
function getSkillKey(skill) { return skill.toLowerCase().replace(/[^a-z]/g, ''); }
function getDefaultRatings() {
  const psychomotorSkillsList = ['Handling of tools', 'Public Speaking', 'Speech Fluency', 'Handwriting', 'Sport and Game', 'Drawing/Painting'];
  const affectiveSkillsList = ['Attentiveness', 'Neatness', 'Honesty', 'Politeness', 'Punctuality', 'Self-control/Calmness', 'Obedience', 'Reliability', 'Relationship with others', 'Leadership'];
  const defaults = {};
  [...psychomotorSkillsList, ...affectiveSkillsList].forEach(skill => { defaults[getSkillKey(skill)] = 3; });
  return defaults;
}
function resetRatingsToDefaults() { currentReportState.psychomotor = getDefaultRatings(); }

function getScoringDocId(session, term, level) {
  return `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}_${level}`;
}
function generateSessionOptions() {
  const year = new Date().getFullYear();
  let opts = [];
  for (let i = 0; i < 5; i++) opts.push(`${year - i}/${year - i + 1}`);
  return opts;
}
function getSubjectsByLevel(level) {
  if (!level) return allSubjectsList;
  return allSubjectsList.filter(subj => !subj.level || subj.level === level);
}

// ------------------- Data Loading (with subject level) -------------------
async function loadClassesAndSubjects() {
  try {
    const classesSnap = await getDocs(query(collection(db, 'classes'), where('schoolId', '==', currentSchoolId)));
    classesMap.clear();
    classesSnap.forEach(doc => classesMap.set(doc.id, { name: doc.data().name, level: doc.data().level }));

    const subjSnap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId)));
    subjectsMap.clear();
    allSubjectsList = [];
    subjSnap.forEach(doc => {
      const data = doc.data();
      subjectsMap.set(doc.id, { name: data.name, level: data.level || null });
      allSubjectsList.push({ id: doc.id, name: data.name, level: data.level || null });
    });
  } catch (err) { handleError(err, "Failed to load classes/subjects."); throw err; }
}
async function loadAllStudents() {
  try {
    const snap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', currentSchoolId)));
    studentsList = snap.docs.map(doc => ({
      id: doc.id, name: doc.data().name, classId: doc.data().classId, level: doc.data().level || 'secondary',
      admissionNumber: doc.data().admissionNumber || '—', gender: doc.data().gender || '—',
      dob: doc.data().dob || '', club: doc.data().club || '—', passport: doc.data().passport || null,
      subjects: doc.data().subjects || []
    }));
  } catch (err) { handleError(err, "Failed to load students."); throw err; }
}

// ------------------- Level‑aware Grading -------------------
async function loadScoringSetting(session, term, level) {
  try {
    const docId = getScoringDocId(session, term, level);
    const docSnap = await getDoc(doc(db, 'scoring', docId));
    let grading = '40/60';
    if (docSnap.exists()) grading = docSnap.data().grading;
    const [ca, exam] = grading.split('/').map(Number);
    return { ca, exam };
  } catch (err) { return { ca: 40, exam: 60 }; }
}

// ------------------- Scores & Stats -------------------
async function fetchStudentScores(studentId, term, session) {
  try {
    const q = query(collection(db, 'scores'), where('studentId', '==', studentId), where('schoolId', '==', currentSchoolId), where('term', '==', term), where('session', '==', session));
    const snap = await getDocs(q);
    return snap.docs.map(doc => ({ subjectId: doc.data().subjectId, ca: doc.data().ca, exam: doc.data().exam }));
  } catch (err) { return []; }
}
async function fetchClassScores(classId, term, session) {
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return [];
  const studentIds = classStudents.map(s => s.id);
  const scores = [];
  for (let i = 0; i < studentIds.length; i += 30) {
    const chunk = studentIds.slice(i, i+30);
    const q = query(collection(db, 'scores'), where('studentId', 'in', chunk), where('schoolId', '==', currentSchoolId), where('term', '==', term), where('session', '==', session));
    const snap = await getDocs(q);
    snap.forEach(doc => scores.push({ ...doc.data(), id: doc.id }));
  }
  return scores;
}
async function computeSubjectStats(classId, term, session) {
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return new Map();
  const allScores = await fetchClassScores(classId, term, session);
  const subjectMap = new Map();
  for (const subjId of subjectsMap.keys()) subjectMap.set(subjId, { totals: [], classAverage: 0, rankMap: new Map() });
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

// ------------------- Helper: Get relevant subjects (level + have scores) -------------------
async function getRelevantSubjectsForClass(classId, term, session) {
  const classInfo = classesMap.get(classId);
  if (!classInfo) return [];
  const classLevel = classInfo.level;
  let levelSubjects = allSubjectsList.filter(subj => subj.level === classLevel);
  if (levelSubjects.length === 0) levelSubjects = allSubjectsList;
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return levelSubjects;
  const studentIds = classStudents.map(s => s.id);
  const subjectIdsWithScores = new Set();
  for (let i = 0; i < studentIds.length; i += 30) {
    const chunk = studentIds.slice(i, i+30);
    const q = query(
      collection(db, 'scores'),
      where('studentId', 'in', chunk),
      where('schoolId', '==', currentSchoolId),
      where('term', '==', term),
      where('session', '==', session)
    );
    const snap = await getDocs(q);
    snap.forEach(doc => subjectIdsWithScores.add(doc.data().subjectId));
  }
  return levelSubjects.filter(subj => subjectIdsWithScores.has(subj.id));
}

// ------------------- Report Card Rendering (Level‑based) -------------------
async function loadExistingReport(studentId, term, session) {
  resetRatingsToDefaults();
  try {
    const q = query(collection(db, 'reports'), where('studentId', '==', studentId), where('schoolId', '==', currentSchoolId), where('term', '==', term), where('session', '==', session));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const data = snap.docs[0].data();
      if (data.psychomotor) Object.assign(currentReportState.psychomotor, data.psychomotor);
      currentReportState.teacherComment = data.teacherComment || '';
      currentReportState.principalComment = data.principalComment || '';
      currentReportState.attendance = data.attendance || { schoolOpened: 0, present: 0, absent: 0 };
      currentReportState.savedReportId = snap.docs[0].id;
    } else { currentReportState.savedReportId = null; }
  } catch (err) { handleError(err, "Failed to load existing report."); }
}

async function renderStudentReportCard(studentId, studentName, classId, session, term) {
  currentReportState.selectedStudent = { id: studentId, name: studentName };
  currentReportState.term = term;
  currentReportState.session = session;
  const classInfo = classesMap.get(classId);
  const className = classInfo?.name || 'Class';
  const classLevel = classInfo?.level || 'secondary';
  const isPrimary = (classLevel === 'primary');
  let grading = { ca: 40, exam: 60 };
  try { grading = await loadScoringSetting(session, term, classLevel); } catch(e) {}
  
  const relevantSubjects = await getRelevantSubjectsForClass(classId, term, session);
  const subjectIds = new Set(relevantSubjects.map(s => s.id));
  
  await loadExistingReport(studentId, term, session);
  
  showLoader();
  try {
    const schoolDoc = await getDoc(doc(db, 'schools', currentSchoolId));
    const school = {
      name: schoolDoc.exists() ? schoolDoc.data().name : 'School Name',
      address: schoolDoc.exists() ? schoolDoc.data().address : '',
      logo: schoolDoc.exists() ? schoolDoc.data().logo : null
    };
    const student = studentsList.find(s => s.id === studentId) || {};
    const scoresRaw = await fetchStudentScores(studentId, term, session);
    const scoresWithNames = scoresRaw.filter(s => subjectIds.has(s.subjectId)).map(score => ({
      subjectId: score.subjectId,
      subjectName: subjectsMap.get(score.subjectId)?.name || score.subjectId,
      ca: score.ca,
      exam: score.exam
    }));
    const fullStats = await computeSubjectStats(classId, term, session);
    const subjectStats = new Map();
    for (let [subjId, stat] of fullStats) if (subjectIds.has(subjId)) subjectStats.set(subjId, stat);
    
    const studentData = {
      id: studentId, name: studentName, admissionNumber: student.admissionNumber || '—',
      gender: student.gender || '—', dob: student.dob || '', club: student.club || '—',
      passport: student.passport || null
    };
    
    renderReportCardUI({
      student: studentData, scores: scoresWithNames, className, school, grading,
      psychomotor: currentReportState.psychomotor,
      comments: { teacherComment: currentReportState.teacherComment, principalComment: currentReportState.principalComment },
      attendance: currentReportState.attendance, term, session, subjectStats,
      container: document.getElementById('reportCardContent'), isPrimary,
      onRatingChange: (key,val) => { currentReportState.psychomotor[key] = val; },
      onTeacherCommentChange: (val) => { currentReportState.teacherComment = val; },
      onPrincipalCommentChange: (val) => { currentReportState.principalComment = val; }
    });
    
    const reportActions = document.getElementById('reportActions');
    if (reportActions) reportActions.style.display = 'flex';
  } catch (err) { handleError(err, "Failed to render report card."); } finally { hideLoader(); }
}

async function saveReportCard() {
  if (!currentReportState.selectedStudent) { showNotification("Select a student.", "error"); return; }
  const schoolOpened = parseInt(document.querySelector('.attendance-input.school-opened')?.value) || 0;
  const present = parseInt(document.querySelector('.attendance-input.present')?.value) || 0;
  const absent = parseInt(document.querySelector('.attendance-input.absent')?.value) || 0;
  const attendance = { schoolOpened, present, absent };
  const totalScore = parseInt(document.querySelector('.summary-table tr:nth-child(1) td')?.textContent) || 0;
  const totalObtainable = parseInt(document.querySelector('.summary-table tr:nth-child(2) td')?.textContent) || 0;
  const average = parseFloat(document.querySelector('.summary-table tr:nth-child(4) td')?.textContent) || 0;
  const overallGrade = document.querySelector('.summary-table tr:nth-child(5) td')?.textContent || 'N/A';
  const reportData = {
    studentId: currentReportState.selectedStudent.id, classId: document.getElementById('classSelect').value,
    schoolId: currentSchoolId, term: currentReportState.term, session: currentReportState.session,
    totalScore, maxTotal: totalObtainable, average, overallGrade, psychomotor: currentReportState.psychomotor,
    teacherComment: currentReportState.teacherComment, principalComment: currentReportState.principalComment,
    attendance, updatedAt: new Date()
  };
  showLoader();
  try {
    if (currentReportState.savedReportId) {
      await updateDoc(doc(db, 'reports', currentReportState.savedReportId), reportData);
    } else {
      const newRef = await addDoc(collection(db, 'reports'), { ...reportData, createdAt: new Date() });
      currentReportState.savedReportId = newRef.id;
    }
    showNotification("Report saved.", "success");
  } catch (err) { handleError(err, "Save failed."); } finally { hideLoader(); }
}

// ------------------- Print / PDF (one page, no overlap) -------------------
function printReportCard() {
  const teacherText = document.getElementById('teacherCommentText');
  const printTeacher = document.getElementById('printTeacherComment');
  if (teacherText && printTeacher) printTeacher.textContent = escapeHtml(teacherText.value);
  const principalText = document.getElementById('principalCommentText');
  const printPrincipal = document.getElementById('printPrincipalComment');
  if (principalText && printPrincipal) printPrincipal.textContent = escapeHtml(principalText.value);
  
  const reportContent = document.getElementById('reportCardContent');
  if (!reportContent || reportContent.children.length === 0) { showNotification("Report not ready.", "error"); return; }
  const cloned = reportContent.cloneNode(true);
  const printWindow = window.open('', '_blank');
  if (!printWindow) { showNotification("Please allow popups.", "error"); return; }
  
  const externalCssUrl = new URL('../css/styles.css', window.location.href).href;
  const inlineStyles = Array.from(document.querySelectorAll('style')).map(style => style.innerHTML).join('\n');
  
  const extraPrintCSS = `
    .report-card, .report-card * {
      page-break-inside: avoid;
      page-break-after: avoid;
      page-break-before: avoid;
    }
    @page {
      size: A4;
      margin: 5mm;
    }
    body, .print-container {
      margin: 0;
      padding: 0;
      background: white;
    }
    .print-container {
      width: 100%;
      max-width: 210mm;
      margin: 0 auto;
    }
    .report-card {
      padding: 2px !important;
      margin: 0 !important;
      font-size: 8px !important;
      line-height: 1.2;
    }
    .subject-table {
      font-size: 5.5px !important;
    }
    .subject-table th, .subject-table td {
      padding: 2px 2px !important;
    }
    .subject-table th:not(:first-child) {
      height: 45px !important;
      width: 24px !important;
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      font-size: 5px;
    }
    .student-details-grid {
      font-size: 6px !important;
    }
    .skills-table, .summary-table, .grade-scale-table {
      font-size: 5px !important;
    }
    .skills-table th, .skills-table td,
    .summary-table th, .summary-table td {
      padding: 1px 2px !important;
    }
    .comments-section {
      font-size: 7px !important;
      margin-top: 2px !important;
    }
    .signature-stamp {
      margin-top: 2px !important;
      padding-top: 2px !important;
    }
    .rating-tick, select, textarea, button, .comment-controls, .tick {
      display: none !important;
    }
    .print-value, .print-comment-text {
      display: block !important;
    }
    .report-card, .report-card * {
      overflow: visible !important;
    }
  `;
  
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Report Card</title>
    <link rel="stylesheet" href="${externalCssUrl}">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { background: white; margin: 0; padding: 0; display: flex; justify-content: center; font-family: 'Segoe UI', sans-serif; }
      .print-container { width: 210mm; margin: 0 auto; background: white; }
      ${inlineStyles}
      ${extraPrintCSS}
    </style>
    </head>
    <body><div class="print-container">${cloned.outerHTML}</div></body>
    </html>
  `);
  printWindow.document.close();
  setTimeout(() => { printWindow.focus(); printWindow.print(); }, 300);
}

// ------------------- Broadsheet Functions (Level‑based, using getRelevantSubjectsForClass) -------------------
async function getStudentAverageForTerm(studentId, term, session) {
  const scores = await fetchStudentScores(studentId, term, session);
  if (!scores.length) return null;
  let total = 0, count = 0;
  for (const s of scores) { total += (s.ca || 0) + (s.exam || 0); count++; }
  if (count === 0) return null;
  return ((total / (count * 100)) * 100).toFixed(1);
}

async function generateBroadsheet(classId, session, term) {
  const classInfo = classesMap.get(classId);
  const className = classInfo?.name || 'Class';
  const classLevel = classInfo?.level;
  
  const relevantSubjects = await getRelevantSubjectsForClass(classId, term, session);
  if (relevantSubjects.length === 0) return '<div class="alert">No subjects found for the selected class level or no scores available.</div>';
  
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return '<div class="alert">No students found.</div>';
  
  const allScores = await fetchClassScores(classId, term, session);
  const scoresByStudent = new Map();
  for (const score of allScores) {
    if (!scoresByStudent.has(score.studentId)) scoresByStudent.set(score.studentId, []);
    scoresByStudent.get(score.studentId).push(score);
  }
  const term1Averages = new Map(), term2Averages = new Map(), term3Averages = new Map();
  for (const student of classStudents) {
    const avg1 = await getStudentAverageForTerm(student.id, '1', session);
    const avg2 = await getStudentAverageForTerm(student.id, '2', session);
    const avg3 = await getStudentAverageForTerm(student.id, '3', session);
    term1Averages.set(student.id, avg1 ? parseFloat(avg1) : null);
    term2Averages.set(student.id, avg2 ? parseFloat(avg2) : null);
    term3Averages.set(student.id, avg3 ? parseFloat(avg3) : null);
  }
  const studentResults = [];
  for (const student of classStudents) {
    const scores = scoresByStudent.get(student.id) || [];
    const scoreMap = new Map();
    scores.forEach(s => scoreMap.set(s.subjectId, { ca: s.ca, exam: s.exam, total: s.ca + s.exam }));
    let totalScore = 0;
    const subjectDetails = [];
    for (const subj of relevantSubjects) {
      const { ca = 0, exam = 0, total = 0 } = scoreMap.get(subj.id) || {};
      totalScore += total;
      subjectDetails.push({ subjectName: subj.name, ca, exam, total });
    }
    const totalObtainable = relevantSubjects.length * 100;
    const average = totalObtainable ? (totalScore / totalObtainable) * 100 : 0;
    let grade = 'F9', remark = 'Fail';
    if (classLevel === 'primary') {
      if (average >= 90) grade = 'A+'; else if (average >= 80) grade = 'A'; else if (average >= 70) grade = 'B+';
      else if (average >= 60) grade = 'B'; else if (average >= 50) grade = 'C'; else if (average >= 40) grade = 'D';
      else grade = 'F';
      const remarks = { 'A+':'Exceptional','A':'Excellent','B+':'Very Good','B':'Good','C':'Fairly Good','D':'Pass','F':'Fail' };
      remark = remarks[grade] || '';
    } else {
      if (average >= 85) grade = 'A1'; else if (average >= 75) grade = 'B2'; else if (average >= 70) grade = 'B3';
      else if (average >= 65) grade = 'C4'; else if (average >= 60) grade = 'C5'; else if (average >= 50) grade = 'C6';
      else if (average >= 45) grade = 'D7'; else if (average >= 40) grade = 'E8'; else grade = 'F9';
      const remarks = { A1:'Excellent',B2:'Very Good',B3:'Good',C4:'Credit',C5:'Credit',C6:'Credit',D7:'Pass',E8:'Pass',F9:'Fail' };
      remark = remarks[grade] || '';
    }
    const termValues = [term1Averages.get(student.id), term2Averages.get(student.id), term3Averages.get(student.id)].filter(v => v !== null);
    let combinedAvg = termValues.length ? (termValues.reduce((a,b)=>a+b,0)/termValues.length).toFixed(1) : null;
    studentResults.push({
      studentId: student.id, studentName: student.name, totalScore, average, grade, remark, subjectDetails,
      term1Avg: term1Averages.get(student.id) !== null ? term1Averages.get(student.id).toFixed(1)+'%' : '—',
      term2Avg: term2Averages.get(student.id) !== null ? term2Averages.get(student.id).toFixed(1)+'%' : '—',
      term3Avg: term3Averages.get(student.id) !== null ? term3Averages.get(student.id).toFixed(1)+'%' : '—',
      combinedAvg: combinedAvg ? combinedAvg+'%' : '—'
    });
  }
  studentResults.sort((a,b) => b.totalScore - a.totalScore);
  let rank = 1;
  for (let i=0; i<studentResults.length; i++) {
    if (i>0 && studentResults[i].totalScore < studentResults[i-1].totalScore) rank = i+1;
    studentResults[i].position = rank;
  }
  let html = `<div style="margin-bottom:1rem;"><h3>BROADSHEET – ${escapeHtml(className)} – ${session} – ${term}</h3></div>`;
  html += `<div class="table-responsive-wrapper"><table class="broadsheet-table" border="1" cellpadding="5" cellspacing="0"><thead>`;
  html += `<tr><th>S/N</th><th>Student Name</th>`;
  for (const subj of relevantSubjects) html += `<th colspan="3">${escapeHtml(subj.name)}</th>`;
  html += `<th>Total</th><th>1st Term</th><th>2nd Term</th><th>3rd Term</th><th>% Avg Total</th><th>Grade</th><th>Position</th><th>Remark</th></tr>`;
  html += `<tr><th></th><th></th>`;
  for (let i=0; i<relevantSubjects.length; i++) html += `<th>CA</th><th>Exam</th><th>Total</th>`;
  html += `<th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th></tr></thead><tbody>`;
  for (let i=0; i<studentResults.length; i++) {
    const r = studentResults[i];
    html += `<tr>`;
    html += `<td>${i+1}</td>`;
    html += `<td class="student-name-cell">${escapeHtml(r.studentName)}</td>`;
    for (const sub of r.subjectDetails) html += `<td>${sub.ca}</td><td>${sub.exam}</td><td>${sub.total}</td>`;
    html += `<td>${r.totalScore}</td>`;
    html += `<td>${r.term1Avg}</td>`;
    html += `<td>${r.term2Avg}</td>`;
    html += `<td>${r.term3Avg}</td>`;
    html += `<td>${r.combinedAvg}</td>`;
    html += `<td>${r.grade}</td>`;
    html += `<td>${r.position}${r.position===1?'st':r.position===2?'nd':r.position===3?'rd':'th'}</td>`;
    html += `<td>${r.remark}</td>`;
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
}

function printBroadsheet() {
  const broadsheetDiv = document.getElementById('currentBroadsheetContainer');
  if (!broadsheetDiv || !broadsheetDiv.querySelector('.broadsheet-table')) {
    showNotification("No broadsheet data to print.", "error");
    return;
  }
  const cloned = broadsheetDiv.cloneNode(true);
  const printWindow = window.open('', '_blank');
  if (!printWindow) { showNotification("Please allow popups.", "error"); return; }
  printWindow.document.write(`
    <!DOCTYPE html><html><head><title>Broadsheet</title>
    <style>
      body { margin: 20px; font-family: 'Segoe UI', sans-serif; }
      .broadsheet-table { width: 100%; border-collapse: collapse; font-size: 11px; }
      .broadsheet-table th, .broadsheet-table td { border: 1px solid #000; padding: 6px 4px; text-align: center; }
      .student-name-cell { text-align: left; }
      @media print { @page { size: landscape; margin: 1cm; } body { margin: 0; } }
    </style>
    </head><body>${cloned.outerHTML}</body></html>
  `);
  printWindow.document.close();
  setTimeout(() => { printWindow.focus(); printWindow.print(); }, 300);
}

// ------------------- Document Type Handler -------------------
async function onGetDoc() {
  const classId = document.getElementById('classSelect')?.value;
  const session = document.getElementById('sessionSelect')?.value;
  const term = document.getElementById('termSelect')?.value;
  const docType = document.getElementById('docTypeSelect')?.value;
  if (!classId || !session || !term || !docType) {
    showNotification("Please select Class, Session, Term, and Document Type.", "error");
    return;
  }
  const container = document.getElementById('recordsList');
  if (!container) return;
  if (docType === 'report') {
    const classStudents = studentsList.filter(s => s.classId === classId);
    if (!classStudents.length) { container.innerHTML = '<div class="no-data">No students found.</div>'; return; }
    const editorHtml = `
      <div class="report-editor-container">
        <div class="student-list-panel"><h3>👩‍🎓 Students</h3><div id="studentListContainer"></div></div>
        <div class="report-card-panel" id="reportCardArea">
          <div id="reportCardContainer">
            <div id="reportCardContent" class="report-card"><p>Select a student</p></div>
            <div id="reportActions" class="action-buttons" style="display:none;">
              <button id="saveReportBtn" class="btn-primary">💾 Save Report</button>
              <button id="printReportBtn" class="btn-secondary">🖨️ Print / PDF</button>
            </div>
          </div>
        </div>
      </div>`;
    container.innerHTML = editorHtml;
    const studentContainer = document.getElementById('studentListContainer');
    if (studentContainer) {
      let studentHtml = '';
      classStudents.forEach(s => {
        studentHtml += `<div class="student-list-item" data-id="${s.id}" data-name="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>`;
      });
      studentContainer.innerHTML = studentHtml;
    }
    document.querySelectorAll('.student-list-item').forEach(el => {
      el.addEventListener('click', async () => {
        document.querySelectorAll('.student-list-item').forEach(i => i.classList.remove('active'));
        el.classList.add('active');
        await renderStudentReportCard(el.dataset.id, el.dataset.name, classId, session, term);
      });
    });
    const first = document.querySelector('.student-list-item');
    if (first) { first.classList.add('active'); await renderStudentReportCard(first.dataset.id, first.dataset.name, classId, session, term); }
    const saveBtn = document.getElementById('saveReportBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveReportCard);
    const printBtn = document.getElementById('printReportBtn');
    if (printBtn) printBtn.addEventListener('click', printReportCard);
  } else if (docType === 'broadsheet') {
    const broadsheetHtml = await generateBroadsheet(classId, session, term);
    container.innerHTML = `<div id="currentBroadsheetContainer" class="table-responsive-wrapper">${broadsheetHtml}</div>`;
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'action-buttons';
    actionsDiv.style.marginTop = '16px';
    actionsDiv.style.display = 'flex';
    actionsDiv.style.gap = '12px';
    actionsDiv.style.justifyContent = 'flex-end';
    const printBtn = document.createElement('button');
    printBtn.className = 'btn-secondary';
    printBtn.textContent = '🖨️ Print / PDF';
    printBtn.addEventListener('click', printBroadsheet);
    actionsDiv.appendChild(printBtn);
    container.appendChild(actionsDiv);
  }
}

// ------------------- Subscription Payment Banner -------------------
function injectSubscriptionUI() {
  if (!document.getElementById('paymentBannerContainer')) {
    const contentDiv = document.querySelector('.content');
    if (contentDiv) {
      const pd = document.createElement('div');
      pd.id = 'paymentBannerContainer';
      pd.style.margin = '16px 0';
      contentDiv.insertBefore(pd, contentDiv.firstChild);
    }
  }
}
function showPaymentBanner() {
  const container = document.getElementById('paymentBannerContainer');
  if (!container) return;
  const existing = document.getElementById('paymentBanner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'paymentBanner';
  banner.className = 'payment-banner';
  banner.innerHTML = `
    <div><h3>💰 Activate Your Subscription</h3><p>Pay via Paystack or WhatsApp.</p></div>
    <div><button id="paystackPaymentBtn" class="paystack-btn">💳 Pay Now</button>
    <a href="https://wa.me/2349044784225?text=Hello%20Acadex%2C%20I%20want%20to%20renew%20my%20subscription" target="_blank" class="whatsapp-btn">WhatsApp</a></div>`;
  container.appendChild(banner);
  document.getElementById('paystackPaymentBtn')?.addEventListener('click', () => window.open('https://paystack.shop/pay/fmj267paou', '_blank'));
}
function hidePaymentBanner() { document.getElementById('paymentBanner')?.remove(); }
async function setupSubscriptionUI() { injectSubscriptionUI(); hidePaymentBanner(); }
async function initSubscriptionListener() {
  if (!currentSchoolId) return;
  if (window._unsubRecords) window._unsubRecords();
  const subRef = doc(db, 'schools', currentSchoolId, 'subscription', 'current');
  window._unsubRecords = onSnapshot(subRef, (snap) => {
    if (!snap.exists()) return showPaymentBanner();
    const sub = snap.data();
    (sub.status === 'active' && sub.locked === false) ? hidePaymentBanner() : showPaymentBanner();
  }, (err) => handleError(err, "Subscription listener error."));
}

// ------------------- Initialization -------------------
export async function initRecordsPage() {
  currentSchoolId = await getCurrentSchoolId();
  if (!currentSchoolId) { showNotification("School ID missing.", "error"); return; }
  await loadClassesAndSubjects();
  await loadAllStudents();
  const classSelect = document.getElementById('classSelect');
  if (classSelect) {
    classSelect.innerHTML = '<option value="">Select Class</option>';
    classesMap.forEach((info, id) => { classSelect.appendChild(new Option(info.name, id)); });
  }
  const sessions = generateSessionOptions();
  const sessionSelect = document.getElementById('sessionSelect');
  if (sessionSelect) {
    sessionSelect.innerHTML = '<option value="">Select Session</option>';
    sessions.forEach(s => { sessionSelect.appendChild(new Option(s, s)); });
  }
  const termSelect = document.getElementById('termSelect');
  if (termSelect) termSelect.innerHTML = '<option value="">Select Term</option><option value="1">1st Term</option><option value="2">2nd Term</option><option value="3">3rd Term</option>';
  document.getElementById('getDocBtn')?.addEventListener('click', onGetDoc);
  setupSubscriptionUI();
  initSubscriptionListener();
  const container = document.getElementById('recordsList');
  if (container) container.innerHTML = `<div class="no-data"><p>Please select <strong>Class, Session, Term, and Document Type</strong>, then click <strong>Get Doc</strong>.</p></div>`;
}