// results.js - Admin report card page using shared renderer + subscription check + payment banner
// FULLY INTEGRATED with Central Academic Calendar Engine + REAL‑TIME SUBSCRIPTION LOCK (RAW STATUS)
// DYNAMIC SESSION DROPDOWN – shows only sessions with existing scores for the school
// ADDED: Alphabetical sorting of students, class options, and subject options.
// MODIFIED: Attendance now correctly fetched from Firestore (classId & schoolId passed to renderer)
// ADDED: Parent phone number to student data + "Send to WhatsApp" button with robust normalisation.
// UPDATED: Print comments now appear inline (same line as label)
//
// All Firestore operations go through service.js where possible.
// TODO: service.js does not yet support scoring config save/load by docId, broadsheet save,
// some complex queries – those remain as direct Firestore calls.
//
// FIXED: All user-facing errors now show toast notifications instead of alerts.
// ADDED: Subscription restriction – if subscription is inactive, users can only view results from
//        previous sessions/terms (not the current one). Current session/term results are blocked.

import * as service from './service.js';
import { getCurrentSchoolId } from './admin.js';
import { renderReportCardUI } from './reportCardRenderer.js';
import { onSubscriptionChange } from './plan.js';
import { getCurrentSession, getCurrentTerm, initAcademicCalendar } from './academic-calendar.js';
import { showNotification, handleError, showLoader, hideLoader, toast } from './error-handler.js';

// NEW: shared grading utilities
import {
  calculateGrade,
  getGradeRemark,
  getSkillKey,
  getDefaultRatings,
  getGradeScaleHtml,
  getCommentOptionsByGrade,
  getTermSuffix,
  calculateAge,
  escapeHtml,
  psychomotorSkillsList,
  affectiveSkillsList
} from './report-utils.js';

// ------------------- Global State -------------------
let currentSchoolId = null;
let classesMap = new Map();
let studentsList = [];
let subjectsMap = new Map();
let allSubjectsList = [];
let currentGrading = { ca: 40, exam: 60 };
let isSubscriptionActive = false;
let unsubscribeSub = null;
let currentAcademicSession = '';
let currentAcademicTerm = '';

let editorState = {
  selectedStudent: null,
  term: '1',
  session: '',
  psychomotor: {},
  teacherComment: '',
  principalComment: '',
  savedReportId: null,
  attendance: { schoolOpened: 0, present: 0, absent: 0 }
};

// Skills lists are now imported, no local definitions

// ------------------- Helper: Check if requested session/term is current -------------------
function isCurrentSessionTerm(session, term) {
  if (!currentAcademicSession || !currentAcademicTerm) return false;
  const termName = term; // term is already numeric, we compare directly because currentAcademicTerm is also numeric? Actually it's "First Term" etc.
  // We need to convert both to comparable format. We'll use the term number for comparison.
  const termNumFromName = (name) => ({ 'First Term': '1', 'Second Term': '2', 'Third Term': '3' }[name] || name);
  return session === currentAcademicSession && termNumFromName(term) === termNumFromName(currentAcademicTerm);
}

// ------------------- Helper: Check if user can view this result -------------------
function canViewResult(session, term) {
  if (isSubscriptionActive) return true;
  return !isCurrentSessionTerm(session, term);
}

// ------------------- Utility Functions (removed duplicates, imports now) -------------------

// No more local definitions of calculateGrade, getGradeRemark, etc.

// ------------------- Firestore Helpers (via service) -------------------
function getScoringDocId(session, term, level) {
  return `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}_${level}`;
}

async function loadSessionOptions(schoolId) {
  return await service.loadSessionOptions(schoolId);
}

// ------------------- Data Loading via service -------------------
async function loadClassesAndSubjects() {
  try {
    const classes = await service.getClassesBySchool(currentSchoolId);
    classesMap.clear();
    classes.forEach(cls => classesMap.set(cls.id, { name: cls.name, level: cls.level }));
    const subjects = await service.getSubjectsBySchool(currentSchoolId);
    subjectsMap.clear();
    allSubjectsList = [];
    subjects.forEach(subj => {
      subjectsMap.set(subj.id, { name: subj.name, level: subj.level });
      allSubjectsList.push({ id: subj.id, name: subj.name, level: subj.level });
    });
  } catch (err) {
    console.error('Failed to load classes/subjects:', err);
    toast.error('Unable to load classes and subjects. Please refresh the page.');
    throw err;
  }
}

async function loadAllStudents() {
  try {
    const students = await service.getStudentsBySchool(currentSchoolId);
    studentsList = students.map(s => ({
      id: s.id, name: s.name, classId: s.classId,
      admissionNumber: s.admissionNumber, gender: s.gender,
      dob: s.dob, club: s.club, passport: s.passport || null,
      subjects: s.subjects || [],
      parentPhone: s.parentPhone || null,
      nationality: s.nationality || null,
      state: s.state || null,
      religion: s.religion || null
    }));
    studentsList.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } catch (err) {
    console.error('Failed to load students:', err);
    toast.error('Unable to load students. Please refresh the page.');
    throw err;
  }
}

