// cbt/js/cbt.js - Acadex CBT Dashboard (Student)
// Preserves all existing practice test functionality.
// Adds real‑time assigned tests table with status from Firestore.
// In recent tests, shows actual subject name plus "(Assigned Test)" for CBT tests.
//
// All Firestore operations go through service.js where possible.
// TODO: service.js does not yet support real-time listeners for test_results,
// real-time listeners for assigned CBT tests (array-contains-any), or getCbtById
// for starting a test – those remain as direct Firestore calls.
// All user-facing errors now show clear, friendly messages without technical jargon.

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

// ========== CONSTANTS (all existing) ==========
const WAEC_NECO_QUESTIONS = 50;
const WAEC_NECO_TIME = 40 * 60;
const QUESTIONS_TO_FETCH = 20;
const RECENT_TESTS_PAGE_SIZE = 12;

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
    { value: 'agric', name: 'Agricultural Science'},
    { value: 'yoruba', name: 'Yoruba'}
];

// ========== DOM ELEMENTS (existing) ==========
const getElement = (id) => document.getElementById(id);
const startQuickTestBtn = getElement('startQuickTestBtn');
const classSelect = getElement('classSelect');
const subjectSelect = getElement('subjectSelect');
const userName = getElement('userName');
const completedTests = getElement('completedTests');
const averageScore = getElement('averageScore');
const performanceMessage = getElement('performanceMessage');
const additionalSubjectsDiv = getElement('additionalSubjects');
const startJambDrillBtn = getElement('startJambDrillBtn');
const waecNecoSubjectSelect = getElement('waecNecoSubjectSelect');
const startWaecNecoDrillBtn = getElement('startWaecNecoDrillBtn');
const assignedCbtSection = getElement('assignedCbtSection');
const assignedTestsWrapper = getElement('assignedTestsTableWrapper');
const cbtErrorMessage = getElement('cbtErrorMessage');

// ========== STATE ==========
let currentStudentData = null;
let currentStudentId = null;
let currentSchoolId = null;
let unsubscribeRecentTests = null;
let lastVisibleRecentDoc = null;
let unsubscribeAssignedTests = null;

// ========== HELPER FUNCTIONS (existing, unchanged) ==========
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

// ========== STUDENT DATA (using service) ==========
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

// ========== SUBJECT DROPDOWNS (existing) ==========
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

// ========== RECENT TESTS (real-time listener – kept direct Firestore) ==========
function setupRecentTests(userId) {
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
    unsubscribeRecentTests = onSnapshot(q, (snapshot) => {
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
    }, (error) => {
        console.error("Error loading recent tests:", error);
        toast.error('Unable to load recent tests. Please refresh the page.');
        recentTestsList.innerHTML = '<p class="error">Error loading recent tests. Please refresh.</p>';
    });
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

// ========== STATISTICS (using service.getTestResultsByUser) ==========
async function updateBasicStats(userId) {
    try {
        const results = await service.getTestResultsByUser(userId);
        let totalTests = 0, totalScore = 0;
        results.forEach(data => {
            let score = data.score;
            if (data.mode === 'jamb_drill' && data.totalQuestions) score = (data.rawScore / data.totalQuestions) * 100;
            if (score !== undefined && score !== null) {
                totalTests++;
                totalScore += score;
            }
        });
        if (completedTests) completedTests.textContent = totalTests;
        const avg = totalTests > 0 ? Math.round(totalScore / totalTests) : 0;
        if (averageScore) averageScore.textContent = avg;
        let msg = "Start practicing!";
        if (avg >= 90) msg = "Excellent!";
        else if (avg >= 80) msg = "Great job!";
        else if (avg >= 70) msg = "Good work!";
        else if (avg >= 60) msg = "Keep improving!";
        if (performanceMessage) performanceMessage.textContent = msg;
    } catch (err) {
        console.error('Error updating stats:', err);
        toast.warning('Unable to update statistics. Please refresh the page.');
    }
}

// ========== ASSIGNED TESTS TABLE (real-time listener – kept direct Firestore) ==========
function subscribeToAssignedTests() {
    if (!currentSchoolId || !currentStudentId || !currentStudentData) return;
    if (unsubscribeAssignedTests) unsubscribeAssignedTests();

    const studentClassId = currentStudentData.classId;
    const q = query(
        collection(db, 'cbt'),
        where('schoolId', '==', currentSchoolId),
        where('assignedTo', 'array-contains-any', [currentStudentId, studentClassId])
    );

    unsubscribeAssignedTests = onSnapshot(q, (snapshot) => {
        const tests = [];
        snapshot.forEach(docSnap => {
            const test = { id: docSnap.id, ...docSnap.data() };
            tests.push(test);
        });
        renderAssignedTestsTable(tests);
    }, (err) => {
        console.error('Error listening to assigned tests:', err);
        toast.warning('Unable to load assigned tests. Please refresh the page.');
        if (assignedTestsWrapper) assignedTestsWrapper.innerHTML = '<p class="error">Error loading assigned tests. Please refresh.</p>';
    });
}

function renderAssignedTestsTable(tests) {
    if (!assignedTestsWrapper) return;

    if (!tests || tests.length === 0) {
        assignedTestsWrapper.innerHTML = '<p class="no-tests">No assigned tests yet.</p>';
        return;
    }

    const rows = tests.map(test => {
        const status = test.status || 'pending';
        let statusBadge = '';
        if (status === 'started') statusBadge = '<span class="status-badge status-started">Started</span>';
        else if (status === 'pending') statusBadge = '<span class="status-badge status-pending">Pending</span>';
        else if (status === 'expired') statusBadge = '<span class="status-badge status-expired">Expired</span>';
        else statusBadge = `<span class="status-badge">${escapeHtml(status)}</span>`;

        const isTakeEnabled = (status === 'started');
        const takeButton = `<button class="take-test-btn" data-id="${test.id}" ${!isTakeEnabled ? 'disabled' : ''}>Take Test</button>`;

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
                    </table>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;

    document.querySelectorAll('.take-test-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const cbtId = btn.dataset.id;
            await startAssignedTest(cbtId);
        });
    });
}

