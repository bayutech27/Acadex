// scores.js - Teacher score entry
//
// UPDATED (this version):
//   1. checkSubscription() now reads the school's access document DIRECTLY
//      from Firestore (bypassing any service cache) so the client and
//      server always agree.
//   2. loadTeacherAssignedSubjectsAndClasses() now handles BOTH teacher
//      storage shapes — teachers/{authUid} OR teachers/{anything} where
//      a field authUid/uid points back to the auth user. After resolving
//      the teacher's record, it also syncs subjectIds/classIds into the
//      user profile so the security check can find them there too.
//   3. saveAllScores() now writes each student's score INDIVIDUALLY
//      (Promise.allSettled) — partial saves are preserved, and no batch
//      deletes are attempted (teachers can't delete score records under
//      the security policy). Orphaned duplicates are left for the
//      administrator to clean up.
//   4. All user-facing messages are now friendly, plain English. No
//      mention of Firestore, collections, security rules, fields,
//      term/session internals, or any backend concept. The failure
//      diagnostic still runs server-side reads to figure out the real
//      cause, but it prints only a human-friendly reason.
//   5. On the save-denied path the diagnostic fetches every relevant
//      piece of data with DIRECT reads (bypassing cache) and reports
//      the actual blocker in plain language:
//         • school's access has expired / been paused / not renewed
//         • specific students haven't been approved yet
//         • teacher account's subject/class assignments are out of sync
//         • otherwise "please contact your school administrator"
//   6. Also mirrors subjectIds/classIds into users/{authUid} at init
//      so the security check passes for teachers whose profile lives
//      under a non-authUid document ID.
//
// All other functionality (score table rendering, deduplication of
// score records by deterministic ID, notifications to students,
// grading clamps, session locking) is unchanged.

