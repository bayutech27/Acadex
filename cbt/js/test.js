// cbt/js/test.js - Acadex CBT Engine (with academic session/term integration)
// ADDED: Tab‑switching detector – first violation warns, second auto‑submits.
// ADDED: Page refresh prevention (F5, Ctrl+R, beforeunload, etc.)
// FIXED: Double-trigger bug (blur + visibilitychange both counting), isSubmitting guard conflict.
import { auth, db } from '../../js/firebase-config.js';
import {
    collection, addDoc, getDoc, getDocs, doc, updateDoc,
    increment, serverTimestamp, setDoc
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";
// Academic calendar integration – session & term
import { initAcademicCalendar, getCurrentTerm, getCurrentSession } from '../../js/academic-calendar.js';

// =============================================
// WEAKNESS DETECTION & RECOMMENDATION ENGINE
// =============================================

function getTopicFromQuestion(question) {
    if (question.topic && typeof question.topic === 'string' && question.topic.trim() !== '') {
        return question.topic.trim();
    }
    const possibleFields = ['topicName', 'category', 'subjectTopic'];
    for (const field of possibleFields) {
        if (question[field] && typeof question[field] === 'string' && question[field].trim() !== '') {
            return question[field].trim();
        }
    }
    console.warn('No topic field found in question. Available keys:', Object.keys(question));
    return 'General';
}

function generateWeaknessReport(userAnswers, questions) {
  const topicMap = new Map();
  questions.forEach((q, index) => {
    const answer = userAnswers[index];
    if (answer === null) return;
    const subject = q.subject || 'General';
    const topic = getTopicFromQuestion(q);
    const key = `${subject}|${topic}`;
    const isCorrect = (answer === q.correctAnswer);
    if (!topicMap.has(key)) {
      topicMap.set(key, { subject, topic, total: 0, correct: 0 });
    }
    const record = topicMap.get(key);
    record.total += 1;
    if (isCorrect) record.correct += 1;
  });
  const topics = Array.from(topicMap.values()).map(record => {
    const accuracy = Math.round((record.correct / record.total) * 100);
    let level = 'Weak';
    if (accuracy >= 70) level = 'Strong';
    else if (accuracy >= 50) level = 'Average';
    return { ...record, accuracy, level };
  });
  const subjectGroups = {};
  topics.forEach(t => {
    if (!subjectGroups[t.subject]) subjectGroups[t.subject] = [];
    subjectGroups[t.subject].push(t);
  });
  return Object.entries(subjectGroups).map(([subject, topicList]) => ({ subject, topics: topicList }));
}

async function saveTopicStats(userId, topicStats) {
  if (!userId || !topicStats || topicStats.length === 0) return;
  try {
    for (const subjectData of topicStats) {
      for (const topic of subjectData.topics) {
        const statData = {
          userId,
          subject: subjectData.subject,
          topic: topic.topic,
          total: topic.total,
          correct: topic.correct,
          accuracy: topic.accuracy,
          level: topic.level,
          timestamp: serverTimestamp(),
        };
        await addDoc(collection(db, "users", userId, "topicStats"), statData);
      }
    }
    console.log("✅ Topic stats saved successfully");
  } catch (error) {
    console.error("❌ Error saving topic stats:", error);
  }
}

async function updateCumulativeTopicStats(userId, topicStats) {
    if (!userId || !topicStats || topicStats.length === 0) return;
    try {
        for (const subjectData of topicStats) {
            for (const topic of subjectData.topics) {
                const sanitizedSubject = subjectData.subject.replace(/[^a-zA-Z0-9]/g, '_');
                const sanitizedTopic = topic.topic.replace(/[^a-zA-Z0-9]/g, '_');
                const docId = `${sanitizedSubject}_${sanitizedTopic}`;
                const docRef = doc(db, "users", userId, "topicCumulative", docId);
                const docSnap = await getDoc(docRef);
                let previousAccuracy = null;
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    const prevTotal = data.totalAnswered || 0;
                    const prevCorrect = data.totalCorrect || 0;
                    previousAccuracy = prevTotal > 0 ? Math.round((prevCorrect / prevTotal) * 100) : 0;
                }
                const updateData = {
                    subject: subjectData.subject,
                    topic: topic.topic,
                    totalAnswered: increment(topic.total),
                    totalCorrect: increment(topic.correct),
                    lastUpdated: serverTimestamp(),
                    lastPracticed: serverTimestamp()
                };
                if (previousAccuracy !== null) {
                    updateData.lastAccuracy = previousAccuracy;
                }
                await setDoc(docRef, updateData, { merge: true });
            }
        }
        console.log("✅ Cumulative topic stats updated with trend info");
    } catch (error) {
        console.error("❌ Error updating cumulative topic stats:", error);
    }
}

async function fetchCumulativeTopicStats(userId) {
    if (!userId) return [];
    try {
        const colRef = collection(db, "users", userId, "topicCumulative");
        const snapshot = await getDocs(colRef);
        const stats = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            stats.push({
                subject: data.subject || 'General',
                topic: data.topic || 'Unknown',
                totalAnswered: data.totalAnswered || 0,
                totalCorrect: data.totalCorrect || 0,
                lastUpdated: data.lastUpdated,
                lastAccuracy: data.lastAccuracy,
                lastPracticed: data.lastPracticed
            });
        });
        return stats;
    } catch (error) {
        console.error("❌ Error fetching cumulative topic stats:", error);
        return [];
    }
}

function calculateCumulativeWeakness(cumulativeStats) {
    const topics = cumulativeStats.map(stat => {
        const totalAnswered = stat.totalAnswered || 0;
        const totalCorrect = stat.totalCorrect || 0;
        const accuracy = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;
        let level = 'Weak';
        if (accuracy >= 70) level = 'Strong';
        else if (accuracy >= 50) level = 'Average';
        return {
            subject: stat.subject,
            topic: stat.topic,
            totalAnswered,
            totalCorrect,
            accuracy,
            level,
            lastAccuracy: stat.lastAccuracy,
            lastPracticed: stat.lastPracticed ? stat.lastPracticed.toDate() : null
        };
    });
    const reliableTopics = topics.filter(t => t.totalAnswered >= 5);
    const sortedAsc = [...reliableTopics].sort((a, b) => a.accuracy - b.accuracy);
    const sortedDesc = [...reliableTopics].sort((a, b) => b.accuracy - a.accuracy);
    const weakTopics = sortedAsc.filter(t => t.level === 'Weak').slice(0, 10);
    const strongTopics = sortedDesc.filter(t => t.level === 'Strong').slice(0, 2);
    return { weakTopics, strongTopics };
}

