// class.js - Teacher report card page + broadsheet (full functionality) + attendance fix + broadsheet enhancements with 3rd term
import { db } from './firebase-config.js';
import {
  collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getTeacherData } from './teacher-dashboard.js';
import { renderReportCardUI } from './reportCardRenderer.js';
import { canEnterScores } from './plan.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

let currentSchoolId = null;
let teacherData = null;
let classId = null;
let classNameCache = '';
let currentGrading = { ca: 40, exam: 60 };
let classesMap = new Map();
let subjectsMap = new Map();
let studentsList = [];
let allSubjectsList = [];
let isSubscriptionAllowed = false;

const psychomotorSkillsList = ['Handling of tools', 'Public Speaking', 'Speech Fluency', 'Handwriting', 'Sport and Game', 'Drawing/Painting'];
const affectiveSkillsList = ['Attentiveness', 'Neatness', 'Honesty', 'Politeness', 'Punctuality', 'Self-control/Calmness', 'Obedience', 'Reliability', 'Relationship with others', 'Leadership'];

let reportState = {
  selectedStudent: null,
  term: '1',
  session: '',
  psychomotor: {},
  teacherComment: '',
  principalComment: '',
  attendance: { schoolOpened: 0, present: 0, absent: 0 },
  savedReportId: null
};

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

// ------------------- Data Loading -------------------
async function fetchClassName() {
  try {
    const classRef = doc(db, 'classes', classId);
    const classSnap = await getDoc(classRef);
    classNameCache = classSnap.exists() ? classSnap.data().name : classId;
  } catch(e) {
    console.warn(e);
    classNameCache = classId;
  }
}

async function loadSubjectsAndClasses() {
  try {
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
  } catch (err) {
    handleError(err, "Failed to load subjects and classes.");
  }
}

async function loadStudentsList() {
  try {
    const snap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', currentSchoolId)));
    studentsList = snap.docs.map(doc => ({
      id: doc.id, name: doc.data().name, classId: doc.data().classId,
      admissionNumber: doc.data().admissionNumber, gender: doc.data().gender,
      dob: doc.data().dob, club: doc.data().club, passport: doc.data().passport || null
    }));
  } catch (err) {
    handleError(err, "Failed to load students.");
  }
}

async function fetchScores(studentId, term, session) {
  try {
    const snap = await getDocs(query(
      collection(db, 'scores'),
      where('studentId', '==', studentId),
      where('schoolId', '==', currentSchoolId),
      where('term', '==', term),
      where('session', '==', session)
    ));
    return snap.docs.map(doc => ({ subjectId: doc.data().subjectId, ca: doc.data().ca, exam: doc.data().exam }));
  } catch (err) {
    handleError(err, "Failed to load student scores.");
    return [];
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
    handleError(err, "Failed to load grading settings. Using defaults.");
    currentGrading = { ca: 40, exam: 60 };
  }
}

// ------------------- Subject Stats -------------------
async function computeSubjectStats(classId, term, session) {
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return new Map();
  const studentIds = classStudents.map(s => s.id);
  const allScores = [];
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
      snap.forEach(doc => allScores.push(doc.data()));
    }
  } catch (err) {
    handleError(err, "Failed to compute subject statistics.");
    return new Map();
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
  try {
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
      reportState.attendance = data.attendance || { schoolOpened: 0, present: 0, absent: 0 };
      reportState.savedReportId = snap.docs[0].id;
    } else {
      reportState.attendance = { schoolOpened: 0, present: 0, absent: 0 };
      reportState.savedReportId = null;
    }
  } catch (err) {
    handleError(err, "Failed to load existing report.");
  }
}

