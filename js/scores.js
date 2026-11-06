// scores.js - Teacher score entry with direct Firestore subscription check
//
// UPDATED (this version):
//   • checkSubscription() now mirrors the FULL server-side isSubscriptionActive()
//     rule (status, locked === false, endDate present, endDate future,
//     term === expectedTerm, session === expectedSession).
//     STRICT — does NOT soften any rule. Missing `locked` → refuses to save.
//   • saveScores() error handler now diagnoses the exact cause when the write
//     is denied:
//       – Refreshes the subscription state and shows the specific blocker.
//       – If subscription is fine, verifies each student's `locked` field
//         in Firestore and lists those that are NOT exactly `false`.
//       – If all students are unlocked, prints the exact subject/class IDs
//         in users/{uid} vs teachers/{uid} so the admin can pinpoint the
//         mismatch in the teacher's assignments.
//   • All other functionality (score upsert, deduplication, notifications,
//     grading limits, session locking) is unchanged.

import { auth } from './firebase-config.js';
import {
  collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { db } from './firebase-config.js';
import { getTeacherData } from './teacher-dashboard.js';
import { showNotification, handleError, showLoader, hideLoader, toast } from './error-handler.js';
import { initAcademicCalendar, getCurrentTerm, getCurrentSession } from './academic-calendar.js';
import { createBulkNotifications } from './notification-service.js';
import * as service from './service.js';

let currentSchoolId = null;
let teacherData = null;
let teacherId = null;
let teacherSubjectIds = [];
let teacherClassIds = [];
let subjectsMap = new Map();
let classesMap = new Map();          // classId -> { name, level }
let studentsList = [];
let selectedClassId = null;
let selectedSubjectId = null;
let selectedTerm = '1';
let selectedSession = '';
let currentGrading = { ca: 40, exam: 60 };
let isScoreEntryAllowed = false;
let subscriptionIssue = null;

// ------------------- Mirror of server expectedTerm() / expectedSession() -------------------
// Must stay identical to those helpers in firestore.rules.
function computeExpectedTerm() {
  const m = new Date().getMonth() + 1; // JS months are 0-11; rules use 1-12
  if (m >= 9) return 'First Term';
  if (m >= 5) return 'Third Term';
  return 'Second Term';
}
function computeExpectedSession() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  return m >= 9 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}
function toDateOrNull(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  const parsed = new Date(v);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// ------------------- STRICT subscription check (mirrors server rule) -------------------
async function checkSubscription() {
  subscriptionIssue = null;
  try {
    const subData = await service.getSubscription(currentSchoolId);

    if (!subData) {
      isScoreEntryAllowed = false;
      subscriptionIssue = 'No subscription record found for this school. Please contact your administrator.';
      updateSubscriptionUI();
      return false;
    }

    if (subData.status !== 'active') {
      isScoreEntryAllowed = false;
      subscriptionIssue = `Your school's subscription is currently "${subData.status}". Please contact your administrator to renew.`;
      updateSubscriptionUI();
      return false;
    }

    // STRICT: server requires `locked == false` exactly. If the field is
    // missing (undefined) or any non-false value, the server denies.
    if (subData.locked !== false) {
      isScoreEntryAllowed = false;
      subscriptionIssue = subData.locked === true
        ? 'Your school\'s subscription is locked. Please contact your administrator.'
        : 'Your school\'s subscription record is missing the "locked" field. Please ask your administrator to set it to false in the subscription settings.';
      updateSubscriptionUI();
      return false;
    }

    const endDate = toDateOrNull(subData.endDate);
    if (!endDate) {
      isScoreEntryAllowed = false;
      subscriptionIssue = 'Your school\'s subscription has no valid expiry date. Please contact your administrator.';
      updateSubscriptionUI();
      return false;
    }
    if (endDate <= new Date()) {
      isScoreEntryAllowed = false;
      subscriptionIssue = `Your school's subscription expired on ${endDate.toLocaleDateString()}. Please contact your administrator to renew.`;
      updateSubscriptionUI();
      return false;
    }

    const expectedTerm = computeExpectedTerm();
    const expectedSession = computeExpectedSession();
    if (subData.term !== expectedTerm || subData.session !== expectedSession) {
      isScoreEntryAllowed = false;
      subscriptionIssue =
        `Your school's subscription is registered for "${subData.term || '—'} ${subData.session || '—'}", ` +
        `but the current term is "${expectedTerm} ${expectedSession}". ` +
        `Please ask your administrator to renew for the current term.`;
      updateSubscriptionUI();
      return false;
    }

    isScoreEntryAllowed = true;
    updateSubscriptionUI();
    return true;
  } catch (err) {
    console.error('Subscription check error:', err);
    isScoreEntryAllowed = false;
    subscriptionIssue = 'Unable to verify subscription status. Please refresh the page.';
    toast.error(subscriptionIssue);
    updateSubscriptionUI();
    return false;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

// ==================== Dynamic session loading via service ====================
async function loadSessionOptions(schoolId) {
  return await service.loadSessionOptions(schoolId);
}

// ------------------- Grading loading -------------------
async function loadGradingSettingByClassLevel(classId, session, term) {
  if (!classId) {
    currentGrading = { ca: 40, exam: 60 };
    return;
  }
  try {
    const classData = await service.getClassById(classId);
    if (!classData) {
      currentGrading = { ca: 40, exam: 60 };
      return;
    }
    const classLevel = classData.level;

    const scoringConfigs = await service.getScoringConfig(currentSchoolId, classLevel);
    let grading = null;
    if (scoringConfigs && scoringConfigs.length > 0) {
      const data = scoringConfigs[0];
      grading = data.grading || `${data.caWeight}/${data.examWeight}`;
    }

    if (!grading) {
      const fallbackConfigs = await service.getScoringConfig(currentSchoolId);
      if (fallbackConfigs && fallbackConfigs.length > 0) {
        const data = fallbackConfigs[0];
        grading = data.grading || `${data.caWeight}/${data.examWeight}`;
      }
    }

    if (grading) {
      const [ca, exam] = grading.split('/').map(Number);
      currentGrading = { ca, exam };
      console.log(`Grading loaded for level ${classLevel}: CA=${ca}, Exam=${exam}`);
    } else {
      currentGrading = { ca: 40, exam: 60 };
    }
  } catch (err) {
    console.error("Failed to load grading by class level:", err);
    currentGrading = { ca: 40, exam: 60 };
  }
}

async function loadGradingSetting(session, term) {
  if (selectedClassId) {
    await loadGradingSettingByClassLevel(selectedClassId, session, term);
  } else {
    try {
      const docId = `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}`;
      const docSnap = await getDoc(doc(db, 'scoring', docId));
      let grading = '40/60';
      if (docSnap.exists()) grading = docSnap.data().grading;
      const [ca, exam] = grading.split('/').map(Number);
      currentGrading = { ca, exam };
    } catch (err) {
      console.error('Grading setting error:', err);
      currentGrading = { ca: 40, exam: 60 };
    }
  }
}

// ------------------- Data loading -------------------
async function loadAllSubjects() {
  try {
    const q = query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId));
    const snap = await getDocs(q);
    subjectsMap.clear();
    snap.forEach(docSnap => {
      const d = docSnap.data();
      if (d.name) subjectsMap.set(docSnap.id, d.name);
    });
    console.log(`Loaded ${subjectsMap.size} subjects directly from Firestore.`);
  } catch (err) {
    console.error('Load subjects error:', err);
    toast.error('Unable to load subjects. Please refresh the page.');
  }
}

async function loadAllClasses() {
  try {
    const classes = await service.getClassesBySchool(currentSchoolId);
    classesMap.clear();
    classes.forEach(cls => classesMap.set(cls.id, { name: cls.name, level: cls.level }));
  } catch (err) {
    console.error('Load classes error:', err);
    toast.error('Unable to load classes. Please refresh the page.');
  }
}

async function loadTeacherAssignedSubjectsAndClasses() {
  if (!teacherId) return;
  try {
    const teacherDocSnap = await getDoc(doc(db, 'teachers', teacherId));
    if (teacherDocSnap.exists()) {
      const teacher = teacherDocSnap.data();
      teacherSubjectIds = teacher.subjectIds || [];
      teacherClassIds = teacher.classIds || [];
      console.log("Teacher assigned subjects (fresh):", teacherSubjectIds);
      console.log("Teacher assigned classes (fresh):", teacherClassIds);
    } else {
      console.warn("Teacher document not found for UID:", teacherId);
    }
  } catch (err) {
    console.error('Load teacher assignments error:', err);
    toast.warning('Unable to load teacher assignments. Please refresh the page.');
  }
}

function populateSubjectDropdown() {
  const subjectSelect = document.getElementById('subjectSelect');
  if (!subjectSelect) return;
  subjectSelect.innerHTML = '<option value="">Select Subject</option>';
  let subjectsToShow = teacherSubjectIds.length ? teacherSubjectIds : Array.from(subjectsMap.keys());
  if (!subjectsToShow.length) {
    const option = document.createElement('option');
    option.disabled = true;
    option.textContent = 'No subjects available';
    subjectSelect.appendChild(option);
    subjectSelect.disabled = true;
    return;
  }
  for (const subjId of subjectsToShow) {
    const subjectName = subjectsMap.get(subjId);
    if (subjectName) {
      const option = document.createElement('option');
      option.value = subjId;
      option.textContent = subjectName;
      subjectSelect.appendChild(option);
    }
  }
  subjectSelect.disabled = false;
}

function populateClassDropdown() {
  const classSelect = document.getElementById('classSelect');
  if (!classSelect) return;
  let teacherClasses = teacherClassIds.length ? teacherClassIds : Array.from(classesMap.keys());
  classSelect.innerHTML = '<option value="">Select Class</option>';
  for (const clsId of teacherClasses) {
    const classInfo = classesMap.get(clsId);
    const className = classInfo ? classInfo.name : clsId;
    const option = document.createElement('option');
    option.value = clsId;
    option.textContent = className;
    classSelect.appendChild(option);
  }
  classSelect.disabled = false;
}

async function loadStudentsForClass(classId) {
  try {
    const students = await service.getStudentsByClass(currentSchoolId, classId);
    studentsList = students.map(s => ({
      id: s.id,
      name: s.name,
      locked: s.locked === true
    }));
  } catch (err) {
    console.error('Load students for class error:', err);
    toast.error('Unable to load students for this class. Please refresh.');
    studentsList = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Score upsert helpers (duplicate-safe)
// ─────────────────────────────────────────────────────────────────────────────
function _scoreDateMs(score) {
  const candidates = [score.updatedAt, score.createdAt];
  for (const val of candidates) {
    if (!val) continue;
    try {
      if (val.toDate) return val.toDate().getTime();
      if (val.seconds) return val.seconds * 1000;
      const parsed = new Date(val).getTime();
      if (!Number.isNaN(parsed)) return parsed;
    } catch (_) {}
  }
  return 0;
}

function sanitizeForDocId(value) {
  return String(value || '').replace(/[^\w-]/g, '_');
}

async function getAllExistingScoreDocs(studentId, subjectId, term, session) {
  try {
    const q = query(
      collection(db, 'scores'),
      where('studentId', '==', studentId),
      where('subjectId', '==', subjectId),
      where('schoolId', '==', currentSchoolId),
      where('term', '==', term),
      where('session', '==', session)
    );
    const snap = await getDocs(q);
    const docs = snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    docs.sort((a, b) => _scoreDateMs(b) - _scoreDateMs(a));
    return docs;
  } catch (err) {
    console.error('Get all existing score docs error:', err);
    toast.warning('Unable to load existing scores. Please refresh.');
    return [];
  }
}

async function fetchExistingScores(studentId, subjectId, term, session) {
  const allExisting = await getAllExistingScoreDocs(studentId, subjectId, term, session);
  return allExisting.length > 0 ? allExisting[0] : null;
}

async function saveAllScores(scoresData) {
  if (!isScoreEntryAllowed) throw new Error('subscription_inactive');
  if (scoresData.length === 0) return;

  const batch = writeBatch(db);

  for (const score of scoresData) {
    const allExisting = await getAllExistingScoreDocs(
      score.studentId,
      score.subjectId,
      selectedTerm,
      selectedSession
    );

    const subjectName = subjectsMap.get(score.subjectId) || '';
    const className   = classesMap.get(selectedClassId)?.name || '';
    const now = new Date();

    const identityFields = {
      studentId:   score.studentId,
      studentName: score.studentName || '',
      subjectId:   score.subjectId,
      subjectName: subjectName,
      schoolId:    currentSchoolId,
      classId:     selectedClassId,
      className:   className,
      term:        selectedTerm,
      session:     selectedSession,
      ca:          score.ca,
      exam:        score.exam
    };

    let scoreRef;

    if (allExisting.length === 0) {
      const deterministicId = `${score.studentId}_${score.subjectId}_${selectedTerm}_${sanitizeForDocId(selectedSession)}`;
      scoreRef = doc(db, 'scores', deterministicId);
      batch.set(scoreRef, { ...identityFields, createdAt: now, updatedAt: now });
    } else {
      const canonical = allExisting[0];
      const extras = allExisting.slice(1);
      scoreRef = doc(db, 'scores', canonical.id);
      batch.set(scoreRef, { ...identityFields, updatedAt: now }, { merge: true });
      for (const extra of extras) {
        batch.delete(doc(db, 'scores', extra.id));
      }
    }
  }

  await batch.commit();
  service.invalidateScores();
}

// ------------------- UI control based on subscription -------------------
function updateSubscriptionUI() {
  const saveBtn = document.getElementById('saveScoresBtn');
  const container = document.getElementById('scoresContainer');
  const existingBanner = document.getElementById('subscriptionBanner');

  if (!isScoreEntryAllowed) {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.5';
      saveBtn.title = subscriptionIssue || 'Subscription inactive – cannot save scores';
    }

    const bannerHtml = `
      <strong>⚠️ Score Entry Blocked</strong><br>
      ${escapeHtml(subscriptionIssue || 'Your school subscription is inactive.')}
    `;

    if (container && !existingBanner) {
      const banner = document.createElement('div');
      banner.id = 'subscriptionBanner';
      banner.className = 'subscription-banner';
      banner.style.cssText = 'background: #fee2e2; color: #991b1b; padding: 12px; margin-bottom: 16px; border-radius: 8px;';
      banner.innerHTML = bannerHtml;
      container.prepend(banner);
    } else if (existingBanner) {
      existingBanner.innerHTML = bannerHtml;
    }

    document.querySelectorAll('.ca-input, .exam-input').forEach(input => input.disabled = true);
  } else {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.style.opacity = '1';
      saveBtn.title = '';
    }
    if (existingBanner) existingBanner.remove();
    document.querySelectorAll('.ca-input, .exam-input').forEach(input => {
      const row = input.closest('tr');
      const isLocked = row?.dataset.locked === 'true';
      input.disabled = isLocked;
    });
  }
}

// ------------------- Score table rendering -------------------
async function renderScoreTable() {
  const container = document.getElementById('scoresTableContainer');
  if (!container) return;
  if (!selectedClassId || !selectedSubjectId) {
    container.innerHTML = '<p>Select class and subject</p>';
    return;
  }

  await loadStudentsForClass(selectedClassId);
  if (studentsList.length === 0) {
    container.innerHTML = '<p>No students in this class</p>';
    return;
  }

  const caMax   = Number(currentGrading.ca)   || 0;
  const examMax = Number(currentGrading.exam) || 0;

  let tableHtml = `<table class="scores-table">
    <thead>
      <tr><th>Student Name</th><th>CA (${caMax})</th><th>Exam (${examMax})</th><th>Total</th><th>Status</th></tr>
    </thead>
    <tbody>`;

  for (const student of studentsList) {
    const existing = await fetchExistingScores(student.id, selectedSubjectId, selectedTerm, selectedSession);
    const ca = existing?.ca ?? '';
    const exam = existing?.exam ?? '';
    const total = (ca !== '' && exam !== '') ? (parseInt(ca) + parseInt(exam)) : '';
    const isLocked = student.locked === true;
    const disabledAttr = (!isScoreEntryAllowed || isLocked) ? 'disabled' : '';
    const statusText = isLocked ? '🔒 Not Approved' : '✅ Approved';

    tableHtml += `<tr data-student-id="${student.id}" data-locked="${isLocked}" data-student-name="${escapeHtml(student.name)}">
      <td>${escapeHtml(student.name)}</td>
      <td><input type="number" class="score-input ca-input" value="${ca}" min="0" max="${caMax}" data-max="${caMax}" ${disabledAttr}></td>
      <td><input type="number" class="score-input exam-input" value="${exam}" min="0" max="${examMax}" data-max="${examMax}" ${disabledAttr}></td>
      <td class="total-cell">${total}</td>
      <td class="status-cell">${statusText}</td>
    </tr>`;
  }

  tableHtml += `</tbody></table>`;
  container.innerHTML = `<div class="table-responsive-wrapper">${tableHtml}</div>`;

  if (isScoreEntryAllowed) {
    document.querySelectorAll('.ca-input:not([disabled]), .exam-input:not([disabled])').forEach(input => {
      input.addEventListener('input', function() {
        const max = Number(this.dataset.max) || 0;
        if (this.value !== '') {
          let v = parseInt(this.value, 10);
          if (Number.isNaN(v)) v = 0;
          if (v < 0) v = 0;
          if (v > max) {
            v = max;
            this.value = String(max);
            toast.warning(`Maximum allowed is ${max}.`);
          }
        }
        const row = this.closest('tr');
        if (!row) return;
        const caInput = row.querySelector('.ca-input');
        const examInput = row.querySelector('.exam-input');
        const totalCell = row.querySelector('.total-cell');
        if (!caInput || !examInput || !totalCell) return;
        const ca = parseInt(caInput.value) || 0;
        const exam = parseInt(examInput.value) || 0;
        totalCell.textContent = ca + exam;
      });

      input.addEventListener('change', function() {
        const max = Number(this.dataset.max) || 0;
        let v = parseInt(this.value, 10);
        if (Number.isNaN(v)) v = 0;
        if (v < 0) v = 0;
        if (v > max) {
          v = max;
          this.value = String(max);
          toast.warning(`Maximum allowed is ${max}.`);
        }
      });
    });
  }
}

// ------------------- Save scores -------------------
async function saveScores() {
  const active = await checkSubscription();
  if (!active) {
    toast.error(subscriptionIssue || 'School subscription is inactive. Cannot save scores.');
    return;
  }

  if (!selectedClassId || !selectedSubjectId) {
    toast.error('Please select a class and subject first.');
    return;
  }
  if (teacherSubjectIds.length > 0 && !teacherSubjectIds.includes(selectedSubjectId)) {
    toast.error(`You are not assigned to teach the subject "${subjectsMap.get(selectedSubjectId) || selectedSubjectId}".`);
    return;
  }
  if (teacherClassIds.length > 0 && !teacherClassIds.includes(selectedClassId)) {
    toast.error(`You are not assigned to teach the class "${classesMap.get(selectedClassId)?.name || selectedClassId}".`);
    return;
  }

  const rows = document.querySelectorAll('#scoresTableContainer tbody tr');
  if (!rows.length) {
    toast.error('No students found. Please refresh the class list.');
    return;
  }

  const caMax   = Number(currentGrading.ca)   || 0;
  const examMax = Number(currentGrading.exam) || 0;

  const unlockedScores = [];
  const lockedStudentNames = [];

  for (const row of rows) {
    const studentId = row.dataset.studentId;
    const studentName = row.dataset.studentName || row.querySelector('td:first-child')?.textContent || 'Unknown';
    const isLocked = row.dataset.locked === 'true';
    const caInput = row.querySelector('.ca-input');
    const examInput = row.querySelector('.exam-input');
    if (!caInput || !examInput) continue;
    const ca = parseInt(caInput.value) || 0;
    const exam = parseInt(examInput.value) || 0;

    if (ca > caMax || exam > examMax) {
      toast.error(`Invalid scores for ${studentName}. CA max = ${caMax}, Exam max = ${examMax}`);
      return;
    }
    if (isLocked) {
      lockedStudentNames.push(studentName);
      continue;
    }
    unlockedScores.push({ studentId, studentName, subjectId: selectedSubjectId, ca, exam });
  }

  if (lockedStudentNames.length) {
    toast.warning(`Scores not saved for locked students: ${lockedStudentNames.join(', ')}`);
  }
  if (unlockedScores.length === 0) {
    toast.info('No scores were saved because all students are locked.');
    return;
  }

  showLoader();
  try {
    await saveAllScores(unlockedScores);

    if (unlockedScores.length > 0) {
      try {
        const subjectName = subjectsMap.get(selectedSubjectId) || '';
        const notifications = unlockedScores.map(score => ({
          studentId: score.studentId,
          schoolId: currentSchoolId,
          title: 'New Score Uploaded',
          message: `Your ${subjectName} score has been uploaded.`,
          type: 'score',
          relatedId: null
        }));
        await createBulkNotifications(notifications);
      } catch (notifErr) {
        console.error('Failed to create score notifications:', notifErr);
      }
    }

    toast.success(`Scores saved successfully for ${unlockedScores.length} student(s).`);
    await renderScoreTable();
  } catch (err) {
    console.error("Full error object:", err);

    if (err.code !== 'permission-denied') {
      if (err.message === 'subscription_inactive') {
        toast.error(subscriptionIssue || 'School subscription is inactive. Please renew to save scores.');
      } else {
        toast.error('Failed to save scores. Please try again.');
      }
      return;
    }

    // === Diagnose permission-denied by re-checking each condition ===
    const stillOk = await checkSubscription();
    if (!stillOk) {
      toast.error(subscriptionIssue || 'Unable to save. Subscription is not valid for the current term.');
      return;
    }

    // Subscription is fine — check students' locked flags
    const blockedStudents = [];
    for (const score of unlockedScores) {
      try {
        const sDoc = await getDoc(doc(db, 'students', score.studentId));
        if (!sDoc.exists()) {
          blockedStudents.push(`${score.studentName} (student doc not found)`);
        } else {
          const v = sDoc.data().locked;
          if (v !== false) {
            blockedStudents.push(`${score.studentName} (locked=${v === undefined ? 'missing' : JSON.stringify(v)})`);
          }
        }
      } catch (e) {
        blockedStudents.push(`${score.studentName} (unable to verify)`);
      }
    }
    if (blockedStudents.length) {
      toast.error(`Unable to save. These students are not unlocked (must have locked:false): ${blockedStudents.join(', ')}`);
      return;
    }

    // Subscription OK + all students unlocked — check teacher assignment
    const uid = auth.currentUser.uid;
    let usersData = null;
    let teachersData = null;
    try {
      const uDoc = await getDoc(doc(db, 'users', uid));
      usersData = uDoc.exists() ? uDoc.data() : null;
      const tDoc = await getDoc(doc(db, 'teachers', uid));
      teachersData = tDoc.exists() ? tDoc.data() : null;
    } catch (e) { /* non-fatal */ }

    const uSubs = (usersData?.subjectIds || []);
    const uCls = (usersData?.classIds || []);
    const tSubs = (teachersData?.subjectIds || []);
    const tCls = (teachersData?.classIds || []);

    const subjOk =
      (uSubs.length === 0 && tSubs.length === 0) ||
      uSubs.includes(selectedSubjectId) ||
      tSubs.includes(selectedSubjectId);
    const clsOk =
      (uCls.length === 0 && tCls.length === 0) ||
      uCls.includes(selectedClassId) ||
      tCls.includes(selectedClassId);

    if (!subjOk || !clsOk) {
      toast.error(
        `Unable to save. Teacher assignment mismatch. ` +
        `Subject: users=[${uSubs.join(',') || '∅'}] / teachers=[${tSubs.join(',') || '∅'}] → ${subjOk ? 'MATCH' : 'NO MATCH'}. ` +
        `Class: users=[${uCls.join(',') || '∅'}] / teachers=[${tCls.join(',') || '∅'}] → ${clsOk ? 'MATCH' : 'NO MATCH'}. ` +
        `Please ask your administrator to update your teacher record.`
      );
      return;
    }

    toast.error(
      'Save was denied by security rules despite all checks passing. ' +
      'Please contact support with the console log from this attempt.'
    );
  } finally {
    hideLoader();
  }
}

// ------------------- Page initialisation -------------------
async function initScoresPage() {
  const user = auth.currentUser;
  if (!user) {
    toast.error('User not logged in. Please refresh the page.');
    return;
  }
  teacherId = user.uid;

  teacherData = getTeacherData();
  if (!teacherData) {
    toast.error('Teacher data not found. Please contact your administrator.');
    return;
  }
  currentSchoolId = teacherData.schoolId;
  if (!currentSchoolId) {
    toast.error('School ID missing. Please log out and log in again.');
    return;
  }

  await initAcademicCalendar();
  await checkSubscription();

  await Promise.all([loadAllSubjects(), loadAllClasses()]);
  await loadTeacherAssignedSubjectsAndClasses();

  populateSubjectDropdown();
  populateClassDropdown();

  const currentSession   = getCurrentSession();
  const currentTermName  = getCurrentTerm();
  const termMap          = { 'First Term': '1', 'Second Term': '2', 'Third Term': '3' };
  const defaultTermNum   = termMap[currentTermName] || '1';

  const sessionSelect = document.getElementById('sessionSelect');
  if (sessionSelect) {
    sessionSelect.innerHTML = `<option value="${currentSession}">${currentSession}</option>`;
    sessionSelect.value = currentSession;
    sessionSelect.disabled = true;
  }

  const termSelect = document.getElementById('termSelect');
  if (termSelect) termSelect.value = defaultTermNum;

  await loadGradingSetting(currentSession, defaultTermNum);

  const classSelect = document.getElementById('classSelect');
  const subjectSelect = document.getElementById('subjectSelect');

  if (classSelect) {
    classSelect.addEventListener('change', async () => {
      selectedClassId = classSelect.value;
      if (selectedClassId) {
        const s = document.getElementById('sessionSelect')?.value || currentSession;
        const t = document.getElementById('termSelect')?.value || defaultTermNum;
        await loadGradingSettingByClassLevel(selectedClassId, s, t);
        if (selectedSubjectId) await renderScoreTable();
      } else {
        currentGrading = { ca: 40, exam: 60 };
        renderScoreTable();
      }
    });
  }

  if (subjectSelect) {
    subjectSelect.addEventListener('change', () => {
      selectedSubjectId = subjectSelect.value;
      renderScoreTable();
    });
  }

  if (sessionSelect) {
    sessionSelect.addEventListener('change', async () => {
      selectedSession = sessionSelect.value;
      if (selectedClassId) {
        const t = document.getElementById('termSelect')?.value || defaultTermNum;
        await loadGradingSettingByClassLevel(selectedClassId, selectedSession, t);
      } else {
        await loadGradingSetting(selectedSession, defaultTermNum);
      }
      renderScoreTable();
    });
  }

  if (termSelect) {
    termSelect.addEventListener('change', async (e) => {
      selectedTerm = e.target.value;
      if (selectedClassId) {
        const s = document.getElementById('sessionSelect')?.value || currentSession;
        await loadGradingSettingByClassLevel(selectedClassId, s, selectedTerm);
      } else {
        await loadGradingSetting(currentSession, selectedTerm);
      }
      renderScoreTable();
    });
  }

  const saveBtn = document.getElementById('saveScoresBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveScores);

  selectedSession = currentSession;
  selectedTerm    = defaultTermNum;

  if (selectedClassId) {
    await loadGradingSettingByClassLevel(selectedClassId, selectedSession, selectedTerm);
  } else {
    await loadGradingSetting(selectedSession, selectedTerm);
  }
  renderScoreTable();
  updateSubscriptionUI();
}

export { initScoresPage };