function generateSmartRecommendations(weakTopics) {
    if (!weakTopics || weakTopics.length === 0) {
        return ["Great job! Keep practicing to maintain your strengths."];
    }
    const groupedBySubject = new Map();
    weakTopics.forEach(topic => {
        if (!groupedBySubject.has(topic.subject)) {
            groupedBySubject.set(topic.subject, { subject: topic.subject, topics: [] });
        }
        groupedBySubject.get(topic.subject).topics.push(topic);
    });
    const templates = {
        critical: [
            "{topic} needs urgent attention. Start with simpler practice questions.",
            "{topic} is a critical weakness. Master the basics before attempting harder questions.",
            "Your performance in {topic} is very low. Focus on fundamental concepts."
        ],
        weak: [
            "Spend more time strengthening {topic}.",
            "{topic} requires consistent practice. Try 2–3 Quick Tests this week.",
            "Dedicate extra study sessions to {topic}."
        ],
        improving: [
            "You are improving in {topic}. Keep practicing to cross 50%.",
            "Good progress in {topic}! A few more drills and you'll master it.",
            "{topic} is getting better. Stay consistent!"
        ],
        declining: [
            "Your performance in {topic} is dropping. Revise fundamentals before another drill.",
            "{topic} needs a refresher. Review notes and retry questions.",
            "Don't let {topic} slip! Go back to the basics."
        ],
        timeBased: [
            "You haven't practiced {topic} recently. Attempt a Quick Test to refresh.",
            "It's been a while since you practiced {topic}. A short review will help.",
            "{topic} needs a quick refresher – try a few questions now."
        ],
        grouped: [
            "{subject} needs attention. Focus on {topics} this week.",
            "Your weak areas in {subject} are {topics}. Prioritize them.",
            "Strengthen {subject} by practicing {topics}."
        ]
    };
    function randomTemplate(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
    const candidates = [];
    groupedBySubject.forEach((group, subject) => {
        const topics = group.topics;
        if (topics.length >= 2) {
            const topicNames = topics.map(t => t.topic).join(', ');
            let template = randomTemplate(templates.grouped);
            candidates.push(template.replace('{subject}', subject).replace('{topics}', topicNames));
        } else {
            const topic = topics[0];
            const accuracy = topic.accuracy;
            const lastAccuracy = topic.lastAccuracy;
            const lastPracticed = topic.lastPracticed;
            let severity = accuracy < 35 ? 'critical' : 'weak';
            let trend = 'stable';
            if (lastAccuracy !== undefined && lastAccuracy !== null) {
                if (accuracy > lastAccuracy) trend = 'improving';
                else if (accuracy < lastAccuracy) trend = 'declining';
            }
            let pool;
            if (trend === 'improving') pool = templates.improving;
            else if (trend === 'declining') pool = templates.declining;
            else pool = templates[severity];
            let message = randomTemplate(pool).replace('{topic}', topic.topic);
            if (lastPracticed) {
                const daysAgo = (Date.now() - lastPracticed.getTime()) / (1000 * 60 * 60 * 24);
                if (daysAgo > 5) {
                    const timeHint = randomTemplate(templates.timeBased).replace('{topic}', topic.topic);
                    message += ' ' + timeHint;
                }
            }
            candidates.push(message);
        }
    });
    const shuffled = candidates.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 3);
    if (selected.length === 0) return ["Great job! Keep practicing to maintain your strengths."];
    return selected;
}

// =============================================
// DOM Elements
// =============================================
const testSubject = document.getElementById('testSubject');
const questionCounter = document.getElementById('questionCounter');
const currentQuestionSpan = document.getElementById('currentQuestion');
const totalQuestionsSpan = document.getElementById('totalQuestions');
const timerElement = document.getElementById('timer');
const questionContent = document.getElementById('questionContent');
const optionsContainer = document.getElementById('optionsContainer');
const progressBar = document.getElementById('progressBar');
const questionDots = document.getElementById('questionDots');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const getResultBtn = document.getElementById('getResultBtn');
const submitModal = document.getElementById('submitModal');
const resultsModal = document.getElementById('resultsModal');
const cancelSubmit = document.getElementById('cancelSubmit');
const confirmSubmit = document.getElementById('confirmSubmit');
const answeredCount = document.getElementById('answeredCount');
const totalQuestionsModal = document.getElementById('totalQuestionsModal');
const finalScore = document.getElementById('finalScore');
const scoreLabel = document.getElementById('scoreLabel');
const correctCount = document.getElementById('correctCount');
const totalQuestionsCount = document.getElementById('totalQuestionsCount');
const performanceMessage = document.getElementById('performanceMessage');
const backToDashboard = document.getElementById('backToDashboard');
const subjectTabs = document.getElementById('subjectTabs');
const subjectBreakdown = document.getElementById('subjectBreakdown');
const subjectBreakdownList = document.getElementById('subjectBreakdownList');

let testData = null;
let timeRemaining = 0;
let timerInterval = null;
let currentQuestionIndex = 0;
let currentUser = null;
let subjectStartIndices = {};
let subjectCounts = {};

// =============================================
// ANTI-CHEAT — tab switch detector + refresh block
// =============================================

/* Path to student dashboard (root/student/student-portal.html) */
const DASHBOARD_URL = '../../student/student-portal.html';

let tabSwitchCount = 0;
let isSubmitting = false;
let warningTimeout = null;

/* Timestamp of the last visibility-loss event — used to deduplicate
   cases where both 'blur' and 'visibilitychange' fire in the same tick. */
let lastViolationTs = 0;

const antiCheatWarningModal = document.getElementById('antiCheatWarningModal');
const warningMessageElement = antiCheatWarningModal?.querySelector('.warning-message');