// ── Scores: keep using the numeric term as-is (no conversion) ──
async function fetchClassScores(classId, term, session) {
  try {
    const scores = await service.getScoresByClass(classId, currentSchoolId, term, session);
    return scores.map(s => ({ ...s, id: s.id }));
  } catch (err) {
    console.error('Failed to fetch class scores:', err);
    toast.warning('Unable to load class scores. Please refresh the page.');
    return [];
  }
}

async function fetchStudentScores(studentId, term, session) {
  try {
    const scores = await service.getScoresByStudent(studentId, currentSchoolId, term, session);
    return scores.map(s => ({ subjectId: s.subjectId, ca: s.ca, exam: s.exam }));
  } catch (err) {
    console.error('Failed to fetch student scores:', err);
    toast.warning('Unable to load student scores. Please refresh the page.');
    return [];
  }
}

async function loadGradingSetting(session, term, level = 'secondary') {
  try {
    const docId = getScoringDocId(session, term, level);
    const { getDoc, doc: fDoc } = await import('https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js');
    const { db } = await import('./firebase-config.js');
    const docSnap = await getDoc(fDoc(db, 'scoring', docId));
    let grading = '40/60';
    if (docSnap.exists()) grading = docSnap.data().grading;
    const [ca, exam] = grading.split('/').map(Number);
    currentGrading = { ca, exam };
    if (level === 'secondary') {
      const gradingSelect = document.getElementById('gradingSelect');
      if (gradingSelect) gradingSelect.value = grading;
    } else if (level === 'primary') {
      const primaryGradingSelect = document.getElementById('primaryGradingSelect');
      if (primaryGradingSelect) primaryGradingSelect.value = grading;
    }
  } catch (err) { 
    console.error(err); 
    currentGrading = { ca: 40, exam: 60 };
    toast.warning('Unable to load grading settings. Using default values.');
  }
}

async function saveGradingSetting(level = 'secondary') {
  if (!isSubscriptionActive) { 
    toast.error('Subscription inactive. Cannot save grading settings.'); 
    return; 
  }
  const gradingSelect = document.getElementById(level === 'secondary' ? 'gradingSelect' : 'primaryGradingSelect');
  if (!gradingSelect) return;
  const grading = gradingSelect.value;
  let session = document.getElementById('editorSessionSelect')?.value;
  let term = document.getElementById('editorTermSelect')?.value;
  if (!session || !term) {
    session = document.getElementById('broadsheetSessionSelect')?.value;
    term = document.getElementById('broadsheetTermSelect')?.value;
  }
  if (!session || !term) { 
    toast.error('Please select a session and term first.'); 
    return; 
  }
  const docId = getScoringDocId(session, term, level);
  const { setDoc, doc: fDoc } = await import('https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js');
  const { db } = await import('./firebase-config.js');
  try {
    await setDoc(fDoc(db, 'scoring', docId), { grading, schoolId: currentSchoolId, session, term, level });
    if (level === 'secondary') { const [ca, exam] = grading.split('/').map(Number); currentGrading = { ca, exam }; }
    toast.success(`Grading saved for ${level} level.`);
    if (editorState.selectedStudent) await renderReportCard(editorState.selectedStudent.id, editorState.selectedStudent.name);
  } catch (err) {
    if (err.code === 'permission-denied') {
      toast.error('Permission denied. Subscription required to save grading.');
    } else { 
      console.error(err); 
      toast.error('Failed to save grading. Please try again.');
    }
  }
}

async function computeSubjectStats(classId, term, session, subjectIdsToInclude = null) {
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return new Map();
  const allScores = await fetchClassScores(classId, term, session);
  const subjectMap = new Map();
  let targetSubjectIds = subjectIdsToInclude ? new Set(subjectIdsToInclude) : new Set(subjectsMap.keys());
  for (const subjId of targetSubjectIds) subjectMap.set(subjId, { totals: [], classAverage: 0, rankMap: new Map() });
  for (const score of allScores) {
    if (!targetSubjectIds.has(score.subjectId)) continue;
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
        if (i > 0 && stat.totals[i].total < stat.totals[i-1].total) rank = i+1;
        stat.rankMap.set(stat.totals[i].studentId, rank);
      }
    }
  }
  return subjectMap;
}

async function getRelevantSubjectsForClass(classId, session) {
  const classInfo = classesMap.get(classId);
  if (!classInfo) return [];
  const classLevel = classInfo.level;
  let levelSubjects = allSubjectsList.filter(subj => subj.level === classLevel);
  if (levelSubjects.length === 0) levelSubjects = allSubjectsList;
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return levelSubjects;
  const studentIds = classStudents.map(s => s.id);
  const subjectIdsWithScores = new Set();
  for (const term of ['1', '2', '3']) {
    const scores = await fetchClassScores(classId, term, session);
    scores.forEach(s => subjectIdsWithScores.add(s.subjectId));
  }
  return levelSubjects.filter(subj => subjectIdsWithScores.has(subj.id));
}

async function getStudentAverageForTerm(studentId, term, session) {
  const scores = await fetchStudentScores(studentId, term, session);
  if (!scores.length) return null;
  let total = 0, count = 0;
  for (const s of scores) { total += (s.ca || 0) + (s.exam || 0); count++; }
  if (count === 0) return null;
  return ((total / (count * 100)) * 100).toFixed(1);
}

