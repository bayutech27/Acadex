// cbt/js/cbt.js - Acadex CBT Dashboard (Student)
// Preserves all existing practice test functionality.
// Adds real-time assigned tests table with status from Firestore.
// In recent tests, shows actual subject name plus "(Assigned Test)" for CBT tests.
//
// NEW (per-student submission gate):
//   • Listens to `cbt_submissions/{cbtId}_{studentId}` in real time.
//   • Renders the "Take Test" button as "✅ Submitted" (disabled) once a
//     submission marker exists — even while the test's global status is
//     still 'started'.
//   • startAssignedTest() runs THREE defence-in-depth guards so a student
//     cannot retake a test they have already submitted.
//
// NEW (recent tests — manual load):
//   • Recent tests are NO LONGER loaded automatically on page load.
//   • The student clicks "Check Your Recent Tests" (id: loadRecentTestsBtn)
//     inside #recentTestsList, which calls setupRecentTests(). Once the
//     container's innerHTML is replaced by the loaded tests, the button
//     disappears naturally.
//   • RECENT_TESTS_PAGE_SIZE = 4 → initial load shows 4 tests, and the
//     "Load More" button loads 4 more per click.
//
// NEW (SmartBrain SSO — practice tests hand-off):
//   • The "Practice Tests" tab no longer opens Acadex's in-app practice.
//     Clicking it redirects the student to SmartBrain's SSO login page
//     with their email, acadexUid, name, schoolId and a return URL (`r`).
//   • SmartBrain's sso-login.html derives a password from the acadexUid
//     and signs the student in (or creates the account on first visit).
//   • "Assigned Tests" becomes the default tab (teacher-created tests
//     still live and are taken inside Acadex).
//   • Tabs are now bigger, bolder, more beautiful — Assigned first,
//     Practice second — styled via JS-injected CSS (no CSS file changes).
//
// REMOVED (per cleanup request):
//   • updateBasicStats() and its call site in initCBTDashboard() — the
//     stats HTML no longer exists in cbt.html, so the underlying service
//     call was throwing and triggering a toast on every page load.
//   • The orphaned DOM refs (completedTests, averageScore, performanceMessage)
//     that only that function used.
//
// All Firestore operations go through service.js where possible.