function showAntiCheatModal(message, autoCloseMs = 5000) {
    if (!antiCheatWarningModal || !warningMessageElement) return;
    if (warningTimeout) clearTimeout(warningTimeout);
    warningMessageElement.textContent = message;
    antiCheatWarningModal.style.display = 'flex';
    warningTimeout = setTimeout(() => {
        antiCheatWarningModal.style.display = 'none';
        warningTimeout = null;
    }, autoCloseMs);
}

/**
 * Called only by the 'visibilitychange' listener.
 * Fires once per tab-switch because we only listen to this single event.
 */
function handleVisibilityLoss() {
    /* Only act when the tab is actually hidden */
    if (!document.hidden) return;
    /* Safety guard — if submission already in progress, ignore */
    if (isSubmitting) return;

    /* Debounce: some browsers fire the event twice in quick succession */
    const now = Date.now();
    if (now - lastViolationTs < 800) return;
    lastViolationTs = now;

    tabSwitchCount++;

    if (tabSwitchCount === 1) {
        showAntiCheatModal(
            '⚠️ Tab switching detected! This is your only warning. ' +
            'Switching tabs again will immediately auto-submit your test.',
            7000
        );
    } else {
        /* Second (or later) violation — auto-submit and redirect */
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
        showAntiCheatModal(
            '❌ Test auto-submitted: repeated tab switching detected. Redirecting to dashboard…',
            4000
        );
        /* Give the modal 1.5 s to display before navigating away */
        setTimeout(() => { forceSubmitAndRedirect(); }, 1500);
    }
}

/**
 * Block F5 / Ctrl+R / Cmd+R keyboard shortcuts.
 * The beforeunload handler covers the browser-button refresh.
 */
function preventRefresh(e) {
    const key = e.key;
    const isRefreshKey =
        key === 'F5' ||
        (e.ctrlKey  && (key === 'r' || key === 'R')) ||
        (e.ctrlKey  && e.shiftKey && (key === 'r' || key === 'R')) ||
        (e.metaKey  && (key === 'r' || key === 'R'));

    if (isRefreshKey) {
        e.preventDefault();
        e.stopPropagation();
        showAntiCheatModal(
            '⚠️ Page refresh is not allowed during the test. Please continue.',
            4000
        );
        return false;
    }
}

/**
 * Block browser-button / address-bar navigations that would refresh the page.
 * Removed automatically just before a legitimate redirect so it doesn't
 * interfere with the post-submit navigation.
 */
function preventBeforeUnload(e) {
    e.preventDefault();
    /* Modern browsers require returnValue to be set */
    e.returnValue = 'Your test is in progress. Leaving this page will discard your answers.';
    return e.returnValue;
}

function initAntiCheat() {
    /* Single listener — visibilitychange is the authoritative tab-switch event.
       We do NOT add a 'blur' listener; blur fires on any focus loss (devtools,
       address bar click, etc.) and would cause false double-counts. */
    document.addEventListener('visibilitychange', handleVisibilityLoss);

    /* Block keyboard-shortcut refreshes */
    window.addEventListener('keydown', preventRefresh, true);

    /* Block browser-button / address-bar refreshes */
    window.addEventListener('beforeunload', preventBeforeUnload);
}

/**
 * Called when auto-submit is triggered by the anti-cheat system.
 * Removes the beforeunload guard first so the redirect can proceed cleanly.
 */
async function forceSubmitAndRedirect() {
    /* Prevent double invocation */
    if (isSubmitting) {
        window.removeEventListener('beforeunload', preventBeforeUnload);
        window.location.href = DASHBOARD_URL;
        return;
    }
    /* Remove the refresh block before we intentionally navigate */
    window.removeEventListener('beforeunload', preventBeforeUnload);
    /* submitTest manages the isSubmitting flag internally */
    await submitTest(/* redirectAfter = */ true);
}

// =============================================
// INITIALIZATION with Acadex session validation
// =============================================
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('currentYear').textContent = new Date().getFullYear();

    const schoolId = localStorage.getItem('userSchoolId');
    const studentId = localStorage.getItem('studentId');
    if (!schoolId || !studentId) {
        alert('Invalid session. Please log in again.');
        window.location.href = '../../index.html';
        return;
    }

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = '../../index.html';
        } else {
            currentUser = user;
            await initAcademicCalendar().catch(e => console.warn('Academic calendar init failed:', e));
            await loadTestData();
        }
    });

    prevBtn.addEventListener('click', showPreviousQuestion);
    nextBtn.addEventListener('click', showNextQuestion);
    getResultBtn.addEventListener('click', showSubmitModal);
    cancelSubmit.addEventListener('click', hideSubmitModal);
    confirmSubmit.addEventListener('click', () => submitTest(false));
    backToDashboard.addEventListener('click', goToDashboard);
    document.addEventListener('keydown', handleKeyboardNavigation);

    initAntiCheat();
});

// =============================================
// HELPER FUNCTIONS
// =============================================
function fixExcelFraction(value) {
    if (typeof value !== "string") return value;
    const months = { Jan: "1", Feb: "2", Mar: "3", Apr: "4", May: "5", Jun: "6", Jul: "7", Aug: "8", Sep: "9", Oct: "10", Nov: "11", Dec: "12" };
    const match1 = value.match(/^(\d{1,2})-([A-Za-z]{3})$/);
    if (match1) {
        const day = parseInt(match1[1], 10);
        const monthAbbr = match1[2];
        if (months[monthAbbr]) return `${day}/${months[monthAbbr]}`;
    }
    const match2 = value.match(/^([A-Za-z]{3})-(\d{1,2})$/);
    if (match2) {
        const monthAbbr = match2[1];
        const day = parseInt(match2[2], 10);
        if (months[monthAbbr]) return `${months[monthAbbr]}/${day}`;
    }
    return value;
}

function formatTextForDisplay(text) {
    if (!text) return "";
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\n/g, '<br>');
}