// ------------------- renderReportCard -------------------
async function renderReportCard(studentId, studentName) {
  const requestedSession = editorState.session || document.getElementById('editorSessionSelect')?.value || getCurrentSession();
  const requestedTermNum = editorState.term || document.getElementById('editorTermSelect')?.value || '1';
  // No conversion needed anymore; term is already numeric and that's what we store

  if (!canViewResult(requestedSession, requestedTermNum)) {
    const container = document.getElementById('reportCardContent');
    if (container) {
      container.innerHTML = `
        <div style="text-align:center;padding:40px;background:#fef3c7;border-radius:8px;margin:20px;">
          <h3>⚠️ Subscription Required for Current Term</h3>
          <p>Your school subscription is inactive. You can only view results from previous sessions/terms.</p>
          <p>To access results for <strong>${requestedSession} - ${requestedTermNum}</strong>, please renew your subscription.</p>
          <p><a href="#" onclick="document.getElementById('paymentBannerContainer')?.scrollIntoView({behavior:'smooth'}); return false;">Click here to see renewal options</a></p>
        </div>`;
    }
    const actions = document.getElementById('reportActions');
    if (actions) actions.style.display = 'none';
    return;
  }

  if (!isSubscriptionActive) {
    const container = document.getElementById('reportCardContent');
    if (container && !container.querySelector('.subscription-view-warning')) {
      const warningDiv = document.createElement('div');
      warningDiv.className = 'subscription-view-warning';
      warningDiv.style.cssText = 'background:#fef3c7;color:#92400e;padding:10px;border-radius:8px;margin-bottom:15px;text-align:center;';
      warningDiv.innerHTML = '⚠️ Subscription inactive. You are viewing historical results (view only). Current term results are locked.';
      container.prepend(warningDiv);
    }
  }

  editorState.selectedStudent = { id: studentId, name: studentName };
  editorState.term    = document.getElementById('editorTermSelect')?.value    || '1';
  editorState.session = document.getElementById('editorSessionSelect')?.value || getCurrentSession();
  const classId    = document.getElementById('editorClassSelect')?.value;
  const className  = classesMap.get(classId)?.name || 'Class';
  const classInfo  = classesMap.get(classId);
  const classLevel = classInfo?.level || 'secondary';
  const isPrimary  = (classLevel === 'primary');

  await loadGradingSetting(editorState.session, editorState.term, classLevel);

  const school = await service.getSchoolById(currentSchoolId);
  const student = studentsList.find(s => s.id === studentId) || {};
  const scoresRaw = await fetchStudentScores(studentId, editorState.term, editorState.session);
  const relevantSubjectIds = allSubjectsList.filter(s => s.level === classLevel).map(s => s.id);
  const scoresWithNames = scoresRaw.filter(s => relevantSubjectIds.includes(s.subjectId)).map(score => ({
    subjectId:   score.subjectId,
    subjectName: subjectsMap.get(score.subjectId)?.name || score.subjectId,
    ca:   score.ca,
    exam: score.exam
  }));

  let subjectStats = new Map();
  if (classId) subjectStats = await computeSubjectStats(classId, editorState.term, editorState.session, relevantSubjectIds);
  await loadExistingEditorReport(studentId);

  const studentData = {
    id: studentId, name: studentName,
    classId: student.classId,
    schoolId: currentSchoolId,
    admissionNumber: student.admissionNumber || '—',
    gender: student.gender || '—',
    dob:    student.dob    || '',
    club:   student.club   || '—',
    passport: student.passport || null,
    parentPhone: student.parentPhone || null
  };
  editorState.selectedStudent.parentPhone = student.parentPhone || null;

  const comments   = { teacherComment: editorState.teacherComment, principalComment: editorState.principalComment };
  const attendance = editorState.attendance || { schoolOpened: 0, present: 0, absent: 0 };

  renderReportCardUI({
    student: studentData, scores: scoresWithNames, className, school,
    grading: currentGrading, psychomotor: editorState.psychomotor, comments,
    term: editorState.term, session: editorState.session, subjectStats,
    container: document.getElementById('reportCardContent'),
    attendance, isPrimary,
    onRatingChange:          (skillKey, newValue) => { editorState.psychomotor[skillKey] = newValue; },
    onTeacherCommentChange:  (newComment)          => { editorState.teacherComment   = newComment; },
    onPrincipalCommentChange:(newComment)          => { editorState.principalComment = newComment; }
  });
  
  const actions = document.getElementById('reportActions');
  if (actions) actions.style.display = 'flex';
  
  if (!isSubscriptionActive) {
    const saveBtn = document.getElementById('saveReportBtn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.5';
      saveBtn.title = 'Saving disabled – subscription inactive';
    }
  } else {
    const saveBtn = document.getElementById('saveReportBtn');
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.style.opacity = '1';
      saveBtn.title = '';
    }
  }
}

// ── FIX: load report without fallback (term is already numeric) ──
async function loadExistingEditorReport(studentId) {
  // Use imported getDefaultRatings
  editorState.psychomotor = getDefaultRatings();
  editorState.attendance = { schoolOpened: 0, present: 0, absent: 0 };

  // term is numeric (e.g., '1') as stored in scores
  const report = await service.getReportByStudent(studentId, currentSchoolId, editorState.term, editorState.session);
  if (report) {
    if (report.psychomotor) Object.assign(editorState.psychomotor, report.psychomotor);
    editorState.teacherComment   = report.teacherComment   || '';
    editorState.principalComment = report.principalComment || '';
    editorState.savedReportId    = report.id;
    if (report.attendance) editorState.attendance = report.attendance;
  } else {
    editorState.savedReportId = null;
  }
}

