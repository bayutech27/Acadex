// teacher-cbt.js — Acadex Teacher CBT Manager (session/term filter for scores)
// All Firestore operations go through service.js where possible.
// TODO: service.js does not yet support teacher class list retrieval, test_results queries,
// manual start/end test status updates, notification creation – those remain as direct Firestore calls.
// All user-facing errors now show clear, friendly messages without technical jargon.
// NEW: Added subscription check. If school subscription is expired, all CBT buttons are disabled
//      and a notification is shown at the top of the page.
// NEW: The "Student Name" column in the CBT Scores table now shows the real student name
//      pulled from the `students` collection's `name` field (via the student's UID),
//      instead of the auth-account-derived userName stored on each test_results document.
//
// ============================================================================
// RESTART FIX (this revision):
//   Previously, when a teacher clicked "Start" on an already-expired CBT, every
//   student who had submitted the *previous* run was still blocked because the
//   per-student `cbt_submissions/{cbtId}_{studentId}` markers persisted forever.
//   Because a "Start" action begins a NEW logical run of the test, those old
//   markers are now cleared at the moment Start is pressed. Only the manual
//   Start path clears markers — natural expiry and early End leave them intact.
//   The fix is contained in `startTest()` + new `clearSubmissionMarkers()`;
//   no changes are required in test.js or cbt.js. See inline comments.
// ============================================================================

import * as service from './service.js';
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";
import {
  collection, addDoc, getDocs, query, where, doc, updateDoc, deleteDoc,
  getDoc, orderBy, serverTimestamp, onSnapshot, setDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";
import { db } from './firebase-config.js';
import { getSchoolById } from './app.js';
import { initAcademicCalendar, getCurrentTerm, getCurrentSession } from './academic-calendar.js';
import { showNotification, handleError, showLoader, hideLoader, toast } from './error-handler.js';
import { createBulkNotifications } from './notification-service.js';

// ==============================
// STATE
// ==============================
let teacherClasses  = [];
let subjectsList    = [];
let tests           = [];
let currentQuestions = [];
let csvImportedQuestions = [];
let currentQuestionIndex = 0;
let editingTestId   = null;
let unsubscribeTests = null;
let expirationTimers = {};
let currentTeacherId = null;
let currentSchoolId = null;
let teacherData = null;

// NEW: Whether CBT features are allowed (school subscription active)
let cbtAccessEnabled = false;

// ==============================
// DOM REFERENCES (existing CBT)
// ==============================
const testsTableWrapper = document.getElementById('testsTableWrapper');
const createTestBtn    = document.getElementById('createTestBtn');
const testModal        = document.getElementById('testModal');
const modalTitle       = document.getElementById('modalTitle');
const testForm         = document.getElementById('testForm');
const testType         = document.getElementById('testType');
const testSubjectSel   = document.getElementById('testSubject');
const testClassSel     = document.getElementById('testClass');
const testDuration     = document.getElementById('testDuration');
const testDate         = document.getElementById('testDate');
const questionCountEl  = document.getElementById('questionCount');
const questionsSection = document.getElementById('questionsSection');
const questionProgress = document.getElementById('questionProgress');
const questionEditor   = document.getElementById('questionEditor');
const prevQuestionBtn  = document.getElementById('prevQuestionBtn');
const nextQuestionBtn  = document.getElementById('nextQuestionBtn');
const cancelModalBtn   = document.getElementById('cancelModalBtn');
const csvUploadInput   = document.getElementById('csvUploadInput');
const csvTemplateBtn   = document.getElementById('csvTemplateBtn');
const csvStatusMsg     = document.getElementById('csvStatusMsg');
const pendingQuestionsCount = document.getElementById('pendingQuestionsCount');

// ==============================
// NEW: DOM references for Scores Section (session/term selects)
// ==============================
const scoresClassSelect   = document.getElementById('scoresClassSelect');
const scoresSubjectSelect = document.getElementById('scoresSubjectSelect');
const scoresSessionSelect = document.getElementById('scoresSessionSelect');
const scoresTermSelect    = document.getElementById('scoresTermSelect');
const getScoresBtn        = document.getElementById('getScoresBtn');
const scoresResultsContainer = document.getElementById('scoresResultsContainer');

// ==============================
// UTILITIES (unchanged)
// ==============================
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function formatDateOnly(isoOrDate) {
  if (!isoOrDate) return '—';
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-NG', { year:'numeric', month:'short', day:'numeric' });
}

function getStatusBadge(status) {
  const map = {
    pending : '<span class="status-badge status-pending">Pending</span>',
    started : '<span class="status-badge status-started">Started</span>',
    expired : '<span class="status-badge status-expired">Expired</span>',
  };
  return map[status] || `<span class="status-badge">${escapeHtml(status)}</span>`;
}

// ==============================
// IMAGE COMPRESSION (unchanged)
// ==============================
async function compressImage(file, maxSizeKB = 800, targetQuality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Not an image file'));
      return;
    }
    if (file.size <= maxSizeKB * 1024) {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        const maxDimension = 1200;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = (height * maxDimension) / width;
            width = maxDimension;
          } else {
            width = (width * maxDimension) / height;
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        let quality = targetQuality;
        let result = canvas.toDataURL('image/jpeg', quality);
        while (result.length > maxSizeKB * 1024 && quality > 0.2) {
          quality -= 0.1;
          result = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(result);
      };
      img.onerror = () => reject(new Error('Image loading failed'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('File reading failed'));
    reader.readAsDataURL(file);
  });
}

// ==============================
// LOAD TEACHER CLASSES & SUBJECTS (using service)
// ==============================
async function loadTeacherClasses() {
  if (!currentTeacherId || !currentSchoolId) return [];
  try {
    const teacher = await service.getTeacherById(currentTeacherId);
    if (!teacher) return [];
    const classIds = teacher.classIds || (teacher.hostClassId ? [teacher.hostClassId] : []);
    const classes = [];
    for (const id of classIds) {
      try {
        const classData = await service.getClassById(id);
        if (classData) classes.push({ id, name: classData.name || id });
      } catch (e) { console.warn('Class load error:', e); }
    }
    return classes;
  } catch (err) {
    console.error('Error loading teacher classes:', err);
    toast.error('Unable to load your classes. Please refresh the page.');
    return [];
  }
}

async function loadSubjects() {
  if (!currentSchoolId) return [];
  try {
    return await service.getSubjectsBySchool(currentSchoolId);
  } catch (e) {
    console.warn('Subjects load error:', e);
    toast.error('Unable to load subjects. Please refresh the page.');
    return [];
  }
}

// ==============================
// NEW: Check school subscription status and update UI
// ==============================
async function checkSubscriptionStatus() {
  if (!currentSchoolId) return;
  const subRef = doc(db, 'schools', currentSchoolId, 'subscription', 'current');
  const subSnap = await getDoc(subRef);
  let status = 'expired';
  if (subSnap.exists()) {
    status = subSnap.data().status || 'expired';
  }
  cbtAccessEnabled = status === 'active';
  applySubscriptionUI();
}