function processSolutionText(text) {
    if (!text) return '';
    let processed = text.replace(/\^(\d+)/g, '<sup>$1</sup>').replace(/_(\d+)/g, '<sub>$1</sub>');
    processed = processed.replace(/([A-Z][a-z]?)(\d+)/g, (match, element, number) => element + '<sub>' + number + '</sub>');
    return processed.replace(/\n/g, '<br>');
}

// =============================================
// LOAD TEST DATA
// =============================================
async function loadTestData() {
    const savedTest = sessionStorage.getItem('currentTest');
    if (!savedTest) {
        alert('No test found. Please start a test from the dashboard.');
        window.location.href = DASHBOARD_URL;
        return;
    }
    try {
        testData = JSON.parse(savedTest);
        console.log("Test data loaded:", testData);
        initializeTest();
    } catch (error) {
        console.error('Error loading test data:', error);
        alert('Error loading test. Please try again.');
        window.location.href = DASHBOARD_URL;
    }
}

function initializeTest() {
    if (!testData || !testData.questions) {
        alert('Error: Test questions not loaded properly.');
        window.location.href = DASHBOARD_URL;
        return;
    }

    if (testData.mode === 'cbt') {
        testSubject.innerHTML = `<i class="fas fa-laptop"></i> CBT: ${testData.title || 'Assigned Test'}`;
    } else if (testData.mode === 'jamb_drill') {
        const subjectsList = testData.subjects.map(s => s.name).join(' + ');
        testSubject.innerHTML = `<i class="fas fa-graduation-cap"></i> JAMB Drill: ${subjectsList}`;
        let idx = 0;
        testData.subjects.forEach(subj => {
            subjectStartIndices[subj.value] = idx;
            subjectCounts[subj.value] = subj.count;
            idx += subj.count;
        });
        renderSubjectTabs();
    } else if (testData.mode === 'waec_neco') {
        const subjectName = testData.subject ? testData.subject.charAt(0).toUpperCase() + testData.subject.slice(1) : 'Unknown Subject';
        testSubject.innerHTML = `<i class="fas fa-school"></i> WAEC/NECO Drill: ${subjectName}`;
    } else {
        const subjectName = testData.subject ? testData.subject.charAt(0).toUpperCase() + testData.subject.slice(1) : 'Unknown Subject';
        testSubject.innerHTML = `<i class="fas fa-book"></i> Quick Test: ${subjectName} - ${testData.examType || 'Test'}`;
    }

    totalQuestionsSpan.textContent = testData.totalQuestions || testData.questions.length;
    totalQuestionsModal.textContent = testData.totalQuestions || testData.questions.length;
    timeRemaining = testData.totalTime || (testData.questions.length * 120);
    updateTimerDisplay();
    startTimer();
    generateQuestionDots();
    if (!testData.userAnswers) testData.userAnswers = Array(testData.questions.length).fill(null);
    loadQuestion(0);
    updateProgressBar();
    updateAnsweredCount();
}

function renderSubjectTabs() {
    if (!subjectTabs || testData.mode !== 'jamb_drill') return;
    subjectTabs.style.display = 'block';
    subjectTabs.innerHTML = '';
    testData.subjects.forEach((subj) => {
        const tab = document.createElement('button');
        tab.className = 'subject-tab';
        tab.dataset.subject = subj.value;
        tab.textContent = subj.name;
        tab.addEventListener('click', () => switchToSubject(subj.value));
        subjectTabs.appendChild(tab);
    });
    document.querySelectorAll('.subject-tab').forEach(tab => {
        tab.style.padding = '10px 20px';
        tab.style.marginRight = '5px';
        tab.style.border = 'none';
        tab.style.borderRadius = '20px';
        tab.style.background = '#e0e0e0';
        tab.style.cursor = 'pointer';
        tab.style.fontSize = '14px';
        tab.style.fontWeight = '500';
        tab.style.transition = 'all 0.3s';
    });
    highlightActiveSubjectTab(testData.questions[0]?.subject);
}

function highlightActiveSubjectTab(subject) {
    document.querySelectorAll('.subject-tab').forEach(tab => {
        if (tab.dataset.subject === subject) {
            tab.style.background = 'var(--eggplant)';
            tab.style.color = 'white';
        } else {
            tab.style.background = '#e0e0e0';
            tab.style.color = '#333';
        }
    });
}

function switchToSubject(subject) {
    if (subjectStartIndices[subject] !== undefined) {
        loadQuestion(subjectStartIndices[subject]);
        highlightActiveSubjectTab(subject);
    }
}

function loadQuestion(index) {
    if (!testData || !testData.questions || index < 0 || index >= testData.questions.length) return;
    currentQuestionIndex = index;
    const question = testData.questions[index];
    if (!question) return;

    questionContent.innerHTML = '';
    const hasQuestionText = question.questionText && question.questionText.trim() !== '';
    const hasQuestionImage = question.questionImage;
    let questionHTML = '';
    if (hasQuestionText && hasQuestionImage) {
        questionHTML = `<div class="question-text-content">${formatTextForDisplay(question.questionText)}</div><div class="question-image-container"><img src="${question.questionImage}" alt="Question image" class="question-image"></div>`;
    } else if (hasQuestionText) {
        questionHTML = `<div class="question-text-content">${formatTextForDisplay(question.questionText)}</div>`;
    } else if (hasQuestionImage) {
        questionHTML = `<div class="question-image-container"><img src="${question.questionImage}" alt="Question image" class="question-image"></div>`;
    } else {
        questionHTML = `<div class="question-text-content">Question content not available</div>`;
    }
    questionContent.innerHTML = questionHTML;
    currentQuestionSpan.textContent = index + 1;
    optionsContainer.innerHTML = '';

    const rawOptions = question.options || { A: question.optionA || "", B: question.optionB || "", C: question.optionC || "", D: question.optionD || "" };
    const options = { A: fixExcelFraction(rawOptions.A), B: fixExcelFraction(rawOptions.B), C: fixExcelFraction(rawOptions.C), D: fixExcelFraction(rawOptions.D) };
    ['A', 'B', 'C', 'D'].forEach(letter => {
        if (options[letter]) {
            const optionElement = document.createElement('div');
            optionElement.className = 'option';
            optionElement.dataset.option = letter;
            if (testData.userAnswers[index] === letter) optionElement.classList.add('selected');
            optionElement.innerHTML = `<div class="option-letter">${letter}</div><div class="option-text">${options[letter]}</div>`;
            optionElement.addEventListener('click', () => selectOption(letter));
            optionsContainer.appendChild(optionElement);
        }
    });

    prevBtn.disabled = index === 0;
    nextBtn.disabled = index === testData.questions.length - 1;
    updateActiveDot(index);
    updateProgressBar();
    if (testData.mode === 'jamb_drill' && question.subject) highlightActiveSubjectTab(question.subject);
}