import { auth } from './firebase-config.js';
import {
  collection, getDocs, query, where, doc, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { db } from './firebase-config.js';
import { getTeacherData } from './teacher-dashboard.js';
import { showLoader, hideLoader, toast } from './error-handler.js';
import { initAcademicCalendar, getCurrentTerm, getCurrentSession } from './academic-calendar.js';
import { createBulkNotifications } from './notification-service.js';
import * as service from './service.js';

let currentSchoolId = null;
let teacherData = null;
let teacherId = null;
let teacherSubjectIds = [];
let teacherClassIds = [];
let subjectsMap = new Map();
let classesMap = new Map();
let studentsList = [];
let selectedClassId = null;
let selectedSubjectId = null;
let selectedTerm = '1';
let selectedSession = '';
let currentGrading = { ca: 40, exam: 60 };
let isScoreEntryAllowed = false;
let subscriptionIssue = null;

// ------------------- helpers -------------------
function computeExpectedTerm() {
  const m = new Date().getMonth() + 1;
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
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

// ------------------- Subscription check (STRICT — direct read) -------------------
// Reads the school's access document straight from the server so the
// client-side state always matches what the backend will see.
async function checkSubscription() {
  subscriptionIssue = null;
  try {
    if (!currentSchoolId) {
      isScoreEntryAllowed = false;
      subscriptionIssue = 'Your school information is missing. Please log out and log in again.';
      updateSubscriptionUI();
      return false;
    }

    const subRef = doc(db, 'schools', currentSchoolId, 'subscription', 'current');
    const subSnap = await getDoc(subRef);
    const subData = subSnap.exists() ? subSnap.data() : null;

    if (!subData) {
      isScoreEntryAllowed = false;
      subscriptionIssue = 'Your school\'s access has not been set up yet. Please contact your school administrator.';
      updateSubscriptionUI();
      return false;
    }

    if (subData.status !== 'active') {
      isScoreEntryAllowed = false;
      subscriptionIssue = 'Your school\'s access is currently paused. Please contact your school administrator to restore it.';
      updateSubscriptionUI();
      return false;
    }

    // Missing `locked` is NOT the same as `locked == false` — treat as blocked.
    if (subData.locked !== false) {
      isScoreEntryAllowed = false;
      subscriptionIssue = 'Your school\'s access is currently locked. Please contact your school administrator.';
      updateSubscriptionUI();
      return false;
    }

    const endDate = toDateOrNull(subData.endDate);
    if (!endDate) {
      isScoreEntryAllowed = false;
      subscriptionIssue = 'Your school\'s access needs to be refreshed. Please contact your school administrator.';
      updateSubscriptionUI();
      return false;
    }
    if (endDate <= new Date()) {
      isScoreEntryAllowed = false;
      subscriptionIssue = 'Your school\'s access has expired. Please ask your school administrator to renew it.';
      updateSubscriptionUI();
      return false;
    }

    const expectedTerm = computeExpectedTerm();
    const expectedSession = computeExpectedSession();
    if (subData.term !== expectedTerm || subData.session !== expectedSession) {
      isScoreEntryAllowed = false;
      subscriptionIssue = 'Your school\'s access has not been renewed for the current term. Please ask your school administrator to renew it.';
      updateSubscriptionUI();
      return false;
    }

    isScoreEntryAllowed = true;
    updateSubscriptionUI();
    return true;
  } catch (err) {
    console.error('Access verification error:', err);
    isScoreEntryAllowed = false;
    subscriptionIssue = 'We couldn\'t verify your school\'s access right now. Please refresh the page and try again.';
    toast.error(subscriptionIssue);
    updateSubscriptionUI();
    return false;
  }
}

// ------------------- Grading -------------------
async function loadGradingSettingByClassLevel(classId, session, term) {
  if (!classId) { currentGrading = { ca: 40, exam: 60 }; return; }
  try {
    const classData = await service.getClassById(classId);
    if (!classData) { currentGrading = { ca: 40, exam: 60 }; return; }
    const classLevel = classData.level;

    const scoringConfigs = await service.getScoringConfig(currentSchoolId, classLevel);
    let grading = null;
    if (scoringConfigs && scoringConfigs.length > 0) {
      const data = scoringConfigs[0];
      grading = data.grading || `${data.caWeight}/${data.examWeight}`;
    }
    if (!grading) {
      const fallback = await service.getScoringConfig(currentSchoolId);
      if (fallback && fallback.length > 0) {
        const data = fallback[0];
        grading = data.grading || `${data.caWeight}/${data.examWeight}`;
      }
    }
    if (grading) {
      const [ca, exam] = grading.split('/').map(Number);
      currentGrading = { ca, exam };
    } else {
      currentGrading = { ca: 40, exam: 60 };
    }
  } catch (err) {
    console.error('Grading load error:', err);
    currentGrading = { ca: 40, exam: 60 };
  }
}

async function loadGradingSetting(session, term) {
  if (selectedClassId) {
    await loadGradingSettingByClassLevel(selectedClassId, session, term);
  } else {
    try {
      const docId = `${currentSchoolId}_${session.replace(/\//g, '_')}_${term}`;
      const snap = await getDoc(doc(db, 'scoring', docId));
      let grading = '40/60';
      if (snap.exists()) grading = snap.data().grading;
      const [ca, exam] = grading.split('/').map(Number);
      currentGrading = { ca, exam };
    } catch (err) {
      console.error('Grading load error:', err);
      currentGrading = { ca: 40, exam: 60 };
    }
  }
}

// ------------------- Subject / Class / Student loading -------------------
async function loadAllSubjects() {
  try {
    const q = query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId));
    const snap = await getDocs(q);
    subjectsMap.clear();
    snap.forEach(d => {
      const s = d.data();
      if (s.name) subjectsMap.set(d.id, s.name);
    });
  } catch (err) {
    console.error('Subject load error:', err);
    toast.error('We couldn\'t load the subjects. Please refresh the page.');
  }
}

async function loadAllClasses() {
  try {
    const classes = await service.getClassesBySchool(currentSchoolId);
    classesMap.clear();
    classes.forEach(c => classesMap.set(c.id, { name: c.name, level: c.level }));
  } catch (err) {
    console.error('Class load error:', err);
    toast.error('We couldn\'t load the classes. Please refresh the page.');
  }
}