function applySubscriptionUI() {
  const noticeEl = document.getElementById('subscriptionNotice');
  const contentEl = document.querySelector('.cbt-page-content');

  if (!cbtAccessEnabled) {
    if (noticeEl) {
      noticeEl.style.display = 'block';
      noticeEl.innerHTML = '<strong>⚠️ Your school does not currently have an active subscription.</strong> The CBT system is unavailable. Please contact your administrator to renew.';
      noticeEl.style.cssText = 'background:#fee2e2;color:#991b1b;padding:12px 20px;margin-bottom:16px;border-radius:8px;font-weight:600;';
    }
  } else {
    if (noticeEl) noticeEl.style.display = 'none';
  }

  // Disable/enable all buttons inside the main CBT page content.
  if (contentEl) {
    contentEl.querySelectorAll('button').forEach(btn => {
      btn.disabled = !cbtAccessEnabled;
    });
  }

  // Also ensure modal buttons are handled if modal is open later.
  if (createTestBtn) createTestBtn.disabled = !cbtAccessEnabled;
  if (getScoresBtn) getScoresBtn.disabled = !cbtAccessEnabled;
}

// ==============================
// REAL-TIME TEST LISTENER (using service.subscribeToTeacherCbt)
// ==============================
function subscribeToTests() {
  if (!currentTeacherId || !currentSchoolId) {
    console.error('subscribeToTests called without teacherId/schoolId');
    if (testsTableWrapper) testsTableWrapper.innerHTML = '<p class="no-data-msg">Missing teacher or school information. Please refresh.</p>';
    return;
  }
  if (unsubscribeTests) unsubscribeTests();

  unsubscribeTests = service.subscribeToTeacherCbt(currentTeacherId, currentSchoolId, (testsList) => {
    tests = testsList;
    // NEW: rebuild the Session/Term filters now that the teacher's tests are loaded.
    cbtScoresModule.refreshSessionTerm();
    checkAndExpireTests(tests);
    renderTestsTable(tests);
    // After rendering dynamic buttons, re-apply UI state.
    applySubscriptionUI();
  });
}