function selectOption(optionLetter) {
    document.querySelectorAll('.option').forEach(opt => opt.classList.remove('selected'));
    const selected = document.querySelector(`.option[data-option="${optionLetter}"]`);
    if (selected) selected.classList.add('selected');
    testData.userAnswers[currentQuestionIndex] = optionLetter;
    updateAnsweredDot(currentQuestionIndex);
    updateAnsweredCount();
}

function generateQuestionDots() {
    if (!testData || !testData.questions) return;
    questionDots.innerHTML = '';
    for (let i = 0; i < testData.questions.length; i++) {
        const dot = document.createElement('div');
        dot.className = 'dot';
        if (i === currentQuestionIndex) dot.classList.add('active');
        if (testData.userAnswers && testData.userAnswers[i] !== null) dot.classList.add('answered');
        dot.dataset.index = i;
        dot.addEventListener('click', () => loadQuestion(i));
        questionDots.appendChild(dot);
    }
}

function updateActiveDot(index) {
    document.querySelectorAll('.dot').forEach((dot, i) => {
        dot.classList.remove('active');
        if (i === index) dot.classList.add('active');
    });
}

function updateAnsweredDot(index) {
    const dot = document.querySelector(`.dot[data-index="${index}"]`);
    if (dot) dot.classList.add('answered');
}

function updateProgressBar() {
    if (!testData || !testData.questions) return;
    const progress = ((currentQuestionIndex + 1) / testData.questions.length) * 100;
    progressBar.style.width = `${progress}%`;
}

function updateAnsweredCount() {
    if (!testData || !testData.userAnswers) return;
    const answered = testData.userAnswers.filter(a => a !== null).length;
    answeredCount.textContent = answered;
}

function showPreviousQuestion() { if (currentQuestionIndex > 0) loadQuestion(currentQuestionIndex - 1); }
function showNextQuestion() { if (currentQuestionIndex < testData.questions.length - 1) loadQuestion(currentQuestionIndex + 1); }

function startTimer() {
    updateTimerDisplay();
    timerInterval = setInterval(() => {
        timeRemaining--;
        updateTimerDisplay();
        if (timeRemaining <= 300) timerElement.classList.add('warning');
        if (timeRemaining <= 0) { clearInterval(timerInterval); timerInterval = null; autoSubmitTest(); }
    }, 1000);
}

function updateTimerDisplay() {
    const minutes = Math.floor(timeRemaining / 60);
    const seconds = timeRemaining % 60;
    timerElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function showSubmitModal() { updateAnsweredCount(); submitModal.style.display = 'flex'; }
function hideSubmitModal() { submitModal.style.display = 'none'; }
function autoSubmitTest() { getResultBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Time\'s Up! Submitting...'; setTimeout(() => submitTest(false), 1000); }

// =============================================
// SAVE TEST RESULT TO FIRESTORE (with session & term)
// =============================================
async function saveTestResultToFirestore(score, correctAnswers, rawScore, subjectScores = null) {
    try {
        if (!currentUser) {
            await new Promise(resolve => setTimeout(resolve, 200));
            if (!auth.currentUser) throw new Error("User not authenticated");
            currentUser = auth.currentUser;
        }
        const schoolId = localStorage.getItem('userSchoolId');
        if (!schoolId) throw new Error("School ID missing");

        let classId = null;
        let className = null;
        try {
            const studentDocRef = doc(db, 'students', currentUser.uid);
            const studentSnap = await getDoc(studentDocRef);
            if (studentSnap.exists()) {
                const studentData = studentSnap.data();
                classId = studentData.classId || null;
                className = studentData.className || null;
                if (classId && !className) {
                    const classDoc = await getDoc(doc(db, 'classes', classId));
                    if (classDoc.exists()) {
                        className = classDoc.data().name || null;
                    }
                }
            } else {
                console.warn("Student document not found for UID:", currentUser.uid);
            }
        } catch (err) {
            console.warn("Could not fetch student class info:", err);
        }

        const subjectName = testData.mode === 'quick'
            ? (testData.subject ? testData.subject.charAt(0).toUpperCase() + testData.subject.slice(1) : 'Unknown Subject')
            : testData.mode === 'jamb_drill' ? 'JAMB Drill' : testData.mode === 'waec_neco' ? 'WAEC/NECO Drill' : (testData.title || 'CBT Test');

        let userName = currentUser.displayName || '';
        if (!userName && currentUser.email) userName = currentUser.email.split('@')[0];
        if (!userName) userName = 'Anonymous';

        const questionsData = testData.questions.map((q, index) => ({
            id: q.id || `q-${index}`,
            questionText: q.questionText || "",
            hasQuestionImage: !!q.questionImage,
            correctAnswer: q.correctAnswer || "",
            userAnswer: testData.userAnswers[index] || null,
            subject: q.subject || testData.subject
        }));

        let session = '';
        let term = '';
        try {
            session = getCurrentSession();
            term = getCurrentTerm();
        } catch (e) {
            console.warn('Academic calendar not ready, using empty strings for session/term');
        }

        const resultData = {
            completedAt: serverTimestamp(),
            correctAnswers: correctAnswers,
            rawScore: rawScore,
            examType: testData.examType || "Practice",
            mode: testData.mode || 'quick',
            plan: 'full_access',
            questions: questionsData,
            score: score,
            subject: testData.subject || "general",
            subjectName: subjectName,
            testId: testData.testId || `test-${Date.now()}`,
            timeSpent: (testData.totalTime || (testData.questions.length * 120)) - timeRemaining,
            totalQuestions: testData.questions.length,
            userAnswers: testData.userAnswers.map(a => a || null),
            userId: currentUser.uid,
            userName: userName,
            schoolId: schoolId,
            cbtId: testData.cbtId || null,
            classId: classId,
            className: className,
            session: session,
            term: term
        };

        if (testData.mode === 'jamb_drill') {
            resultData.subjects = testData.subjects;
            resultData.subjectScores = subjectScores;
            resultData.totalRawScore = rawScore;
            resultData.totalPossible = testData.totalQuestions;
        } else if (testData.mode === 'waec_neco' && subjectScores) {
            resultData.subjectScores = subjectScores;
            resultData.totalRawScore = rawScore;
            resultData.totalPossible = testData.totalQuestions;
        }

        console.log("Saving test result to Firestore:", resultData);
        const docRef = await addDoc(collection(db, "test_results"), resultData);
        console.log('✅ Test result saved to Firestore with ID:', docRef.id);
        showToast('✅ Test result saved successfully!', 'success');
        return docRef.id;
    } catch (error) {
        console.error('❌ ERROR SAVING TO FIRESTORE:', error);
        showToast(`❌ Failed to save test result: ${error.message}`, 'error');
        throw error;
    }
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    let bgColor = '#4CAF50';
    if (type === 'error') bgColor = '#f44336';
    if (type === 'warning') bgColor = '#ff9800';
    toast.style.cssText = `position: fixed; top: 20px; right: 20px; background: ${bgColor}; color: white; padding: 15px 20px; border-radius: 8px; z-index: 9999; box-shadow: 0 4px 6px rgba(0,0,0,0.1); font-size: 14px; animation: slideIn 0.3s ease-out; max-width: 300px;`;
    let icon = '✅';
    if (type === 'error') icon = '❌';
    if (type === 'warning') icon = '⚠️';
    toast.innerHTML = `${icon} ${message}`;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.5s';
        setTimeout(() => { if (toast.parentNode) document.body.removeChild(toast); }, 500);
    }, 5000);
}