// ── Save: term is numeric, we store that ──
async function saveEditorReport() {
  if (!isSubscriptionActive) { 
    toast.error('Cannot save report – subscription inactive.'); 
    return; 
  }
  if (!editorState.selectedStudent) {
    toast.error('Please select a student first.');
    return;
  }
  const totalScore      = parseInt(document.querySelector('.rc-summary-table tr:nth-child(1) td')?.textContent) || 0;
  const totalObtainable = parseInt(document.querySelector('.rc-summary-table tr:nth-child(2) td')?.textContent) || 0;
  const average         = parseFloat(document.querySelector('.rc-summary-table tr:nth-child(4) td')?.textContent) || 0;
  const overallGrade    = document.querySelector('.rc-summary-table tr:nth-child(5) td')?.textContent || 'N/A';
  const schoolOpened    = parseInt(document.querySelector('.rc-att-input.school-opened')?.value) || 0;
  const present         = parseInt(document.querySelector('.rc-att-input.present')?.value) || 0;
  const absent          = parseInt(document.querySelector('.rc-att-input.absent')?.value) || 0;
  const attendance = { schoolOpened, present, absent };
  const reportData = {
    studentId: editorState.selectedStudent.id,
    classId: document.getElementById('editorClassSelect')?.value,
    schoolId: currentSchoolId,
    term: editorState.term,   // numeric
    session: editorState.session,
    totalScore, maxTotal: totalObtainable, average, overallGrade,
    psychomotor: editorState.psychomotor,
    teacherComment: editorState.teacherComment, principalComment: editorState.principalComment,
    attendance, updatedAt: new Date()
  };
  try {
    await service.saveReport(reportData, editorState.savedReportId);
    toast.success('Report saved successfully.');
  } catch (error) {
    if (error.code === 'permission-denied') {
      toast.error('Permission denied. Subscription required to save reports.');
    } else { 
      console.error(error); 
      toast.error('Failed to save report. Please try again.');
    }
  }
}

// ==================== PRINT, WHATSAPP, BROADSHEET ETC. (unchanged except removed duplicate helpers) ====================