async function saveReportCard() {
  if (!isSubscriptionAllowed) {
    showNotification("Cannot save report – subscription inactive.", "error");
    return;
  }
  if (!reportState.selectedStudent) {
    showNotification("Select a student first.", "error");
    return;
  }

  const schoolOpenedInput = document.querySelector('.attendance-input.school-opened');
  const presentInput = document.querySelector('.attendance-input.present');
  const absentInput = document.querySelector('.attendance-input.absent');
  
  const schoolOpened = schoolOpenedInput ? parseInt(schoolOpenedInput.value) || 0 : reportState.attendance.schoolOpened;
  const present = presentInput ? parseInt(presentInput.value) || 0 : reportState.attendance.present;
  const absent = absentInput ? parseInt(absentInput.value) || 0 : reportState.attendance.absent;
  const attendance = { schoolOpened, present, absent };

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
    attendance,
    updatedAt: new Date()
  };
  showLoader();
  try {
    if (reportState.savedReportId) {
      await updateDoc(doc(db, 'reports', reportState.savedReportId), reportData);
    } else {
      const newRef = await addDoc(collection(db, 'reports'), { ...reportData, createdAt: new Date() });
      reportState.savedReportId = newRef.id;
    }
    reportState.attendance = attendance;
    showNotification("Report saved successfully.", "success");
  } catch (err) {
    if (err.code === 'permission-denied') {
      showNotification("Permission denied. Subscription required to save reports.", "error");
    } else {
      handleError(err, "Failed to save report.");
    }
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

async function loadReportCard(studentId, studentName) {
  if (!isSubscriptionAllowed) {
    const container = document.getElementById('reportCardContent');
    if (container) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px; background: #fef3c7; border-radius: 8px; margin: 20px;">
          <h3>⚠️ Subscription Required</h3>
          <p>Report cards are unavailable because the school subscription is inactive.</p>
          <p>Please contact your administrator to renew.</p>
        </div>
      `;
    }
    const actions = document.getElementById('reportActions');
    if (actions) actions.style.display = 'none';
    return;
  }

  reportState.selectedStudent = { id: studentId, name: studentName };
  reportState.term = document.getElementById('termSelect').value;
  reportState.session = document.getElementById('sessionSelect').value;

  showLoader();
  try {
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
      attendance: reportState.attendance,
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

    const actions = document.getElementById('reportActions');
    if (actions) actions.style.display = 'flex';
  } catch (err) {
    handleError(err, "Failed to load report card.");
  } finally {
    hideLoader();
  }
}

async function loadClassStudents() {
  reportState.term = document.getElementById('termSelect').value;
  reportState.session = document.getElementById('sessionSelect').value;
  await loadGradingSetting(reportState.session, reportState.term);
  const classStudents = studentsList.filter(s => s.classId === classId);
  const container = document.getElementById('studentListContainer');
  if (!container) return;
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

// ==================== BROADSHEET FUNCTIONS (enhanced with 3rd term and combined average) ====================
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

async function getStudentAverageForTerm(studentId, term, session) {
  const scores = await fetchScores(studentId, term, session);
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

async function generateBroadsheet() {
  if (!isSubscriptionAllowed) {
    const container = document.getElementById('broadsheetContainer');
    if (container) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px; background: #fef3c7; border-radius: 8px;">
          <h3>⚠️ Subscription Required</h3>
          <p>Broadsheets are unavailable because the school subscription is inactive.</p>
        </div>
      `;
    }
    const actions = document.getElementById('broadsheetActions');
    if (actions) actions.style.display = 'none';
    return;
  }
  const classId = document.getElementById('broadsheetClassSelect')?.value;
  const session = document.getElementById('broadsheetSessionSelect')?.value;
  const term = document.getElementById('broadsheetTermSelect')?.value;
  if (!classId || !session || !term) {
    showNotification("Please select Class, Session and Term", "error");
    return;
  }

  const className = classesMap.get(classId) || 'Class';
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) {
    const container = document.getElementById('broadsheetContainer');
    if (container) container.innerHTML = '<div class="alert">No students found in this class.</div>';
    return;
  }

  showLoader();
  try {
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
    html += `</tbody></table></div>`;

    const container = document.getElementById('broadsheetContainer');
    if (container) container.innerHTML = html;
    const actions = document.getElementById('broadsheetActions');
    if (actions) actions.style.display = 'flex';
    window.currentBroadsheetData = { classId, session, term, studentResults, subjects: allSubjectsList };
  } catch (err) {
    handleError(err, "Failed to generate broadsheet.");
  } finally {
    hideLoader();
  }
}

async function saveBroadsheetToFirestore() {
  if (!isSubscriptionAllowed) {
    showNotification("Cannot save broadsheet – subscription inactive.", "error");
    return;
  }
  if (!window.currentBroadsheetData) {
    showNotification("No broadsheet data to save. Generate first.", "error");
    return;
  }
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
      term1Avg: s.term1Avg,
      term2Avg: s.term2Avg,
      term3Avg: s.term3Avg,
      combinedAvg: s.combinedAvg,
      subjectDetails: s.subjectDetails
    })),
    subjects: subjects.map(s => ({ id: s.id, name: s.name })),
    createdAt: new Date(),
    updatedAt: new Date()
  };
  showLoader();
  try {
    await setDoc(doc(db, 'broadsheets', docId), broadsheetData, { merge: true });
    showNotification("Broadsheet saved successfully.", "success");
  } catch (err) {
    if (err.code === 'permission-denied') {
      showNotification("Permission denied. Subscription required to save broadsheets.", "error");
    } else {
      handleError(err, "Failed to save broadsheet.");
    }
  } finally {
    hideLoader();
  }
}