// Handles both storage shapes:
//   teachers/{authUid}.subjectIds    (doc ID = auth UID)
//   teachers/{other}.authUid === authUid   (doc ID = something else)
// After resolving, mirrors subjectIds/classIds into users/{authUid} so the
// security check finds them there too.
async function loadTeacherAssignedSubjectsAndClasses() {
  if (!teacherId) return;
  teacherSubjectIds = [];
  teacherClassIds = [];

  try {
    let teacher = null;

    // 1) Direct lookup by auth UID
    const directSnap = await getDoc(doc(db, 'teachers', teacherId));
    if (directSnap.exists()) {
      teacher = directSnap.data();
    } else {
      // 2) Query by authUid field
      const q1 = query(collection(db, 'teachers'), where('authUid', '==', teacherId));
      const snap1 = await getDocs(q1);
      if (!snap1.empty) {
        teacher = snap1.docs[0].data();
      } else {
        // 3) Query by uid field (legacy name)
        const q2 = query(collection(db, 'teachers'), where('uid', '==', teacherId));
        const snap2 = await getDocs(q2);
        if (!snap2.empty) teacher = snap2.docs[0].data();
      }
    }

    if (!teacher) {
      console.warn('Teacher profile not found for signed-in user.');
      return;
    }

    teacherSubjectIds = Array.isArray(teacher.subjectIds) ? teacher.subjectIds : [];
    teacherClassIds = Array.isArray(teacher.classIds) ? teacher.classIds : [];

    // Mirror assignments into users/{authUid} so the security check
    // finds them there. Best-effort, never blocks the page.
    try {
      const userRef = doc(db, 'users', teacherId);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const u = userSnap.data();
        const uSubs = Array.isArray(u.subjectIds) ? u.subjectIds : [];
        const uCls  = Array.isArray(u.classIds)  ? u.classIds  : [];
        const subsDiffer = teacherSubjectIds.length > 0 &&
          (uSubs.length !== teacherSubjectIds.length ||
           teacherSubjectIds.some(id => !uSubs.includes(id)));
        const clsDiffer = teacherClassIds.length > 0 &&
          (uCls.length !== teacherClassIds.length ||
           teacherClassIds.some(id => !uCls.includes(id)));

        if (subsDiffer || clsDiffer) {
          const updates = {};
          if (subsDiffer) updates.subjectIds = teacherSubjectIds;
          if (clsDiffer)  updates.classIds   = teacherClassIds;
          await setDoc(userRef, updates, { merge: true });
          console.log('Teacher assignments synced to profile.');
        }
      }
    } catch (syncErr) {
      console.warn('Assignment sync skipped:', syncErr);
    }
  } catch (err) {
    console.error('Teacher assignment load error:', err);
    toast.warning('We couldn\'t load your teaching assignments. Please refresh the page.');
  }
}

function populateSubjectDropdown() {
  const subjectSelect = document.getElementById('subjectSelect');
  if (!subjectSelect) return;
  subjectSelect.innerHTML = '<option value="">Select Subject</option>';
  const subjectsToShow = teacherSubjectIds.length ? teacherSubjectIds : Array.from(subjectsMap.keys());
  if (!subjectsToShow.length) {
    const o = document.createElement('option');
    o.disabled = true;
    o.textContent = 'No subjects available';
    subjectSelect.appendChild(o);
    subjectSelect.disabled = true;
    return;
  }
  for (const id of subjectsToShow) {
    const name = subjectsMap.get(id);
    if (name) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = name;
      subjectSelect.appendChild(o);
    }
  }
  subjectSelect.disabled = false;
}

function populateClassDropdown() {
  const classSelect = document.getElementById('classSelect');
  if (!classSelect) return;
  const teacherClasses = teacherClassIds.length ? teacherClassIds : Array.from(classesMap.keys());
  classSelect.innerHTML = '<option value="">Select Class</option>';
  for (const id of teacherClasses) {
    const info = classesMap.get(id);
    const name = info ? info.name : id;
    const o = document.createElement('option');
    o.value = id;
    o.textContent = name;
    classSelect.appendChild(o);
  }
  classSelect.disabled = false;
}

async function loadStudentsForClass(classId) {
  try {
    const students = await service.getStudentsByClass(currentSchoolId, classId);
    studentsList = students.map(s => ({
      id: s.id,
      name: s.name || 'Student',
      locked: s.locked === true
    }));
  } catch (err) {
    console.error('Student load error:', err);
    toast.error('We couldn\'t load the students for this class. Please refresh.');
    studentsList = [];
  }
}

// ------------------- Score record helpers -------------------
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
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    docs.sort((a, b) => _scoreDateMs(b) - _scoreDateMs(a));
    return docs;
  } catch (err) {
    console.error('Existing score lookup error:', err);
    return [];
  }
}

