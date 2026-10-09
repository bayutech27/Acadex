// class.js - Teacher report card page + broadsheet (full functionality)
//
// UPDATED (snapshot refactor):
//  • The teacher's class and current session remain FIXED. Term remains selectable.
//  • When a report is saved, a complete snapshot is persisted alongside the
//    identity fields (schoolId/studentId/classId/className/term/session). This
//    lets the admin page faithfully re-render historical cards even after the
//    student has moved, been made inactive or graduated.
//  • Existing report lookups now reliably use classId (5th arg) thanks to the
//    service.js change.
//
// All existing UI and behaviour is otherwise unchanged.

import * as service from './service.js';
import { getTeacherData } from './teacher-dashboard.js';
import { showNotification, handleError, showLoader, hideLoader, toast } from './error-handler.js';
import { initAcademicCalendar, getCurrentTerm, getCurrentSession } from './academic-calendar.js';
import { renderReportCardUI } from './reportCardRenderer.js';
import { auth } from './firebase-config.js';

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

let currentSchoolId = null;
let teacherData = null;
let currentClassId = null;
let hostClassIds = [];
let classNameCache = '';
let currentGrading = { ca: 40, exam: 60 };
let classesMap = new Map();
let subjectsMap = new Map();
let allSubjectsList = [];
let studentsList = [];
let isSubscriptionActive = false;

const psychomotorSkillsList_local = psychomotorSkillsList;
const affectiveSkillsList_local = affectiveSkillsList;

let reportState = {
  selectedStudent: null,
  term: '1',
  session: '',
  psychomotor: {},
  teacherComment: '',
  principalComment: '',
  attendance: { schoolOpened: 0, present: 0, absent: 0 },
  savedReportId: null,
  savedReport: null,
  // snapshot inputs
  currentScores: [],
  currentSubjectStats: null,
  currentClassName: '',
  currentClassId: '',
  currentClassLevel: '',
  currentIsPrimary: false,
  currentGrading: { ca: 40, exam: 60 },
  currentStudentData: null
};

[...psychomotorSkillsList_local, ...affectiveSkillsList_local].forEach(skill => {
  const key = getSkillKey(skill);
  reportState.psychomotor[key] = 3;
});

/* ---------------- Subscription ---------------- */
async function checkSubscription() {
  try {
    const subData = await service.getSubscription(currentSchoolId);
    isSubscriptionActive = subData ? (subData.status === 'active' && subData.locked !== true) : false;
    if (isSubscriptionActive) enableSubscriptionFeatures();
    else disableSubscriptionFeatures();
    return isSubscriptionActive;
  } catch (err) {
    console.error('Subscription check error:', err);
    toast.error('Unable to verify subscription status. Please refresh the page.');
    isSubscriptionActive = false;
    disableSubscriptionFeatures();
    return false;
  }
}
function disableSubscriptionFeatures() {
  const ids = ['saveReportBtn','printReportBtn','whatsappReportBtn','generateBroadsheetBtn','saveBroadsheetBtn','printBroadsheetBtn'];
  ids.forEach(id => { const b = document.getElementById(id); if (b) { b.disabled = true; b.style.opacity = '0.5'; } });
  if (!document.querySelector('.subscription-warning')) {
    const div = document.createElement('div');
    div.className = 'subscription-warning';
    div.style.cssText = 'background:#fee2e2;color:#991b1b;padding:12px;margin-bottom:16px;border-radius:8px;';
    div.innerHTML = '⚠️ Subscription inactive. Report card and broadsheet features are disabled. Please contact your administrator to renew.';
    const container = document.querySelector('.class-report-container');
    if (container) container.prepend(div);
  }
}
function enableSubscriptionFeatures() {
  const ids = ['saveReportBtn','printReportBtn','whatsappReportBtn','generateBroadsheetBtn','saveBroadsheetBtn','printBroadsheetBtn'];
  ids.forEach(id => { const b = document.getElementById(id); if (b) { b.disabled = false; b.style.opacity = '1'; } });
  document.querySelector('.subscription-warning')?.remove();
}

/* ---------------- Teacher / class loading ---------------- */
async function loadTeacherHostClasses() {
  try {
    const user = auth.currentUser;
    if (!user || !user.uid) { toast.error('You are not logged in. Please refresh the page.'); return false; }
    const teacher = await service.getTeacherById(user.uid);
    if (!teacher) { toast.error('Teacher record not found. Please contact support.'); return false; }
    if (teacher.hostClassIds && teacher.hostClassIds.length > 0) hostClassIds = teacher.hostClassIds;
    else if (teacher.hostClassId) hostClassIds = [teacher.hostClassId];
    else { hostClassIds = []; toast.error('You are not assigned as a class teacher for any class.'); window.location.href = 'teacher-dashboard.html'; return false; }
    return true;
  } catch (err) {
    console.error('Load teacher host classes error:', err);
    toast.error('Unable to load your assigned classes. Please refresh the page.');
    return false;
  }
}