async function startAssignedTest(cbtId) {
    try {
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

// ========== EXISTING TEST LAUNCHERS (using service.getQuestions) ==========
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

// ========== JAMB DRILL UI (existing) ==========
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
    if (checkboxes.length === 3) { 
        hint.innerHTML = '✅ 3 subjects selected. Ready to start.'; 
        hint.style.color = '#28a745'; 
    } else { 
        hint.innerHTML = `Select exactly 3 subjects (currently ${checkboxes.length} selected)`; 
        hint.style.color = '#dc3545'; 
    }
}

// ========== TAB SYSTEM (existing, but load assigned tests on first show) ==========
function createTabs() {
    const practiceContainer = document.getElementById('practiceTestsContainer');
    const assignedSection = document.getElementById('assignedCbtSection');
    if (!practiceContainer || !assignedSection) return;

    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'cbt-tabs';
    tabsContainer.style.display = 'flex';
    tabsContainer.style.gap = '1rem';
    tabsContainer.style.marginBottom = '1.5rem';
    tabsContainer.style.borderBottom = '2px solid #ddd';
    tabsContainer.style.paddingBottom = '0.5rem';

    const practiceTab = document.createElement('button');
    practiceTab.textContent = '📚 Practice Tests';
    practiceTab.className = 'cbt-tab active';
    practiceTab.style.background = 'none';
    practiceTab.style.border = 'none';
    practiceTab.style.fontSize = '1.1rem';
    practiceTab.style.fontWeight = '600';
    practiceTab.style.cursor = 'pointer';
    practiceTab.style.padding = '0.5rem 1rem';
    practiceTab.style.color = '#6A11CB';
    practiceTab.style.borderBottom = '3px solid #6A11CB';

    const assignedTab = document.createElement('button');
    assignedTab.textContent = '📋 Assigned Tests';
    assignedTab.className = 'cbt-tab';
    assignedTab.style.background = 'none';
    assignedTab.style.border = 'none';
    assignedTab.style.fontSize = '1.1rem';
    assignedTab.style.fontWeight = '600';
    assignedTab.style.cursor = 'pointer';
    assignedTab.style.padding = '0.5rem 1rem';
    assignedTab.style.color = '#666';

    tabsContainer.appendChild(practiceTab);
    tabsContainer.appendChild(assignedTab);

    const dashboardContainer = document.querySelector('.dashboard-container');
    const statsSection = document.querySelector('.stats-section');
    if (statsSection && statsSection.nextSibling) {
        dashboardContainer.insertBefore(tabsContainer, statsSection.nextSibling);
    } else {
        dashboardContainer.appendChild(tabsContainer);
    }

    function showPractice() {
        practiceContainer.style.display = 'block';
        assignedSection.style.display = 'none';
        practiceTab.classList.add('active');
        practiceTab.style.color = '#6A11CB';
        practiceTab.style.borderBottom = '3px solid #6A11CB';
        assignedTab.classList.remove('active');
        assignedTab.style.color = '#666';
        assignedTab.style.borderBottom = 'none';
    }

    function showAssigned() {
        practiceContainer.style.display = 'none';
        assignedSection.style.display = 'block';
        assignedTab.classList.add('active');
        assignedTab.style.color = '#6A11CB';
        assignedTab.style.borderBottom = '3px solid #6A11CB';
        practiceTab.classList.remove('active');
        practiceTab.style.color = '#666';
        practiceTab.style.borderBottom = 'none';
        if (currentSchoolId && currentStudentId && currentStudentData && !unsubscribeAssignedTests) {
            subscribeToAssignedTests();
        }
    }

    practiceTab.addEventListener('click', showPractice);
    assignedTab.addEventListener('click', showAssigned);
    showPractice();
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
            setupRecentTests(currentStudentId);
            await updateBasicStats(currentStudentId);
            createTabs();
        } else {
            console.error('Missing school or student ID');
            toast.error('Unable to load dashboard. School or student information missing.');
        }
    });

    if (startQuickTestBtn) startQuickTestBtn.addEventListener('click', startQuickTest);
    if (startJambDrillBtn) startJambDrillBtn.addEventListener('click', startJambDrill);
    if (startWaecNecoDrillBtn) startWaecNecoDrillBtn.addEventListener('click', startWaecNecoDrill);
}

initCBTDashboard();