// ------------------- Save scores (individual writes) -------------------
// Each student's score is written independently so a partial failure
// doesn't roll back successful saves. No deletes are attempted.
async function saveAllScores(scoresData) {
  if (!isScoreEntryAllowed) throw new Error('subscription_inactive');
  if (scoresData.length === 0) return { succeeded: [], failed: [] };

  const subjectName = subjectsMap.get(selectedSubjectId) || '';
  const className = classesMap.get(selectedClassId)?.name || '';

  const tasks = scoresData.map(async (score) => {
    const allExisting = await getAllExistingScoreDocs(
      score.studentId, score.subjectId, selectedTerm, selectedSession
    );

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

    const now = new Date();
    let scoreRef;
    if (allExisting.length === 0) {
      const detId = `${score.studentId}_${score.subjectId}_${selectedTerm}_${sanitizeForDocId(selectedSession)}`;
      scoreRef = doc(db, 'scores', detId);
      await setDoc(scoreRef, { ...identityFields, createdAt: now, updatedAt: now });
    } else {
      const canonical = allExisting[0];
      scoreRef = doc(db, 'scores', canonical.id);
      await setDoc(scoreRef, { ...identityFields, updatedAt: now }, { merge: true });
    }

    return { score, ok: true };
  });

  const settled = await Promise.allSettled(tasks);
  const succeeded = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') succeeded.push(scoresData[i]);
    else {
      console.error(`Failed to save score for ${scoresData[i].studentName}:`, r.reason);
      failed.push({ student: scoresData[i], reason: r.reason });
    }
  });

  try { service.invalidateScores(); } catch (_) {}
  return { succeeded, failed };
}

// ------------------- UI control -------------------
function updateSubscriptionUI() {
  const saveBtn = document.getElementById('saveScoresBtn');
  const container = document.getElementById('scoresContainer');
  const existingBanner = document.getElementById('subscriptionBanner');

  if (!isScoreEntryAllowed) {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.5';
      saveBtn.title = subscriptionIssue || 'Saving is currently unavailable.';
    }

    const bannerHtml = `
      <strong>⚠️ Saving is unavailable</strong><br>
      ${escapeHtml(subscriptionIssue || 'Please contact your school administrator.')}
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

    document.querySelectorAll('.ca-input, .exam-input').forEach(i => i.disabled = true);
  } else {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.style.opacity = '1';
      saveBtn.title = '';
    }
    if (existingBanner) existingBanner.remove();
    document.querySelectorAll('.ca-input, .exam-input').forEach(input => {
      const row = input.closest('tr');
      input.disabled = row?.dataset.locked === 'true';
    });
  }
}

// ------------------- Score table -------------------
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

  const caMax = Number(currentGrading.ca) || 0;
  const examMax = Number(currentGrading.exam) || 0;

  let html = `<table class="scores-table">
    <thead><tr>
      <th>Student Name</th><th>CA (${caMax})</th><th>Exam (${examMax})</th><th>Total</th><th>Status</th>
    </tr></thead><tbody>`;

  for (const s of studentsList) {
    const existing = await getAllExistingScoreDocs(s.id, selectedSubjectId, selectedTerm, selectedSession)
      .then(a => a.length ? a[0] : null);
    const ca = existing?.ca ?? '';
    const exam = existing?.exam ?? '';
    const total = (ca !== '' && exam !== '') ? (parseInt(ca) + parseInt(exam)) : '';
    const isLocked = s.locked === true;
    const dis = (!isScoreEntryAllowed || isLocked) ? 'disabled' : '';
    const statusText = isLocked ? '🔒 Not Approved' : '✅ Approved';

    html += `<tr data-student-id="${s.id}" data-locked="${isLocked}" data-student-name="${escapeHtml(s.name)}">
      <td>${escapeHtml(s.name)}</td>
      <td><input type="number" class="score-input ca-input" value="${ca}" min="0" max="${caMax}" data-max="${caMax}" ${dis}></td>
      <td><input type="number" class="score-input exam-input" value="${exam}" min="0" max="${examMax}" data-max="${examMax}" ${dis}></td>
      <td class="total-cell">${total}</td>
      <td class="status-cell">${statusText}</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  container.innerHTML = `<div class="table-responsive-wrapper">${html}</div>`;

  if (isScoreEntryAllowed) {
    document.querySelectorAll('.ca-input:not([disabled]), .exam-input:not([disabled])').forEach(input => {
      input.addEventListener('input', function () {
        const max = Number(this.dataset.max) || 0;
        if (this.value !== '') {
          let v = parseInt(this.value, 10);
          if (Number.isNaN(v)) v = 0;
          if (v < 0) v = 0;
          if (v > max) { v = max; this.value = String(max); }
        }
        const row = this.closest('tr');
        if (!row) return;
        const ca = parseInt(row.querySelector('.ca-input').value) || 0;
        const exam = parseInt(row.querySelector('.exam-input').value) || 0;
        const total = row.querySelector('.total-cell');
        if (total) total.textContent = ca + exam;
      });
      input.addEventListener('change', function () {
        const max = Number(this.dataset.max) || 0;
        let v = parseInt(this.value, 10);
        if (Number.isNaN(v)) v = 0;
        if (v < 0) v = 0;
        if (v > max) { v = max; this.value = String(max); }
      });
    });
  }
}