function handlePrint() {
  const teacherText    = document.getElementById('teacherCommentText');
  const printTeacher   = document.getElementById('printTeacherComment');
  if (teacherText && printTeacher) printTeacher.textContent = escapeHtml(teacherText.value);
  const principalText  = document.getElementById('principalCommentText');
  const printPrincipal = document.getElementById('printPrincipalComment');
  if (principalText && printPrincipal) printPrincipal.textContent = escapeHtml(principalText.value);

  const reportContent = document.getElementById('reportCardContent');
  if (!reportContent || reportContent.children.length === 0 ||
      (reportContent.children.length === 1 && reportContent.children[0].tagName === 'P' &&
       reportContent.children[0].textContent.includes('Select a student'))) {
    toast.error('Report not ready. Please select a student first.');
    return;
  }

  const clonedReport = reportContent.cloneNode(true);
  const printWindow = window.open('', '_blank');
  if (!printWindow) { 
    toast.error('Please allow pop-ups to print the report.'); 
    return; 
  }

  const externalCssUrl = new URL('../css/styles.css', window.location.href).href;
  const inlineStyles = Array.from(document.querySelectorAll('style')).map(style => style.innerHTML).join('\n');

  const extraPrintCSS = `
    @page { size: A4; margin: 8mm; }
    body, .print-container { margin: 0; padding: 0; background: white; }
    .print-container { width: 100%; max-width: 210mm; margin: 0 auto; }
    .rc-wrapper { max-width: 100%; border: none; padding: 0; font-size: 8pt; background: #fdf8f2 !important; }
    .rc-school-name { font-size: 22pt !important; }
    .rc-main-row { display: grid !important; grid-template-columns: 62fr 35fr !important; gap: 14px !important; }
    .rc-col-left, .rc-col-right { min-width: 0; }
    .rc-att-input, .rc-tick-row, .rc-comment-controls, select, textarea, button { display: none !important; }
    .rc-print-val     { display: inline !important; }
    .rc-print-comment { display: inline !important; }
    .rc-scroll-outer  { overflow: visible !important; }
    .rc-details-band  { background: #1a3a5c !important; }
    .rc-details-cell  { color: #fff !important; border-right: 1px solid rgba(255,255,255,0.18) !important; border-bottom: 1px solid rgba(255,255,255,0.18) !important; }
    .rc-details-cell strong { color: #a8d8f0 !important; }
    .rc-subject-table, .rc-summary-table, .rc-attendance-table, .rc-skills-table, .rc-grade-scale { break-inside: avoid; page-break-inside: avoid; }
    *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
    .rc-subject-table th, .rc-summary-table th, .rc-attendance-table th, .rc-skills-table th { background: #ADD8E6 !important; }
    .rc-grade-scale th { background: #FFD700 !important; }
    .rc-comments { background: #f9f9f9 !important; }
    .rc-comment-row, .rc-comment-item {
      display: flex !important;
      flex-direction: row !important;
      align-items: baseline !important;
      gap: 8px !important;
      flex-wrap: wrap !important;
    }
    .rc-comment-label, .rc-comment-item strong {
      white-space: nowrap !important;
    }
  `;

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Report Card – ${escapeHtml(editorState.selectedStudent?.name || 'Student')}</title>
      <link rel="stylesheet" href="${externalCssUrl}">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: white; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .print-container { width: 210mm; margin: 0 auto; background: white; }
        ${inlineStyles}
        ${extraPrintCSS}
      </style>
    </head>
    <body>
      <div class="print-container">${clonedReport.outerHTML}</div>
    </body>
    </html>
  `);
  printWindow.document.close();
  setTimeout(() => { printWindow.focus(); printWindow.print(); }, 300);
}

function sendToWhatsApp() {
  if (!editorState.selectedStudent) {
    toast.error('Please select a student first.');
    return;
  }

  let phone = editorState.selectedStudent.parentPhone;
  if (!phone || phone.trim() === '') {
    toast.error('Parent phone number not available. Please update the student record.');
    return;
  }

  let digits = phone.replace(/\D/g, '');
  
  if (digits.length === 10 && digits.startsWith('8')) {
    digits = '234' + digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = '234' + digits.substring(1);
  } else if (digits.length === 13 && digits.startsWith('234')) {
    // already correct
  } else if (digits.length === 14 && digits.startsWith('234')) {
    if (digits.startsWith('234234')) digits = digits.substring(3);
  } else if (digits.length === 10 && /^[789]/.test(digits)) {
    digits = '234' + digits;
  } else {
    toast.error('Invalid phone number format. Please update the parent phone number.');
    return;
  }
  
  if (!digits.startsWith('234')) {
    toast.error('Phone number must start with Nigeria country code (234).');
    return;
  }
  if (digits.length !== 13) {
    toast.error('Phone number must be 13 digits (e.g., 234XXXXXXXXX).');
    return;
  }
  
  const message = `Please find attached the report card for ${editorState.selectedStudent.name}.`;
  const whatsappUrl = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  window.open(whatsappUrl, '_blank');
}

// ------------------- Broadsheet Functions (unchanged, just imports used) -------------------
async function generateBroadsheet() {
  if (!isSubscriptionActive) {
    const container = document.getElementById('broadsheetContainer');
    container.innerHTML = `<div style="text-align:center;padding:40px;background:#fef3c7;border-radius:8px;"><h3>⚠️ Subscription Required</h3><p>Broadsheets are unavailable because the school subscription is inactive.</p></div>`;
    document.getElementById('broadsheetActions').style.display = 'none';
    return;
  }
  const classId = document.getElementById('broadsheetClassSelect')?.value;
  const session = document.getElementById('broadsheetSessionSelect')?.value;
  const term    = document.getElementById('broadsheetTermSelect')?.value;
  if (!classId || !session || !term) { 
    toast.error('Please select Class, Session and Term'); 
    return; 
  }

  const classInfo     = classesMap.get(classId);
  const className     = classInfo?.name || 'Class';
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) {
    const container = document.getElementById('broadsheetContainer');
    if (container) container.innerHTML = '<div class="alert">No students found in this class.</div>';
    return;
  }

  const relevantSubjects = await getRelevantSubjectsForClass(classId, session);
  if (relevantSubjects.length === 0) {
    const container = document.getElementById('broadsheetContainer');
    container.innerHTML = '<div class="alert">No subjects with scores found for this class level.</div>';
    document.getElementById('broadsheetActions').style.display = 'none';
    return;
  }

  showLoader();
  try {
    const term1Scores = await fetchClassScores(classId, '1', session);
    const term2Scores = await fetchClassScores(classId, '2', session);
    const term3Scores = await fetchClassScores(classId, '3', session);

    const scoresByStudentTerm = new Map();
    const storeScores = (termScores, termNum) => {
      for (const score of termScores) {
        if (!scoresByStudentTerm.has(score.studentId)) scoresByStudentTerm.set(score.studentId, new Map());
        const studentMap = scoresByStudentTerm.get(score.studentId);
        if (!studentMap.has(termNum)) studentMap.set(termNum, new Map());
        studentMap.get(termNum).set(score.subjectId, { ca: score.ca, exam: score.exam, total: score.ca + score.exam });
      }
    };
    storeScores(term1Scores, 1); storeScores(term2Scores, 2); storeScores(term3Scores, 3);

    const termAverages = new Map();
    for (const student of classStudents) {
      const averages = {};
      let sumCombined = 0, termsWithData = 0;
      for (const t of [1,2,3]) {
        const studentScoreMap = scoresByStudentTerm.get(student.id)?.get(t) || new Map();
        let totalScore = 0, subjectCount = 0;
        for (const subj of relevantSubjects) {
          const score = studentScoreMap.get(subj.id);
          if (score) { totalScore += score.total; subjectCount++; }
        }
        if (subjectCount > 0) {
          const avg = (totalScore / (subjectCount * 100)) * 100;
          averages[t] = avg.toFixed(1); sumCombined += avg; termsWithData++;
        } else { averages[t] = null; }
      }
      const combinedAvg = termsWithData > 0 ? (sumCombined / termsWithData).toFixed(1) : null;
      termAverages.set(student.id, { ...averages, combined: combinedAvg });
    }

    const studentResults = [];
    for (const student of classStudents) {
      const subjectDetails = [];
      let totalScoreOverall = 0;
      const studentScoreMap = scoresByStudentTerm.get(student.id)?.get(parseInt(term)) || new Map();
      for (const subj of relevantSubjects) {
        const score = studentScoreMap.get(subj.id) || { ca: 0, exam: 0, total: 0 };
        totalScoreOverall += score.total;
        subjectDetails.push({ subjectName: subj.name, ca: score.ca, exam: score.exam, total: score.total });
      }
      const totalObtainable = relevantSubjects.length * 100;
      const average = totalObtainable ? (totalScoreOverall / totalObtainable) * 100 : 0;
      const grade   = calculateGrade(average);  // using imported
      const remark  = getGradeRemark(grade);
      const tAvg    = termAverages.get(student.id);
      studentResults.push({
        studentId: student.id, studentName: student.name,
        totalScore: totalScoreOverall, average, grade, remark, subjectDetails,
        term1Avg: tAvg ? (tAvg[1] !== null ? tAvg[1]+'%' : '—') : '—',
        term2Avg: tAvg ? (tAvg[2] !== null ? tAvg[2]+'%' : '—') : '—',
        term3Avg: tAvg ? (tAvg[3] !== null ? tAvg[3]+'%' : '—') : '—',
        combinedAvg: tAvg && tAvg.combined ? tAvg.combined+'%' : '—'
      });
    }

    studentResults.sort((a, b) => b.average - a.average);
    let rank = 1;
    for (let i = 0; i < studentResults.length; i++) {
      if (i > 0 && studentResults[i].average < studentResults[i-1].average) rank = i+1;
      studentResults[i].position = rank;
    }

    let html = `<div style="margin-bottom:1rem;"><h3>BROADSHEET – ${escapeHtml(className)} – ${session} – Term ${term}</h3></div>`;
    html += `<div class="table-responsive-wrapper"><table class="broadsheet-table" border="1" cellpadding="5" cellspacing="0">`;
    html += `<thead><tr><th>S/N</th><th>Student Name</th>`;
    for (const subj of relevantSubjects) html += `<th colspan="3">${escapeHtml(subj.name)}</th>`;
    html += `<th>Total</th><th>1st Term</th><th>2nd Term</th><th>3rd Term</th><th>% Avg Total</th><th>Grade</th><th>Position</th><th>Remark</th></tr>`;
    html += `<tr><th></th><th></th>`;
    for (let i = 0; i < relevantSubjects.length; i++) html += `<th>CA</th><th>Exam</th><th>Total</th>`;
    html += `<th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th></tr></thead><tbody>`;
    for (let i = 0; i < studentResults.length; i++) {
      const r = studentResults[i];
      html += `<tr><td class="sn-cell">${i+1}</td><td class="student-name-cell">${escapeHtml(r.studentName)}</td>`;
      for (const sub of r.subjectDetails) html += `<td>${sub.ca}</td><td class="exam-cell">${sub.exam}</td><td class="total-cell">${sub.total}</td>`;
      html += `<td>${r.totalScore}</td><td class="term1-cell">${r.term1Avg}</td><td class="term2-cell">${r.term2Avg}</td><td class="term3-cell">${r.term3Avg}</td><td class="combined-cell">${r.combinedAvg}</td><td class="grade-cell">${r.grade}</td>`;
      html += `<td>${r.position}${r.position===1?'st':r.position===2?'nd':r.position===3?'rd':'th'}</td><td class="remark-cell">${r.remark}</td></tr>`;
    }
    html += `</tbody></table></div>`;
    const container = document.getElementById('broadsheetContainer');
    if (container) container.innerHTML = html;
    const actions = document.getElementById('broadsheetActions');
    if (actions) actions.style.display = 'flex';
    window.currentBroadsheetData = { classId, session, term, studentResults, subjects: relevantSubjects };
  } catch (err) {
    console.error('Broadsheet generation error:', err);
    toast.error('Failed to generate broadsheet. Please try again.');
  } finally {
    hideLoader();
  }
}

async function saveBroadsheetToFirestore() {
  if (!isSubscriptionActive) { 
    toast.error('Cannot save broadsheet – subscription inactive.'); 
    return; 
  }
  if (!window.currentBroadsheetData) { 
    toast.error('No broadsheet data to save. Generate first.'); 
    return; 
  }
  const { classId, session, term, studentResults, subjects } = window.currentBroadsheetData;
  const docId = `${currentSchoolId}_${classId}_${session.replace(/\//g, '_')}_${term}`;
  const broadsheetData = {
    schoolId: currentSchoolId, classId, session, term,
    students: studentResults.map(s => ({
      studentId: s.studentId, studentName: s.studentName, totalScore: s.totalScore,
      average: s.average, grade: s.grade, remark: s.remark, position: s.position,
      term1Avg: s.term1Avg, term2Avg: s.term2Avg, term3Avg: s.term3Avg,
      combinedAvg: s.combinedAvg, subjectDetails: s.subjectDetails
    })),
    subjects: subjects.map(s => ({ id: s.id, name: s.name })),
    createdAt: new Date(), updatedAt: new Date()
  };
  try {
    await service.saveBroadsheet(docId, broadsheetData);
    toast.success('Broadsheet saved successfully.');
  } catch (err) {
    if (err.code === 'permission-denied') {
      toast.error('Permission denied. Subscription required to save broadsheets.');
    } else { 
      console.error(err); 
      toast.error('Failed to save broadsheet. Please try again.');
    }
  }
}

function printBroadsheet() {
  const container = document.getElementById('broadsheetContainer');
  if (!container || !container.innerHTML.trim()) { 
    toast.error('No broadsheet to download.'); 
    return; 
  }
  const originalContent = container.cloneNode(true);
  const title = document.querySelector('#broadsheetContainer h3')?.innerText || 'Class Broadsheet';
  const printWindow = window.open('', '_blank');
  if (!printWindow) { 
    toast.error('Please allow pop-ups to print.'); 
    return; 
  }
  const externalCssUrl = new URL('../css/styles.css', window.location.href).href;
  const inlineStyles = Array.from(document.querySelectorAll('style')).map(s => s.innerHTML).join('\n');
  const printCSS = `
    @page { size: A4 landscape; margin: 1cm; }
    body { margin:0; padding:0; font-family:'Segoe UI',sans-serif; font-size:10px; }
    .broadsheet-table { width:100%; border-collapse:collapse; font-size:8px; }
    .broadsheet-table th, .broadsheet-table td { border:1px solid #000; padding:4px 3px; text-align:center; vertical-align:middle; }
    .student-name-cell { text-align:left !important; }
    .table-responsive-wrapper { overflow:visible !important; border:none !important; margin:0 !important; }
    tr, td, th { page-break-inside:avoid; page-break-after:avoid; }
  `;
  printWindow.document.write(`
    <!DOCTYPE html><html><head><title>${title}</title>
    <link rel="stylesheet" href="${externalCssUrl}">
    <style>${inlineStyles}${printCSS}</style>
    </head><body>${originalContent.outerHTML}</body></html>
  `);
  printWindow.document.close();
  printWindow.print();
}

async function onEditorClassChange() {
  const classId = document.getElementById('editorClassSelect')?.value;
  const studentContainer = document.getElementById('studentListContainer');
  const reportContent    = document.getElementById('reportCardContent');
  const reportActions    = document.getElementById('reportActions');
  if (!classId) {
    if (studentContainer) studentContainer.innerHTML = '<p>Select a class</p>';
    if (reportContent)    reportContent.innerHTML    = '<p>Select a student</p>';
    if (reportActions)    reportActions.style.display = 'none';
    return;
  }
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) { if (studentContainer) studentContainer.innerHTML = '<p>No students</p>'; return; }
  let html = '';
  classStudents.forEach(student => { html += `<div class="student-list-item" data-id="${student.id}">${escapeHtml(student.name)}</div>`; });
  if (studentContainer) studentContainer.innerHTML = html;

  const firstStudent = classStudents[0];
  if (firstStudent) {
    const firstEl = document.querySelector('.student-list-item');
    if (firstEl) firstEl.classList.add('active');
    // resetRatingsToDefaults() - no longer needed as it's done inside render
    await renderReportCard(firstStudent.id, firstStudent.name);
  }
  document.querySelectorAll('.student-list-item').forEach(el => {
    el.addEventListener('click', async () => {
      document.querySelectorAll('.student-list-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      await renderReportCard(el.dataset.id, el.textContent.trim());
    });
  });
  await onEditorFilterChange();
}

async function onEditorFilterChange() {
  editorState.term    = document.getElementById('editorTermSelect')?.value    || '1';
  editorState.session = document.getElementById('editorSessionSelect')?.value || getCurrentSession();
  if (editorState.selectedStudent) await renderReportCard(editorState.selectedStudent.id, editorState.selectedStudent.name);
}

function updateSubscriptionUI() {
  if (!document.getElementById('paymentBannerContainer')) {
    const contentDiv = document.querySelector('.content');
    if (contentDiv) {
      const paymentDiv = document.createElement('div');
      paymentDiv.id = 'paymentBannerContainer';
      paymentDiv.style.margin = '16px 0';
      contentDiv.insertBefore(paymentDiv, contentDiv.firstChild);
    }
  }
  const container = document.getElementById('paymentBannerContainer');
  if (container) {
    if (!isSubscriptionActive) {
      if (!document.getElementById('paymentBanner')) {
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
        document.getElementById('paystackPaymentBtn')?.addEventListener('click', async () => {
          const ref = 'PAY-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
          await import('https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js').then(({ setDoc, doc }) => {
            import('./firebase-config.js').then(({ db }) => {
              setDoc(doc(db, 'paymentReferences', ref), {
                schoolId: currentSchoolId,
                amount: 0,
                reason: 'renewal',
                createdAt: new Date(),
                status: 'pending',
                reference: ref
              });
            });
          });
          window.open(`https://paystack.shop/pay/fmj267paou?reference=${ref}`, '_blank');
        });
      }
    } else {
      const existing = document.getElementById('paymentBanner');
      if (existing) existing.remove();
    }
  }

  const btns = ['saveGradingBtn','savePrimaryGradingBtn','generateBroadsheetBtn','saveBroadsheetBtn','printBroadsheetBtn','saveReportBtn','printReportBtn'];
  btns.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) { btn.disabled = !isSubscriptionActive; btn.style.opacity = isSubscriptionActive ? '1' : '0.5'; }
  });

  const existingWarning = document.querySelector('.subscription-warning-banner');
  if (!isSubscriptionActive) {
    if (!existingWarning) {
      const warningBanner = document.createElement('div');
      warningBanner.className = 'subscription-warning-banner';
      warningBanner.style.cssText = 'background:#fee2e2;color:#991b1b;padding:12px;text-align:center;margin-bottom:16px;border-radius:8px;';
      warningBanner.innerHTML = '⚠️ Subscription inactive. Report cards and broadsheets are disabled. Please renew to access these features.';
      const contentDiv = document.querySelector('.content');
      if (contentDiv) contentDiv.insertBefore(warningBanner, contentDiv.firstChild);
    }
  } else if (existingWarning) {
    existingWarning.remove();
  }
}

