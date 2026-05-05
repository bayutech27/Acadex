// class.js - Teacher report card page + broadsheet (full functionality)
// DIRECT subscription check from Firestore – no listener, no bypass chance
// Dynamic session dropdown – shows only sessions with existing scores for the school
// Side‑by‑side report card renderer (subjects left, skills right)
// Summary and Attendance moved to top
// Subjects table extreme left, skills tables extreme right – clear gap between them
// Fully responsive: scales with zoom, stacks on mobile

import { db } from './firebase-config.js';
import {
  collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getTeacherData } from './teacher-dashboard.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';
import { initAcademicCalendar, getCurrentTerm, getCurrentSession } from './academic-calendar.js';

let currentSchoolId = null;
let teacherData = null;
let classId = null;
let classNameCache = '';
let currentGrading = { ca: 40, exam: 60 };
let classesMap = new Map();
let subjectsMap = new Map();
let allSubjectsList = [];
let studentsList = [];
let isSubscriptionActive = false;

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

// ------------------- Subscription check directly from Firestore -------------------
async function checkSubscription() {
  try {
    const subDoc = await getDoc(doc(db, 'schools', currentSchoolId, 'subscription', 'current'));
    if (!subDoc.exists()) {
      isSubscriptionActive = false;
      disableSubscriptionFeatures();
      return false;
    }
    const subData = subDoc.data();
    isSubscriptionActive = (subData.status === 'active' && subData.locked !== true);
    if (isSubscriptionActive) {
      enableSubscriptionFeatures();
    } else {
      disableSubscriptionFeatures();
    }
    return isSubscriptionActive;
  } catch (err) {
    handleError(err, "Failed to verify subscription.");
    isSubscriptionActive = false;
    disableSubscriptionFeatures();
    return false;
  }
}

function disableSubscriptionFeatures() {
  const saveBtn = document.getElementById('saveReportBtn');
  const printBtn = document.getElementById('printReportBtn');
  const generateBtn = document.getElementById('generateBroadsheetBtn');
  const saveBroadsheetBtn = document.getElementById('saveBroadsheetBtn');
  const printBroadsheetBtn = document.getElementById('printBroadsheetBtn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.style.opacity = '0.5'; }
  if (printBtn) { printBtn.disabled = true; printBtn.style.opacity = '0.5'; }
  if (generateBtn) generateBtn.disabled = true;
  if (saveBroadsheetBtn) saveBroadsheetBtn.disabled = true;
  if (printBroadsheetBtn) printBroadsheetBtn.disabled = true;
  const warningDiv = document.querySelector('.subscription-warning');
  if (!warningDiv) {
    const div = document.createElement('div');
    div.className = 'subscription-warning';
    div.style.cssText = 'background:#fee2e2;color:#991b1b;padding:12px;margin-bottom:16px;border-radius:8px;';
    div.innerHTML = '⚠️ Subscription inactive. Report card and broadsheet features are disabled. Please contact your administrator to renew.';
    const container = document.querySelector('.class-report-container');
    if (container) container.prepend(div);
  }
}

function enableSubscriptionFeatures() {
  const saveBtn = document.getElementById('saveReportBtn');
  const printBtn = document.getElementById('printReportBtn');
  const generateBtn = document.getElementById('generateBroadsheetBtn');
  const saveBroadsheetBtn = document.getElementById('saveBroadsheetBtn');
  const printBroadsheetBtn = document.getElementById('printBroadsheetBtn');
  if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = '1'; }
  if (printBtn) { printBtn.disabled = false; printBtn.style.opacity = '1'; }
  if (generateBtn) generateBtn.disabled = false;
  if (saveBroadsheetBtn) saveBroadsheetBtn.disabled = false;
  if (printBroadsheetBtn) printBroadsheetBtn.disabled = false;
  const warning = document.querySelector('.subscription-warning');
  if (warning) warning.remove();
}

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

function calculateAge(dobString) {
  if (!dobString) return null;
  const birthDate = new Date(dobString);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
  return age;
}

// ==================== DYNAMIC SESSION OPTIONS ====================
async function loadSessionOptions(schoolId) {
  try {
    const scoresQuery = query(collection(db, 'scores'), where('schoolId', '==', schoolId));
    const snapshot = await getDocs(scoresQuery);
    const sessionsSet = new Set();
    snapshot.forEach(doc => { const session = doc.data().session; if (session) sessionsSet.add(session); });
    const sortedSessions = Array.from(sessionsSet).sort((a, b) => {
      const [yearA] = a.split('/');
      const [yearB] = b.split('/');
      return parseInt(yearB) - parseInt(yearA);
    });
    return sortedSessions;
  } catch (err) {
    console.error('Failed to load session options:', err);
    const year = new Date().getFullYear();
    const fallback = [];
    for (let i = 0; i < 10; i++) fallback.push(`${year - i}/${year - i + 1}`);
    return fallback;
  }
}

// ------------------- Grading loading -------------------
async function loadGradingSettingByLevel(level, session, term) {
  if (!level) { currentGrading = { ca: 40, exam: 60 }; return; }
  try {
    const q = query(collection(db, 'scoring'), where('schoolId', '==', currentSchoolId), where('level', '==', level));
    const snap = await getDocs(q);
    let grading = null;
    if (!snap.empty) {
      const data = snap.docs[0].data();
      grading = data.grading || `${data.caWeight}/${data.examWeight}`;
    }
    if (!grading) {
      const fallbackQ = query(collection(db, 'scoring'), where('schoolId', '==', currentSchoolId));
      const fallbackSnap = await getDocs(fallbackQ);
      if (!fallbackSnap.empty) {
        const data = fallbackSnap.docs[0].data();
        grading = data.grading || `${data.caWeight}/${data.examWeight}`;
      }
    }
    if (!grading) {
      const docId = `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}`;
      const docSnap = await getDoc(doc(db, 'scoring', docId));
      if (docSnap.exists()) grading = docSnap.data().grading;
    }
    if (grading) {
      const [ca, exam] = grading.split('/').map(Number);
      currentGrading = { ca, exam };
    } else {
      currentGrading = { ca: 40, exam: 60 };
    }
  } catch (err) {
    handleError(err, "Failed to load grading by level. Using defaults.");
    currentGrading = { ca: 40, exam: 60 };
  }
}

