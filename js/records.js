// records.js - Archive viewer with identical rendering to results.js (FIXED)

import { db } from './firebase-config.js';
import {
  collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId } from './admin.js';
import { renderReportCardUI } from './reportCardRenderer.js';

// ------------------- Global State -------------------
let currentSchoolId = null;
let classesMap = new Map();
let subjectsMap = new Map();
let allSubjectsList = [];
let studentsList = [];
let currentGrading = { ca: 40, exam: 60 };

let currentReportState = {
  selectedStudent: null,
  term: '',
  session: '',
  psychomotor: {},
  teacherComment: '',
  principalComment: '',
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
    console.error('Failed to load classes/subjects:', err);
    alert('Unable to load classes/subjects. Check your permissions.');
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
    console.error('Failed to load students:', err);
    alert('Unable to load students. Check your permissions.');
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
    currentReportState.savedReportId = snap.docs[0].id;
  } else {
    currentReportState.savedReportId = null;
  }
}

async function saveReportCard() {
  if (!currentReportState.selectedStudent) return alert('Select a student.');
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
    updatedAt: new Date()
  };
  try {
    if (currentReportState.savedReportId) {
      await updateDoc(doc(db, 'reports', currentReportState.savedReportId), reportData);
    } else {
      const newRef = await addDoc(collection(db, 'reports'), { ...reportData, createdAt: new Date() });
      currentReportState.savedReportId = newRef.id;
    }
    alert('Report saved.');
  } catch (err) {
    console.error(err);
    alert('Save failed.');
  }
}

// ------------------- Print Handlers (clone to new window with full CSS) -------------------
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
      <title>Report Card - ${escapeHtml(currentReportState.selectedStudent?.name || 'Student')}</title>
      <link rel="stylesheet" href="${externalCssUrl}">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: white; margin: 0; padding: 0; display: flex; justify-content: center; font-family: 'Segoe UI', sans-serif; }
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

// FIXED: Broadsheet print – clones the container with title + table
function printBroadsheet() {
  const broadsheetDiv = document.getElementById('currentBroadsheetContainer');
  if (!broadsheetDiv || !broadsheetDiv.querySelector('.broadsheet-table')) {
    alert('No broadsheet data to print. Please generate the broadsheet first.');
    return;
  }
  
  const cloned = broadsheetDiv.cloneNode(true);
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

// ------------------- Broadsheet Functions (identical to results.js) -------------------
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
    subjects: allSubjectsList.map(s => ({ id: s.id, name: s.name })),
    updatedAt: new Date()
  };
  try {
    await setDoc(doc(db, 'broadsheets', docId), broadsheetData, { merge: true });
    alert('Broadsheet saved successfully.');
  } catch (err) {
    console.error(err);
    alert('Save failed.');
  }
}

// ------------------- UI Rendering Helpers -------------------
function showNoSelectionMessage() {
  const container = document.getElementById('recordsList');
  container.innerHTML = `<div class="no-data"><p>Please select <strong>Class, Session, Term, and Document Type</strong>, then click <strong>Get Doc</strong>.</p></div>`;
}