export async function initResultsPage() {
  if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));

  currentSchoolId = await getCurrentSchoolId();
  if (!currentSchoolId) { 
    toast.error('School ID missing. Please log out and log in again.'); 
    return; 
  }

  await initAcademicCalendar();
  currentAcademicSession = getCurrentSession();
  currentAcademicTerm = getCurrentTerm();

  if (unsubscribeSub) unsubscribeSub();
  unsubscribeSub = onSubscriptionChange(currentSchoolId, ({ isActive }) => {
    isSubscriptionActive = isActive;
    updateSubscriptionUI();
    if (editorState.selectedStudent) renderReportCard(editorState.selectedStudent.id, editorState.selectedStudent.name);
  });

  const currentSession = getCurrentSession();
  const currentTerm    = getCurrentTerm();
  const termMap        = { 'First Term': '1', 'Second Term': '2', 'Third Term': '3' };
  const currentTermNum = termMap[currentTerm] || '1';

  try {
    await loadClassesAndSubjects();
    await loadAllStudents();
  } catch (err) { 
    console.error('Data loading failed', err); 
    return; 
  }

  const classSelects = ['broadsheetClassSelect', 'editorClassSelect'];
  classSelects.forEach(id => {
    const select = document.getElementById(id);
    if (select) {
      const sortedClasses = Array.from(classesMap.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));
      select.innerHTML = '<option value="">-- Select Class --</option>' +
        sortedClasses.map(([id, info]) => `<option value="${id}">${escapeHtml(info.name)}</option>`).join('');
    }
  });

  const distinctSessions = await loadSessionOptions(currentSchoolId);
  if (!distinctSessions.includes(currentSession)) distinctSessions.unshift(currentSession);

  const sessionSelects = ['broadsheetSessionSelect', 'editorSessionSelect'];
  sessionSelects.forEach(id => {
    const select = document.getElementById(id);
    if (select) select.innerHTML = distinctSessions.map(s => `<option value="${s}" ${s === currentSession ? 'selected' : ''}>${s}</option>`).join('');
  });

  const termSelects = ['broadsheetTermSelect', 'editorTermSelect'];
  termSelects.forEach(id => { const select = document.getElementById(id); if (select) select.value = currentTermNum; });

  await loadGradingSetting(currentSession, currentTermNum, 'secondary');
  await loadGradingSetting(currentSession, currentTermNum, 'primary');

  document.getElementById('generateBroadsheetBtn')?.addEventListener('click', generateBroadsheet);
  document.getElementById('saveBroadsheetBtn')?.addEventListener('click', saveBroadsheetToFirestore);
  document.getElementById('printBroadsheetBtn')?.addEventListener('click', printBroadsheet);
  document.getElementById('saveGradingBtn')?.addEventListener('click', () => saveGradingSetting('secondary'));
  document.getElementById('savePrimaryGradingBtn')?.addEventListener('click', () => saveGradingSetting('primary'));
  document.getElementById('refreshEditorBtn')?.addEventListener('click', () => onEditorClassChange());
  document.getElementById('saveReportBtn')?.addEventListener('click', saveEditorReport);
  document.getElementById('printReportBtn')?.addEventListener('click', handlePrint);
  document.getElementById('editorClassSelect')?.addEventListener('change', onEditorClassChange);
  document.getElementById('editorSessionSelect')?.addEventListener('change', onEditorFilterChange);
  document.getElementById('editorTermSelect')?.addEventListener('change', onEditorFilterChange);

  const downloadBroadsheetBtn = document.getElementById('printBroadsheetBtn');
  if (downloadBroadsheetBtn) downloadBroadsheetBtn.textContent = 'Print/Download';
  const downloadReportBtn = document.getElementById('printReportBtn');
  if (downloadReportBtn) downloadReportBtn.textContent = 'Print/Download';

  const reportActions = document.getElementById('reportActions');
  if (reportActions && !document.getElementById('whatsappReportBtn')) {
    const whatsappBtn = document.createElement('button');
    whatsappBtn.id = 'whatsappReportBtn';
    whatsappBtn.className = 'btn-secondary';
    whatsappBtn.style.backgroundColor = '#25D366';
    whatsappBtn.style.color = 'white';
    whatsappBtn.innerHTML = '📱 Send to WhatsApp';
    whatsappBtn.addEventListener('click', sendToWhatsApp);
    reportActions.appendChild(whatsappBtn);
  }

  updateSubscriptionUI();
  await onEditorClassChange();
}