async function loadGradingSettingByLevel(level, session, term) {
  if (!level) { currentGrading = { ca: 40, exam: 60 }; return; }
  try {
    const configs = await service.getScoringConfig(currentSchoolId, level);
    let grading = null;
    if (configs && configs.length > 0) {
      const data = configs[0];
      grading = data.grading || `${data.caWeight}/${data.examWeight}`;
    }
    if (!grading) {
      const fallback = await service.getScoringConfig(currentSchoolId);
      if (fallback && fallback.length > 0) grading = fallback[0].grading || `${fallback[0].caWeight}/${fallback[0].examWeight}`;
    }
    if (!grading) {
      const { getDoc, doc } = await import('https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js');
      const { db } = await import('./firebase-config.js');
      const docId = `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}`;
      const snap = await getDoc(doc(db, 'scoring', docId));
      if (snap.exists()) grading = snap.data().grading;
    }
    if (grading) { const [ca, exam] = grading.split('/').map(Number); currentGrading = { ca, exam }; }
    else currentGrading = { ca: 40, exam: 60 };
  } catch (err) {
    console.error('Grading load error:', err);
    toast.warning('Unable to load grading settings. Using default values (CA=40, Exam=60).');
    currentGrading = { ca: 40, exam: 60 };
  }
}
async function loadGradingSetting(session, term, classLevel = null) {
  if (classLevel) { await loadGradingSettingByLevel(classLevel, session, term); return; }
  try {
    const docId = `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}`;
    const { getDoc, doc } = await import('https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js');
    const { db } = await import('./firebase-config.js');
    const snap = await getDoc(doc(db, 'scoring', docId));
    let grading = '40/60';
    if (snap.exists()) grading = snap.data().grading;
    const [ca, exam] = grading.split('/').map(Number);
    currentGrading = { ca, exam };
  } catch (err) { currentGrading = { ca: 40, exam: 60 }; }
}
async function fetchClassName() {
  try {
    const classData = await service.getClassById(currentClassId);
    classNameCache = classData ? classData.name : currentClassId;
    if (classData) classesMap.set(currentClassId, { name: classData.name, level: classData.level });
  } catch (e) { console.warn(e); classNameCache = currentClassId; }
}
async function loadSubjectsAndClasses() {
  try {
    const subjects = await service.getSubjectsBySchool(currentSchoolId);
    subjectsMap.clear(); allSubjectsList = [];
    subjects.forEach(subj => {
      subjectsMap.set(subj.id, subj.name);
      allSubjectsList.push({ id: subj.id, name: subj.name, level: subj.level || null });
    });
    const classes = await service.getClassesBySchool(currentSchoolId);
    classesMap.clear();
    classes.forEach(cls => classesMap.set(cls.id, { name: cls.name, level: cls.level }));
  } catch (err) {
    console.error('Subjects/classes load error:', err);
    toast.error('Unable to load subjects and classes. Please refresh the page.');
  }
}
async function loadStudentsList() {
  try {
    const students = await service.getStudentsBySchool(currentSchoolId);
    studentsList = students.map(s => ({
      id: s.id, name: s.name, classId: s.classId,
      admissionNumber: s.admissionNumber, gender: s.gender,
      dob: s.dob, club: s.club, passport: s.passport || null,
      subjects: s.subjects || [], schoolId: s.schoolId,
      parentPhone: s.parentPhone || null
    }));
  } catch (err) {
    console.error('Students load error:', err);
    toast.error('Unable to load students. Please refresh the page.');
  }
}