async function loadGradingSetting(session, term, classLevel = null) {
  if (classLevel) {
    await loadGradingSettingByLevel(classLevel, session, term);
  } else {
    try {
      const docId = `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}`;
      const docSnap = await getDoc(doc(db, 'scoring', docId));
      let grading = '40/60';
      if (docSnap.exists()) grading = docSnap.data().grading;
      const [ca, exam] = grading.split('/').map(Number);
      currentGrading = { ca, exam };
    } catch (err) {
      currentGrading = { ca: 40, exam: 60 };
    }
  }
}

// ------------------- Data Loading -------------------
async function fetchClassName() {
  try {
    const classRef = doc(db, 'classes', classId);
    const classSnap = await getDoc(classRef);
    classNameCache = classSnap.exists() ? classSnap.data().name : classId;
    if (classSnap.exists()) {
      classesMap.set(classId, { name: classSnap.data().name, level: classSnap.data().level });
    }
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
      const data = doc.data();
      subjectsMap.set(doc.id, data.name);
      allSubjectsList.push({ id: doc.id, name: data.name, level: data.level || null });
    });
    const classSnap = await getDocs(query(collection(db, 'classes'), where('schoolId', '==', currentSchoolId)));
    classesMap.clear();
    classSnap.forEach(doc => { classesMap.set(doc.id, { name: doc.data().name, level: doc.data().level }); });
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
      dob: doc.data().dob, club: doc.data().club, passport: doc.data().passport || null,
      subjects: doc.data().subjects || []
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