// =============================================
// SUBMIT TEST
// =============================================
async function submitTest(redirectAfter = false) {
    /* Prevent re-entry */
    if (isSubmitting) return;
    isSubmitting = true;

    /* Always remove the beforeunload guard before any navigation or
       long async work — prevents the browser blocking our redirect */
    window.removeEventListener('beforeunload', preventBeforeUnload);

    hideSubmitModal();
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    getResultBtn.classList.add('btn-loading');
    getResultBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Calculating Score...';

    try {
        let correctAnswers = 0;
        testData.questions.forEach((question, idx) => {
            if (testData.userAnswers[idx] === question.correctAnswer) correctAnswers++;
        });

        let finalDisplayScore, rawScore = correctAnswers, subjectScores = null;
        if (testData.mode === 'jamb_drill') {
            subjectScores = {};
            testData.subjects.forEach(subj => { subjectScores[subj.value] = { correct: 0, total: subj.count }; });
            testData.questions.forEach((q, idx) => {
                if (testData.userAnswers[idx] === q.correctAnswer) {
                    const subj = q.subject;
                    if (subj && subjectScores[subj]) subjectScores[subj].correct++;
                }
            });
            finalDisplayScore = Math.round((correctAnswers / testData.totalQuestions) * 400);
            scoreLabel.textContent = '/400 Score';
        } else if (testData.mode === 'waec_neco') {
            subjectScores = {};
            subjectScores[testData.subject] = { correct: correctAnswers, total: testData.totalQuestions };
            finalDisplayScore = Math.round((correctAnswers / testData.questions.length) * 100);
            scoreLabel.textContent = '% Score';
        } else {
            finalDisplayScore = Math.round((correctAnswers / testData.questions.length) * 100);
            scoreLabel.textContent = '% Score';
        }

        const isCbtExam = (testData.examType === 'CBT' || testData.mode === 'cbt');
        if (!isCbtExam) {
            const topicStats = generateWeaknessReport(testData.userAnswers, testData.questions);
            if (topicStats.length > 0) {
                saveTopicStats(currentUser.uid, topicStats).catch(e => console.warn(e));
                await updateCumulativeTopicStats(currentUser.uid, topicStats);
                const cumulative = await fetchCumulativeTopicStats(currentUser.uid);
                let filtered = cumulative;
                if (testData.mode === 'quick' || testData.mode === 'waec_neco') filtered = cumulative.filter(s => s.subject === testData.subject);
                else if (testData.mode === 'jamb_drill') filtered = cumulative.filter(s => testData.subjects.map(x => x.value).includes(s.subject));
                const { weakTopics, strongTopics } = calculateCumulativeWeakness(filtered);
                testData.weakTopics = weakTopics;
                testData.strongTopics = strongTopics;
                testData.recommendations = generateSmartRecommendations(weakTopics);
            } else {
                testData.weakTopics = [];
                testData.strongTopics = [];
                testData.recommendations = [];
            }
        } else {
            testData.weakTopics = [];
            testData.strongTopics = [];
            testData.recommendations = [];
        }

        let saveSuccess = false;
        try {
            await saveTestResultToFirestore(finalDisplayScore, correctAnswers, correctAnswers, subjectScores);
            saveSuccess = true;
        } catch (firstError) {
            if (firstError.message.includes('permission') || firstError.code === 'permission-denied') {
                console.warn("Permission denied, attempting to refresh user session...");
                await new Promise(resolve => setTimeout(resolve, 500));
                currentUser = auth.currentUser;
                if (currentUser) {
                    await saveTestResultToFirestore(finalDisplayScore, correctAnswers, correctAnswers, subjectScores);
                    saveSuccess = true;
                } else {
                    throw new Error("Authentication lost. Please log in again.");
                }
            } else {
                throw firstError;
            }
        }

        if (!saveSuccess) throw new Error("Failed to save test result after retry.");

        /* ── Auto-submit path: redirect straight to dashboard ── */
        if (redirectAfter) {
            window.location.href = DASHBOARD_URL;
            return;
        }

        let message = "";
        if (testData.mode === 'jamb_drill') {
            const percent = (correctAnswers / testData.questions.length) * 100;
            if (percent >= 90) message = "Excellent! You're on track for a great JAMB score!";
            else if (percent >= 80) message = "Very good! Keep practicing.";
            else if (percent >= 70) message = "Good effort. Review your weak areas.";
            else message = "Keep practicing. You'll improve!";
        } else {
            if (finalDisplayScore >= 90) message = "Excellent! You're a master of this subject!";
            else if (finalDisplayScore >= 80) message = "Great job! You have a strong understanding.";
            else if (finalDisplayScore >= 70) message = "Good work! Keep practicing to improve.";
            else if (finalDisplayScore >= 60) message = "Not bad! Review the topics you missed.";
            else message = "Keep practicing! You'll improve with more study.";
        }
        showResults(finalDisplayScore, correctAnswers, message, subjectScores);
    } catch (error) {
        console.error('Error in submitTest:', error);
        getResultBtn.classList.remove('btn-loading');
        getResultBtn.innerHTML = '<i class="fas fa-check-circle"></i> Submit Test';
        alert(`❌ Error submitting test: ${error.message || 'Please try again.'}`);
        isSubmitting = false;
        /* Re-attach the beforeunload guard since we're still on the page */
        window.addEventListener('beforeunload', preventBeforeUnload);
    }
}