/* ---------------- Scores / stats ---------------- */
async function fetchScores(studentId, term, session) {
  try {
    const scores = await service.getScoresByStudent(studentId, currentSchoolId, term, session);
    return scores.map(s => ({
      subjectId: s.subjectId, ca: s.ca, exam: s.exam,
      createdAt: s.createdAt || null, updatedAt: s.updatedAt || null
    }));
  } catch (err) {
    console.error('Scores fetch error:', err);
    toast.error('Unable to load student scores. Please refresh the page.');
    return [];
  }
}
async function computeSubjectStats(classId, term, session) {
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return new Map();
  try {
    const allScores = await service.getScoresByClass(classId, currentSchoolId, term, session);
    const subjectMap = new Map();
    for (const subjId of subjectsMap.keys()) subjectMap.set(subjId, { totals: [], classAverage: 0, rankMap: new Map() });
    for (const score of allScores) {
      const total = (score.ca || 0) + (score.exam || 0);
      const stat = subjectMap.get(score.subjectId);
      if (stat) stat.totals.push({ studentId: score.studentId, total });
    }
    for (const [, stat] of subjectMap.entries()) {
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
  } catch (err) {
    console.error('Subject stats error:', err);
    toast.warning('Unable to compute subject statistics. Position and class average will not be shown.');
    return new Map();
  }
}
async function getRelevantSubjectsForClass(classId, term, session) {
  const classInfo = classesMap.get(classId);
  if (!classInfo) return [];
  const classLevel = classInfo.level;
  let levelSubjects = allSubjectsList.filter(subj => subj.level === classLevel);
  if (levelSubjects.length === 0) levelSubjects = allSubjectsList;
  const classStudents = studentsList.filter(s => s.classId === classId);
  if (!classStudents.length) return levelSubjects;
  try {
    const allScores = await service.getScoresByClass(classId, currentSchoolId, term, session);
    const ids = new Set(allScores.map(s => s.subjectId));
    return levelSubjects.filter(subj => ids.has(subj.id));
  } catch (err) { return levelSubjects; }
}

/* ---------------- Snapshot builder (shared with results.js semantics) ---------------- */
function buildSnapshotForSave({
  studentData, scores, className, classId, grading, isPrimary,
  totalScore, totalObtainable, average, overallGrade,
  attendance, psychomotor, teacherComment, principalComment, position,
  subjectStats, studentId
}) {
  const subjectSnapshot = (Array.isArray(scores) ? scores : [])
    .filter(s => Number(s.ca) > 0 || Number(s.exam) > 0)
    .map(s => {
      const ca = Number(s.ca) || 0;
      const exam = Number(s.exam) || 0;
      let subjPosition = null;
      let subjClassAvg = null;
      if (subjectStats && typeof subjectStats.get === 'function') {
        const stat = subjectStats.get(s.subjectId);
        if (stat) {
          const rank = stat.rankMap?.get?.(studentId);
          if (typeof rank === 'number') subjPosition = rank;
          if (stat.classAverage != null) subjClassAvg = stat.classAverage;
        }
      }
      return {
        subjectId: s.subjectId,
        subjectName: s.subjectName || s.subjectId,
        ca, exam,
        total: ca + exam,
        position: subjPosition,
        classAverage: subjClassAvg
      };
    });

  const psychoOut = {};
  if (psychomotor && typeof psychomotor === 'object') {
    Object.keys(psychomotor).forEach(k => {
      const v = psychomotor[k];
      if (typeof v === 'number') psychoOut[k] = v;
    });
  }

  return {
    studentSnapshot: {
      id: studentData?.id || studentId,
      name: studentData?.name || '',
      admissionNumber: studentData?.admissionNumber || '',
      gender: studentData?.gender || '',
      dob: studentData?.dob || '',
      club: studentData?.club || '',
      passport: studentData?.passport || null,
      parentPhone: studentData?.parentPhone || null
    },
    subjectSnapshot,
    grading: { ca: Number(grading?.ca) || 40, exam: Number(grading?.exam) || 60 },
    isPrimary: !!isPrimary,
    className: className || '',
    classId: classId || '',
    totalScore: Number(totalScore) || 0,
    totalObtainable: Number(totalObtainable) || 0,
    average: Number(average) || 0,
    overallGrade: overallGrade || '',
    attendance: {
      schoolOpened: Number(attendance?.schoolOpened) || 0,
      present: Number(attendance?.present) || 0,
      absent: Number(attendance?.absent) || 0
    },
    psychomotor: psychoOut,
    teacherComment: teacherComment || '',
    principalComment: principalComment || '',
    position: (typeof position === 'number') ? position : null
  };
}

/* ---------------- Report card ---------------- */
async function loadReportCard(studentId, studentName) {
  if (!isSubscriptionActive) {
    const container = document.getElementById('reportCardContent');
    if (container) {
      container.innerHTML = `
        <div style="text-align:center;padding:40px;background:#fef3c7;border-radius:8px;margin:20px;">
          <h3>⚠️ Subscription Required</h3>
          <p>Report cards are unavailable because the school subscription is inactive.</p>
          <p>Please contact your administrator to renew.</p>
        </div>`;
    }
    const actions = document.getElementById('reportActions');
    if (actions) actions.style.display = 'none';
    return;
  }

  reportState.term    = document.getElementById('termSelect').value;
  reportState.session = document.getElementById('sessionSelect').value;

  const student        = studentsList.find(s => s.id === studentId);
  const studentClassId = student ? student.classId : currentClassId;

  reportState.selectedStudent = { id: studentId, name: studentName, classId: studentClassId };

  let classLevel = null;
  if (studentClassId && classesMap.has(studentClassId)) classLevel = classesMap.get(studentClassId).level;
  else if (studentClassId) {
    const classData = await service.getClassById(studentClassId);
    if (classData) classLevel = classData.level;
  }
  await loadGradingSetting(reportState.session, reportState.term, classLevel);
  const isPrimary = (classLevel === 'primary');

  reportState.selectedStudent.parentPhone = (student && student.parentPhone) ? student.parentPhone : null;

  showLoader();
  try {
    const school = await service.getSchoolById(currentSchoolId);
    const rawScores = await fetchScores(studentId, reportState.term, reportState.session);
    const scoresWithNames = rawScores.map(score => ({
      subjectId:   score.subjectId,
      subjectName: subjectsMap.get(score.subjectId) || score.subjectId,
      ca:   score.ca,
      exam: score.exam,
      createdAt: score.createdAt,
      updatedAt: score.updatedAt
    }));

    const subjectStats = await computeSubjectStats(studentClassId, reportState.term, reportState.session);

    // Fetch existing report for this exact identity (classId now used)
    await loadExistingReport(studentId, studentClassId);

    const studentData = {
      id: studentId, name: studentName, schoolId: currentSchoolId,
      classId: studentClassId,
      admissionNumber: student?.admissionNumber || '—',
      gender:   student?.gender   || '—',
      dob:      student?.dob      || '',
      club:     student?.club     || '—',
      passport: student?.passport || null,
      parentPhone: student?.parentPhone || null
    };

    // Capture snapshot inputs
    reportState.currentScores       = scoresWithNames;
    reportState.currentSubjectStats = subjectStats;
    reportState.currentClassName    = classNameCache;
    reportState.currentClassId      = studentClassId;
    reportState.currentClassLevel   = classLevel;
    reportState.currentIsPrimary    = isPrimary;
    reportState.currentGrading      = { ...currentGrading };
    reportState.currentStudentData  = studentData;

    await renderReportCardUI({
      student: studentData, scores: scoresWithNames, className: classNameCache,
      school, grading: currentGrading, psychomotor: reportState.psychomotor,
      comments: { teacherComment: reportState.teacherComment, principalComment: reportState.principalComment },
      attendance: reportState.attendance, term: reportState.term, session: reportState.session,
      subjectStats, container: document.getElementById('reportCardContent'), isPrimary,
      onRatingChange:          (skillKey, newValue) => { reportState.psychomotor[skillKey] = newValue; },
      onTeacherCommentChange:  (newComment)          => { reportState.teacherComment   = newComment; },
      onPrincipalCommentChange:(newComment)          => { reportState.principalComment = newComment; }
    });

    const actions = document.getElementById('reportActions');
    if (actions) actions.style.display = 'flex';
  } catch (err) {
    console.error('Report card load error:', err);
    toast.error('Unable to load report card. Please refresh the page.');
  } finally {
    hideLoader();
  }
}

async function loadExistingReport(studentId, classId) {
  try {
    const report = await service.getReportByStudent(
      studentId, currentSchoolId, reportState.term, reportState.session, classId
    );
    if (report) {
      reportState.savedReport = report;
      if (report.psychomotor) Object.assign(reportState.psychomotor, report.psychomotor);
      reportState.teacherComment   = report.teacherComment   || '';
      reportState.principalComment = report.principalComment || '';
      reportState.attendance       = report.attendance       || { schoolOpened: 0, present: 0, absent: 0 };
      reportState.savedReportId    = report.id;
    } else {
      reportState.savedReport = null;
      reportState.attendance    = { schoolOpened: 0, present: 0, absent: 0 };
      reportState.savedReportId = null;
    }
  } catch (err) {
    console.error('Existing report load error:', err);
    toast.warning('Could not load saved report data. Starting with fresh report.');
  }
}

async function saveReportCard() {
  const active = await checkSubscription();
  if (!active) { toast.error('Cannot save report – subscription inactive.'); return; }
  if (!reportState.selectedStudent) { toast.error('Please select a student first.'); return; }

  const schoolOpenedInput = document.querySelector('.rc-att-input.school-opened');
  const presentInput      = document.querySelector('.rc-att-input.present');
  const absentInput       = document.querySelector('.rc-att-input.absent');

  const schoolOpened = schoolOpenedInput ? parseInt(schoolOpenedInput.value) || 0 : reportState.attendance.schoolOpened;
  const present      = presentInput      ? parseInt(presentInput.value)      || 0 : reportState.attendance.present;
  const absent       = absentInput       ? parseInt(absentInput.value)       || 0 : reportState.attendance.absent;
  const attendance   = { schoolOpened, present, absent };

  const totalScore      = parseInt(document.querySelector('.rc-summary-table tr:nth-child(1) td')?.textContent) || 0;
  const totalObtainable = parseInt(document.querySelector('.rc-summary-table tr:nth-child(2) td')?.textContent) || 0;
  const average         = parseFloat(document.querySelector('.rc-summary-table tr:nth-child(4) td')?.textContent) || 0;
  const overallGrade    = document.querySelector('.rc-summary-table tr:nth-child(5) td')?.textContent || 'N/A';

  const classIdForSave = reportState.selectedStudent.classId || currentClassId;
  const classNameForSave = reportState.currentClassName || classNameCache || '';
  const isPrimary = !!reportState.currentIsPrimary;

  const snapshot = buildSnapshotForSave({
    studentData: reportState.currentStudentData,
    scores:      reportState.currentScores,
    className:   classNameForSave,
    classId:     classIdForSave,
    grading:     reportState.currentGrading,
    isPrimary,
    totalScore, totalObtainable, average, overallGrade,
    attendance,
    psychomotor:      reportState.psychomotor,
    teacherComment:   reportState.teacherComment,
    principalComment: reportState.principalComment,
    position:         null, // teacher page does not render position
    subjectStats:     reportState.currentSubjectStats,
    studentId:        reportState.selectedStudent.id
  });

  const reportData = {
    studentId: reportState.selectedStudent.id,
    studentName: reportState.selectedStudent.name,
    classId:   classIdForSave,
    className: classNameForSave,
    schoolId:  currentSchoolId,
    term:      reportState.term,
    session:   reportState.session,
    totalScore, maxTotal: totalObtainable, average, overallGrade,
    psychomotor: reportState.psychomotor,
    teacherComment: reportState.teacherComment, principalComment: reportState.principalComment,
    attendance,
    updatedAt: new Date(),
    snapshot
  };

  // Safety: never overwrite a report for a different identity
  let existingId = reportState.savedReportId;
  if (existingId && reportState.savedReport) {
    const sr = reportState.savedReport;
    const same =
      sr.studentId === reportData.studentId &&
      sr.classId   === reportData.classId   &&
      sr.term      === reportData.term      &&
      sr.session   === reportData.session;
    if (!same) existingId = null;
  }

  showLoader();
  try {
    const newId = await service.saveReport(reportData, existingId);
    reportState.savedReportId = newId;
    reportState.attendance = attendance;
    toast.success('Report saved successfully.');
  } catch (err) {
    console.error('Report save error:', err);
    if (err.code === 'permission-denied' || err.message?.includes('permission')) {
      toast.error('Permission denied. Subscription required to save reports.');
    } else {
      toast.error('Failed to save report. Please try again.');
    }
  } finally {
    hideLoader();
  }
}

/* ---------------- Print / WhatsApp (unchanged) ---------------- */
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
    toast.error('Report not ready. Please select a student first.');
    return;
  }

  const clonedReport = reportContent.cloneNode(true);
  const printWindow = window.open('', '_blank');
  if (!printWindow) { toast.error('Please allow pop-ups to print the report.'); return; }

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
    .rc-comment-row, .rc-comment-item { display: flex !important; flex-direction: row !important; align-items: baseline !important; gap: 8px !important; flex-wrap: wrap !important; }
    .rc-comment-label, .rc-comment-item strong { white-space: nowrap !important; }
  `;

  printWindow.document.write(`
    <!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Report Card – ${escapeHtml(reportState.selectedStudent?.name || 'Student')}</title>
    <link rel="stylesheet" href="${externalCssUrl}">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { background: white; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
      .print-container { width: 210mm; margin: 0 auto; background: white; }
      ${inlineStyles}${extraPrintCSS}
    </style></head><body>
      <div class="print-container">${clonedReport.outerHTML}</div>
    </body></html>`);
  printWindow.document.close();
  setTimeout(() => { printWindow.focus(); printWindow.print(); }, 300);
}

function sendToWhatsApp() {
  if (!reportState.selectedStudent) { toast.error('Please select a student first.'); return; }
  let phone = reportState.selectedStudent.parentPhone;
  if (!phone || phone.trim() === '') { toast.error('Parent phone number not available. Please update the student record.'); return; }
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('8')) digits = '234' + digits;
  else if (digits.length === 11 && digits.startsWith('0')) digits = '234' + digits.substring(1);
  else if (digits.length === 13 && digits.startsWith('234')) { /* ok */ }
  else if (digits.length === 14 && digits.startsWith('234')) digits = digits.substring(3);
  else if (digits.length === 10 && /^[789]/.test(digits)) digits = '234' + digits;
  else { toast.error('Invalid phone number format. Please update the parent phone number.'); return; }
  if (!digits.startsWith('234')) { toast.error('Phone number must start with Nigeria country code (234).'); return; }
  if (digits.length !== 13) { toast.error('Phone number must be 13 digits (e.g., 234XXXXXXXXX).'); return; }
  const message = `Please find attached the report card for ${reportState.selectedStudent.name}.`;
  window.open(`https://wa.me/${digits}?text=${encodeURIComponent(message)}`, '_blank');
}