async function onGetDoc() {
  const classId = document.getElementById('classSelect').value;
  const session = document.getElementById('sessionSelect').value;
  const term = document.getElementById('termSelect').value;
  const docType = document.getElementById('docTypeSelect').value;

  if (!classId || !session || !term || !docType) {
    alert('Please select Class, Session, Term, and Document Type.');
    return;
  }

  await loadGradingSetting(session, term);
  const container = document.getElementById('recordsList');

  if (docType === 'report') {
    // Build two‑column layout exactly like results.html
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

    // Populate student list
    const studentContainer = document.getElementById('studentListContainer');
    let studentHtml = '';
    classStudents.forEach(student => {
      studentHtml += `<div class="student-list-item" data-id="${student.id}" data-name="${escapeHtml(student.name)}">${escapeHtml(student.name)}</div>`;
    });
    studentContainer.innerHTML = studentHtml;

    // Attach click handlers
    document.querySelectorAll('.student-list-item').forEach(el => {
      el.addEventListener('click', async () => {
        document.querySelectorAll('.student-list-item').forEach(item => item.classList.remove('active'));
        el.classList.add('active');
        const studentId = el.dataset.id;
        const studentName = el.dataset.name;
        await renderStudentReportCard(studentId, studentName, classId, session, term);
      });
    });

    // Select first student by default
    const firstStudent = document.querySelector('.student-list-item');
    if (firstStudent) {
      firstStudent.classList.add('active');
      await renderStudentReportCard(firstStudent.dataset.id, firstStudent.dataset.name, classId, session, term);
    }
  } else if (docType === 'broadsheet') {
    // Broadsheet: wrap everything in a container with a fixed ID for printing
    const broadsheetHtml = await generateBroadsheet(classId, session, term);
    container.innerHTML = `<div id="currentBroadsheetContainer">${broadsheetHtml}</div>`;

    // Action buttons (only Print/PDF)
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
  // Reset state
  currentReportState = {
    selectedStudent: { id: studentId, name: studentName },
    term,
    session,
    psychomotor: {},
    teacherComment: '',
    principalComment: '',
    savedReportId: null
  };
  // Initialize psychomotor with defaults
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
  container.innerHTML = ''; // clear previous

  renderReportCardUI({
    student: studentData,
    scores: scoresWithNames,
    className: classesMap.get(classId) || 'Class',
    school,
    grading: currentGrading,
    psychomotor: currentReportState.psychomotor,
    comments: { teacherComment: currentReportState.teacherComment, principalComment: currentReportState.principalComment },
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

  // Show the action buttons
  const reportActions = document.getElementById('reportActions');
  if (reportActions) reportActions.style.display = 'flex';

  // Re‑attach button events (they might be overwritten by renderReportCardUI)
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

// ------------------- Initialization -------------------
export async function initRecordsPage() {
  currentSchoolId = await getCurrentSchoolId();
  if (!currentSchoolId) {
    alert('School ID missing. Please log out and log in again.');
    return;
  }

  await loadClassesAndSubjects();
  await loadAllStudents();

  // Populate class dropdown
  const classSelect = document.getElementById('classSelect');
  classSelect.innerHTML = '<option value="">Select Class</option>';
  for (let [id, name] of classesMap) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = name;
    classSelect.appendChild(option);
  }

  // Populate session dropdown (last 5 years)
  const sessionSelect = document.getElementById('sessionSelect');
  const sessions = generateSessionOptions();
  sessionSelect.innerHTML = '<option value="">Select Session</option>';
  sessions.forEach(s => {
    const option = document.createElement('option');
    option.value = s;
    option.textContent = s;
    sessionSelect.appendChild(option);
  });

  // Populate term dropdown
  const termSelect = document.getElementById('termSelect');
  termSelect.innerHTML = '<option value="">Select Term</option><option value="1">1st Term</option><option value="2">2nd Term</option><option value="3">3rd Term</option>';

  // Add Document Type dropdown and Get Doc button if not already present
  const filtersDiv = document.querySelector('.filters');
  if (!document.getElementById('docTypeSelect')) {
    const docTypeGroup = document.createElement('div');
    docTypeGroup.className = 'filter-group';
    docTypeGroup.innerHTML = `<label for="docTypeSelect">Document Type</label>
                              <select id="docTypeSelect">
                                <option value="">Select Type</option>
                                <option value="report">Report Cards</option>
                                <option value="broadsheet">Broadsheet</option>
                              </select>`;
    filtersDiv.appendChild(docTypeGroup);

    const getDocBtn = document.createElement('button');
    getDocBtn.id = 'getDocBtn';
    getDocBtn.className = 'btn-primary';
    getDocBtn.textContent = 'Get Doc';
    getDocBtn.style.alignSelf = 'flex-end';
    getDocBtn.style.padding = '10px 20px';
    filtersDiv.appendChild(getDocBtn);
  }

  // Attach event listeners
  document.getElementById('getDocBtn').addEventListener('click', onGetDoc);

  // Initial message
  showNoSelectionMessage();
}