// =============================================
// SHOW RESULTS
// =============================================
function showResults(score, correctAnswers, message, subjectScores) {
    getResultBtn.classList.remove('btn-loading');
    getResultBtn.innerHTML = '<i class="fas fa-check-circle"></i> Submit Test';
    finalScore.textContent = score;
    correctCount.textContent = correctAnswers;
    totalQuestionsCount.textContent = testData.questions.length;
    if (performanceMessage) performanceMessage.textContent = message;

    const isCbtExam = (testData.examType === 'CBT' || testData.mode === 'cbt');

    const topicBreakdownContainer = document.getElementById('topicBreakdownContainer');
    const topicBreakdownList = document.getElementById('topicBreakdownList');
    if (topicBreakdownContainer && topicBreakdownList && !isCbtExam && ((testData.weakTopics && testData.weakTopics.length) || (testData.strongTopics && testData.strongTopics.length))) {
        let html = '';
        if (testData.weakTopics && testData.weakTopics.length) {
            html += '<div style="margin-top: 8px; font-weight: 600; color: #dc3545;">Weak Areas</div>';
            testData.weakTopics.forEach(t => {
                html += `<div class="topic-item"><span class="topic-name">${t.topic} (${t.subject})</span><span class="topic-stats">${t.totalCorrect}/${t.totalAnswered} (${t.accuracy}%)</span><span class="topic-accuracy accuracy-weak">Weak</span></div>`;
            });
        }
        if (testData.strongTopics && testData.strongTopics.length) {
            html += '<div style="margin-top: 16px; font-weight: 600; color: #28a745;">Strong Areas</div>';
            testData.strongTopics.forEach(t => {
                html += `<div class="topic-item"><span class="topic-name">${t.topic} (${t.subject})</span><span class="topic-stats">${t.totalCorrect}/${t.totalAnswered} (${t.accuracy}%)</span><span class="topic-accuracy accuracy-strong">Strong</span></div>`;
            });
        }
        topicBreakdownList.innerHTML = html;
        topicBreakdownContainer.style.display = 'block';
    } else if (topicBreakdownContainer) {
        topicBreakdownContainer.style.display = 'none';
    }

    const recommendationsContainer = document.getElementById('recommendationsContainer');
    const recommendationsList = document.getElementById('recommendationsList');
    if (recommendationsContainer && recommendationsList && !isCbtExam && testData.recommendations && testData.recommendations.length) {
        recommendationsList.innerHTML = testData.recommendations.map(r => `<li>${r}</li>`).join('');
        recommendationsContainer.style.display = 'block';
    } else if (recommendationsContainer) {
        recommendationsContainer.style.display = 'none';
    }

    if (subjectScores && (testData.mode === 'jamb_drill' || testData.mode === 'waec_neco')) {
        subjectBreakdown.style.display = 'block';
        let html = '';
        if (testData.mode === 'jamb_drill') {
            testData.subjects.forEach(subj => {
                const data = subjectScores[subj.value] || { correct: 0, total: subj.count };
                html += `<div style="margin: 5px 0;"><strong>${subj.name}:</strong> ${data.correct}/${data.total}</div>`;
            });
        } else {
            const subjName = testData.subject.charAt(0).toUpperCase() + testData.subject.slice(1);
            const data = subjectScores[testData.subject] || { correct: correctAnswers, total: testData.totalQuestions };
            html += `<div style="margin: 5px 0;"><strong>${subjName}:</strong> ${data.correct}/${data.total}</div>`;
        }
        subjectBreakdownList.innerHTML = html;
    } else {
        subjectBreakdown.style.display = 'none';
    }

    resultsModal.style.display = 'flex';
    addSolutionButton();
    sessionStorage.removeItem('currentTest');
    try { sessionStorage.setItem('previousTest', JSON.stringify({ ...testData, finalScore: score, correctAnswers, completedAt: new Date().toISOString() })); } catch(e) {}
    isSubmitting = false;
}

function addSolutionButton() {
    const premiumNotification = document.getElementById('premiumNotification');
    if (premiumNotification) premiumNotification.style.display = 'none';

    const modalButtons = document.querySelector('#resultsModal .modal-buttons');
    if (!modalButtons) return;

    const existingBtn = document.getElementById('solutionBtn');
    if (existingBtn) existingBtn.remove();

    const solutionBtn = document.createElement('button');
    solutionBtn.id = 'solutionBtn';
    solutionBtn.className = 'modal-btn';
    solutionBtn.innerHTML = '<i class="fas fa-lightbulb"></i> View Detailed Solutions';
    solutionBtn.style.backgroundColor = '#17a2b8';
    solutionBtn.style.cursor = 'pointer';
    solutionBtn.addEventListener('click', () => {
        resultsModal.style.display = 'none';
        showSolutionsModal(testData.questions, testData.userAnswers);
    });

    const backBtn = document.getElementById('backToDashboard');
    if (backBtn) modalButtons.insertBefore(solutionBtn, backBtn);
    else modalButtons.appendChild(solutionBtn);
}