// ------------------- Save scores -------------------
async function saveScores() {
  const active = await checkSubscription();
  if (!active) {
    toast.error(subscriptionIssue || 'Saving is currently unavailable. Please contact your school administrator.');
    return;
  }

  if (!selectedClassId || !selectedSubjectId) {
    toast.error('Please select a class and subject first.');
    return;
  }
  if (teacherSubjectIds.length > 0 && !teacherSubjectIds.includes(selectedSubjectId)) {
    toast.error('You are not assigned to this subject. Please contact your school administrator.');
    return;
  }
  if (teacherClassIds.length > 0 && !teacherClassIds.includes(selectedClassId)) {
    toast.error('You are not assigned to this class. Please contact your school administrator.');
    return;
  }

  const rows = document.querySelectorAll('#scoresTableContainer tbody tr');
  if (!rows.length) {
    toast.error('No students found in this class. Please refresh the page.');
    return;
  }

  const caMax = Number(currentGrading.ca) || 0;
  const examMax = Number(currentGrading.exam) || 0;

  const unlocked = [];
  const lockedNames = [];

  for (const row of rows) {
    const studentId = row.dataset.studentId;
    const studentName = row.dataset.studentName || 'Student';
    const isLocked = row.dataset.locked === 'true';
    const caInput = row.querySelector('.ca-input');
    const examInput = row.querySelector('.exam-input');
    if (!caInput || !examInput) continue;

    const ca = parseInt(caInput.value) || 0;
    const exam = parseInt(examInput.value) || 0;

    if (ca > caMax || exam > examMax) {
      toast.error(`${studentName}'s score is above the maximum allowed. Please correct it before saving.`);
      return;
    }
    if (isLocked) { lockedNames.push(studentName); continue; }
    unlocked.push({ studentId, studentName, subjectId: selectedSubjectId, ca, exam });
  }

  if (lockedNames.length) {
    toast.warning('Some students haven\'t been approved yet — their scores were skipped.');
  }
  if (unlocked.length === 0) {
    toast.info('No students have been approved yet, so nothing was saved.');
    return;
  }

  showLoader();
  try {
    const { succeeded, failed } = await saveAllScores(unlocked);

    // Send notifications only for students whose score actually saved
    if (succeeded.length > 0) {
      try {
        const subjectName = subjectsMap.get(selectedSubjectId) || '';
        await createBulkNotifications(succeeded.map(s => ({
          studentId: s.studentId,
          schoolId: currentSchoolId,
          title: 'New Score Uploaded',
          message: `Your ${subjectName} score has been uploaded.`,
          type: 'score',
          relatedId: null
        })));
      } catch (notifErr) {
        console.error('Notification send skipped:', notifErr);
      }
    }

    if (failed.length === 0) {
      toast.success(`Scores saved for ${succeeded.length} student(s).`);
      await renderScoreTable();
      return;
    }

    if (succeeded.length === 0) {
      // All failed — diagnose and give a friendly reason.
      await diagnoseSaveFailure(unlocked);
      await renderScoreTable();
      return;
    }

    // Some succeeded, some failed — show which.
    const names = failed.map(f => f.student.studentName).join(', ');
    toast.warning(`Saved ${succeeded.length} student(s). Couldn't save: ${names}. Please contact your school administrator.`);
    await renderScoreTable();
  } catch (err) {
    console.error('Score save failed:', err);
    if (err.message === 'subscription_inactive') {
      toast.error(subscriptionIssue || 'Saving is currently unavailable. Please contact your school administrator.');
    } else {
      toast.error('We couldn\'t save the scores. Please try again in a moment.');
    }
  } finally {
    hideLoader();
  }
}

