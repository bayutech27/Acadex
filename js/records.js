// records.js - Archive viewer with identical rendering to results.js + payment banner + attendance fix + broadsheet enhancements (3rd term & combined average)
import { db } from './firebase-config.js';
import {
  collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, setDoc, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId } from './admin.js';
import { renderReportCardUI } from './reportCardRenderer.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

// ------------------- Global State -------------------
let currentSchoolId = null;
let classesMap = new Map();
let subjectsMap = new Map();
let allSubjectsList = [];
let studentsList = [];
let currentGrading = { ca: 40, exam: 60 };
let unsubscribeSub = null;

let currentReportState = {
  selectedStudent: null,
  term: '',
  session: '',
  psychomotor: {},
  teacherComment: '',
  principalComment: '',
  attendance: { schoolOpened: 0, present: 0, absent: 0 },
  savedReportId: null
};

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

function getScoringDocId(session, term) {
  return `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}`;
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
    handleError(err, "Failed to load classes/subjects.");
    throw err;
  }
}

async function loadAllStudents() {
  try {
    const snap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', currentSchoolId)));
    studentsList = snap.docs.map(doc => ({
      id: doc.id,
      name: doc.data().name,
      classId: doc.data().classId,
      admissionNumber: doc.data().admissionNumber || '—',
      gender: doc.data().gender || '—',
      dob: doc.data().dob || '',
      club: doc.data().club || '—',
      passport: doc.data().passport || null
    }));
  } catch (err) {
    handleError(err, "Failed to load students.");
    throw err;
  }
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
    console.error(err);
    currentGrading = { ca: 40, exam: 60 };
  }
}

async function fetchStudentScores(studentId, term, session) {
  try {
    const q = query(
      collection(db, 'scores'),
      where('studentId', '==', studentId),
      where('schoolId', '==', currentSchoolId),
      where('term', '==', term),
      where('session', '==', session)
    );
    const snap = await getDocs(q);
    return snap.docs.map(doc => ({ subjectId: doc.data().subjectId, ca: doc.data().ca, exam: doc.data().exam }));
  } catch (err) {
    handleError(err, "Failed to fetch student scores.");
    return [];
  }
}

async function fetchClassScores(classId, term, session) {
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return [];
  const studentIds = classStudents.map(s => s.id);
  const scores = [];
  try {
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
  } catch (err) {
    handleError(err, "Failed to fetch class scores.");
  }
  return scores;
}

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

async function loadExistingReport(studentId, term, session) {
  try {
    const q = query(
      collection(db, 'reports'),
      where('studentId', '==', studentId),
      where('schoolId', '==', currentSchoolId),
      where('term', '==', term),
      where('session', '==', session)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      const data = snap.docs[0].data();
      if (data.psychomotor) Object.assign(currentReportState.psychomotor, data.psychomotor);
      currentReportState.teacherComment = data.teacherComment || '';
      currentReportState.principalComment = data.principalComment || '';
      currentReportState.attendance = data.attendance || { schoolOpened: 0, present: 0, absent: 0 };
      currentReportState.savedReportId = snap.docs[0].id;
    } else {
      currentReportState.savedReportId = null;
    }
  } catch (err) {
    handleError(err, "Failed to load existing report.");
  }
}

async function saveReportCard() {
  if (!currentReportState.selectedStudent) {
    showNotification("Select a student.", "error");
    return;
  }

  const schoolOpened = parseInt(document.querySelector('.attendance-input.school-opened')?.value) || 0;
  const present = parseInt(document.querySelector('.attendance-input.present')?.value) || 0;
  const absent = parseInt(document.querySelector('.attendance-input.absent')?.value) || 0;
  const attendance = { schoolOpened, present, absent };

  const totalScore = parseInt(document.querySelector('.summary-table tr:nth-child(1) td')?.textContent) || 0;
  const totalObtainable = parseInt(document.querySelector('.summary-table tr:nth-child(2) td')?.textContent) || 0;
  const average = parseFloat(document.querySelector('.summary-table tr:nth-child(4) td')?.textContent) || 0;
  const overallGrade = document.querySelector('.summary-table tr:nth-child(5) td')?.textContent || 'N/A';
  const reportData = {
    studentId: currentReportState.selectedStudent.id,
    classId: document.getElementById('classSelect').value,
    schoolId: currentSchoolId,
    term: currentReportState.term,
    session: currentReportState.session,
    totalScore,
    maxTotal: totalObtainable,
    average,
    overallGrade,
    psychomotor: currentReportState.psychomotor,
    teacherComment: currentReportState.teacherComment,
    principalComment: currentReportState.principalComment,
    attendance,
    updatedAt: new Date()
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
  } catch (err) {
    handleError(err, "Save failed.");
  } finally {
    hideLoader();
  }
}