// ==============================
// RENDER TESTS TABLE (unchanged)
// ==============================
function renderTestsTable(testList) {
  if (!testsTableWrapper) return;
  if (!testList || testList.length === 0) {
    testsTableWrapper.innerHTML = '<p class="no-data-msg">No tests yet. Click <strong>Create New Test</strong> to get started.</p>';
    return;
  }

  const rows = testList.map(t => `
    <tr data-id="${t.id}">
      <td data-label="Type">${escapeHtml(t.type || '—')}</td>
      <td data-label="Subject">${escapeHtml(t.subjectName || t.subjectId || '—')}</td>
      <td data-label="Class">${escapeHtml(t.className || t.classId || '—')}</td>
      <td data-label="Questions">${Array.isArray(t.questions) ? t.questions.length : 0}</td>
      <td data-label="Duration">${escapeHtml(String(t.durationMinutes || '—'))} min</td>
      <td data-label="Scheduled">${formatDateOnly(t.scheduledDate)}</td>
      <td data-label="Term/Session">${escapeHtml(t.term || '—')} / ${escapeHtml(t.session || '—')}</td>
      <td data-label="Status" class="status-cell">${getStatusBadge(t.status)}</td>
      <td data-label="Actions" class="actions-cell">
        <button class="tbl-btn btn-edit"   data-id="${t.id}" title="Edit">✏️ Edit</button>
        ${t.status !== 'started'
          ? `<button class="tbl-btn btn-start"  data-id="${t.id}" title="Start Test">▶️ Start</button>`
          : `<button class="tbl-btn btn-expire" data-id="${t.id}" title="End Test">⏹ End</button>`}
        <button class="tbl-btn btn-delete" data-id="${t.id}" title="Delete">🗑️ Delete</button>
        </td>
      </tr>
  `).join('');

  testsTableWrapper.innerHTML = `
    <div class="table-scroll-wrapper">
      <table class="cbt-table" id="cbtTable">
        <thead>
          <tr><th>Type</th><th>Subject</th><th>Class</th><th>Questions</th>
            <th>Duration</th><th>Scheduled Date</th><th>Term / Session</th>
            <th>Status</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  testsTableWrapper.querySelectorAll('.btn-edit').forEach(btn =>
    btn.addEventListener('click', () => openEditModal(btn.dataset.id)));
  testsTableWrapper.querySelectorAll('.btn-start').forEach(btn =>
    btn.addEventListener('click', () => startTest(btn.dataset.id)));
  testsTableWrapper.querySelectorAll('.btn-expire').forEach(btn =>
    btn.addEventListener('click', () => endTest(btn.dataset.id)));
  testsTableWrapper.querySelectorAll('.btn-delete').forEach(btn =>
    btn.addEventListener('click', () => confirmDeleteTest(btn.dataset.id)));
}

// ==============================
// EXPIRATION & ACTIONS
// ==============================
function checkAndExpireTests(testList) {
  testList.forEach(t => {
    if (t.status === 'started' && t.startedAt) {
      const startSec = t.startedAt.seconds || (t.startedAt.toDate ? t.startedAt.toDate().getTime()/1000 : 0);
      const endSec   = startSec + (t.durationMinutes || 60) * 60;
      const nowSec   = Date.now() / 1000;
      if (nowSec >= endSec) {
        expireTest(t.id);
      } else {
        scheduleExpiration(t.id, (endSec - nowSec) * 1000);
      }
    }
  });
}

function scheduleExpiration(testId, msUntilExpiry) {
  if (expirationTimers[testId]) return;
  expirationTimers[testId] = setTimeout(() => {
    expireTest(testId);
    delete expirationTimers[testId];
  }, msUntilExpiry);
}

async function expireTest(testId) {
  // NOTE: Natural expiry intentionally does NOT clear submission markers.
  // Students who took this run stay blocked. Only a manual "Start" begins a
  // new run and clears markers (see startTest / clearSubmissionMarkers).
  try {
    await updateDoc(doc(db, 'cbt', testId), { status: 'expired', expiredAt: serverTimestamp() });
  } catch (e) { console.warn('Expire error:', e); }
}

async function endTest(testId) {
  if (!cbtAccessEnabled) return;
  if (!confirm('End this test early? Students will no longer be able to take it.')) return;
  // NOTE: Early End also leaves markers intact (same rationale as expireTest).
  try {
    await updateDoc(doc(db, 'cbt', testId), { status: 'expired', expiredAt: serverTimestamp() });
    toast.success('Test ended successfully.');
  } catch (e) {
    console.error('End test error:', e);
    toast.error('Failed to end test. Please try again.');
  }
}

// ============================================================
// RESTART FIX — Start clears stale submission markers
// ============================================================
// Deletes every `cbt_submissions` record for the given test. Called only
// from startTest(), because a "Start" action begins a NEW run of the test
// and any markers from a previous run are stale.
//
// Design notes:
//  - Non-throwing on purpose: callers decide how to handle failures.
//  - Equality filters on cbtId + schoolId keep the query cheap and
//    safely scoped; a composite index on (cbtId, schoolId) may be needed
//    the first time this runs (Firestore will prompt).
//  - Batches are chunked at 400 to remain safely under Firestore's
//    500-operation-per-batch limit.
//  - Returns the number of markers deleted (0 on error).
async function clearSubmissionMarkers(testId) {
  if (!testId || !currentSchoolId) return 0;
  try {
    const q = query(
      collection(db, 'cbt_submissions'),
      where('cbtId', '==', testId),
      where('schoolId', '==', currentSchoolId)
    );
    const snap = await getDocs(q);
    if (snap.empty) return 0;

    const refs = snap.docs.map(d => d.ref);
    for (let i = 0; i < refs.length; i += 400) {
      const batch = writeBatch(db);
      refs.slice(i, i + 400).forEach(ref => batch.delete(ref));
      await batch.commit();
    }
    console.log(`[startTest] Cleared ${refs.length} stale submission marker(s) for test ${testId}.`);
    return refs.length;
  } catch (err) {
    console.warn('[startTest] Submission-marker cleanup failed (non-fatal):', err);
    return 0;
  }
}

async function startTest(testId) {
  if (!cbtAccessEnabled) return;
  if (!confirm('Activate this test? Students will be able to take it immediately.')) return;
  try {
    showLoader();

    // ── RESTART FIX ─────────────────────────────────────────────────────
    // A Start click begins a new run of the test. Any per-student marker
    // left behind by a previous run would permanently block those students
    // from retaking — so clear them BEFORE the run goes live.
    // Cleanup failure is non-fatal; the test still restarts.
    const markersCleared = await clearSubmissionMarkers(testId);

    await updateDoc(doc(db, 'cbt', testId), { status: 'started', startedAt: serverTimestamp() });

    toast.success(markersCleared > 0
      ? `Test activated! ${markersCleared} previous submission${markersCleared === 1 ? '' : 's'} cleared — students may retake.`
      : 'Test activated! Students can now take it.');
  } catch (e) {
    console.error('Start test error:', e);
    toast.error('Failed to start test. Please try again.');
  }
  finally { hideLoader(); }
}

async function confirmDeleteTest(testId) {
  if (!cbtAccessEnabled) return;
  if (!confirm('Permanently delete this test? This cannot be undone.')) return;
  try {
    showLoader();
    await service.deleteCbt(testId);
    if (expirationTimers[testId]) { clearTimeout(expirationTimers[testId]); delete expirationTimers[testId]; }
    toast.success('Test deleted successfully.');
  } catch (e) {
    console.error('Delete test error:', e);
    toast.error('Failed to delete test. Please try again.');
  }
  finally { hideLoader(); }
}

// ==============================
// MODAL: CREATE / EDIT (using service for create/update)
// ==============================
async function openCreateModal() {
  if (!cbtAccessEnabled) return;
  if (!currentTeacherId || !currentSchoolId) {
    toast.error('Teacher data not loaded. Please refresh the page.');
    return;
  }
  resetModalState();
  modalTitle.textContent = 'Create New CBT Test';
  teacherClasses = await loadTeacherClasses();
  subjectsList   = await loadSubjects();
  populateModalDropdowns();
  testModal.style.display = 'flex';
}

async function openEditModal(testId) {
  if (!cbtAccessEnabled) return;
  const test = tests.find(t => t.id === testId);
  if (!test) return;

  resetModalState();
  editingTestId = testId;
  modalTitle.textContent = 'Edit CBT Test';

  teacherClasses = await loadTeacherClasses();
  subjectsList   = await loadSubjects();
  populateModalDropdowns();

  testType.value     = test.type || 'Test';
  testDuration.value = test.durationMinutes || '';
  testDate.value     = test.scheduledDate || '';
  if (test.subjectId) testSubjectSel.value = test.subjectId;
  if (test.classId)   testClassSel.value   = test.classId;

  currentQuestions = (test.questions || []).map(q => ({ ...q }));
  questionCountEl.value = currentQuestions.length;
  if (currentQuestions.length > 0) {
    questionsSection.style.display = 'block';
    showQuestionEditor(0);
  }
  updatePendingCount();
  testModal.style.display = 'flex';
}

function populateModalDropdowns() {
  testClassSel.innerHTML   = '<option value="">Select class</option>' +
    teacherClasses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  testSubjectSel.innerHTML = '<option value="">Select subject</option>' +
    subjectsList.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
}

function resetModalState() {
  editingTestId = null;
  currentQuestions = [];
  csvImportedQuestions = [];
  currentQuestionIndex = 0;
  testForm.reset();
  questionsSection.style.display = 'none';
  if (csvStatusMsg) { csvStatusMsg.textContent = ''; csvStatusMsg.className = 'csv-status'; }
  updatePendingCount();
}

function closeModal() {
  testModal.style.display = 'none';
  resetModalState();
}

// ==============================
// QUESTION WIZARD (unchanged)
// ==============================
function showQuestionEditor(index) {
  const total = parseInt(questionCountEl.value, 10) || currentQuestions.length;
  const q = currentQuestions[index] || { questionText:'', options:{ A:'', B:'', C:'', D:'' }, correctAnswer:'A', solution:'', questionImage:null };

  questionProgress.textContent = `Question ${index + 1} of ${total}`;

  const imgPreview = q.questionImage
    ? `<div class="img-preview-wrap"><img src="${q.questionImage}" alt="Question image" class="img-preview"><button type="button" id="removeImageBtn" class="remove-img-btn">✕ Remove</button></div>`
    : '';

  questionEditor.innerHTML = `
    <div class="form-group">
      <label>Question Text *</label>
      <textarea id="qText" class="form-control" rows="3" placeholder="Enter question text...">${escapeHtml(q.questionText)}</textarea>
    </div>
    <div class="form-group">
      <label>Question Image (optional, max 800 KB)</label>
      <div class="image-upload-area" id="imageUploadArea">
        <label for="qImageFile" class="image-upload-label">
          <i class="fas fa-cloud-upload-alt"></i>
          <span id="imageUploadText">${q.questionImage ? '📷 Change image' : '📷 Click or drag to upload image'}</span>
        </label>
        <input type="file" id="qImageFile" accept="image/*" style="display:none">
        ${imgPreview}
      </div>
      <div id="imageError" class="error-message" style="display:none;"></div>
    </div>
    <div class="options-row">
      <div class="form-group"><label>A. Option A *</label><input type="text" id="qA" class="form-control" value="${escapeHtml(q.options?.A || '')}"></div>
      <div class="form-group"><label>B. Option B *</label><input type="text" id="qB" class="form-control" value="${escapeHtml(q.options?.B || '')}"></div>
      <div class="form-group"><label>C. Option C *</label><input type="text" id="qC" class="form-control" value="${escapeHtml(q.options?.C || '')}"></div>
      <div class="form-group"><label>D. Option D *</label><input type="text" id="qD" class="form-control" value="${escapeHtml(q.options?.D || '')}"></div>
    </div>
    <div class="form-group">
      <label>Correct Answer *</label>
      <select id="qCorrect" class="form-control">
        ${['A','B','C','D'].map(l => `<option value="${l}" ${q.correctAnswer===l?'selected':''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>Explanation / Solution (optional)</label>
      <textarea id="qExplanation" class="form-control" rows="2" placeholder="Provide explanation...">${escapeHtml(q.solution || '')}</textarea>
    </div>`;

  const qImageFile = document.getElementById('qImageFile');
  const imageUploadArea = document.getElementById('imageUploadArea');
  const imageError = document.getElementById('imageError');

  const processImage = async (file) => {
    imageError.style.display = 'none';
    if (!file.type.startsWith('image/')) {
      imageError.textContent = 'Only image files are allowed.';
      imageError.style.display = 'block';
      return;
    }
    try {
      const compressedBase64 = await compressImage(file, 800, 0.85);
      currentQuestions[index].questionImage = compressedBase64;
      const prev = imageUploadArea.querySelector('.img-preview-wrap');
      if (prev) prev.remove();
      imageUploadArea.insertAdjacentHTML('beforeend', `
        <div class="img-preview-wrap">
          <img src="${compressedBase64}" alt="Preview" class="img-preview">
          <button type="button" id="removeImageBtn" class="remove-img-btn">✕ Remove</button>
        </div>`);
      document.getElementById('imageUploadText').textContent = '📷 Change image';
      const newRemoveBtn = document.getElementById('removeImageBtn');
      if (newRemoveBtn) {
        newRemoveBtn.addEventListener('click', () => {
          currentQuestions[index].questionImage = null;
          document.getElementById('imageUploadText').textContent = '📷 Click or drag to upload image';
          newRemoveBtn.closest('.img-preview-wrap').remove();
        });
      }
    } catch (err) {
      console.error(err);
      imageError.textContent = 'Failed to process image. Please try again.';
      imageError.style.display = 'block';
    }
  };

  qImageFile.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (file) await processImage(file);
  });
  imageUploadArea.addEventListener('dragover', e => { e.preventDefault(); imageUploadArea.classList.add('drag-over'); });
  imageUploadArea.addEventListener('dragleave', () => imageUploadArea.classList.remove('drag-over'));
  imageUploadArea.addEventListener('drop', async e => {
    e.preventDefault();
    imageUploadArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) await processImage(file);
  });

  const removeBtn = document.getElementById('removeImageBtn');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      currentQuestions[index].questionImage = null;
      document.getElementById('imageUploadText').textContent = '📷 Click or drag to upload image';
      const wrap = imageUploadArea.querySelector('.img-preview-wrap');
      if (wrap) wrap.remove();
    });
  }

  prevQuestionBtn.disabled = (index === 0);
  nextQuestionBtn.textContent = (index >= parseInt(questionCountEl.value, 10) - 1) ? 'Finish' : 'Next →';
}