// ==================== LOCAL REPORT CARD RENDERER ====================
// Visual updates: bigger school name, email+phone under address, bigger passport,
// navy details band with clean cell dividers, cream paper background on wrapper.
// Layout, functions and behaviours are unchanged.
function renderReportCardUI({
  student, scores, className, school, grading, psychomotor, comments,
  term, session, subjectStats, container, attendance = {},
  isPrimary = false,
  onRatingChange, onTeacherCommentChange, onPrincipalCommentChange
}) {
  if (!container) return;

  const calcGrade = (total) => isPrimary
    ? (total>=90?'A+':total>=80?'A':total>=70?'B+':total>=60?'B':total>=50?'C':total>=40?'D':'F')
    : (total>=85?'A1':total>=75?'B2':total>=70?'B3':total>=65?'C4':total>=60?'C5':total>=50?'C6':total>=45?'D7':total>=40?'E8':'F9');
  const gradeRemark = (g) => isPrimary
    ? ({'A+':'Exceptional','A':'Excellent','B+':'Very Good','B':'Good','C':'Fairly Good','D':'Pass','F':'Fail'}[g]||'')
    : ({A1:'Excellent',B2:'Very Good',B3:'Good',C4:'Credit',C5:'Credit',C6:'Credit',D7:'Pass',E8:'Pass',F9:'Fail'}[g]||'');

  // Subject table rows
  let totalScore = 0, subjectCount = 0, rows = '';
  if (scores && scores.length) {
    for (const s of scores) {
      const subj = s.subjectName || s.subjectId;
      const t = (s.ca||0)+(s.exam||0);
      totalScore += t; subjectCount++;
      const g = calcGrade(t);
      const r = gradeRemark(g);
      let pos = '—', avg = '—';
      const stat = subjectStats?.get(s.subjectId);
      if (stat && !isPrimary) {
        const rank = stat.rankMap?.get(student.id);
        if (rank) pos = `${rank}<sup>${rank===1?'st':rank===2?'nd':rank===3?'rd':'th'}</sup>`;
        avg = stat.classAverage ?? '—';
      }
      rows += isPrimary
        ? `<tr><td class="rc-subj-name">${escapeHtml(subj)}</td><td>${s.ca}</td><td>${s.exam}</td><td>${t}</td><td>${g}</td><td>${r}</td></tr>`
        : `<tr><td class="rc-subj-name">${escapeHtml(subj)}</td><td>${s.ca}</td><td>${s.exam}</td><td>${t}</td><td>${g}</td><td>${r}</td><td>${pos}</td><td>${avg}</td></tr>`;
    }
  } else rows = `<tr><td colspan="${isPrimary?6:8}">No scores found</td></tr>`;

  const avgPercent = subjectCount ? ((totalScore/(subjectCount*100))*100).toFixed(1) : 0;
  const overallGrade = calcGrade(parseFloat(avgPercent));
  const remark = gradeRemark(overallGrade);

  const subjectHeader = isPrimary
    ? `<thead><tr><th>Subject</th><th>CA (${grading.ca})</th><th>Exam (${grading.exam})</th><th>Total</th><th>Grade</th><th>Remark</th></tr></thead>`
    : `<thead><tr><th>Subject</th><th>CA (${grading.ca})</th><th>Exam (${grading.exam})</th><th>Total</th><th>Grade</th><th>Remark</th><th>Pos.</th><th>Cls Avg</th></tr></thead>`;
  const subjectTable = `<table class="rc-subject-table">${subjectHeader}<tbody>${rows}</tbody></table>`;

  // Grade scale
  const gradeScaleHtml = (() => {
    const scale = isPrimary
      ? [['A+','90-100','Exceptional'],['A','80-89','Excellent'],['B+','70-79','Very Good'],['B','60-69','Good'],['C','50-59','Fairly Good'],['D','40-49','Pass'],['F','0-39','Fail']]
      : [['A1','85-100','Excellent'],['B2','75-84','Very Good'],['B3','70-74','Good'],['C4','65-69','Credit'],['C5','60-64','Credit'],['C6','50-59','Credit'],['D7','45-49','Pass'],['E8','40-44','Pass'],['F9','0-39','Fail']];
    return `<table class="rc-grade-scale"><thead><tr><th>Grade</th><th>Range</th><th>Remark</th></tr></thead><tbody>${scale.map(s=>`<tr><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td></tr>`).join('')}</tbody></table>`;
  })();

  // Summary
  const summaryHtml = `
    <div class="rc-section-title">📊 SUMMARY OF PERFORMANCE</div>
    <table class="rc-summary-table">
      <tr><th>Total Obtained</th><td>${totalScore}</td></tr>
      <tr><th>Total Obtainable</th><td>${subjectCount*100}</td></tr>
      <tr><th>Total Subjects</th><td>${subjectCount}</td></tr>
      <tr><th>% Average</th><td>${avgPercent}%</td></tr>
      <tr><th>Grade</th><td>${overallGrade}</td></tr>
      <tr><th>Remark</th><td>${remark}</td></tr>
    </table>`;

  // Attendance
  const attendanceHtml = `
    <div class="rc-section-title">📅 Attendance Record</div>
    <table class="rc-attendance-table">
      <tr><td class="rc-att-label">Times School Opened</td><td><input class="rc-att-input school-opened" type="number" value="${attendance.schoolOpened||0}" min="0"><span class="rc-print-val school-opened-value">${attendance.schoolOpened||0}</span></td></tr>
      <tr><td class="rc-att-label">Times Present</td><td><input class="rc-att-input present" type="number" value="${attendance.present||0}" min="0"><span class="rc-print-val present-value">${attendance.present||0}</span></td></tr>
      <tr><td class="rc-att-label">Times Absent</td><td><input class="rc-att-input absent" type="number" value="${attendance.absent||0}" min="0"><span class="rc-print-val absent-value">${attendance.absent||0}</span></td></tr>
    </table>`;

  // Skills tables
  let psychoRows = '';
  for (const skill of psychomotorSkillsList) {
    const k = skill.toLowerCase().replace(/[^a-z]/g, '');
    const v = psychomotor?.[k] ?? 3;
    psychoRows += `<tr><td class="rc-skill-name">${escapeHtml(skill)}</td><td class="rc-rating-cell" data-skill-key="${k}"><span class="rc-print-val">${v}</span></td></tr>`;
  }
  let affectRows = '';
  for (const skill of affectiveSkillsList) {
    const k = skill.toLowerCase().replace(/[^a-z]/g, '');
    const v = psychomotor?.[k] ?? 3;
    affectRows += `<tr><td class="rc-skill-name">${escapeHtml(skill)}</td><td class="rc-rating-cell" data-skill-key="${k}"><span class="rc-print-val">${v}</span></td></tr>`;
  }
  const skillsStack = `
    <table class="rc-skills-table">
      <thead><tr><th>Psychomotor Skills</th><th>Rating</th></tr></thead>
      <tbody>${psychoRows}</tbody>
    </table>
    <table class="rc-skills-table rc-skills-table--lower">
      <thead><tr><th>Affective Domain</th><th>Rating</th></tr></thead>
      <tbody>${affectRows}</tbody>
    </table>
    <div class="rc-rating-guide">1: Poor &nbsp; 2: Fair &nbsp; 3: Good &nbsp; 4: Very Good &nbsp; 5: Excellent</div>`;

  // ── Header — school name enlarged; email + phone (from Firestore) shown under address ──
  const headerHtml = `
    <div class="rc-header">
      <div class="rc-header-logo">${school.logo ? `<img src="${school.logo}" alt="School Logo">` : ''}</div>
      <div class="rc-header-text">
        <h1 class="rc-school-name">${escapeHtml(school.name)}</h1>
        ${school.address ? `<div class="rc-school-address">${escapeHtml(school.address)}</div>` : ''}
        ${school.phone   ? `<div class="rc-school-contact">📞 ${escapeHtml(school.phone)}</div>`   : ''}
        ${school.email   ? `<div class="rc-school-contact">✉️ ${escapeHtml(school.email)}</div>`   : ''}
      </div>
      <div class="rc-header-passport">${student.passport ? `<img src="${student.passport}" alt="Passport">` : ''}</div>
    </div>`;

  // ── Student details band — navy background with clean cell dividers ──
  const studentAge = student.dob ? calculateAge(student.dob) : '—';
  const detailsBand = `
    <div class="rc-details-band">
      <div class="rc-details-cell"><strong>Name:</strong> <span class="rc-student-name">${escapeHtml(student.name).toUpperCase()}</span></div>
      <div class="rc-details-cell"><strong>Admission No:</strong> ${escapeHtml(student.admissionNumber||'—')}</div>
      <div class="rc-details-cell"><strong>Gender:</strong> ${escapeHtml(student.gender||'—')}</div>
      <div class="rc-details-cell"><strong>DOB:</strong> ${student.dob||'—'} (Age ${studentAge})</div>
      <div class="rc-details-cell"><strong>Class:</strong> ${escapeHtml(className)}</div>
      <div class="rc-details-cell"><strong>Term:</strong> ${term}${getTermSuffix(term)}</div>
      <div class="rc-details-cell"><strong>Session:</strong> ${session}</div>
      <div class="rc-details-cell"><strong>Club:</strong> ${escapeHtml(student.club||'—')}</div>
    </div>`;

  // Comments
  const commentBank = [
    'Keep up the great work!', 'Your effort is commendable.', 'Consistent practice will yield even better results.',
    'You have shown improvement this term.', 'Stay focused and keep pushing forward.', 'Your positive attitude is appreciated.'
  ];
  const teacherEff   = comments.teacherComment   || commentBank[0];
  const principalEff = comments.principalComment || commentBank[0];
  const principalLabel = isPrimary ? "Head Teacher's Comment:" : "Principal's Comment:";
  const commentsHtml = `
    <div class="rc-comments">
      <strong>Comments</strong>
      <div class="rc-comment-row">
        <label>Class Teacher's Comment:</label>
        <select class="teacher-comment-select">${commentBank.map(o=>`<option ${teacherEff===o?'selected':''}>${o}</option>`).join('')}</select>
        <textarea class="teacher-comment-text" rows="1">${escapeHtml(teacherEff)}</textarea>
        <span class="rc-print-comment">${escapeHtml(teacherEff)}</span>
      </div>
      <div class="rc-comment-row">
        <label>${principalLabel}</label>
        <select class="principal-comment-select">${commentBank.map(o=>`<option ${principalEff===o?'selected':''}>${o}</option>`).join('')}</select>
        <textarea class="principal-comment-text" rows="1">${escapeHtml(principalEff)}</textarea>
        <span class="rc-print-comment">${escapeHtml(principalEff)}</span>
      </div>
    </div>`;

  // ── STYLES ──────────────────────────────────────────────────────────────────
  const styles = `
    <style>
      /* ── Wrapper — cream paper background ── */
      .rc-wrapper {
        width: 100%;
        max-width: 210mm;
        margin: 0 auto;
        background: #fdf8f2 !important;
        border: 2px solid #000;
        padding: clamp(8px, 2%, 20px);
        box-sizing: border-box;
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        font-size: clamp(9px, 1.2vw, 13px);
      }

      /* ── Header ── */
      .rc-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 10px;
      }
      .rc-header-logo img {
        max-width: clamp(60px, 8vw, 100px);
        max-height: clamp(60px, 8vw, 100px);
        object-fit: contain;
        border-radius: 4px;
      }
      /* ── Passport — slightly bigger + framed ── */
      .rc-header-passport img {
        width:  clamp(80px, 11vw, 125px);
        height: clamp(80px, 11vw, 125px);
        object-fit: cover;
        border-radius: 6px;
        border: 2px solid #1a3a5c;
      }
      .rc-header-text { flex: 1; text-align: center; }

      /* ── School name — notably larger ── */
      .rc-school-name {
        margin: 0 0 4px 0;
        font-size: clamp(22px, 4vw, 42px) !important;
        font-weight: 800;
        letter-spacing: 0.02em;
        line-height: 1.15;
        text-transform: uppercase;
      }
      .rc-school-address { font-size: 0.88em; margin-top: 2px; }
      .rc-school-contact { font-size: 0.82em; color: #333; margin-top: 1px; }

      /* ── Details band — deep navy, white text, clean cell dividers ── */
      .rc-details-band {
        background: #1a3a5c !important;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(clamp(140px, 22%, 220px), 1fr));
        gap: 0;
        font-weight: bold;
        font-size: 0.92em;
        border-radius: 6px;
        margin-bottom: 12px;
        overflow: hidden;
        border: 1px solid #0f2740;
      }
      .rc-details-cell {
        padding: clamp(5px, 1.2%, 10px) clamp(6px, 1.5%, 12px);
        border-right: 1px solid rgba(255, 255, 255, 0.18) !important;
        border-bottom: 1px solid rgba(255, 255, 255, 0.18) !important;
        color: #fff !important;
      }
      .rc-details-cell strong { color: #a8d8f0 !important; margin-right: 3px; }
      .rc-student-name { font-size: 1.05em; font-weight: 700; color: #fff !important; }

      /* ── Summary + Attendance row (top) ── */
      .rc-top-row {
        display: flex;
        flex-wrap: wrap;
        gap: clamp(8px, 2%, 20px);
        margin-bottom: clamp(10px, 2%, 18px);
      }
      .rc-top-row > div { flex: 1 1 clamp(160px, 40%, 300px); }

      /* ── Section title ── */
      .rc-section-title { font-weight: bold; margin-bottom: 4px; font-size: 0.95em; }

      /* ── Shared table base ── */
      .rc-subject-table,
      .rc-summary-table,
      .rc-attendance-table,
      .rc-skills-table,
      .rc-grade-scale {
        width: 100%;
        border-collapse: collapse;
        border: 2px solid #000;
        background: #fff !important;
      }
      .rc-subject-table th, .rc-subject-table td,
      .rc-summary-table th, .rc-summary-table td,
      .rc-attendance-table th, .rc-attendance-table td,
      .rc-skills-table th, .rc-skills-table td,
      .rc-grade-scale th, .rc-grade-scale td {
        border: 1px solid #000;
        padding: clamp(2px, 0.6%, 6px);
        text-align: center;
        vertical-align: middle;
      }
      .rc-subject-table th,
      .rc-summary-table th,
      .rc-attendance-table th,
      .rc-skills-table th { background: #ADD8E6 !important; }
      .rc-grade-scale th  { background: #FFD700 !important; }

      .rc-subj-name,
      .rc-att-label { text-align: left !important; white-space: normal; word-break: break-word; }

      .rc-skill-name {
        text-align: left !important;
        writing-mode: horizontal-tb !important;
        text-orientation: mixed !important;
        white-space: normal !important;
        word-break: break-word;
      }

      /* ── Main two-column grid ── */
      .rc-main-row {
        display: grid;
        grid-template-columns: 62fr 35fr;
        gap: clamp(12px, 3%, 28px);
        align-items: start;
        width: 100%;
        box-sizing: border-box;
      }
      .rc-col-left,
      .rc-col-right {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: clamp(6px, 1.5%, 14px);
      }

      .rc-rating-guide { font-size: 0.78em; color: #444; margin-top: 2px; }

      /* Rating ticks */
      .rc-tick-row { display: flex; gap: 3px; justify-content: center; flex-wrap: wrap; }
      .rc-tick {
        width: clamp(14px, 2vw, 20px);
        height: clamp(14px, 2vw, 20px);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid #999;
        border-radius: 50%;
        cursor: pointer;
        font-size: 0.75em;
        user-select: none;
      }
      .rc-tick.selected { background: #3b82f6; color: #fff; border-color: #3b82f6; }

      /* Attendance input */
      .rc-att-input { width: 100%; max-width: 80px; padding: 2px 4px; box-sizing: border-box; font-size: inherit; }

      /* Comments */
      .rc-comments {
        border: 1px solid #ddd;
        padding: clamp(4px, 1%, 10px);
        margin-top: 10px;
        font-size: 0.9em;
        background: #f9f9f9 !important;
      }
      .rc-comment-row { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; }
      .rc-comment-row select,
      .rc-comment-row textarea { width: 100%; box-sizing: border-box; font-size: inherit; }
      .rc-comment-row textarea { display: none; }

      .rc-print-val,
      .rc-print-comment { display: none; }

      /* ── Mobile ── */
      @media (max-width: 600px) {
        .rc-wrapper   { padding: 8px; font-size: 11px; }
        .rc-school-name { font-size: clamp(18px, 6vw, 26px) !important; }
        .rc-main-row  { grid-template-columns: 1fr; gap: 16px; }
        .rc-top-row   { flex-direction: column; }
        .rc-details-band { grid-template-columns: 1fr 1fr; }
        .rc-header-logo img { max-width: 55px; max-height: 55px; }
        .rc-header-passport img { width: 65px; height: 65px; }
      }

      /* ── Print ── */
      @media print {
        .rc-wrapper { max-width: 100%; border: none; padding: 0; font-size: 8.5pt; background: #fdf8f2 !important; }
        .rc-school-name { font-size: 22pt !important; }
        .rc-main-row { grid-template-columns: 62fr 35fr; gap: 14px; }
        .rc-att-input, .rc-tick-row, select, textarea, button { display: none !important; }
        .rc-print-val    { display: block !important; }
        .rc-print-comment { display: block !important; }
        .rc-rating-cell .rc-print-val { display: inline !important; }
        .rc-details-band { background: #1a3a5c !important; }
        .rc-details-cell { color: #fff !important; border-right: 1px solid rgba(255,255,255,0.18) !important; border-bottom: 1px solid rgba(255,255,255,0.18) !important; }
        .rc-details-cell strong { color: #a8d8f0 !important; }
        .rc-scroll-outer { overflow: visible !important; }
        *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        @page { size: A4; margin: 8mm; }
      }
    </style>`;

  // ── Final HTML assembly ──────────────────────────────────────────────────────
  const cardHtml = `
    ${styles}
    <div class="rc-wrapper">
      ${headerHtml}
      ${detailsBand}
      <div class="rc-top-row">
        <div>${summaryHtml}</div>
        <div>${attendanceHtml}</div>
      </div>
      <div class="rc-main-row">
        <div class="rc-col-left">
          ${subjectTable}
          ${gradeScaleHtml}
        </div>
        <div class="rc-col-right">
          ${skillsStack}
        </div>
      </div>
      ${commentsHtml}
    </div>`;

  container.innerHTML = `<div class="rc-scroll-outer" style="overflow-x:auto;">${cardHtml}</div>`;

  // ── Attach interactive rating ticks ─────────────────────────────────────────
  container.querySelectorAll('.rc-rating-cell').forEach(el => {
    const key = el.dataset.skillKey;
    if (!key) return;
    const val = psychomotor?.[key] ?? 3;
    const tickRow = document.createElement('div');
    tickRow.className = 'rc-tick-row';
    for (let i = 1; i <= 5; i++) {
      const tick = document.createElement('span');
      tick.className = 'rc-tick' + (i === val ? ' selected' : '');
      tick.textContent = i;
      tick.addEventListener('click', (e) => {
        e.stopPropagation();
        tickRow.querySelectorAll('.rc-tick').forEach(t => t.classList.remove('selected'));
        tick.classList.add('selected');
        if (onRatingChange) onRatingChange(key, i);
        const printSpan = el.querySelector('.rc-print-val');
        if (printSpan) printSpan.textContent = i;
      });
      tickRow.appendChild(tick);
    }
    el.appendChild(tickRow);
  });

  // ── Attendance live sync ─────────────────────────────────────────────────────
  container.querySelectorAll('.rc-att-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const spanClass = '.' + inp.classList[1] + '-value';
      const span = container.querySelector(spanClass);
      if (span) span.textContent = inp.value;
    });
  });

  // ── Comment selects / textareas ──────────────────────────────────────────────
  const tSelect  = container.querySelector('.teacher-comment-select');
  const tText    = container.querySelector('.teacher-comment-text');
  const pSelect  = container.querySelector('.principal-comment-select');
  const pText    = container.querySelector('.principal-comment-text');
  const printComments = container.querySelectorAll('.rc-print-comment');
  const tPrint   = printComments[0];
  const pPrint   = printComments[1];

  if (tSelect) tSelect.onchange = () => { tText.value = tSelect.value; if (tPrint) tPrint.textContent = tSelect.value; onTeacherCommentChange?.(tSelect.value); };
  if (tText)   tText.oninput   = () => { if (tPrint) tPrint.textContent = tText.value; onTeacherCommentChange?.(tText.value); };
  if (pSelect) pSelect.onchange = () => { pText.value = pSelect.value; if (pPrint) pPrint.textContent = pSelect.value; onPrincipalCommentChange?.(pSelect.value); };
  if (pText)   pText.oninput   = () => { if (pPrint) pPrint.textContent = pText.value; onPrincipalCommentChange?.(pText.value); };
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
      reportState.teacherComment   = data.teacherComment   || '';
      reportState.principalComment = data.principalComment || '';
      reportState.attendance       = data.attendance       || { schoolOpened: 0, present: 0, absent: 0 };
      reportState.savedReportId    = snap.docs[0].id;
    } else {
      reportState.attendance    = { schoolOpened: 0, present: 0, absent: 0 };
      reportState.savedReportId = null;
    }
  } catch (err) {
    handleError(err, "Failed to load existing report.");
  }
}