import { auth, db } from '../../js/firebase-config.js';
import {
    collection,
    query,
    where,
    getDocs,
    orderBy,
    getDoc,
    doc,
    updateDoc,
    increment,
    serverTimestamp,
    onSnapshot,
    limit,
    startAfter
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";

import {
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";

import * as service from '../../js/service.js';
import { toast } from '../../js/error-handler.js';

// ========== CONSTANTS ==========
const WAEC_NECO_QUESTIONS = 50;
const WAEC_NECO_TIME = 40 * 60;
const QUESTIONS_TO_FETCH = 20;
const RECENT_TESTS_PAGE_SIZE = 4;

// SmartBrain production URL — change here if the domain moves.
const SMARTBRAIN_SSO_URL = 'https://smartbraincbt.vercel.app/dashboard/sso-login.html';

const EXAM_TYPE_MAP = {
    'waec': 'WAEC/NECO',
    'jamb': 'JAMB'
};

const ALL_SUBJECTS = [
    { value: 'mathematics', name: 'Mathematics' },
    { value: 'english', name: 'English Language' },
    { value: 'physics', name: 'Physics' },
    { value: 'chemistry', name: 'Chemistry' },
    { value: 'accounting', name: 'Accounting' },
    { value: 'literature', name: 'Literature in English' },
    { value: 'government', name: 'Government' },
    { value: 'commerce', name: 'Commerce' },
    { value: 'biology', name: 'Biology' },
    { value: 'economics', name: 'Economics' },
    { value: 'crk', name: 'Christian Religious Knowledge (CRK)' },
    { value: 'civic', name: 'Civic Education' },
    { value: 'furtherMath', name: 'Further Mathematics' },
    { value: 'geography', name: 'Geography' },
    { value: 'ict', name: 'ICT (Computer Studies)' },
    { value: 'marketing', name: 'Marketing' },
    { value: 'agric', name: 'Agricultural Science' },
    { value: 'yoruba', name: 'Yoruba' }
];

// ========== DOM ELEMENTS ==========
const getElement = (id) => document.getElementById(id);
const startQuickTestBtn = getElement('startQuickTestBtn');
const classSelect = getElement('classSelect');
const subjectSelect = getElement('subjectSelect');
const userName = getElement('userName');
const additionalSubjectsDiv = getElement('additionalSubjects');
const startJambDrillBtn = getElement('startJambDrillBtn');
const waecNecoSubjectSelect = getElement('waecNecoSubjectSelect');
const startWaecNecoDrillBtn = getElement('startWaecNecoDrillBtn');
const assignedCbtSection = getElement('assignedCbtSection');
const assignedTestsWrapper = getElement('assignedTestsTableWrapper');
const cbtErrorMessage = getElement('cbtErrorMessage');
const loadRecentTestsBtn = getElement('loadRecentTestsBtn');

// ========== STATE ==========
let currentStudentData = null;
let currentStudentId = null;
let currentSchoolId = null;
let unsubscribeRecentTests = null;
let lastVisibleRecentDoc = null;
let unsubscribeAssignedTests = null;

// Per-student submission tracking + module-level listener snapshots
let submittedCbtIds       = new Set();
let unsubscribeSubmissions = null;
let pendingAssignedTests   = [];
let startedAssignedTests   = [];

// ========== HELPER FUNCTIONS ==========
function convertTimestamp(value) {
    if (!value) return null;
    if (typeof value.toDate === 'function') return value.toDate();
    if (value.seconds !== undefined) return new Date(value.seconds * 1000);
    if (typeof value === 'string') {
        const d = new Date(value);
        if (!isNaN(d.getTime())) return d;
    }
    if (value instanceof Date && !isNaN(value.getTime())) return value;
    return null;
}

function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function generateTestId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function showLoadingState(show, button) {
    if (!button) return;
    if (show) {
        button.dataset.originalText = button.innerHTML;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
        button.disabled = true;
    } else {
        button.innerHTML = button.dataset.originalText || button.innerHTML;
        button.disabled = false;
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ========== STUDENT DATA ==========
async function loadStudentProfile(userId) {
    try {
        const student = await service.getStudentById(userId);
        if (!student) throw new Error('Student profile not found');
        currentStudentData = student;
        currentStudentId = userId;
        currentSchoolId = currentStudentData.schoolId || localStorage.getItem('userSchoolId');
        if (!currentSchoolId) throw new Error('School ID missing');
        userName.textContent = currentStudentData.name || 'Student';
        const classId = currentStudentData.classId;
        let className = classId || 'Not assigned';
        if (classId) {
            try {
                const classData = await service.getClassById(classId);
                if (classData) className = classData.name || classId;
            } catch (e) { console.warn(e); }
        }
        const classElem = document.getElementById('studentClassDisplay');
        if (classElem) classElem.innerHTML = `<i class="fas fa-graduation-cap"></i> Class: ${className}`;
    } catch (err) {
        console.error('Error loading student profile:', err);
        toast.error('Unable to load your profile. Please refresh the page.');
        userName.textContent = 'Student';
        const classElem = document.getElementById('studentClassDisplay');
        if (classElem) classElem.innerHTML = `<i class="fas fa-graduation-cap"></i> Class: Not assigned`;
    }
}

// ========== SUBJECT DROPDOWNS ==========
function populateQuickTestSubjects() {
    if (!subjectSelect) return;
    subjectSelect.innerHTML = '<option value="" disabled selected>Choose subject</option>';
    ALL_SUBJECTS.forEach(subject => {
        const option = document.createElement('option');
        option.value = subject.value;
        option.textContent = subject.name;
        subjectSelect.appendChild(option);
    });
}

function populateWaecNecoSubjects() {
    if (!waecNecoSubjectSelect) return;
    waecNecoSubjectSelect.innerHTML = '<option value="" disabled selected>Choose subject</option>';
    ALL_SUBJECTS.forEach(subject => {
        const option = document.createElement('option');
        option.value = subject.value;
        option.textContent = subject.name;
        waecNecoSubjectSelect.appendChild(option);
    });
}

// ========== RECENT TESTS (kept for backward compat) ==========
async function setupRecentTests(userId) {
    if (unsubscribeRecentTests) unsubscribeRecentTests();
    const recentTestsList = document.getElementById('recentTestsList');
    const loadMoreContainer = document.getElementById('recentTestsMore');
    const loadMoreBtn = document.getElementById('loadMoreRecentBtn');
    if (!recentTestsList) return;
    lastVisibleRecentDoc = null;
    const q = query(
        collection(db, "test_results"),
        where("userId", "==", userId),
        orderBy("completedAt", "desc"),
        limit(RECENT_TESTS_PAGE_SIZE)
    );
    try {
        const snapshot = await getDocs(q);
        if (snapshot.empty) {
            recentTestsList.innerHTML = '<p class="no-tests">No tests yet. Start practicing!</p>';
            if (loadMoreContainer) loadMoreContainer.style.display = 'none';
            return;
        }
        const results = [];
        snapshot.forEach((doc) => results.push({ id: doc.id, ...doc.data() }));
        if (snapshot.docs.length > 0) lastVisibleRecentDoc = snapshot.docs[snapshot.docs.length - 1];
        recentTestsList.innerHTML = results.map(test => buildRecentTestHTML(test)).join('');
        if (results.length === RECENT_TESTS_PAGE_SIZE && loadMoreContainer) loadMoreContainer.style.display = 'block';
        else if (loadMoreContainer) loadMoreContainer.style.display = 'none';
        if (loadMoreBtn) loadMoreBtn.onclick = async () => await loadMoreRecentTests(userId);
    } catch (error) {
        console.error("Error loading recent tests:", error);
        toast.error('Unable to load recent tests. Please refresh the page.');
        recentTestsList.innerHTML = '<p class="error">Error loading recent tests. Please refresh.</p>';
    }
}

async function loadMoreRecentTests(userId) {
    if (!lastVisibleRecentDoc) return;
    const recentTestsList = document.getElementById('recentTestsList');
    const loadMoreBtn = document.getElementById('loadMoreRecentBtn');
    const loadMoreContainer = document.getElementById('recentTestsMore');
    if (loadMoreBtn) {
        loadMoreBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
        loadMoreBtn.disabled = true;
    }
    const q = query(
        collection(db, "test_results"),
        where("userId", "==", userId),
        orderBy("completedAt", "desc"),
        startAfter(lastVisibleRecentDoc),
        limit(RECENT_TESTS_PAGE_SIZE)
    );
    try {
        const snapshot = await getDocs(q);
        if (snapshot.empty) {
            if (loadMoreContainer) loadMoreContainer.style.display = 'none';
            if (loadMoreBtn) { loadMoreBtn.innerHTML = '<i class="fas fa-check"></i> No more tests'; loadMoreBtn.disabled = true; }
            return;
        }
        const newResults = [];
        snapshot.forEach((doc) => newResults.push({ id: doc.id, ...doc.data() }));
        recentTestsList.innerHTML += newResults.map(test => buildRecentTestHTML(test)).join('');
        lastVisibleRecentDoc = snapshot.docs[snapshot.docs.length - 1];
        if (newResults.length < RECENT_TESTS_PAGE_SIZE && loadMoreContainer) loadMoreContainer.style.display = 'none';
        else if (loadMoreContainer) loadMoreContainer.style.display = 'block';
    } catch (error) {
        console.error("Error loading more tests:", error);
        toast.error('Failed to load more tests. Please try again.');
    } finally {
        if (loadMoreBtn) { loadMoreBtn.innerHTML = '<i class="fas fa-chevron-down"></i> Load More'; loadMoreBtn.disabled = false; }
    }
}

function buildRecentTestHTML(test) {
    const mode = test.mode;
    const completedAt = test.completedAt ? convertTimestamp(test.completedAt) : null;
    const dateStr = completedAt ? completedAt.toLocaleDateString() : 'Unknown date';
    let typeIcon = '', typeLabel = '', mainContent = '';

    if (mode === 'cbt') {
        typeIcon = '<i class="fas fa-chalkboard-teacher"></i>';
        typeLabel = 'Assigned Test';
        mainContent = renderCbtTest(test);
    } else {
        switch (mode) {
            case 'quick': typeIcon = '<i class="fas fa-bolt"></i>'; typeLabel = 'Quick Test'; mainContent = renderQuickTest(test); break;
            case 'waec_neco': typeIcon = '<i class="fas fa-school"></i>'; typeLabel = 'WAEC/NECO'; mainContent = renderWaecNecoTest(test); break;
            case 'jamb_drill': typeIcon = '<i class="fas fa-graduation-cap"></i>'; typeLabel = 'JAMB Drill'; mainContent = renderJambDrillTest(test); break;
            default: typeIcon = '<i class="fas fa-pencil-alt"></i>'; typeLabel = 'Test'; mainContent = renderUnknownTest(test);
        }
    }
    return `
        <div class="recent-test-item">
            <div class="test-header"><div class="test-type-badge" title="${typeLabel}">${typeIcon}</div><div class="test-date">${escapeHtml(dateStr)}</div></div>
            ${mainContent}
        </div>
    `;
}

function renderQuickTest(test) {
    const subject = test.subjectName || test.subject || 'Unknown';
    const rawScore = test.rawScore !== undefined ? test.rawScore : 0;
    const total = test.totalQuestions || 0;
    const scoreText = total > 0 ? `${rawScore}/${total}` : 'N/A';
    return `<div class="test-main"><div class="test-subject">${escapeHtml(subject)}</div><div class="test-score">Score: <strong>${scoreText}</strong></div></div>`;
}

function renderWaecNecoTest(test) {
    const subject = test.subjectName || test.subject || 'Unknown';
    const subjectScores = test.subjectScores || {};
    const totalRaw = test.rawScore !== undefined ? test.rawScore : 0;
    const totalQuestions = test.totalQuestions || 0;
    let subjectRow = '';
    if (Object.keys(subjectScores).length > 0) {
        for (const [subjValue, scoreObj] of Object.entries(subjectScores)) {
            const subjName = subjValue.charAt(0).toUpperCase() + subjValue.slice(1);
            const raw = scoreObj.correct !== undefined ? scoreObj.correct : (scoreObj.raw || 0);
            const total = scoreObj.total || totalQuestions;
            subjectRow += `<div class="subject-score-row"><span class="subject-name">${escapeHtml(subjName)}:</span> <span class="score-value">${raw}/${total}</span></div>`;
        }
    } else {
        subjectRow = `<div class="subject-score-row"><span class="subject-name">Total:</span> <span class="score-value">${totalRaw}/${totalQuestions}</span></div>`;
    }
    return `<div class="test-main"><div class="test-subject">${escapeHtml(subject)}</div><div class="subject-scores">${subjectRow}</div><div class="test-total-score">Total: <strong>${totalRaw}/${totalQuestions}</strong></div></div>`;
}

function renderJambDrillTest(test) {
    const subjectScores = test.subjectScores || {};
    const subjectsList = test.subjects || [];
    const totalRaw = test.rawScore !== undefined ? test.rawScore : 0;
    let subjectRows = '';
    if (subjectsList.length > 0) {
        for (const subj of subjectsList) {
            const subjValue = subj.value;
            const subjName = subj.name;
            const totalQ = subj.count || 0;
            const scoreObj = subjectScores[subjValue] || { correct: 0, total: totalQ };
            const raw = scoreObj.correct !== undefined ? scoreObj.correct : (scoreObj.raw || 0);
            const total = scoreObj.total || totalQ;
            subjectRows += `<div class="subject-score-row"><span class="subject-name">${escapeHtml(subjName)}:</span> <span class="score-value">${raw}/${total}</span></div>`;
        }
    } else if (Object.keys(subjectScores).length > 0) {
        for (const [subjValue, scoreObj] of Object.entries(subjectScores)) {
            const subjName = subjValue.charAt(0).toUpperCase() + subjValue.slice(1);
            const raw = scoreObj.correct !== undefined ? scoreObj.correct : (scoreObj.raw || 0);
            const total = scoreObj.total || 0;
            subjectRows += `<div class="subject-score-row"><span class="subject-name">${escapeHtml(subjName)}:</span> <span class="score-value">${raw}/${total}</span></div>`;
        }
    } else {
        subjectRows = `<div class="subject-score-row"><span class="subject-name">Total:</span> <span class="score-value">${totalRaw}/${test.totalQuestions || 0}</span></div>`;
    }
    let totalPossible = 180;
    if (subjectsList.length) totalPossible = subjectsList.reduce((sum, s) => sum + (s.count || 0), 0);
    const totalScoreText = totalRaw && totalPossible ? `${totalRaw}/${totalPossible}` : 'N/A';
    return `<div class="test-main jamb-detail"><div class="test-subject">JAMB Drill</div><div class="subject-scores">${subjectRows}</div><div class="test-total-score">Total: <strong>${totalScoreText}</strong></div></div>`;
}

function renderCbtTest(test) {
    const subject = test.subject || test.subjectName || 'Unknown';
    const rawScore = test.rawScore !== undefined ? test.rawScore : 0;
    const total = test.totalQuestions || 0;
    const scoreText = total > 0 ? `${rawScore}/${total}` : 'N/A';
    const displaySubject = `${escapeHtml(subject)} (Assigned Test)`;
    return `<div class="test-main"><div class="test-subject">${displaySubject}</div><div class="test-score">Score: <strong>${scoreText}</strong></div></div>`;
}

function renderUnknownTest(test) {
    const rawScore = test.rawScore !== undefined ? test.rawScore : 0;
    const total = test.totalQuestions || 0;
    const scoreText = total > 0 ? `${rawScore}/${total}` : 'N/A';
    return `<div class="test-main"><div class="test-subject">${escapeHtml(test.subject || 'Test')}</div><div class="test-score">Score: <strong>${scoreText}</strong></div></div>`;
}

// ========== ASSIGNED TESTS TABLE ==========
function subscribeToAssignedTests() {
    if (!currentSchoolId || !currentStudentId || !currentStudentData) return;
    if (unsubscribeAssignedTests) unsubscribeAssignedTests();

    const studentClassId = currentStudentData.classId;
    const qPending = query(
        collection(db, 'cbt'),
        where('schoolId', '==', currentSchoolId),
        where('assignedTo', 'array-contains-any', [currentStudentId, studentClassId]),
        where('status', '==', 'pending')
    );
    const qStarted = query(
        collection(db, 'cbt'),
        where('schoolId', '==', currentSchoolId),
        where('assignedTo', 'array-contains-any', [currentStudentId, studentClassId]),
        where('status', '==', 'started')
    );

    pendingAssignedTests = [];
    startedAssignedTests = [];

    const unsubPending = onSnapshot(qPending, (snap) => {
        pendingAssignedTests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderAssignedTestsTable();
    }, (err) => {
        console.error('Error listening to pending tests:', err);
        toast.warning('Unable to load assigned tests. Please refresh the page.');
        if (assignedTestsWrapper) assignedTestsWrapper.innerHTML = '<p class="error">Error loading assigned tests. Please refresh.</p>';
    });

    const unsubStarted = onSnapshot(qStarted, (snap) => {
        startedAssignedTests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderAssignedTestsTable();
    }, (err) => {
        console.error('Error listening to started tests:', err);
        if (assignedTestsWrapper && !assignedTestsWrapper.querySelector('.error')) {
            toast.warning('Unable to load assigned tests. Please refresh the page.');
            assignedTestsWrapper.innerHTML = '<p class="error">Error loading assigned tests. Please refresh.</p>';
        }
    });

    unsubscribeAssignedTests = () => { unsubPending(); unsubStarted(); };
}

function subscribeToSubmissions() {
    if (!currentSchoolId || !currentStudentId) return;
    if (unsubscribeSubmissions) unsubscribeSubmissions();

    const qSub = query(
        collection(db, 'cbt_submissions'),
        where('studentId', '==', currentStudentId),
        where('schoolId', '==', currentSchoolId)
    );

    unsubscribeSubmissions = onSnapshot(qSub, (snap) => {
        submittedCbtIds = new Set(
            snap.docs.map(d => d.data().cbtId).filter(Boolean)
        );
        renderAssignedTestsTable();
    }, (err) => {
        console.warn('cbt_submissions listener error (non-fatal):', err);
    });
}

function renderAssignedTestsTable() {
    if (!assignedTestsWrapper) return;

    const tests = [...pendingAssignedTests, ...startedAssignedTests];

    if (!tests || tests.length === 0) {
        assignedTestsWrapper.innerHTML = '<p class="no-tests">No assigned tests yet.</p>';
        return;
    }

    const rows = tests.map(test => {
        const status = test.status || 'pending';
        const hasSubmitted = submittedCbtIds.has(test.id);

        let statusBadge = '';
        if (status === 'started') statusBadge = '<span class="status-badge status-started">Started</span>';
        else if (status === 'pending') statusBadge = '<span class="status-badge status-pending">Pending</span>';
        else if (status === 'expired') statusBadge = '<span class="status-badge status-expired">Expired</span>';
        else statusBadge = `<span class="status-badge">${escapeHtml(status)}</span>`;

        const isTakeEnabled = (status === 'started') && !hasSubmitted;
        const buttonLabel = hasSubmitted ? '✅ Submitted' : 'Take Test';
        const takeButton = `<button class="take-test-btn" data-id="${test.id}" ${!isTakeEnabled ? 'disabled' : ''}>${buttonLabel}</button>`;

        return `
            <tr data-id="${test.id}">
                <td data-label="Type">${escapeHtml(test.type || '—')}</td>
                <td data-label="Subject">${escapeHtml(test.subjectName || test.subjectId || '—')}</td>
                <td data-label="Questions">${Array.isArray(test.questions) ? test.questions.length : 0}</td>
                <td data-label="Duration">${test.durationMinutes || '—'} min</td>
                <td data-label="Scheduled Date">${test.scheduledDate ? new Date(test.scheduledDate).toLocaleDateString() : '—'}</td>
                <td data-label="Status">${statusBadge}</td>
                <td data-label="Action">${takeButton}</td>
            </tr>
        `;
    }).join('');

    assignedTestsWrapper.innerHTML = `
        <div class="assigned-tests-table-wrapper">
            <table class="assigned-tests-table">
                <thead>
                    <tr>
                        <th>Type</th><th>Subject</th><th>Questions</th><th>Duration</th><th>Scheduled Date</th><th>Status</th><th>Action</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;

    document.querySelectorAll('.take-test-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const cbtId = btn.dataset.id;
            await startAssignedTest(cbtId);
        });
    });
}

async function startAssignedTest(cbtId) {
    try {
        if (submittedCbtIds.has(cbtId)) {
            toast.error('You have already submitted this test. It cannot be retaken.');
            return;
        }

        const cbtDoc = await getDoc(doc(db, 'cbt', cbtId));
        if (!cbtDoc.exists()) {
            toast.error('Test not found. Please refresh the page.');
            throw new Error('Test not found');
        }
        const cbtData = cbtDoc.data();
        if (cbtData.status !== 'started') {
            toast.error('This test is not available for taking.');
            return;
        }

        try {
            const submissionSnap = await getDoc(doc(db, 'cbt_submissions', cbtId + '_' + currentStudentId));
            if (submissionSnap.exists()) {
                toast.error('You have already submitted this test. It cannot be retaken.');
                return;
            }
        } catch (e) {
            console.warn('cbt_submissions check failed (falling back to test_results):', e);
        }

        try {
            const startedAtRaw = cbtData.startedAt;
            let startedAtMs = 0;
            if (startedAtRaw) {
                if (typeof startedAtRaw.seconds === 'number') {
                    startedAtMs = startedAtRaw.seconds * 1000;
                } else if (typeof startedAtRaw.toDate === 'function') {
                    startedAtMs = startedAtRaw.toDate().getTime();
                } else if (startedAtRaw instanceof Date) {
                    startedAtMs = startedAtRaw.getTime();
                } else if (typeof startedAtRaw === 'string') {
                    const parsed = new Date(startedAtRaw);
                    if (!isNaN(parsed.getTime())) startedAtMs = parsed.getTime();
                }
            }

            const resultsCheck = await getDocs(query(
                collection(db, 'test_results'),
                where('cbtId', '==', cbtId),
                where('userId', '==', currentStudentId)
            ));

            const hasSubmittedThisRun = resultsCheck.docs.some(d => {
                const data = d.data();
                const ca = data.completedAt;
                let completedMs = 0;
                if (ca) {
                    if (typeof ca.seconds === 'number') completedMs = ca.seconds * 1000;
                    else if (typeof ca.toDate === 'function') completedMs = ca.toDate().getTime();
                    else if (ca instanceof Date) completedMs = ca.getTime();
                    else if (typeof ca === 'string') {
                        const parsed = new Date(ca);
                        if (!isNaN(parsed.getTime())) completedMs = parsed.getTime();
                    }
                }
                if (startedAtMs === 0) return true;
                return completedMs >= startedAtMs;
            });

            if (hasSubmittedThisRun) {
                toast.error('You have already submitted this test. It cannot be retaken.');
                return;
            }
        } catch (e) {
            console.warn('test_results check failed:', e);
        }

        let remainingSeconds = cbtData.durationMinutes * 60;
        if (cbtData.startedAt) {
            const startTime = convertTimestamp(cbtData.startedAt);
            if (startTime) {
                const now = new Date();
                const elapsed = Math.floor((now - startTime) / 1000);
                remainingSeconds = Math.max(0, cbtData.durationMinutes * 60 - elapsed);
                if (remainingSeconds <= 0) {
                    toast.error('This test has already expired.');
                    return;
                }
            }
        }

        const questions = cbtData.questions || [];
        if (!questions.length) {
            toast.error('No questions found for this test.');
            return;
        }

        const testData = {
            testId: `cbt_${cbtId}_${Date.now()}`,
            mode: 'cbt',
            examType: cbtData.examType || 'CBT',
            subject: cbtData.subjectName || cbtData.subjectId,
            title: cbtData.title,
            cbtId: cbtId,
            questions: questions,
            totalQuestions: questions.length,
            totalTime: remainingSeconds,
            startTime: new Date().toISOString(),
            userId: currentStudentId,
            schoolId: currentSchoolId,
            userAnswers: Array(questions.length).fill(null),
            plan: 'full_access'
        };
        sessionStorage.setItem('currentTest', JSON.stringify(testData));
        window.location.href = 'test.html';
    } catch (err) {
        console.error('Error starting assigned test:', err);
        toast.error('Failed to start test. Please try again.');
    }
}

// ========== EXISTING TEST LAUNCHERS (dormant — practice HTML removed) ==========
async function startQuickTest() {
    const selectedExam = classSelect.value;
    const selectedSubject = subjectSelect.value;
    if (!selectedExam || !selectedSubject) {
        toast.error('Please select exam and subject.');
        return;
    }
    try {
        showLoadingState(true, startQuickTestBtn);
        const firestoreExamType = EXAM_TYPE_MAP[selectedExam] || selectedExam;
        const allQuestions = await fetchQuestions(firestoreExamType, selectedSubject);
        if (allQuestions.length < QUESTIONS_TO_FETCH) {
            showLoadingState(false, startQuickTestBtn);
            toast.error(`Only ${allQuestions.length} questions available for "${selectedSubject}". Please add more questions.`);
            return;
        }
        const shuffledQuestions = shuffleArray([...allQuestions]);
        const selectedQuestions = shuffledQuestions.slice(0, QUESTIONS_TO_FETCH);
        const totalTime = selectedQuestions.reduce((total, q) => total + (parseInt(q.timeLimit) || 120), 0);
        const testData = {
            testId: generateTestId(),
            mode: 'quick',
            examType: firestoreExamType,
            subject: selectedSubject,
            questions: selectedQuestions,
            totalQuestions: selectedQuestions.length,
            totalTime,
            startTime: new Date().toISOString(),
            userId: auth.currentUser.uid,
            userAnswers: Array(selectedQuestions.length).fill(null),
            plan: 'full_access'
        };
        sessionStorage.setItem('currentTest', JSON.stringify(testData));
        window.location.href = 'test.html';
    } catch (error) {
        console.error('Error starting test:', error);
        showLoadingState(false, startQuickTestBtn);
        toast.error(`Failed to start test: ${error.message || 'Please try again.'}`);
    }
}

async function startJambDrill() {
    const selectedCheckboxes = document.querySelectorAll('.jamb-subject-checkbox:checked');
    if (selectedCheckboxes.length !== 3) {
        toast.error('Please select exactly 3 additional subjects.');
        return;
    }
    const subjects = [
        { value: 'english', name: 'English Language', count: 60 },
        ...Array.from(selectedCheckboxes).map(cb => {
            const subject = ALL_SUBJECTS.find(s => s.value === cb.value);
            return { value: cb.value, name: subject.name, count: 40 };
        })
    ];
    try {
        showLoadingState(true, startJambDrillBtn);
        const subjectQuestionMap = {};
        for (let subj of subjects) {
            const questions = await fetchQuestions('JAMB', subj.value);
            if (questions.length < subj.count) {
                showLoadingState(false, startJambDrillBtn);
                toast.error(`Not enough questions for ${subj.name}. Available: ${questions.length}, needed: ${subj.count}.`);
                return;
            }
            const shuffled = shuffleArray(questions);
            const selected = shuffled.slice(0, subj.count).map(q => ({ ...q, subject: subj.value, subjectName: subj.name }));
            subjectQuestionMap[subj.value] = selected;
        }
        const finalQuestions = [];
        subjects.forEach(subj => finalQuestions.push(...subjectQuestionMap[subj.value]));
        const testData = {
            testId: generateTestId(),
            mode: 'jamb_drill',
            examType: 'JAMB',
            subjects,
            questions: finalQuestions,
            totalQuestions: finalQuestions.length,
            totalTime: 120 * 60,
            startTime: new Date().toISOString(),
            userId: auth.currentUser.uid,
            userAnswers: Array(finalQuestions.length).fill(null),
            plan: 'full_access'
        };
        sessionStorage.setItem('currentTest', JSON.stringify(testData));
        window.location.href = 'test.html';
    } catch (error) {
        console.error('Error starting JAMB Drill:', error);
        showLoadingState(false, startJambDrillBtn);
        toast.error(`Failed to start JAMB Drill: ${error.message || 'Please try again.'}`);
    }
}

async function startWaecNecoDrill() {
    const selectedSubject = waecNecoSubjectSelect.value;
    if (!selectedSubject) {
        toast.error('Please select a subject.');
        return;
    }
    try {
        showLoadingState(true, startWaecNecoDrillBtn);
        const allQuestions = await fetchQuestions('WAEC/NECO', selectedSubject);
        if (allQuestions.length < WAEC_NECO_QUESTIONS) {
            showLoadingState(false, startWaecNecoDrillBtn);
            toast.error(`Only ${allQuestions.length} WAEC/NECO questions available for "${selectedSubject}". Please add more questions.`);
            return;
        }
        const shuffled = shuffleArray([...allQuestions]);
        const selectedQuestions = shuffled.slice(0, WAEC_NECO_QUESTIONS);
        const testData = {
            testId: generateTestId(),
            mode: 'waec_neco',
            examType: 'WAEC/NECO',
            subject: selectedSubject,
            questions: selectedQuestions,
            totalQuestions: selectedQuestions.length,
            totalTime: WAEC_NECO_TIME,
            startTime: new Date().toISOString(),
            userId: auth.currentUser.uid,
            userAnswers: Array(selectedQuestions.length).fill(null),
            plan: 'full_access'
        };
        sessionStorage.setItem('currentTest', JSON.stringify(testData));
        window.location.href = 'test.html';
    } catch (error) {
        console.error('Error starting WAEC/NECO Drill:', error);
        showLoadingState(false, startWaecNecoDrillBtn);
        toast.error(`Failed to start test: ${error.message || 'Please try again.'}`);
    }
}

async function fetchQuestions(examType, subject) {
    try {
        const questions = await service.getQuestions(examType, subject);
        const processed = questions.map(q => ({
            id: q.id,
            ...q,
            options: q.options || {
                A: q.optionA || "",
                B: q.optionB || "",
                C: q.optionC || "",
                D: q.optionD || ""
            }
        }));
        return processed;
    } catch (error) {
        console.error('Error in fetchQuestions:', error);
        toast.error('Failed to load questions. Please check your internet connection.');
        throw error;
    }
}

// ========== JAMB DRILL UI (dormant — practice HTML removed) ==========
function setupJambDrillSubjects() {
    if (!additionalSubjectsDiv) return;
    additionalSubjectsDiv.innerHTML = '';
    ALL_SUBJECTS.forEach(subject => {
        if (subject.value === 'english') return;
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex'; wrapper.style.alignItems = 'center'; wrapper.style.gap = '8px';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.value = subject.value; checkbox.id = `subj_${subject.value}`; checkbox.className = 'jamb-subject-checkbox';
        const label = document.createElement('label');
        label.htmlFor = `subj_${subject.value}`; label.textContent = subject.name + ' (40 questions)'; label.style.margin = '0'; label.style.fontWeight = '400';
        wrapper.appendChild(checkbox); wrapper.appendChild(label);
        additionalSubjectsDiv.appendChild(wrapper);
    });
    document.querySelectorAll('.jamb-subject-checkbox').forEach(cb => cb.addEventListener('change', validateJambSubjectSelection));
}

function validateJambSubjectSelection() {
    const checkboxes = document.querySelectorAll('.jamb-subject-checkbox:checked');
    const hint = document.getElementById('subjectSelectionHint');
    if (!hint) return;
    if (checkboxes.length === 3) {
        hint.innerHTML = '✅ 3 subjects selected. Ready to start.';
        hint.style.color = '#28a745';
    } else {
        hint.innerHTML = `Select exactly 3 subjects (currently ${checkboxes.length} selected)`;
        hint.style.color = '#dc3545';
    }
}

// ========== TAB SYSTEM (iOS-style, Assigned first, Practice redirects) ==========

function injectTabStyles() {
    if (document.getElementById('cbt-tab-modern-styles')) return;
    const style = document.createElement('style');
    style.id = 'cbt-tab-modern-styles';
    style.textContent = `
        .cbt-tabs-modern {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-bottom: 1.5rem;
        }
        .cbt-tabs-modern .cbt-tab {
            flex: 1 1 200px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            padding: 18px 28px;
            border-radius: 18px;
            font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', sans-serif;
            font-size: 1.08rem;
            font-weight: 700;
            letter-spacing: -0.01em;
            cursor: pointer;
            transition: all 0.28s cubic-bezier(0.25, 0.8, 0.35, 1);
            -webkit-tap-highlight-color: transparent;
            border: 2px solid rgba(106, 17, 203, 0.18);
            background: #ffffff;
            color: #6A11CB;
            box-shadow: 0 2px 10px rgba(106, 17, 203, 0.06);
            min-height: 64px;
            white-space: nowrap;
        }
        .cbt-tabs-modern .cbt-tab i {
            font-size: 1.15rem;
        }
        .cbt-tabs-modern .cbt-tab:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 22px rgba(106, 17, 203, 0.18);
            border-color: rgba(106, 17, 203, 0.4);
        }
        .cbt-tabs-modern .cbt-tab:active {
            transform: scale(0.98);
        }
        .cbt-tabs-modern .cbt-tab.active {
            background: linear-gradient(135deg, #6A11CB 0%, #9D4EDD 100%);
            color: #ffffff;
            border-color: transparent;
            box-shadow: 0 10px 26px rgba(106, 17, 203, 0.38);
        }
        .cbt-tabs-modern .cbt-tab.active:hover {
            transform: translateY(-2px);
            box-shadow: 0 12px 30px rgba(106, 17, 203, 0.45);
        }
        .cbt-tabs-modern .cbt-tab-external-icon {
            font-size: 0.7em;
            opacity: 0.75;
            margin-left: 2px;
        }
        @media (max-width: 640px) {
            .cbt-tabs-modern {
                flex-direction: column;
                gap: 10px;
            }
            .cbt-tabs-modern .cbt-tab {
                flex: 1 1 auto;
                width: 100%;
                padding: 18px 22px;
                font-size: 1.02rem;
                min-height: 60px;
            }
        }
    `;
    document.head.appendChild(style);
}

function createTabs() {
    const practiceContainer = document.getElementById('practiceTestsContainer');
    const assignedSection = document.getElementById('assignedCbtSection');
    if (!assignedSection) return;

    injectTabStyles();

    if (practiceContainer) practiceContainer.style.display = 'none';

    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'cbt-tabs-modern';

    const assignedTab = document.createElement('button');
    assignedTab.type = 'button';
    assignedTab.className = 'cbt-tab active';
    assignedTab.innerHTML = '<i class="fas fa-clipboard-list"></i> Assigned Tests';

    const practiceTab = document.createElement('button');
    practiceTab.type = 'button';
    practiceTab.className = 'cbt-tab';
    practiceTab.innerHTML = '<i class="fas fa-bolt"></i> Practice Tests <i class="fas fa-arrow-up-right-from-square cbt-tab-external-icon"></i>';

    tabsContainer.appendChild(assignedTab);
    tabsContainer.appendChild(practiceTab);

    const dashboardContainer = document.querySelector('.dashboard-container');
    const welcomeSection = document.querySelector('.welcome-section');

    if (welcomeSection && welcomeSection.parentNode) {
        welcomeSection.parentNode.insertBefore(tabsContainer, welcomeSection.nextSibling);
    } else {
        dashboardContainer.appendChild(tabsContainer);
    }

    function showAssigned() {
        if (practiceContainer) practiceContainer.style.display = 'none';
        assignedSection.style.display = 'block';
        assignedTab.classList.add('active');
        practiceTab.classList.remove('active');
        if (currentSchoolId && currentStudentId && currentStudentData && !unsubscribeAssignedTests) {
            subscribeToAssignedTests();
        }
    }

    async function handlePracticeClick() {
        const originalHTML = practiceTab.innerHTML;
        practiceTab.disabled = true;
        practiceTab.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Opening Smart Brain…';
        const ok = await redirectToSmartBrainPractice();
        if (!ok) {
            practiceTab.disabled = false;
            practiceTab.innerHTML = originalHTML;
        }
    }

    assignedTab.addEventListener('click', showAssigned);
    practiceTab.addEventListener('click', handlePracticeClick);

    showAssigned();
}

// ========== SMARTBRAIN SSO REDIRECT ==========
async function redirectToSmartBrainPractice() {
    try {
        const user = auth.currentUser;
        if (!user) {
            toast.error('Your session has expired. Please log in again.');
            return false;
        }
        if (!currentStudentData) {
            toast.error('Profile still loading. Please try again in a moment.');
            return false;
        }

        const email = (currentStudentData.email || user.email || '').trim().toLowerCase();
        if (!email) {
            toast.error('Your account is missing an email address. Please contact your school.');
            return false;
        }

        const schoolId = currentStudentData.schoolId;
        if (!schoolId) {
            toast.error('You must be enrolled in a school to access practice tests.');
            return false;
        }

        const name = currentStudentData.name || user.displayName || 'Student';

        const returnUrl = window.location.origin + '/student/student-portal.html';

        const params = new URLSearchParams({
            e: email,
            u: user.uid,
            n: name,
            s: schoolId,
            r: returnUrl
        });

        const url = SMARTBRAIN_SSO_URL + '?' + params.toString();
        window.location.href = url;
        return true;
    } catch (err) {
        console.error('SmartBrain SSO redirect error:', err);
        toast.error('Unable to open practice tests. Please try again.');
        return false;
    }
}

// ========== INITIALIZATION ==========
async function initCBTDashboard() {
    console.log("CBT Dashboard initializing...");
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = '../../index.html';
            return;
        }
        await loadStudentProfile(user.uid);
        if (currentSchoolId && currentStudentId) {
            populateQuickTestSubjects();
            populateWaecNecoSubjects();
            setupJambDrillSubjects();

            subscribeToSubmissions();

            // NOTE: updateBasicStats() has been removed — the stats HTML
            // no longer exists in cbt.html, so its service call was failing
            // and triggering an unwanted toast on every page load.

            createTabs();
        } else {
            console.error('Missing school or student ID');
            toast.error('Unable to load dashboard. School or student information missing.');
        }
    });

    if (startQuickTestBtn) startQuickTestBtn.addEventListener('click', startQuickTest);
    if (startJambDrillBtn) startJambDrillBtn.addEventListener('click', startJambDrill);
    if (startWaecNecoDrillBtn) startWaecNecoDrillBtn.addEventListener('click', startWaecNecoDrill);

    if (loadRecentTestsBtn) {
        loadRecentTestsBtn.addEventListener('click', async () => {
            if (!currentStudentId) {
                toast.error('Profile still loading. Please try again in a moment.');
                return;
            }
            loadRecentTestsBtn.disabled = true;
            loadRecentTestsBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
            try {
                await setupRecentTests(currentStudentId);
            } catch (err) {
                console.error('Manual recent tests load failed:', err);
            } finally {
                if (loadRecentTestsBtn.isConnected) {
                    loadRecentTestsBtn.disabled = false;
                    loadRecentTestsBtn.innerHTML = '<i class="fas fa-history"></i> Check Your Recent Tests';
                }
            }
        });
    }
}

initCBTDashboard();