/* ---------------- Broadsheet (unchanged) ---------------- */
async function fetchClassScores(classId, term, session) {
  try { return await service.getScoresByClass(classId, currentSchoolId, term, session); }
  catch (err) { console.error('Class scores fetch error:', err); toast.error('Unable to load class scores. Please refresh the page.'); return []; }
}
async function getStudentAverageForTerm(studentId, term, session) {
  const scores = await fetchScores(studentId, term, session);
  if (!scores.length) return null;
  let total = 0, count = 0;
  for (const score of scores) { total += (score.ca || 0) + (score.exam || 0); count++; }
  if (count === 0) return null;
  return ((total / (count * 100)) * 100).toFixed(1);
}
async function generateBroadsheet() {
  if (!isSubscriptionActive) {
    const container = document.getElementById('broadsheetContainer');
    if (container) container.innerHTML = `<div style="text-align:center;padding:40px;background:#fef3c7;border-radius:8px;"><h3>⚠️ Subscription Required</h3><p>Broadsheets are unavailable because the school subscription is inactive.</p></div>`;
    const actions = document.getElementById('broadsheetActions');
    if (actions) actions.style.display = 'none';
    return;
  }
  const container = document.getElementById('broadsheetContainer');
  if (!container) { toast.error('Broadsheet container not found.'); return; }

  const classIdSel = document.getElementById('broadsheetClassSelect')?.value;
  const session    = document.getElementById('broadsheetSessionSelect')?.value;
  const term       = document.getElementById('broadsheetTermSelect')?.value;
  if (!classIdSel || !session || !term) { toast.error('Please select Class, Session and Term.'); return; }

  const classInfo = classesMap.get(classIdSel);
  const className = classInfo?.name || 'Class';
  const relevantSubjects = await getRelevantSubjectsForClass(classIdSel, term, session);
  if (!relevantSubjects.length) {
    container.innerHTML = '<div class="alert">No subjects found for the selected class level or no scores available.</div>';
    document.getElementById('broadsheetActions').style.display = 'none';
    return;
  }
  const classStudents = studentsList.filter(s => s.classId === classIdSel);
  if (!classStudents.length) { container.innerHTML = '<div class="alert">No students found in this class.</div>'; return; }

  showLoader();
  try {
    const allScores = await fetchClassScores(classIdSel, term, session);
    const scoresByStudent = new Map();
    for (const score of allScores) {
      if (!scoresByStudent.has(score.studentId)) scoresByStudent.set(score.studentId, []);
      scoresByStudent.get(score.studentId).push(score);
    }
    const term1Avg = new Map(), term2Avg = new Map(), term3Avg = new Map();
    for (const student of classStudents) {
      term1Avg.set(student.id, await getStudentAverageForTerm(student.id, '1', session));
      term2Avg.set(student.id, await getStudentAverageForTerm(student.id, '2', session));
      term3Avg.set(student.id, await getStudentAverageForTerm(student.id, '3', session));
    }
    const studentResults = [];
    for (const student of classStudents) {
      const scores = scoresByStudent.get(student.id) || [];
      const scoreMap = new Map();
      scores.forEach(s => scoreMap.set(s.subjectId, { ca: s.ca, exam: s.exam, total: s.ca + s.exam }));
      let totalScore = 0;
      const subjectDetails = [];
      for (const subj of relevantSubjects) {
        const score = scoreMap.get(subj.id) || { ca: 0, exam: 0, total: 0 };
        totalScore += score.total;
        subjectDetails.push({ subjectName: subj.name, ca: score.ca, exam: score.exam, total: score.total });
      }
      const totalObtainable = relevantSubjects.length * 100;
      const average = totalObtainable ? (totalScore / totalObtainable) * 100 : 0;
      const grade = calculateGrade(average);
      const remark = getGradeRemark(grade);
      const t1 = term1Avg.get(student.id), t2 = term2Avg.get(student.id), t3 = term3Avg.get(student.id);
      const vals = [t1, t2, t3].filter(v => v !== null).map(Number);
      const combinedAvg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
      studentResults.push({
        studentId: student.id, studentName: student.name,
        totalScore, average, grade, remark, subjectDetails,
        term1Avg: t1 !== null ? parseFloat(t1).toFixed(1) + '%' : '—',
        term2Avg: t2 !== null ? parseFloat(t2).toFixed(1) + '%' : '—',
        term3Avg: t3 !== null ? parseFloat(t3).toFixed(1) + '%' : '—',
        combinedAvg: combinedAvg !== null ? combinedAvg + '%' : '—'
      });
    }
    studentResults.sort((a, b) => b.totalScore - a.totalScore);
    let rank = 1;
    for (let i = 0; i < studentResults.length; i++) {
      if (i > 0 && studentResults[i].totalScore < studentResults[i - 1].totalScore) rank = i + 1;
      studentResults[i].position = rank;
    }
    let html = `<div style="margin-bottom:1rem;"><h3>BROADSHEET – ${escapeHtml(className)} – ${session} – ${term}</h3></div>`;
    html += `<div class="table-responsive-wrapper"><table class="broadsheet-table" border="1" cellpadding="5" cellspacing="0">`;
    html += `<thead><tr><th>S/N</th><th>Student Name</th>`;
    for (const subj of relevantSubjects) html += `<th colspan="3">${escapeHtml(subj.name)}</th>`;
    html += `<th>Total</th><th>1st Term</th><th>2nd Term</th><th>3rd Term</th><th>% Avg Total</th><th>Grade</th><th>Position</th><th>Remark</th></tr>`;
    html += `<tr><th></th><th></th>`;
    for (let i = 0; i < relevantSubjects.length; i++) html += `<th>CA</th><th>Exam</th><th>Total</th>`;
    html += `<th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th></tr></thead><tbody>`;
    for (let i = 0; i < studentResults.length; i++) {
      const r = studentResults[i];
      html += `<tr><td class="sn-cell">${i + 1}</td><td class="student-name-cell">${escapeHtml(r.studentName)}</td>`;
      for (const sub of r.subjectDetails) html += `<td>${sub.ca}</td><td>${sub.exam}</td><td>${sub.total}</td>`;
      html += `<td>${r.totalScore}</td><td>${r.term1Avg}</td><td>${r.term2Avg}</td><td>${r.term3Avg}</td><td>${r.combinedAvg}</td><td>${r.grade}</td>`;
      html += `<td>${r.position}${r.position === 1 ? 'st' : r.position === 2 ? 'nd' : r.position === 3 ? 'rd' : 'th'}</td><td>${r.remark}</td></tr>`;
    }
    html += `</tbody></table></div>`;
    container.innerHTML = html;
    const actions = document.getElementById('broadsheetActions');
    if (actions) actions.style.display = 'flex';
    window.currentBroadsheetData = { classId: classIdSel, session, term, studentResults, subjects: relevantSubjects };
  } catch (err) {
    console.error('Broadsheet generation error:', err);
    toast.error('Failed to generate broadsheet. Please try again.');
  } finally {
    hideLoader();
  }
}
async function saveBroadsheetToFirestore() {
  const active = await checkSubscription();
  if (!active) { toast.error('Cannot save broadsheet – subscription inactive.'); return; }
  if (!window.currentBroadsheetData) { toast.error('No broadsheet data to save. Generate first.'); return; }
  const { classId: classIdSel, session, term, studentResults, subjects } = window.currentBroadsheetData;
  const docId = `${currentSchoolId}_${classIdSel}_${session.replace(/\//g, '_')}_${term}`;
  const broadsheetData = {
    schoolId: currentSchoolId, classId: classIdSel, session, term,
    students: studentResults.map(s => ({
      studentId: s.studentId, studentName: s.studentName, totalScore: s.totalScore,
      average: s.average, grade: s.grade, remark: s.remark, position: s.position,
      term1Avg: s.term1Avg, term2Avg: s.term2Avg, term3Avg: s.term3Avg,
      combinedAvg: s.combinedAvg, subjectDetails: s.subjectDetails
    })),
    subjects: subjects.map(s => ({ id: s.id, name: s.name })),
    createdAt: new Date(), updatedAt: new Date()
  };
  showLoader();
  try {
    await service.saveBroadsheet(docId, broadsheetData);
    toast.success('Broadsheet saved successfully.');
  } catch (err) {
    console.error('Broadsheet save error:', err);
    if (err.code === 'permission-denied' || err.message?.includes('permission')) toast.error('Permission denied. Subscription required to save broadsheets.');
    else toast.error('Failed to save broadsheet. Please try again.');
  } finally { hideLoader(); }
}
function printBroadsheet() {
  const container = document.getElementById('broadsheetContainer');
  if (!container || !container.innerHTML.trim()) { toast.error('No broadsheet to print.'); return; }
  const originalContent = container.cloneNode(true);
  const title = document.querySelector('#broadsheetContainer h3')?.innerText || 'Class Broadsheet';
  const printWindow = window.open('', '_blank');
  if (!printWindow) { toast.error('Please allow pop-ups to print.'); return; }
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
  printWindow.document.write(`<!DOCTYPE html><html><head><title>${title}</title><link rel="stylesheet" href="${externalCssUrl}"><style>${inlineStyles}${printCSS}</style></head><body>${originalContent.outerHTML}</body></html>`);
  printWindow.document.close();
  printWindow.print();
}