async function saveReportCard() {
  const active = await checkSubscription();
  if (!active) { showNotification("Cannot save report – subscription inactive.", "error"); return; }
  if (!reportState.selectedStudent) { showNotification("Select a student first.", "error"); return; }

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

  const reportData = {
    studentId: reportState.selectedStudent.id, classId, schoolId: currentSchoolId,
    term: reportState.term, session: reportState.session,
    totalScore, maxTotal: totalObtainable, average, overallGrade,
    psychomotor: reportState.psychomotor,
    teacherComment: reportState.teacherComment, principalComment: reportState.principalComment,
    attendance, updatedAt: new Date()
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

// ========== PRINT HANDLER ==========
function printReportCard() {
  const reportContent = document.getElementById('reportCardContent');
  if (!reportContent || reportContent.children.length === 0) {
    showNotification("Report not ready.", "error");
    return;
  }
  const clonedReport = reportContent.cloneNode(true);
  const printWindow = window.open('', '_blank');
  if (!printWindow) { showNotification("Please allow popups to print.", "error"); return; }

  const externalCssUrl = new URL('../css/styles.css', window.location.href).href;
  const inlineStyles = Array.from(document.querySelectorAll('style')).map(style => style.innerHTML).join('\n');

  const extraPrintCSS = `
    @page { size: A4; margin: 8mm; }
    body, .print-container { margin: 0; padding: 0; background: white; }
    .print-container { width: 100%; max-width: 210mm; margin: 0 auto; }
    .rc-wrapper { max-width: 100%; border: none; padding: 0; font-size: 8.5pt; background: #fdf8f2 !important; }
    .rc-school-name { font-size: 22pt !important; }
    .rc-main-row { grid-template-columns: 62fr 35fr; gap: 14px; }
    .rc-att-input, .rc-tick-row, select, textarea, button { display: none !important; }
    .rc-print-val, .rc-print-comment { display: block !important; }
    .rc-rating-cell .rc-print-val { display: inline !important; }
    .rc-details-band { background: #1a3a5c !important; }
    .rc-details-cell { color: #fff !important; border-right: 1px solid rgba(255,255,255,0.18) !important; border-bottom: 1px solid rgba(255,255,255,0.18) !important; }
    .rc-details-cell strong { color: #a8d8f0 !important; }
    .rc-scroll-outer { overflow: visible !important; }
    *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
  `;

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Report Card – ${escapeHtml(reportState.selectedStudent?.name || 'Student')}</title>
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

  reportState.selectedStudent = { id: studentId, name: studentName };
  reportState.term    = document.getElementById('termSelect').value;
  reportState.session = document.getElementById('sessionSelect').value;

  const student       = studentsList.find(s => s.id === studentId);
  const studentClassId = student ? student.classId : classId;
  let classLevel = null;
  if (studentClassId && classesMap.has(studentClassId)) {
    classLevel = classesMap.get(studentClassId).level;
  } else if (studentClassId) {
    const classDoc = await getDoc(doc(db, 'classes', studentClassId));
    if (classDoc.exists()) classLevel = classDoc.data().level;
  }
  await loadGradingSetting(reportState.session, reportState.term, classLevel);
  const isPrimary = (classLevel === 'primary');

  showLoader();
  try {
    const schoolDoc = await getDoc(doc(db, 'schools', currentSchoolId));
    // ── email and phone fetched from Firestore school document ──
    const school = {
      name:    schoolDoc.exists() ? schoolDoc.data().name    : 'School Name',
      address: schoolDoc.exists() ? schoolDoc.data().address : '',
      logo:    schoolDoc.exists() ? schoolDoc.data().logo    : null,
      email:   schoolDoc.exists() ? (schoolDoc.data().email       || '') : '',
      phone:   schoolDoc.exists() ? (schoolDoc.data().phone       || schoolDoc.data().phoneNumber || '') : ''
    };

    const rawScores = await fetchScores(studentId, reportState.term, reportState.session);
    const scoresWithNames = rawScores.map(score => ({
      subjectId:   score.subjectId,
      subjectName: subjectsMap.get(score.subjectId) || score.subjectId,
      ca:   score.ca,
      exam: score.exam
    }));

    const subjectStats = await computeSubjectStats(studentClassId, reportState.term, reportState.session);
    await loadExistingReport(studentId);

    const studentData = {
      id: studentId, name: studentName,
      admissionNumber: student.admissionNumber || '—',
      gender:   student.gender   || '—',
      dob:      student.dob      || '',
      club:     student.club     || '—',
      passport: student.passport || null
    };

    renderReportCardUI({
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
    handleError(err, "Failed to load report card.");
  } finally {
    hideLoader();
  }
}

async function loadClassStudents() {
  reportState.term    = document.getElementById('termSelect').value;
  reportState.session = document.getElementById('sessionSelect').value;
  await loadGradingSetting(reportState.session, reportState.term);
  const classStudents = studentsList.filter(s => s.classId === classId);
  const container = document.getElementById('studentListContainer');
  if (!container) return;

  const titleHtml = `<div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:12px;border-radius:8px 8px 0 0;font-weight:bold;font-size:1.1rem;margin-bottom:5px;text-align:center;">📋 Students in Class</div>`;

  if (!classStudents.length) {
    container.innerHTML = titleHtml + '<p style="padding:20px;background:#f8f9fa;border-radius:0 0 8px 8px;">No students</p>';
    return;
  }

  let html = titleHtml + '<div style="background:#fff;border-radius:0 0 8px 8px;overflow:hidden;">';
  classStudents.forEach(s => {
    html += `<div class="student-list-item" data-id="${s.id}" style="padding:12px 15px;border-bottom:1px solid #e0e0e0;background-color:#f8f9fa;cursor:pointer;transition:all 0.2s;font-weight:500;">${escapeHtml(s.name)}</div>`;
  });
  html += '</div>';
  container.innerHTML = html;

  if (!document.querySelector('#student-list-styles')) {
    const style = document.createElement('style');
    style.id = 'student-list-styles';
    style.textContent = `
      .student-list-item:hover { background-color:#e9ecef !important; transform:translateX(5px); }
      .student-list-item.active { background:linear-gradient(135deg,#667eea 0%,#764ba2 100%) !important; color:#fff !important; border-left:4px solid gold; }
    `;
    document.head.appendChild(style);
  }

  document.querySelectorAll('.student-list-item').forEach(el => {
    el.addEventListener('click', async () => {
      document.querySelectorAll('.student-list-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      await loadReportCard(el.dataset.id, el.textContent.trim());
    });
  });
}

// ==================== BROADSHEET FUNCTIONS ====================
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
  let total = 0, count = 0;
  for (const score of scores) { total += (score.ca || 0) + (score.exam || 0); count++; }
  if (count === 0) return null;
  return ((total / (count * 100)) * 100).toFixed(1);
}

async function generateBroadsheet() {
  if (!isSubscriptionActive) {
    const container = document.getElementById('broadsheetContainer');
    if (container) {
      container.innerHTML = `
        <div style="text-align:center;padding:40px;background:#fef3c7;border-radius:8px;">
          <h3>⚠️ Subscription Required</h3>
          <p>Broadsheets are unavailable because the school subscription is inactive.</p>
        </div>`;
    }
    const actions = document.getElementById('broadsheetActions');
    if (actions) actions.style.display = 'none';
    return;
  }

  const container = document.getElementById('broadsheetContainer');
  if (!container) { showNotification("Broadsheet container not found.", "error"); return; }

  const classIdSel = document.getElementById('broadsheetClassSelect')?.value;
  const session    = document.getElementById('broadsheetSessionSelect')?.value;
  const term       = document.getElementById('broadsheetTermSelect')?.value;
  if (!classIdSel || !session || !term) { showNotification("Please select Class, Session and Term", "error"); return; }

  const classInfo  = classesMap.get(classIdSel);
  const className  = classInfo?.name || 'Class';

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

    const term1Averages = new Map(), term2Averages = new Map(), term3Averages = new Map();
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
      for (const subj of relevantSubjects) {
        const score = scoreMap.get(subj.id) || { ca: 0, exam: 0, total: 0 };
        totalScore += score.total;
        subjectDetails.push({ subjectName: subj.name, ca: score.ca, exam: score.exam, total: score.total });
      }
      const totalObtainable = relevantSubjects.length * 100;
      const average  = totalObtainable ? (totalScore / totalObtainable) * 100 : 0;
      const grade    = calculateGrade(average);
      const remark   = getGradeRemark(grade);
      const termValues = [term1Averages.get(student.id), term2Averages.get(student.id), term3Averages.get(student.id)].filter(v => v !== null);
      const combinedAvg = termValues.length ? (termValues.reduce((a,b)=>a+b,0)/termValues.length).toFixed(1) : null;
      studentResults.push({
        studentId: student.id, studentName: student.name,
        totalScore, average, grade, remark, subjectDetails,
        term1Avg: term1Averages.get(student.id) !== null ? term1Averages.get(student.id).toFixed(1)+'%' : '—',
        term2Avg: term2Averages.get(student.id) !== null ? term2Averages.get(student.id).toFixed(1)+'%' : '—',
        term3Avg: term3Averages.get(student.id) !== null ? term3Averages.get(student.id).toFixed(1)+'%' : '—',
        combinedAvg: combinedAvg !== null ? combinedAvg+'%' : '—'
      });
    }

    studentResults.sort((a,b) => b.totalScore - a.totalScore);
    let rank = 1;
    for (let i = 0; i < studentResults.length; i++) {
      if (i > 0 && studentResults[i].totalScore < studentResults[i-1].totalScore) rank = i+1;
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
      html += `<tr><td>${i+1}</td><td class="student-name-cell">${escapeHtml(r.studentName)}</td>`;
      for (const sub of r.subjectDetails) html += `<td>${sub.ca}</td><td>${sub.exam}</td><td>${sub.total}</td>`;
      html += `<td>${r.totalScore}</td><td>${r.term1Avg}</td><td>${r.term2Avg}</td><td>${r.term3Avg}</td><td>${r.combinedAvg}</td><td>${r.grade}</td>`;
      html += `<td>${r.position}${r.position===1?'st':r.position===2?'nd':r.position===3?'rd':'th'}</td><td>${r.remark}</td></tr>`;
    }
    html += `</tbody></table></div>`;
    container.innerHTML = html;
    const actions = document.getElementById('broadsheetActions');
    if (actions) actions.style.display = 'flex';
    window.currentBroadsheetData = { classId: classIdSel, session, term, studentResults, subjects: relevantSubjects };
  } catch (err) {
    handleError(err, "Failed to generate broadsheet.");
  } finally {
    hideLoader();
  }
}

async function saveBroadsheetToFirestore() {
  const active = await checkSubscription();
  if (!active) { showNotification("Cannot save broadsheet – subscription inactive.", "error"); return; }
  if (!window.currentBroadsheetData) { showNotification("No broadsheet data to save. Generate first.", "error"); return; }
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
  if (!container || !container.innerHTML.trim()) { showNotification("No broadsheet to print.", "error"); return; }
  const originalContent = container.cloneNode(true);
  const title = document.querySelector('#broadsheetContainer h3')?.innerText || 'Class Broadsheet';
  const printWindow = window.open('', '_blank');
  if (!printWindow) { showNotification("Please allow popups.", "error"); return; }
  const externalCssUrl = new URL('../css/styles.css', window.location.href).href;
  const inlineStyles = Array.from(document.querySelectorAll('style')).map(s => s.innerHTML).join('\n');
  printWindow.document.write(`
    <!DOCTYPE html><html><head><title>${title}</title>
    <link rel="stylesheet" href="${externalCssUrl}">
    <style>
      body { font-family:'Segoe UI',sans-serif; margin:20px; }
      .broadsheet-table { width:100%; border-collapse:collapse; font-size:11px; }
      .broadsheet-table th, .broadsheet-table td { border:1px solid #000; padding:6px 4px; text-align:center; }
      .student-name-cell { text-align:left; }
      @media print { @page { size:landscape; margin:1cm; } body { margin:0; } }
      ${inlineStyles}
    </style></head>
    <body>${originalContent.outerHTML}</body></html>
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
  if (!currentSchoolId) { showNotification("School ID missing.", "error"); return; }

  await initAcademicCalendar();
  await checkSubscription();
  await fetchClassName();
  await loadSubjectsAndClasses();
  await loadStudentsList();

  const broadsheetClassSelect = document.getElementById('broadsheetClassSelect');
  if (broadsheetClassSelect) {
    broadsheetClassSelect.innerHTML = '';
    const classInfo = classesMap.get(classId);
    const option = document.createElement('option');
    option.value = classId;
    option.textContent = escapeHtml(classInfo ? classInfo.name : (classNameCache || classId));
    broadsheetClassSelect.appendChild(option);
    broadsheetClassSelect.disabled = false;
    broadsheetClassSelect.value = classId;
  }

  const distinctSessions = await loadSessionOptions(currentSchoolId);
  const currentSession   = getCurrentSession();
  if (!distinctSessions.includes(currentSession)) distinctSessions.unshift(currentSession);

  const currentTermNum = getCurrentTerm();
  const termMap        = { 'First Term': '1', 'Second Term': '2', 'Third Term': '3' };
  const defaultTermNum = termMap[currentTermNum] || '1';

  const sessionSelect = document.getElementById('sessionSelect');
  if (sessionSelect) {
    sessionSelect.innerHTML = distinctSessions.map(s =>
      `<option value="${s}" ${s === currentSession ? 'selected' : ''}>${s}</option>`
    ).join('');
  }
  const broadsheetSessionSelect = document.getElementById('broadsheetSessionSelect');
  if (broadsheetSessionSelect) {
    broadsheetSessionSelect.innerHTML = distinctSessions.map(s =>
      `<option value="${s}" ${s === currentSession ? 'selected' : ''}>${s}</option>`
    ).join('');
  }

  const broadsheetTermSelect = document.getElementById('broadsheetTermSelect');
  if (broadsheetTermSelect) broadsheetTermSelect.value = defaultTermNum;
  const termSelect = document.getElementById('termSelect');
  if (termSelect) termSelect.value = defaultTermNum;

  await loadGradingSetting(currentSession, defaultTermNum);
  await loadClassStudents();

  document.getElementById('termSelect')?.addEventListener('change', () => loadClassStudents());
  document.getElementById('sessionSelect')?.addEventListener('change', () => loadClassStudents());
  document.getElementById('refreshStudentsBtn')?.addEventListener('click', () => loadClassStudents());
  document.getElementById('saveReportBtn')?.addEventListener('click', saveReportCard);
  document.getElementById('printReportBtn')?.addEventListener('click', printReportCard);
  document.getElementById('generateBroadsheetBtn')?.addEventListener('click', generateBroadsheet);
  document.getElementById('saveBroadsheetBtn')?.addEventListener('click', saveBroadsheetToFirestore);
  document.getElementById('printBroadsheetBtn')?.addEventListener('click', printBroadsheet);
}