// ------------------- Friendly failure diagnostic -------------------
// Runs direct reads to figure out the real cause. Never prints backend
// terms — only plain, friendly messages.
async function diagnoseSaveFailure(unlockedScores) {
  // 1. Re-check the school's access.
  const stillOk = await checkSubscription();
  if (!stillOk) {
    toast.error(subscriptionIssue || 'Saving is currently unavailable. Please contact your school administrator.');
    return;
  }

  // 2. Check every student's approval flag.
  const notApproved = [];
  for (const score of unlockedScores) {
    try {
      const sSnap = await getDoc(doc(db, 'students', score.studentId));
      if (!sSnap.exists()) {
        notApproved.push(score.studentName);
      } else {
        const v = sSnap.data().locked;
        if (v !== false) notApproved.push(score.studentName);
      }
    } catch (_) {
      notApproved.push(score.studentName);
    }
  }
  if (notApproved.length > 0) {
    toast.error(`Some students haven't been approved yet: ${notApproved.join(', ')}. Please ask your school administrator to approve them.`);
    return;
  }

  // 3. Check the teacher's stored assignments.
  try {
    const uid = auth.currentUser?.uid;
    if (uid) {
      const uSnap = await getDoc(doc(db, 'users', uid));
      const uData = uSnap.exists() ? uSnap.data() : null;
      const uSubs = Array.isArray(uData?.subjectIds) ? uData.subjectIds : [];
      const uCls = Array.isArray(uData?.classIds) ? uData.classIds : [];
      const subjOk = uSubs.length === 0 || uSubs.includes(selectedSubjectId);
      const clsOk  = uCls.length === 0  || uCls.includes(selectedClassId);
      if (!subjOk || !clsOk) {
        toast.error('Your teaching assignments don\'t match this subject or class. Please contact your school administrator.');
        return;
      }
    }
  } catch (_) { /* ignore */ }

  // 4. Everything looks fine from the client — hand off.
  toast.error('We couldn\'t save the scores. Please contact your school administrator so they can check your account.');
}

// ------------------- Page init -------------------
async function initScoresPage() {
  const user = auth.currentUser;
  if (!user) {
    toast.error('Please log in again to continue.');
    return;
  }
  teacherId = user.uid;

  teacherData = getTeacherData();
  if (!teacherData) {
    toast.error('We couldn\'t load your profile. Please contact your school administrator.');
    return;
  }
  currentSchoolId = teacherData.schoolId;

  // Ensure currentSchoolId matches what the security check will read
  // from the profile doc — otherwise the write would always fail.
  try {
    const uSnap = await getDoc(doc(db, 'users', teacherId));
    if (uSnap.exists()) {
      const uSchoolId = uSnap.data().schoolId;
      if (uSchoolId && uSchoolId !== currentSchoolId) {
        console.warn('School ID mismatch resolved from profile.');
        currentSchoolId = uSchoolId;
      }
    }
  } catch (_) { /* ignore */ }

  if (!currentSchoolId) {
    toast.error('Your school information is missing. Please log out and log in again.');
    return;
  }

  await initAcademicCalendar();
  await checkSubscription();

  await Promise.all([loadAllSubjects(), loadAllClasses()]);
  await loadTeacherAssignedSubjectsAndClasses();

  populateSubjectDropdown();
  populateClassDropdown();

  const currentSession = getCurrentSession();
  const currentTermName = getCurrentTerm();
  const termMap = { 'First Term': '1', 'Second Term': '2', 'Third Term': '3' };
  const defaultTermNum = termMap[currentTermName] || '1';

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
  selectedTerm = defaultTermNum;

  if (selectedClassId) {
    await loadGradingSettingByClassLevel(selectedClassId, selectedSession, selectedTerm);
  } else {
    await loadGradingSetting(selectedSession, selectedTerm);
  }
  renderScoreTable();
  updateSubscriptionUI();
}

export { initScoresPage };