/* ---------------- UI / init ---------------- */
async function loadClassStudents() {
  if (!currentClassId) return;
  reportState.term    = document.getElementById('termSelect').value;
  reportState.session = document.getElementById('sessionSelect').value;
  await loadGradingSetting(reportState.session, reportState.term);

  const classStudents = studentsList.filter(s => s.classId === currentClassId);
  const container = document.getElementById('studentListContainer');
  if (!container) return;

  const titleHtml = `<div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:12px;border-radius:8px 8px 0 0;font-weight:bold;font-size:1.1rem;margin-bottom:5px;text-align:center;">📋 Students in ${escapeHtml(classNameCache)}</div>`;

  if (!classStudents.length) {
    container.innerHTML = titleHtml + '<p style="padding:20px;background:#f8f9fa;border-radius:0 0 8px 8px;">No students</p>';
    document.getElementById('reportCardContent').innerHTML = '<p style="text-align:center; padding:2rem;">No students in this class</p>';
    document.getElementById('reportActions').style.display = 'none';
    return;
  }
  let html = titleHtml + '<div style="background:#fff;border-radius:0 0 8px 8px;overflow:hidden;">';
  classStudents.forEach(s => {
    html += `<div class="student-list-item" data-id="${s.id}" style="padding:12px 15px;border-bottom:1px solid #e0e0e0;background-color:#f8f9fa;cursor:pointer;transition:all 0.2s;font-weight:500;">${escapeHtml(s.name)}</div>`;
  });
  html += '</div>';
  container.innerHTML = html;

  document.querySelectorAll('.student-list-item').forEach(el => {
    el.addEventListener('click', async () => {
      document.querySelectorAll('.student-list-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      await loadReportCard(el.dataset.id, el.textContent.trim());
    });
  });

  const firstStudent = classStudents[0];
  if (firstStudent) {
    const firstEl = document.querySelector('.student-list-item');
    if (firstEl) firstEl.classList.add('active');
    await loadReportCard(firstStudent.id, firstStudent.name);
  }
}
async function onClassChange() {
  const newClassId = document.getElementById('reportClassSelect')?.value || hostClassIds[0];
  if (!newClassId) return;
  currentClassId = newClassId;
  await fetchClassName();
  await loadClassStudents();
}
async function populateClassSelectors() {
  const broadsheetSelect = document.getElementById('broadsheetClassSelect');
  if (broadsheetSelect) {
    broadsheetSelect.innerHTML = '<option value="">-- Select Class --</option>';
    for (const cid of hostClassIds) {
      const classInfo = classesMap.get(cid);
      if (classInfo) {
        const option = document.createElement('option');
        option.value = cid; option.textContent = classInfo.name;
        broadsheetSelect.appendChild(option);
      }
    }
    if (hostClassIds.length === 1) broadsheetSelect.value = hostClassIds[0];
  }
  const reportClassWrapper = document.getElementById('classSelectorWrapper');
  const reportClassSelect = document.getElementById('reportClassSelect');
  if (reportClassWrapper && reportClassSelect) {
    if (hostClassIds.length > 1) {
      reportClassWrapper.style.display = 'flex';
      reportClassSelect.innerHTML = '';
      for (const cid of hostClassIds) {
        const classInfo = classesMap.get(cid);
        if (classInfo) {
          const option = document.createElement('option');
          option.value = cid; option.textContent = classInfo.name;
          reportClassSelect.appendChild(option);
        }
      }
      reportClassSelect.value = hostClassIds[0];
      reportClassSelect.addEventListener('change', onClassChange);
    } else reportClassWrapper.style.display = 'none';
  }
  currentClassId = hostClassIds[0];
  await fetchClassName();
  await loadClassStudents();
}

export async function initClassReportPage() {
  teacherData = getTeacherData();
  if (!teacherData) return;
  currentSchoolId = teacherData.schoolId || localStorage.getItem('userSchoolId');
  if (!currentSchoolId) { toast.error('School ID missing. Please log in again.'); return; }

  await initAcademicCalendar();
  await checkSubscription();

  const success = await loadTeacherHostClasses();
  if (!success) return;

  await loadSubjectsAndClasses();
  await loadStudentsList();
  await populateClassSelectors();

  const currentSession  = getCurrentSession();
  const currentTermNum  = getCurrentTerm();
  const termMap         = { 'First Term': '1', 'Second Term': '2', 'Third Term': '3' };
  const defaultTermNum  = termMap[currentTermNum] || '1';

  const sessionSelect = document.getElementById('sessionSelect');
  if (sessionSelect) {
    sessionSelect.innerHTML = `<option value="${currentSession}">${currentSession}</option>`;
    sessionSelect.value = currentSession;
    sessionSelect.disabled = true;
  }
  const broadsheetSessionSelect = document.getElementById('broadsheetSessionSelect');
  if (broadsheetSessionSelect) {
    broadsheetSessionSelect.innerHTML = `<option value="${currentSession}">${currentSession}</option>`;
    broadsheetSessionSelect.value = currentSession;
    broadsheetSessionSelect.disabled = true;
  }
  const broadsheetTermSelect = document.getElementById('broadsheetTermSelect');
  if (broadsheetTermSelect) broadsheetTermSelect.value = defaultTermNum;
  const termSelect = document.getElementById('termSelect');
  if (termSelect) termSelect.value = defaultTermNum;

  document.getElementById('termSelect')?.addEventListener('change', () => loadClassStudents());
  document.getElementById('refreshStudentsBtn')?.addEventListener('click', () => loadClassStudents());
  document.getElementById('saveReportBtn')?.addEventListener('click', saveReportCard);
  document.getElementById('printReportBtn')?.addEventListener('click', handlePrint);
  document.getElementById('whatsappReportBtn')?.addEventListener('click', sendToWhatsApp);
  document.getElementById('generateBroadsheetBtn')?.addEventListener('click', generateBroadsheet);
  document.getElementById('saveBroadsheetBtn')?.addEventListener('click', saveBroadsheetToFirestore);
  document.getElementById('printBroadsheetBtn')?.addEventListener('click', printBroadsheet);

  if (hostClassIds.length === 1) await loadClassStudents();
}