function showSolutionsModal(questions, userAnswers) {
    const modal = document.getElementById('solutionModal');
    const modalBody = document.getElementById('solutionModalBody');
    if (!modal || !modalBody) return;
    modalBody.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'solutions-container';

    if (testData.mode === 'jamb_drill') {
        testData.subjects.forEach(subj => {
            const header = document.createElement('h3');
            header.style.color = 'var(--eggplant)';
            header.style.margin = '20px 0 10px';
            header.innerHTML = `<i class="fas fa-book"></i> ${subj.name}`;
            container.appendChild(header);
            const subjQuestions = questions.filter(q => q.subject === subj.value);
            subjQuestions.forEach((q, idxInSubj) => {
                const globalIdx = questions.findIndex(qq => qq.id === q.id);
                const solutionItem = createSolutionItem(q, userAnswers[globalIdx], globalIdx+1);
                container.appendChild(solutionItem);
            });
        });
    } else {
        questions.forEach((q, idx) => {
            const solutionItem = createSolutionItem(q, userAnswers[idx], idx+1);
            container.appendChild(solutionItem);
        });
    }

    modalBody.appendChild(container);
    const backDiv = document.createElement('div');
    backDiv.style.marginTop = '30px';
    backDiv.style.paddingTop = '20px';
    backDiv.style.borderTop = '2px solid #eee';
    backDiv.style.textAlign = 'center';
    const backBtn = document.createElement('button');
    backBtn.className = 'modal-btn confirm';
    backBtn.id = 'backToDashboardFromSolution';
    backBtn.innerHTML = '<i class="fas fa-tachometer-alt"></i> Back to Dashboard';
    backBtn.style.backgroundColor = '#28a745';
    backBtn.addEventListener('click', goToDashboard);
    backDiv.appendChild(backBtn);
    modalBody.appendChild(backDiv);
    modal.style.display = 'flex';
    const closeBtn = document.getElementById('closeSolutionModal');
    if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
}

function createSolutionItem(question, userAnswer, displayNumber) {
    const solutionItem = document.createElement('div');
    solutionItem.className = 'solution-item';
    const correctAnswer = question.correctAnswer;
    const isCorrect = userAnswer === correctAnswer;
    const hasSolutionText = question.solution && question.solution.trim() !== '';
    const hasSolutionImage = question.solutionImage;
    let solutionContent = '';
    if (hasSolutionText && hasSolutionImage) {
        solutionContent = `<div class="solution-text-preserved">${processSolutionText(question.solution)}</div><div class="solution-image-container"><img src="${question.solutionImage}" alt="Solution image" class="solution-image"></div>`;
    } else if (hasSolutionText) {
        solutionContent = `<div class="solution-text-preserved">${processSolutionText(question.solution)}</div>`;
    } else if (hasSolutionImage) {
        solutionContent = `<div class="solution-image-container"><img src="${question.solutionImage}" alt="Solution image" class="solution-image"></div>`;
    } else {
        solutionContent = '<div class="solution-text-preserved">No detailed solution available for this question.</div>';
    }

    let questionHtml = '';
    const hasQuestionText = question.questionText && question.questionText.trim() !== '';
    const hasQuestionImage = question.questionImage;
    if (hasQuestionText && hasQuestionImage) {
        questionHtml = `<p><strong>Question:</strong> ${formatTextForDisplay(question.questionText)}</p><div class="question-image-container" style="margin:10px 0;"><img src="${question.questionImage}" alt="Question image" style="max-width:200px; max-height:150px;"></div>`;
    } else if (hasQuestionText) {
        questionHtml = `<p><strong>Question:</strong> ${formatTextForDisplay(question.questionText)}</p>`;
    } else if (hasQuestionImage) {
        questionHtml = `<div class="question-image-container" style="margin:10px 0;"><img src="${question.questionImage}" alt="Question image" style="max-width:200px; max-height:150px;"></div>`;
    }

    solutionItem.innerHTML = `
        <h4><i class="fas fa-question-circle"></i> Question ${displayNumber}</h4>
        ${questionHtml}
        <div class="solution-options">
            <p><strong>Your Answer:</strong> <span class="user-answer">${userAnswer || 'Not answered'}</span>
            <span class="${isCorrect ? 'option-correct' : 'option-incorrect'}">${isCorrect ? '✓ Correct' : '✗ Incorrect'}</span></p>
            <p><strong>Correct Answer:</strong> <span class="correct-answer">${correctAnswer || 'Not specified'}</span></p>
        </div>
        <div class="option-explanation"><p><strong>Explanation:</strong></p>${solutionContent}</div>
    `;
    const separator = document.createElement('hr');
    separator.style.margin = '20px 0';
    separator.style.border = 'none';
    separator.style.borderTop = '1px solid #eee';
    solutionItem.appendChild(separator);
    return solutionItem;
}

// =============================================
// GO TO DASHBOARD
// =============================================
function goToDashboard() {
    window.removeEventListener('beforeunload', preventBeforeUnload);
    window.location.href = DASHBOARD_URL;
}

function handleKeyboardNavigation(e) {
    if (submitModal.style.display === 'flex' || resultsModal.style.display === 'flex') {
        if (e.key === 'Escape') { hideSubmitModal(); resultsModal.style.display = 'none'; }
        return;
    }
    switch(e.key) {
        case '1': case 'A': case 'a': selectOption('A'); break;
        case '2': case 'B': case 'b': selectOption('B'); break;
        case '3': case 'C': case 'c': selectOption('C'); break;
        case '4': case 'D': case 'd': selectOption('D'); break;
        case 'ArrowLeft': if (currentQuestionIndex > 0) loadQuestion(currentQuestionIndex - 1); break;
        case 'ArrowRight': if (currentQuestionIndex < testData.questions.length - 1) loadQuestion(currentQuestionIndex + 1); break;
        case 'Enter':
            if (currentQuestionIndex < testData.questions.length - 1) loadQuestion(currentQuestionIndex + 1);
            else showSubmitModal();
            break;
        case 'Escape': showSubmitModal(); break;
    }
}