function saveCurrentQuestion() {
  const qText = document.getElementById('qText')?.value.trim();
  const optA  = document.getElementById('qA')?.value.trim();
  const optB  = document.getElementById('qB')?.value.trim();
  const optC  = document.getElementById('qC')?.value.trim();
  const optD  = document.getElementById('qD')?.value.trim();
  const correct = document.getElementById('qCorrect')?.value;
  const explanation = document.getElementById('qExplanation')?.value || '';

  if (!qText && !currentQuestions[currentQuestionIndex]?.questionImage) {
    toast.error('Question text or image is required.');
    return false;
  }
  if (!optA || !optB || !optC || !optD) {
    toast.error('All four options (A–D) are required.');
    return false;
  }
  if (!['A','B','C','D'].includes(correct)) {
    toast.error('Please select a valid correct answer.');
    return false;
  }

  currentQuestions[currentQuestionIndex] = {
    ...currentQuestions[currentQuestionIndex],
    questionText:  qText,
    options:       { A: optA, B: optB, C: optC, D: optD },
    correctAnswer: correct,
    solution:      explanation,
    questionImage: currentQuestions[currentQuestionIndex]?.questionImage || null,
  };
  return true;
}

function updatePendingCount() {
  if (!pendingQuestionsCount) return;
  const filled = currentQuestions.filter(q => q && (q.questionText || q.questionImage)).length;
  pendingQuestionsCount.textContent = `${filled} / ${currentQuestions.length} questions entered`;
}