function printBroadsheet() {
  const container = document.getElementById('broadsheetContainer');
  if (!container || !container.innerHTML.trim()) {
    showNotification("No broadsheet to print.", "error");
    return;
  }
  const originalContent = container.cloneNode(true);
  const title = document.querySelector('#broadsheetContainer h3')?.innerText || 'Class Broadsheet';
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showNotification("Please allow popups.", "error");
    return;
  }
  const externalCssUrl = new URL('../css/styles.css', window.location.href).href;
  const inlineStyles = Array.from(document.querySelectorAll('style'))
    .map(style => style.innerHTML)
    .join('\n');
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head><title>${title}</title>
    <link rel="stylesheet" href="${externalCssUrl}">
    <style>
      body { font-family: 'Segoe UI', sans-serif; margin: 20px; }
      .broadsheet-table { width: 100%; border-collapse: collapse; font-size: 11px; }
      .broadsheet-table th, .broadsheet-table td { border: 1px solid #000; padding: 6px 4px; text-align: center; }
      .student-name-cell { text-align: left; }
      @media print { @page { size: landscape; margin: 1cm; } body { margin: 0; } }
      ${inlineStyles}
    </style>
    </head>
    <body>${originalContent.outerHTML}</body>
    </html>
  `);
  printWindow.document.close();
  printWindow.print();
}

// ------------------- Initialisation -------------------
export async function initClassReportPage() {
  teacherData = getTeacherData();
  if (!teacherData) return;
  classId = teacherData.hostClassId || teacherData.classTeacherId;
  if (!classId) {
    showNotification("Not a class teacher.", "error");
    window.location.href = 'teacher-dashboard.html';
    return;
  }
  currentSchoolId = teacherData.schoolId || localStorage.getItem('userSchoolId');
  if (!currentSchoolId) {
    showNotification("School ID missing.", "error");
    return;
  }

  isSubscriptionAllowed = await canEnterScores(currentSchoolId);

  await fetchClassName();
  await loadSubjectsAndClasses();
  await loadStudentsList();

  const broadsheetClassSelect = document.getElementById('broadsheetClassSelect');
  if (broadsheetClassSelect) {
    broadsheetClassSelect.innerHTML = '<option value="">-- Select Class --</option>';
    for (let [id, name] of classesMap) {
      broadsheetClassSelect.innerHTML += `<option value="${id}">${escapeHtml(name)}</option>`;
    }
  }
  const broadsheetSessionSelect = document.getElementById('broadsheetSessionSelect');
  const sessions = generateSessionOptions();
  if (broadsheetSessionSelect) broadsheetSessionSelect.innerHTML = sessions.map(s => `<option value="${s}">${s}</option>`).join('');
  const broadsheetTermSelect = document.getElementById('broadsheetTermSelect');
  if (broadsheetTermSelect) broadsheetTermSelect.value = '1';

  const sessionSelect = document.getElementById('sessionSelect');
  if (sessionSelect) sessionSelect.innerHTML = sessions.map(s => `<option value="${s}">${s}</option>`).join('');
  const termSelect = document.getElementById('termSelect');
  if (termSelect) termSelect.value = '1';

  const academic = await getSchoolAcademicInfo();
  const defaultSession = academic?.currentSession || sessions[0];
  const defaultTerm = academic?.currentTerm || '1';
  if (sessionSelect) sessionSelect.value = defaultSession;
  if (broadsheetSessionSelect) broadsheetSessionSelect.value = defaultSession;
  if (termSelect) termSelect.value = defaultTerm;
  if (broadsheetTermSelect) broadsheetTermSelect.value = defaultTerm;

  await loadGradingSetting(defaultSession, defaultTerm);
  await loadClassStudents();

  const termSelectEl = document.getElementById('termSelect');
  if (termSelectEl) termSelectEl.addEventListener('change', () => loadClassStudents());
  const sessionSelectEl = document.getElementById('sessionSelect');
  if (sessionSelectEl) sessionSelectEl.addEventListener('change', () => loadClassStudents());
  const refreshBtn = document.getElementById('refreshStudentsBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadClassStudents());
  const saveBtn = document.getElementById('saveReportBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveReportCard);
  const printBtn = document.getElementById('printReportBtn');
  if (printBtn) printBtn.addEventListener('click', printReportCard);

  const generateBtn = document.getElementById('generateBroadsheetBtn');
  if (generateBtn) generateBtn.addEventListener('click', generateBroadsheet);
  const saveBroadsheetBtn = document.getElementById('saveBroadsheetBtn');
  if (saveBroadsheetBtn) saveBroadsheetBtn.addEventListener('click', saveBroadsheetToFirestore);
  const printBroadsheetBtn = document.getElementById('printBroadsheetBtn');
  if (printBroadsheetBtn) printBroadsheetBtn.addEventListener('click', printBroadsheet);

  if (!isSubscriptionAllowed) {
    const saveReportBtn = document.getElementById('saveReportBtn');
    if (saveReportBtn) {
      saveReportBtn.disabled = true;
      saveReportBtn.style.opacity = '0.5';
    }
    if (printBtn) {
      printBtn.disabled = true;
      printBtn.style.opacity = '0.5';
    }
    if (generateBtn) generateBtn.disabled = true;
    if (saveBroadsheetBtn) saveBroadsheetBtn.disabled = true;
    if (printBroadsheetBtn) printBroadsheetBtn.disabled = true;
    const warningDiv = document.createElement('div');
    warningDiv.className = 'subscription-warning';
    warningDiv.style.cssText = 'background: #fee2e2; color: #991b1b; padding: 12px; margin-bottom: 16px; border-radius: 8px;';
    warningDiv.innerHTML = '⚠️ Subscription inactive. Report card and broadsheet features are disabled. Please contact your administrator to renew.';
    const container = document.querySelector('.class-report-container');
    if (container) container.prepend(warningDiv);
  }
}