function printReportCard() {
  const teacherText = document.getElementById('teacherCommentText');
  const printTeacher = document.getElementById('printTeacherComment');
  if (teacherText && printTeacher) printTeacher.textContent = escapeHtml(teacherText.value);

  const principalText = document.getElementById('principalCommentText');
  const printPrincipal = document.getElementById('printPrincipalComment');
  if (principalText && printPrincipal) printPrincipal.textContent = escapeHtml(principalText.value);

  const reportContent = document.getElementById('reportCardContent');
  if (!reportContent || reportContent.children.length === 0) {
    showNotification("Report not ready.", "error");
    return;
  }

  const clonedReport = reportContent.cloneNode(true);
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showNotification("Please allow popups to print.", "error");
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
      <title>Report Card - ${escapeHtml(currentReportState.selectedStudent?.name || 'Student')}</title>
      <link rel="stylesheet" href="${externalCssUrl}">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: white; margin: 0; padding: 0; display: flex; justify-content: center; font-family: 'Segoe UI', sans-serif; }
        .print-container { width: 210mm; margin: 0 auto; background: white; }
        @page { size: A4; margin: 5mm; }
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

function printBroadsheet() {
  const broadsheetDiv = document.getElementById('currentBroadsheetContainer');
  if (!broadsheetDiv || !broadsheetDiv.querySelector('.broadsheet-table')) {
    showNotification("No broadsheet data to print. Please generate the broadsheet first.", "error");
    return;
  }
  
  const cloned = broadsheetDiv.cloneNode(true);
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showNotification("Please allow popups to print.", "error");
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
      <title>Class Broadsheet</title>
      <link rel="stylesheet" href="${externalCssUrl}">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: white; margin: 20px; font-family: 'Segoe UI', sans-serif; }
        .broadsheet-table { width: 100%; border-collapse: collapse; font-size: 11px; }
        .broadsheet-table th, .broadsheet-table td { border: 1px solid #000; padding: 6px 4px; text-align: center; }
        .student-name-cell { text-align: left; }
        @media print {
          @page { size: landscape; margin: 1cm; }
          body { margin: 0; }
        }
        ${inlineStyles}
      </style>
    </head>
    <body>${cloned.outerHTML}</body>
    </html>
  `);
  printWindow.document.close();
  setTimeout(() => {
    printWindow.focus();
    printWindow.print();
  }, 300);
}

// ------------------- Enhanced Broadsheet Functions -------------------
async function getStudentAverageForTerm(studentId, term, session) {
  const scores = await fetchStudentScores(studentId, term, session);
  if (!scores.length) return null;
  let total = 0;
  let count = 0;
  for (const score of scores) {
    total += (score.ca || 0) + (score.exam || 0);
    count++;
  }
  if (count === 0) return null;
  const totalObtainable = count * 100;
  const average = (total / totalObtainable) * 100;
  return average.toFixed(1);
}

async function generateBroadsheet(classId, session, term) {
  const className = classesMap.get(classId) || 'Class';
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) {
    return '<div class="alert">No students found in this class.</div>';
  }

  const allScores = await fetchClassScores(classId, term, session);
  const scoresByStudent = new Map();
  for (const score of allScores) {
    if (!scoresByStudent.has(score.studentId)) scoresByStudent.set(score.studentId, []);
    scoresByStudent.get(score.studentId).push(score);
  }

  const term1Averages = new Map();
  const term2Averages = new Map();
  const term3Averages = new Map();
  for (const student of classStudents) {
    const avg1 = await getStudentAverageForTerm(student.id, '1', session);
    const avg2 = await getStudentAverageForTerm(student.id, '2', session);
    const avg3 = await getStudentAverageForTerm(student.id, '3', session);
    term1Averages.set(student.id, avg1 !== null ? parseFloat(avg1) : null);
    term2Averages.set(student.id, avg2 !== null ? parseFloat(avg2) : null);
    term3Averages.set(student.id, avg3 !== null ? parseFloat(avg3) : null);
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

    const termValues = [
      term1Averages.get(student.id),
      term2Averages.get(student.id),
      term3Averages.get(student.id)
    ].filter(v => v !== null);
    let combinedAvg = null;
    if (termValues.length > 0) {
      const sum = termValues.reduce((a, b) => a + b, 0);
      combinedAvg = (sum / termValues.length).toFixed(1);
    }

    studentResults.push({
      studentId: student.id,
      studentName: student.name,
      totalScore,
      average,
      grade,
      remark,
      subjectDetails,
      term1Avg: term1Averages.get(student.id) !== null ? term1Averages.get(student.id).toFixed(1) + '%' : '—',
      term2Avg: term2Averages.get(student.id) !== null ? term2Averages.get(student.id).toFixed(1) + '%' : '—',
      term3Avg: term3Averages.get(student.id) !== null ? term3Averages.get(student.id).toFixed(1) + '%' : '—',
      combinedAvg: combinedAvg !== null ? combinedAvg + '%' : '—'
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
  html += `<thead>`;
  html += `<tr><th>S/N</th><th>Student Name</th>`;
  for (const subj of allSubjectsList) html += `<th colspan="3">${escapeHtml(subj.name)}</th>`;
  html += `<th>Total</th><th>1st Term</th><th>2nd Term</th><th>3rd Term</th><th>% Avg Total</th><th>Grade</th><th>Position</th><th>Remark</th></tr>`;
  html += `<tr><th></th><th></th>`;
  for (let i = 0; i < allSubjectsList.length; i++) html += `<th>CA</th><th>Exam</th><th>Total</th>`;
  html += `<th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th></tr>`;
  html += `</thead><tbody>`;

  for (let i = 0; i < studentResults.length; i++) {
    const r = studentResults[i];
    html += `<tr>`;
    html += `<td>${i + 1}</td>`;
    html += `<td class="student-name-cell">${escapeHtml(r.studentName)}</td>`;
    for (const sub of r.subjectDetails) html += `<td>${sub.ca}</td><td>${sub.exam}</td><td>${sub.total}</td>`;
    html += `<td>${r.totalScore}</td>`;
    html += `<td>${r.term1Avg}</td>`;
    html += `<td>${r.term2Avg}</td>`;
    html += `<td>${r.term3Avg}</td>`;
    html += `<td>${r.combinedAvg}</td>`;
    html += `<td>${r.grade}</td>`;
    html += `<td>${r.position}${r.position === 1 ? 'st' : r.position === 2 ? 'nd' : r.position === 3 ? 'rd' : 'th'}</td>`;
    html += `<td>${r.remark}</td>`;
    html += `</tr>`;
  }
  html += `</tbody></tr></div>`;
  return html;
}

async function saveBroadsheetToFirestore(classId, session, term) {
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return;

  const allScores = await fetchClassScores(classId, term, session);
  const scoresByStudent = new Map();
  for (const score of allScores) {
    if (!scoresByStudent.has(score.studentId)) scoresByStudent.set(score.studentId, []);
    scoresByStudent.get(score.studentId).push(score);
  }

  const term1Averages = new Map();
  const term2Averages = new Map();
  const term3Averages = new Map();
  for (const student of classStudents) {
    const avg1 = await getStudentAverageForTerm(student.id, '1', session);
    const avg2 = await getStudentAverageForTerm(student.id, '2', session);
    const avg3 = await getStudentAverageForTerm(student.id, '3', session);
    term1Averages.set(student.id, avg1 !== null ? parseFloat(avg1) : null);
    term2Averages.set(student.id, avg2 !== null ? parseFloat(avg2) : null);
    term3Averages.set(student.id, avg3 !== null ? parseFloat(avg3) : null);
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

    const termValues = [
      term1Averages.get(student.id),
      term2Averages.get(student.id),
      term3Averages.get(student.id)
    ].filter(v => v !== null);
    let combinedAvg = null;
    if (termValues.length > 0) {
      const sum = termValues.reduce((a, b) => a + b, 0);
      combinedAvg = (sum / termValues.length).toFixed(1);
    }

    studentResults.push({
      studentId: student.id,
      studentName: student.name,
      totalScore,
      average,
      grade,
      remark,
      subjectDetails,
      term1Avg: term1Averages.get(student.id) !== null ? term1Averages.get(student.id).toFixed(1) + '%' : '—',
      term2Avg: term2Averages.get(student.id) !== null ? term2Averages.get(student.id).toFixed(1) + '%' : '—',
      term3Avg: term3Averages.get(student.id) !== null ? term3Averages.get(student.id).toFixed(1) + '%' : '—',
      combinedAvg: combinedAvg !== null ? combinedAvg + '%' : '—'
    });
  }

  studentResults.sort((a, b) => b.totalScore - a.totalScore);
  let rank = 1;
  for (let i = 0; i < studentResults.length; i++) {
    if (i > 0 && studentResults[i].totalScore < studentResults[i - 1].totalScore) rank = i + 1;
    studentResults[i].position = rank;
  }

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
      term1Avg: s.term1Avg,
      term2Avg: s.term2Avg,
      term3Avg: s.term3Avg,
      combinedAvg: s.combinedAvg,
      subjectDetails: s.subjectDetails
    })),
    subjects: allSubjectsList.map(s => ({ id: s.id, name: s.name })),
    updatedAt: new Date()
  };
  showLoader();
  try {
    await setDoc(doc(db, 'broadsheets', docId), broadsheetData, { merge: true });
    showNotification("Broadsheet saved successfully.", "success");
  } catch (err) {
    handleError(err, "Save failed.");
  } finally {
    hideLoader();
  }
}

// ------------------- UI Rendering Helpers -------------------
function showNoSelectionMessage() {
  const container = document.getElementById('recordsList');
  if (container) {
    container.innerHTML = `<div class="no-data"><p>Please select <strong>Class, Session, Term, and Document Type</strong>, then click <strong>Get Doc</strong>.</p></div>`;
  }
}

async function onGetDoc() {
  const classId = document.getElementById('classSelect')?.value;
  const session = document.getElementById('sessionSelect')?.value;
  const term = document.getElementById('termSelect')?.value;
  const docType = document.getElementById('docTypeSelect')?.value;

  if (!classId || !session || !term || !docType) {
    showNotification("Please select Class, Session, Term, and Document Type.", "error");
    return;
  }

  await loadGradingSetting(session, term);
  const container = document.getElementById('recordsList');
  if (!container) return;

  if (docType === 'report') {
    const classStudents = studentsList.filter(s => s.classId === classId);
    if (!classStudents.length) {
      container.innerHTML = '<div class="no-data">No students found in this class.</div>';
      return;
    }

    const editorHtml = `
      <div class="report-editor-container">
        <div class="student-list-panel">
          <h3 style="font-size: 1rem;">👩‍🎓 Students</h3>
          <div id="studentListContainer"></div>
        </div>
        <div class="report-card-panel" id="reportCardArea">
          <div id="reportCardContainer">
            <div id="reportCardContent" class="report-card">
              <p style="text-align:center; color:#64748b; padding:2rem;">Select a student to view report</p>
            </div>
            <div id="reportActions" class="action-buttons" style="display: none;">
              <button id="saveReportBtn" class="btn-primary">💾 Save Report</button>
              <button id="printReportBtn" class="btn-secondary">🖨️ Print / PDF</button>
            </div>
          </div>
        </div>
      </div>
    `;
    container.innerHTML = editorHtml;

    const studentContainer = document.getElementById('studentListContainer');
    if (studentContainer) {
      let studentHtml = '';
      classStudents.forEach(student => {
        studentHtml += `<div class="student-list-item" data-id="${student.id}" data-name="${escapeHtml(student.name)}">${escapeHtml(student.name)}</div>`;
      });
      studentContainer.innerHTML = studentHtml;
    }

    document.querySelectorAll('.student-list-item').forEach(el => {
      el.addEventListener('click', async () => {
        document.querySelectorAll('.student-list-item').forEach(item => item.classList.remove('active'));
        el.classList.add('active');
        const studentId = el.dataset.id;
        const studentName = el.dataset.name;
        await renderStudentReportCard(studentId, studentName, classId, session, term);
      });
    });

    const firstStudent = document.querySelector('.student-list-item');
    if (firstStudent) {
      firstStudent.classList.add('active');
      await renderStudentReportCard(firstStudent.dataset.id, firstStudent.dataset.name, classId, session, term);
    }
  } else if (docType === 'broadsheet') {
    const broadsheetHtml = await generateBroadsheet(classId, session, term);
    container.innerHTML = `<div id="currentBroadsheetContainer">${broadsheetHtml}</div>`;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'action-buttons';
    actionsDiv.style.marginTop = '16px';
    actionsDiv.style.display = 'flex';
    actionsDiv.style.gap = '12px';
    actionsDiv.style.justifyContent = 'flex-end';

    const printBtn = document.createElement('button');
    printBtn.className = 'btn-secondary';
    printBtn.textContent = '🖨️ Print / PDF';
    printBtn.addEventListener('click', () => {
      printBroadsheet();
    });

    actionsDiv.appendChild(printBtn);
    container.appendChild(actionsDiv);
  }
}

async function renderStudentReportCard(studentId, studentName, classId, session, term) {
  currentReportState = {
    selectedStudent: { id: studentId, name: studentName },
    term,
    session,
    psychomotor: {},
    teacherComment: '',
    principalComment: '',
    attendance: { schoolOpened: 0, present: 0, absent: 0 },
    savedReportId: null
  };
  const psychomotorSkillsList = ['Handling of tools', 'Public Speaking', 'Speech Fluency', 'Handwriting', 'Sport and Game', 'Drawing/Painting'];
  const affectiveSkillsList = ['Attentiveness', 'Neatness', 'Honesty', 'Politeness', 'Punctuality', 'Self-control/Calmness', 'Obedience', 'Reliability', 'Relationship with others', 'Leadership'];
  [...psychomotorSkillsList, ...affectiveSkillsList].forEach(skill => {
    const key = skill.toLowerCase().replace(/[^a-z]/g, '');
    currentReportState.psychomotor[key] = 3;
  });

  await loadExistingReport(studentId, term, session);

  const schoolDoc = await getDoc(doc(db, 'schools', currentSchoolId));
  const school = {
    name: schoolDoc.exists() ? schoolDoc.data().name : 'School Name',
    address: schoolDoc.exists() ? schoolDoc.data().address : '',
    logo: schoolDoc.exists() ? schoolDoc.data().logo : null
  };
  const student = studentsList.find(s => s.id === studentId) || {};
  const scoresRaw = await fetchStudentScores(studentId, term, session);
  const scoresWithNames = scoresRaw.map(score => ({
    subjectId: score.subjectId,
    subjectName: subjectsMap.get(score.subjectId) || score.subjectId,
    ca: score.ca,
    exam: score.exam
  }));

  const subjectStats = await computeSubjectStats(classId, term, session);
  const studentData = {
    id: studentId,
    name: studentName,
    admissionNumber: student.admissionNumber || '—',
    gender: student.gender || '—',
    dob: student.dob || '',
    club: student.club || '—',
    passport: student.passport || null
  };

  const container = document.getElementById('reportCardContent');
  if (container) container.innerHTML = '';

  renderReportCardUI({
    student: studentData,
    scores: scoresWithNames,
    className: classesMap.get(classId) || 'Class',
    school,
    grading: currentGrading,
    psychomotor: currentReportState.psychomotor,
    comments: { teacherComment: currentReportState.teacherComment, principalComment: currentReportState.principalComment },
    attendance: currentReportState.attendance,
    term,
    session,
    subjectStats,
    container,
    onRatingChange: (skillKey, newValue) => {
      currentReportState.psychomotor[skillKey] = newValue;
    },
    onTeacherCommentChange: (newComment) => {
      currentReportState.teacherComment = newComment;
    },
    onPrincipalCommentChange: (newComment) => {
      currentReportState.principalComment = newComment;
    }
  });

  const reportActions = document.getElementById('reportActions');
  if (reportActions) reportActions.style.display = 'flex';

  const saveBtn = document.getElementById('saveReportBtn');
  if (saveBtn) {
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.addEventListener('click', saveReportCard);
  }
  const printBtn = document.getElementById('printReportBtn');
  if (printBtn) {
    const newPrintBtn = printBtn.cloneNode(true);
    printBtn.parentNode.replaceChild(newPrintBtn, printBtn);
    newPrintBtn.addEventListener('click', printReportCard);
  }
}

// ========== SUBSCRIPTION PAYMENT BANNER ==========
function injectSubscriptionUI() {
  if (!document.getElementById('paymentBannerContainer')) {
    const contentDiv = document.querySelector('.content');
    if (contentDiv) {
      const paymentDiv = document.createElement('div');
      paymentDiv.id = 'paymentBannerContainer';
      paymentDiv.style.margin = '16px 0';
      contentDiv.insertBefore(paymentDiv, contentDiv.firstChild);
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
    <div class="payment-banner-content">
      <h3>💰 Activate Your Subscription</h3>
      <p>Pay securely online with your ATM card via Paystack, or contact us on WhatsApp for assistance.</p>
    </div>
    <div class="payment-buttons">
      <button id="paystackPaymentBtn" class="paystack-btn">💳 Pay Now (Card/Online)</button>
      <a id="whatsappLink" href="https://wa.me/2349044784225?text=Hello%20Acadex%2C%20I%20want%20to%20renew%20my%20subscription" target="_blank" class="whatsapp-btn">
        <svg class="whatsapp-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-5.46-4.45-9.91-9.91-9.91zm0 2c4.4 0 7.91 3.51 7.91 7.91 0 4.4-3.51 7.91-7.91 7.91-1.43 0-2.78-.38-3.97-1.07l-.6-.34-3.11.82.83-3.04-.34-.6c-.7-1.2-1.07-2.55-1.07-3.97 0-4.4 3.51-7.91 7.91-7.91zM8.53 7.5c-.18 0-.48.07-.73.33-.26.26-.95.93-.95 2.28 0 1.35.98 2.66 1.12 2.84.14.18 1.88 2.98 4.56 4.07.64.26 1.14.42 1.53.54.64.2 1.22.17 1.68.1.51-.08 1.57-.64 1.79-1.26.22-.62.22-1.15.15-1.26-.07-.11-.26-.18-.55-.31-.29-.13-1.7-.84-1.96-.94-.26-.1-.45-.15-.64.15-.19.3-.73.94-.9 1.13-.17.19-.34.21-.63.07-.29-.13-1.22-.45-2.32-1.43-.86-.76-1.44-1.7-1.61-1.99-.17-.29-.02-.45.13-.59.13-.13.29-.34.44-.51.14-.17.19-.29.29-.48.1-.19.05-.36-.03-.51-.08-.15-.64-1.54-.88-2.11-.23-.56-.46-.48-.64-.49h-.55z"/>
        </svg>
        09044784225 (WhatsApp)
      </a>
    </div>
  `;
  container.appendChild(banner);

  const payBtn = document.getElementById('paystackPaymentBtn');
  if (payBtn) {
    payBtn.addEventListener('click', () => {
      window.open('https://paystack.shop/pay/fmj267paou', '_blank');
    });
  }
}