// ==============================
// CSV BULK IMPORT (unchanged)
// ==============================
function downloadCSVTemplate() {
  const header = 'questionText,optionA,optionB,optionC,optionD,correctAnswer,explanation';
  const sample = '"What is 2+2?","3","4","5","6","B","2+2=4 is basic arithmetic"';
  const blob = new Blob([header + '\n' + sample], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'cbt_questions_template.csv';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function parseCSVRow(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCSV(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV file is empty or has no data rows.');
  const header = parseCSVRow(lines[0]).map(h => h.trim().toLowerCase());
  const required = ['questiontext','optiona','optionb','optionc','optiond','correctanswer'];
  for (const col of required) if (!header.includes(col)) throw new Error(`Missing required column: "${col}".`);
  const idx = col => header.indexOf(col);
  const questions = [], errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVRow(lines[i]);
    if (cells.length === 0 || cells.every(c => !c)) continue;
    const row = {
      questionText:  (cells[idx('questiontext')] || '').trim(),
      optionA:       (cells[idx('optiona')]       || '').trim(),
      optionB:       (cells[idx('optionb')]       || '').trim(),
      optionC:       (cells[idx('optionc')]       || '').trim(),
      optionD:       (cells[idx('optiond')]       || '').trim(),
      correctAnswer: (cells[idx('correctanswer')] || '').trim().toUpperCase(),
      explanation:   idx('explanation') >= 0 ? (cells[idx('explanation')] || '').trim() : '',
    };
    if (!row.questionText) { errors.push(`Row ${i+1}: questionText empty`); continue; }
    if (!row.optionA || !row.optionB || !row.optionC || !row.optionD) { errors.push(`Row ${i+1}: all options required`); continue; }
    if (!['A','B','C','D'].includes(row.correctAnswer)) { errors.push(`Row ${i+1}: correctAnswer must be A,B,C,D`); continue; }
    questions.push({
      questionText: row.questionText,
      options: { A: row.optionA, B: row.optionB, C: row.optionC, D: row.optionD },
      correctAnswer: row.correctAnswer,
      solution: row.explanation,
      questionImage: null,
    });
  }
  if (errors.length) console.warn('CSV parse warnings:', errors);
  return { questions, errors };
}

function handleCSVUpload(file) {
  if (!file || !file.name.toLowerCase().endsWith('.csv')) {
    setCsvStatus('Only .csv files are supported.', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const { questions, errors } = parseCSV(e.target.result);
      if (questions.length === 0) { setCsvStatus('No valid questions found.', 'error'); return; }
      csvImportedQuestions = questions;
      const existingCount = parseInt(questionCountEl.value, 10) || 0;
      const totalNeeded = Math.max(existingCount, questions.length);
      questionCountEl.value = totalNeeded;
      while (currentQuestions.length < totalNeeded) currentQuestions.push({ questionText:'', options:{A:'',B:'',C:'',D:''}, correctAnswer:'A', solution:'', questionImage:null });
      questions.forEach((q, i) => { if (!currentQuestions[i]?.questionText) currentQuestions[i] = { ...q }; });
      questionsSection.style.display = 'block';
      showQuestionEditor(0);
      updatePendingCount();
      let msg = `✅ ${questions.length} question(s) imported from CSV.`;
      if (errors.length) msg += ` ⚠️ ${errors.length} row(s) skipped.`;
      setCsvStatus(msg, errors.length ? 'warning' : 'success');
    } catch (err) { setCsvStatus(`❌ CSV Error: ${err.message}`, 'error'); }
  };
  reader.onerror = () => setCsvStatus('❌ Failed to read CSV file.', 'error');
  reader.readAsText(file);
}

function setCsvStatus(msg, type = 'success') {
  if (csvStatusMsg) { csvStatusMsg.textContent = msg; csvStatusMsg.className = `csv-status csv-${type}`; }
}

// ==============================
// SAVE TEST TO FIRESTORE (using service.createCbt / service.updateCbt)
// ==============================
async function saveTestToFirestore() {
  if (!cbtAccessEnabled) return;

  const type        = testType.value;
  const subjectId   = testSubjectSel.value;
  const classId     = testClassSel.value;
  const duration    = parseInt(testDuration.value, 10);
  const scheduledDate = testDate.value;

  if (!type || !subjectId || !classId || isNaN(duration) || !scheduledDate) {
    toast.error('Please fill in all required fields.');
    return;
  }

  const totalQ = parseInt(questionCountEl.value, 10);
  if (!totalQ || totalQ < 1) {
    toast.error('Please set the number of questions.');
    return;
  }
  if (questionsSection.style.display !== 'none' && !saveCurrentQuestion()) return;

  const incomplete = currentQuestions.filter(q => !q || (!q.questionText && !q.questionImage));
  if (incomplete.length > 0) {
    toast.error(`${incomplete.length} question(s) are empty. Please complete all questions.`);
    return;
  }

  const className = teacherClasses.find(c => c.id === classId)?.name || classId;
  const subjectName = subjectsList.find(s => s.id === subjectId)?.name || subjectId;
  const term = getCurrentTerm();
  const session = getCurrentSession();

  const testData = {
    type,
    subjectId,
    subjectName,
    classId,
    className,
    durationMinutes: duration,
    scheduledDate,
    questions: currentQuestions,
    teacherId: currentTeacherId,
    schoolId: currentSchoolId,
    assignedTo: [classId],
    term,
    session,
    updatedAt: new Date(),
  };

  if (!editingTestId) {
    testData.status = 'pending';
    testData.createdAt = new Date();
  }

  showLoader();
  try {
    let newTestId = editingTestId;
    if (editingTestId) {
      await service.updateCbt(editingTestId, testData);
      toast.success('Test updated successfully.');
    } else {
      newTestId = await service.createCbt(testData);
      toast.success('Test created successfully.');
    }

    try {
      const studentsQuery = query(
        collection(db, 'students'),
        where('schoolId', '==', currentSchoolId),
        where('classId', '==', testData.classId)
      );
      const studentsSnap = await getDocs(studentsQuery);
      if (!studentsSnap.empty) {
        const studentIds = studentsSnap.docs.map(d => d.id);
        const notifications = studentIds.map(sid => ({
          studentId: sid,
          schoolId: currentSchoolId,
          title: 'New CBT Assigned',
          message: `${testData.subjectName} ${testData.type} has been assigned to your class.`,
          type: 'cbt',
          relatedId: editingTestId || newTestId
        }));
        await createBulkNotifications(notifications);
      }
    } catch (notifErr) {
      console.error('Failed to create notifications:', notifErr);
    }

    closeModal();
  } catch (err) {
    console.error('Save test error:', err);
    toast.error('Failed to save test. Please try again.');
  } finally {
    hideLoader();
  }
}

// ==============================
// EVENT LISTENERS (existing CBT + logout + hamburger toggle)
// ==============================
function attachEventListeners() {
  createTestBtn.addEventListener('click', openCreateModal);
  cancelModalBtn.addEventListener('click', closeModal);
  window.addEventListener('click', e => { if (e.target === testModal) closeModal(); });
  if (csvUploadInput) csvUploadInput.addEventListener('change', e => { if (e.target.files[0]) handleCSVUpload(e.target.files[0]); e.target.value = ''; });
  if (csvTemplateBtn) csvTemplateBtn.addEventListener('click', downloadCSVTemplate);
  testForm.addEventListener('submit', async e => { e.preventDefault(); await saveTestToFirestore(); });
  questionCountEl.addEventListener('change', () => {
    const total = parseInt(questionCountEl.value, 10);
    if (isNaN(total) || total < 1) { questionsSection.style.display = 'none'; return; }
    const blank = () => ({ questionText:'', options:{ A:'', B:'', C:'', D:'' }, correctAnswer:'A', solution:'', questionImage:null });
    while (currentQuestions.length < total) currentQuestions.push(blank());
    currentQuestions = currentQuestions.slice(0, total);
    csvImportedQuestions.forEach((cq, i) => { if (i < total && !currentQuestions[i].questionText) currentQuestions[i] = { ...cq }; });
    currentQuestionIndex = 0;
    questionsSection.style.display = 'block';
    showQuestionEditor(0);
    updatePendingCount();
  });
  prevQuestionBtn.addEventListener('click', () => {
    if (saveCurrentQuestion() && currentQuestionIndex > 0) { currentQuestionIndex--; showQuestionEditor(currentQuestionIndex); }
  });
  nextQuestionBtn.addEventListener('click', () => {
    if (!saveCurrentQuestion()) return;
    const total = parseInt(questionCountEl.value, 10);
    if (currentQuestionIndex + 1 < total) { currentQuestionIndex++; showQuestionEditor(currentQuestionIndex); }
    else { updatePendingCount(); toast.success('All questions recorded. You can now save the test.'); }
  });

  async function handleLogout() {
    try {
      const auth = getAuth();
      await signOut(auth);
    } catch (err) {
      console.error('Logout error:', err);
      toast.error('Logout failed. Please try again.');
    } finally {
      window.location.href = '/index.html';
    }
  }
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
  const mobileLogoutBtn = document.querySelector('.mobile-logout-btn');
  if (mobileLogoutBtn) mobileLogoutBtn.addEventListener('click', handleLogout);

  const hamburger = document.querySelector('.hamburger-menu');
  const mobileSidebar = document.getElementById('mobileSidebar');
  const overlay = document.getElementById('overlay');
  const closeBtn = document.querySelector('.close-sidebar');

  if (hamburger && mobileSidebar && overlay) {
    function openMenu() {
      mobileSidebar.classList.add('open');
      overlay.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
    function closeMenu() {
      mobileSidebar.classList.remove('open');
      overlay.classList.remove('active');
      document.body.style.overflow = '';
    }
    hamburger.addEventListener('click', openMenu);
    if (closeBtn) closeBtn.addEventListener('click', closeMenu);
    overlay.addEventListener('click', closeMenu);
  } else {
    console.warn('Hamburger elements missing – check .hamburger-menu, #mobileSidebar, #overlay');
  }
}

// ==============================
// HEADER & ACADEMIC INFO (using service.getSchoolById)
// ==============================
async function loadSchoolInfo() {
  if (!currentSchoolId) return;
  try {
    const school = await service.getSchoolById(currentSchoolId);
    const schoolNameEl    = document.getElementById('schoolName');
    const schoolAddressEl = document.getElementById('schoolAddress');
    if (schoolNameEl)    schoolNameEl.textContent    = school ? school.name : 'Unknown School';
    if (schoolAddressEl && school) schoolAddressEl.textContent = school.address || 'No address provided';

    const logoImg = document.getElementById('schoolLogoImg');
    if (logoImg && school?.logo) {
      logoImg.src = school.logo;
    } else if (logoImg) {
      logoImg.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 24 24" fill="%23e2e8f0"%3E%3Ccircle cx="12" cy="12" r="12"/%3E%3C/svg%3E';
    }

    const session   = getCurrentSession();
    const term      = getCurrentTerm();
    const termDisplay = document.getElementById('currentTermDisplay');
    const sessionDisplay = document.getElementById('currentSessionDisplay');
    if (termDisplay) termDisplay.textContent = term;
    if (sessionDisplay) sessionDisplay.textContent = session;
  } catch (err) {
    console.error('Load school info error:', err);
    toast.error('Unable to load school information. Please refresh the page.');
  }
}

// ============================================================
// CBT SCORES MODULE
// ============================================================
const cbtScoresModule = (() => {
  const classFilterEl   = () => document.getElementById('scoresClassSelect');
  const subjectFilterEl = () => document.getElementById('scoresSubjectSelect');
  const sessionFilterEl = () => document.getElementById('scoresSessionSelect');
  const termFilterEl    = () => document.getElementById('scoresTermSelect');
  const getScoresBtn    = () => document.getElementById('getScoresBtn');
  const resultsEl       = () => document.getElementById('scoresResultsContainer');

  let _teacherClasses = [];
  let _teacherSubjects = [];
  let _distinctSessions = [];
  let _distinctTerms = [];
  let _isFetching = false;

  // FIX 2: 60-second in-memory reuse for test_results queries.
  // Module variable only — never persisted to localStorage.
  const RESULTS_REUSE_MS = 60 * 1000;
  let _resultsCacheKey = null;
  let _resultsCacheTs = 0;
  let _resultsCacheData = null;

  function _formatDate(val) {
    if (!val) return '—';
    if (typeof val.toDate === 'function') return formatDateOnly(val.toDate());
    return formatDateOnly(val);
  }

  function _setResultsState(state, msg) {
    const el = resultsEl();
    if (!el) return;
    const icons = { loading: 'fa-spinner fa-spin', empty: 'fa-inbox', placeholder: 'fa-clipboard-list', error: 'fa-exclamation-circle' };
    el.innerHTML = `<div class="scores-empty"><i class="fas ${icons[state] || icons.placeholder}"></i> ${escapeHtml(msg || '')}</div>`;
  }

  async function _fetchAssignedClasses() {
    if (!currentTeacherId || !currentSchoolId) return [];
    try {
      const teacher = await service.getTeacherById(currentTeacherId);
      if (!teacher) return [];
      const classIds = [...(Array.isArray(teacher.classIds) ? teacher.classIds : []), ...(teacher.hostClassId && !teacher.classIds?.includes(teacher.hostClassId) ? [teacher.hostClassId] : [])].filter(Boolean);
      if (classIds.length === 0) return [];
      const results = await Promise.allSettled(classIds.map(id => service.getClassById(id)));
      return results.filter(r => r.status === 'fulfilled' && r.value !== null).map(r => ({ id: r.value.id, name: r.value.name || r.value.id }));
    } catch (err) { console.warn(err); return []; }
  }

  async function _fetchAssignedSubjects() {
    if (!currentTeacherId || !currentSchoolId) return [];
    try {
      const teacher = await service.getTeacherById(currentTeacherId);
      const teacherSubjectIds = teacher ? (teacher.subjectIds || []) : [];
      const allSubjects = await service.getSubjectsBySchool(currentSchoolId);
      if (teacherSubjectIds.length > 0) return allSubjects.filter(s => teacherSubjectIds.includes(s.id));
      return allSubjects;
    } catch (err) { console.warn(err); return []; }
  }

  // NEW: builds the Session/Term filter options from data already in memory
  // (module-level `tests` array + academic calendar). Makes ZERO Firestore reads.
  function _fetchDistinctSessionsAndTerms() {
    const sessionsSet = new Set();
    const termsSet = new Set();

    // Current session from the academic calendar (may not be initialised yet).
    try {
      const currentSession = getCurrentSession();
      if (currentSession) sessionsSet.add(currentSession);
    } catch (_) { /* calendar not ready — skip */ }

    // Sessions and terms seen in the teacher's own tests.
    if (Array.isArray(tests)) {
      for (const t of tests) {
        if (t && t.session) sessionsSet.add(t.session);
        if (t && t.term) termsSet.add(t.term);
      }
    }

    // Fixed term labels used across the app (see academic-calendar.js),
    // followed by any extra term strings found on the teacher's tests.
    const orderedTerms = ['First Term', 'Second Term', 'Third Term'];
    for (const t of termsSet) {
      if (!orderedTerms.includes(t)) orderedTerms.push(t);
    }

    // Sessions newest first (e.g. "2025/2026" before "2024/2025").
    const sessions = Array.from(sessionsSet)
      .sort((a, b) => String(b).localeCompare(String(a)));

    return { sessions, terms: orderedTerms };
  }

  // NEW: rebuild only the Session and Term <select> options.
  // Called from the subscribeToTests callback once `tests` has loaded.
  // Makes ZERO Firestore reads.
  function refreshSessionTerm() {
    const sessionEl = sessionFilterEl();
    const termEl = termFilterEl();
    if (!sessionEl || !termEl) return;

    const data = _fetchDistinctSessionsAndTerms();
    _distinctSessions = data.sessions;
    _distinctTerms = data.terms;

    const prevSession = sessionEl.value;
    const prevTerm = termEl.value;

    sessionEl.innerHTML = '<option value="">— Select Session —</option>' +
      (_distinctSessions.length
        ? _distinctSessions.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')
        : '<option value="" disabled>No sessions found</option>');
    termEl.innerHTML = '<option value="">— Select Term —</option>' +
      (_distinctTerms.length
        ? _distinctTerms.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')
        : '<option value="" disabled>No terms found</option>');

    // Keep the user's previous selection if it is still valid.
    if (prevSession && _distinctSessions.includes(prevSession)) sessionEl.value = prevSession;
    if (prevTerm && _distinctTerms.includes(prevTerm)) termEl.value = prevTerm;
  }

  async function populateDropdowns() {
    const classEl = classFilterEl();
    const subjectEl = subjectFilterEl();
    const sessionEl = sessionFilterEl();
    const termEl = termFilterEl();
    if (!classEl || !subjectEl || !sessionEl || !termEl) return;

    classEl.innerHTML = '<option value="">Loading classes…</option>';
    subjectEl.innerHTML = '<option value="">Loading subjects…</option>';
    sessionEl.innerHTML = '<option value="">Loading sessions…</option>';
    termEl.innerHTML = '<option value="">Loading terms…</option>';

    const [classes, subjects] = await Promise.all([
      _fetchAssignedClasses(),
      _fetchAssignedSubjects()
    ]);

    // NEW: sessions/terms now come from in-memory data only — no Firestore reads.
    const sessionTermData = _fetchDistinctSessionsAndTerms();

    _teacherClasses = classes;
    _teacherSubjects = subjects;
    _distinctSessions = sessionTermData.sessions;
    _distinctTerms = sessionTermData.terms;

    classEl.innerHTML = '<option value="">— Select Class —</option>' + (classes.length ? classes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('') : '<option value="" disabled>No classes assigned</option>');
    subjectEl.innerHTML = '<option value="">— Select Subject —</option>' + (subjects.length ? subjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('') : '<option value="" disabled>No subjects assigned</option>');
    sessionEl.innerHTML = '<option value="">— Select Session —</option>' + (_distinctSessions.length ? _distinctSessions.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('') : '<option value="" disabled>No sessions found</option>');
    termEl.innerHTML = '<option value="">— Select Term —</option>' + (_distinctTerms.length ? _distinctTerms.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('') : '<option value="" disabled>No terms found</option>');
  }

  // FIX 2: query test_results only for the teacher's own tests that match
  // this class/subject/session/term. Uses `cbtId in [<=10]` chunks scoped
  // by schoolId. 60-second in-memory reuse prevents repeat-click cost.
  async function _queryTestResults(classId, subjectId, selectedSession, selectedTerm) {
    const selectedSubject = _teacherSubjects.find(s => s.id === subjectId);
    const subjectName = selectedSubject ? selectedSubject.name : null;
    if (!subjectName) return [];

    const cacheKey = classId + '|' + subjectId + '|' + selectedSession + '|' + selectedTerm;
    const now = Date.now();
    if (_resultsCacheKey === cacheKey &&
        (now - _resultsCacheTs) < RESULTS_REUSE_MS &&
        Array.isArray(_resultsCacheData)) {
      return _resultsCacheData;
    }

    // Find the teacher's own tests that match this class + subject + session + term.
    const matchingTests = (Array.isArray(tests) ? tests : []).filter(t =>
      t &&
      t.classId === classId &&
      t.subjectId === subjectId &&
      t.session === selectedSession &&
      t.term === selectedTerm
    );
    const cbtIds = matchingTests.map(t => t.id).filter(Boolean);

    if (cbtIds.length === 0) {
      _resultsCacheKey = cacheKey;
      _resultsCacheTs = now;
      _resultsCacheData = [];
      return [];
    }

    const allResults = [];
    for (let i = 0; i < cbtIds.length; i += 10) {
      const chunk = cbtIds.slice(i, i + 10);
      const q = query(
        collection(db, 'test_results'),
        where('schoolId', '==', currentSchoolId),
        where('cbtId', 'in', chunk)
      );
      const snapshot = await getDocs(q);
      snapshot.docs.forEach(d => allResults.push({ id: d.id, ...d.data() }));
    }

    _resultsCacheKey = cacheKey;
    _resultsCacheTs = now;
    _resultsCacheData = allResults;
    return allResults;
  }

  // FIX 3: classId parameter added. Uses cached service.getStudentsByClass
  // (5-minute TTL, active students only) to build an id -> name map,
  // replacing per-ID student reads. Inactive/graduated students are not
  // in the active roster and correctly fall back to the stored
  // userName/studentName on the result, then 'Unknown Student'.
  async function _groupByStudent(results, classId) {
    const map = new Map();
    for (const r of results) {
      const sid = r.userId || 'unknown';
      const fallbackName = r.userName || r.studentName || '';
      if (!map.has(sid)) map.set(sid, { studentName: fallbackName, attempts: [] });

      const rawScore = r.rawScore ?? r.correctAnswers ?? 0;
      const totalQuestions = r.totalQuestions ?? r.total ?? 0;
      const percentage = totalQuestions > 0 ? Math.round((rawScore / totalQuestions) * 100) : null;

      map.get(sid).attempts.push({
        rawScore: rawScore,
        total: totalQuestions,
        percentage: percentage,
        completedAt: r.completedAt || null,
        session: r.session || '',
        term: r.term || ''
      });
    }

    // Fetch real student names from the cached class roster.
    if (classId) {
      try {
        const roster = await service.getStudentsByClass(currentSchoolId, classId);
        const nameById = new Map();
        for (const s of roster) {
          if (s && s.id && s.name) nameById.set(s.id, s.name);
        }
        for (const [sid, entry] of map) {
          const name = nameById.get(sid);
          if (name) entry.studentName = name;
        }
      } catch (err) {
        console.warn('Could not fetch class roster for student names:', err);
      }
    }

    // Ensure every entry has a display name and sort attempts newest-first.
    for (const [, data] of map) {
      if (!data.studentName) data.studentName = 'Unknown Student';
      data.attempts.sort((a, b) => {
        const da = a.completedAt?.toDate ? a.completedAt.toDate() : a.completedAt;
        const db = b.completedAt?.toDate ? b.completedAt.toDate() : b.completedAt;
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return db - da;
      });
    }
    return map;
  }

  function _renderTable(grouped, totalResults, className, subjectName) {
    const el = resultsEl();
    if (!el) return;
    let html = `<div class="table-scroll-wrapper"><table class="cbt-table scores-table">
      <thead><tr><th>Student Name</th><th>Score</th><th>Total</th><th>Percentage</th><th>Date</th><th>Session</th><th>Term</th></tr></thead><tbody>`;
    for (const [, data] of grouped) {
      data.attempts.forEach(att => {
        const pctDisplay = att.percentage != null ? `${att.percentage}%` : '—';
        html += `<tr>
          <td>${escapeHtml(data.studentName)}</td>
          <td class="score-highlight">${att.rawScore}</td>
          <td>${att.total}</td>
          <td><span class="percentage-badge">${pctDisplay}</span></td>
          <td>${_formatDate(att.completedAt)}</td>
          <td>${escapeHtml(att.session || '—')}</td>
          <td>${escapeHtml(att.term || '—')}</td>
        </tr>`;
      });
    }
    html += `</tbody></tr></div>`;
    el.innerHTML = `<div class="scores-summary-bar">
      <div class="scores-summary-stat"><span class="stat-label">Class</span><span class="stat-value">${escapeHtml(className)}</span></div>
      <div class="scores-summary-stat"><span class="stat-label">Subject</span><span class="stat-value">${escapeHtml(subjectName)}</span></div>
      <div class="scores-summary-stat"><span class="stat-label">Students</span><span class="stat-value">${grouped.size}</span></div>
      <div class="scores-summary-stat"><span class="stat-label">Attempts</span><span class="stat-value">${totalResults}</span></div>
    </div>${html}`;
  }

  async function handleGetScores() {
    if (!cbtAccessEnabled) return;
    if (_isFetching) return;
    const classEl = classFilterEl();
    const subjectEl = subjectFilterEl();
    const sessionEl = sessionFilterEl();
    const termEl = termFilterEl();
    const btn = getScoresBtn();
    if (!classEl || !subjectEl || !sessionEl || !termEl) return;

    const classId = classEl.value;
    const subjectId = subjectEl.value;
    const selectedSession = sessionEl.value;
    const selectedTerm = termEl.value;

    if (!classId || !subjectId) {
      toast.error('Please select a class and subject.');
      return;
    }
    if (!selectedSession || !selectedTerm) {
      toast.error('Please select a session and term.');
      return;
    }
    if (!currentSchoolId) {
      toast.error('School information not loaded. Please refresh.');
      return;
    }

    const className = _teacherClasses.find(c => c.id === classId)?.name || classId;
    const subjectName = _teacherSubjects.find(s => s.id === subjectId)?.name || subjectId;

    _isFetching = true;
    if (btn) btn.disabled = true;
    _setResultsState('loading', `Fetching CBT scores for ${selectedSession} - ${selectedTerm}…`);
    showLoader();

    try {
      const results = await _queryTestResults(classId, subjectId, selectedSession, selectedTerm);
      if (results.length === 0) {
        _setResultsState('empty', `No CBT scores found for ${className} · ${subjectName} during ${selectedSession} ${selectedTerm}.`);
      } else {
        // FIX 3: classId passed so _groupByStudent uses the cached roster.
        const grouped = await _groupByStudent(results, classId);
        _renderTable(grouped, results.length, className, subjectName);
        toast.success(`Loaded ${grouped.size} student(s) with ${results.length} attempt(s).`);
      }
    } catch (err) {
      console.error('Handle get scores error:', err);
      toast.error('Failed to fetch CBT scores. Please try again.');
      _setResultsState('error', 'Error loading scores.');
    } finally {
      hideLoader();
      _isFetching = false;
      if (btn) btn.disabled = !cbtAccessEnabled;
    }
  }

  function attachListener() {
    const btn = getScoresBtn();
    if (btn) btn.addEventListener('click', handleGetScores);
  }

  async function init() {
    attachListener();
    await populateDropdowns();
  }

  return { init, populateDropdowns, refreshSessionTerm };
})();

// ==============================
// AUTO-INITIALIZATION
// ==============================
async function initializeTeacherContext() {
  const auth = getAuth();
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      console.error("No authenticated user.");
      if (testsTableWrapper) testsTableWrapper.innerHTML = '<p class="no-data-msg">❌ Not logged in. Please log in as a teacher.</p>';
      return;
    }
    try {
      const userData = await service.getUserById(user.uid);
      if (!userData || userData.role !== 'teacher') throw new Error("Not a teacher.");
      currentSchoolId = userData.schoolId;
      if (!currentSchoolId) throw new Error("School ID missing.");
      await initAcademicCalendar();

      // NEW: Check subscription status before enabling CBT features.
      await checkSubscriptionStatus();

      let teacher = await service.getTeacherById(user.uid);
      if (!teacher) {
        console.warn("Teacher document missing – creating minimal record.");
        const minimalTeacher = { userId: user.uid, schoolId: currentSchoolId, email: userData.email, subjectIds: userData.subjects || [], classIds: [], hostClassId: null, isClassTeacher: false };
        await setDoc(doc(db, 'teachers', user.uid), minimalTeacher);
        teacher = minimalTeacher;
      }
      currentTeacherId = user.uid;
      teacherData = teacher;
      teacherClasses = await loadTeacherClasses();
      subjectsList = await loadSubjects();
      await loadSchoolInfo();
      subscribeToTests();
      await cbtScoresModule.init();

      // Apply subscription UI once more after all dynamic elements are ready.
      applySubscriptionUI();
    } catch (err) {
      console.error("Initialization error:", err);
      toast.error('Failed to load teacher data. Please refresh the page.');
      if (testsTableWrapper) testsTableWrapper.innerHTML = '<p class="no-data-msg">⚠️ Failed to load teacher data. Please refresh.</p>';
    }
  });
}

// ==============================
// EXPORTED FUNCTION (for compatibility)
// ==============================
export async function initTeacherCBT(teacherId, schoolId) {
  currentTeacherId = teacherId;
  currentSchoolId = schoolId;
  if (!currentTeacherId || !currentSchoolId) {
    console.error('Invalid teacherId or schoolId provided');
    toast.error('Invalid teacher or school information. Please refresh.');
    if (testsTableWrapper) testsTableWrapper.innerHTML = '<p class="no-data-msg">Invalid teacher or school information. Please refresh.</p>';
    return;
  }

  await checkSubscriptionStatus();

  teacherClasses = await loadTeacherClasses();
  subjectsList = await loadSubjects();
  subscribeToTests();
  await loadSchoolInfo();
  await cbtScoresModule.init();

  applySubscriptionUI();
}

// ==============================
// START EVERYTHING
// ==============================
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', () => { attachEventListeners(); initializeTeacherContext(); }); } else { attachEventListeners(); initializeTeacherContext(); }