function hidePaymentBanner() {
  const banner = document.getElementById('paymentBanner');
  if (banner) banner.remove();
}

async function setupSubscriptionUI() {
  injectSubscriptionUI();
  hidePaymentBanner();
}

async function initSubscriptionListener() {
  if (!currentSchoolId) return;
  if (unsubscribeSub) unsubscribeSub();
  const subRef = doc(db, 'schools', currentSchoolId, 'subscription', 'current');
  unsubscribeSub = onSnapshot(subRef, (snap) => {
    if (!snap.exists()) {
      showPaymentBanner();
      return;
    }
    const sub = snap.data();
    const isActive = sub.status === 'active' && sub.locked === false;
    if (isActive) {
      hidePaymentBanner();
    } else {
      showPaymentBanner();
    }
  }, (err) => handleError(err, "Subscription listener error."));
}

// ------------------- Initialization -------------------
export async function initRecordsPage() {
  currentSchoolId = await getCurrentSchoolId();
  if (!currentSchoolId) {
    showNotification("School ID missing. Please log out and log in again.", "error");
    return;
  }

  await loadClassesAndSubjects();
  await loadAllStudents();

  const classSelect = document.getElementById('classSelect');
  if (classSelect) {
    classSelect.innerHTML = '<option value="">Select Class</option>';
    for (let [id, name] of classesMap) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = name;
      classSelect.appendChild(option);
    }
  }

  const sessionSelect = document.getElementById('sessionSelect');
  const sessions = generateSessionOptions();
  if (sessionSelect) {
    sessionSelect.innerHTML = '<option value="">Select Session</option>';
    sessions.forEach(s => {
      const option = document.createElement('option');
      option.value = s;
      option.textContent = s;
      sessionSelect.appendChild(option);
    });
  }

  const termSelect = document.getElementById('termSelect');
  if (termSelect) {
    termSelect.innerHTML = '<option value="">Select Term</option><option value="1">1st Term</option><option value="2">2nd Term</option><option value="3">3rd Term</option>';
  }

  const getDocBtn = document.getElementById('getDocBtn');
  if (getDocBtn) getDocBtn.addEventListener('click', onGetDoc);

  setupSubscriptionUI();
  initSubscriptionListener();

  showNoSelectionMessage();
}