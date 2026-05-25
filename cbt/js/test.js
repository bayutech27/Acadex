// cbt/js/test.js - Acadex CBT Engine (fully enhanced with anti-cheating, session lock, auto-save)
import { auth, db } from '../../js/firebase-config.js';
import {
    collection, addDoc, getDoc, getDocs, doc, updateDoc,
    increment, serverTimestamp, setDoc
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";
import { initAcademicCalendar, getCurrentTerm, getCurrentSession } from '../../js/academic-calendar.js';

// ==============================
// GLOBAL CONFIGURATION & STATE
// ==============================
const MAX_VIOLATIONS = 3;
const AUTO_SAVE_INTERVAL = 10000; // 10 seconds

let testData = null;
let timeRemaining = 0;
let timerInterval = null;
let currentQuestionIndex = 0;
let currentUser = null;
let subjectStartIndices = {};
let subjectCounts = {};
let isSubmitting = false;
let examSessionToken = null;
let restoreStateApplied = false;

// ==============================
// DOM ELEMENT CACHE (centralised)
// ==============================
const dom = {
    testSubject: document.getElementById('testSubject'),
    questionCounter: document.getElementById('questionCounter'),
    currentQuestionSpan: document.getElementById('currentQuestion'),
    totalQuestionsSpan: document.getElementById('totalQuestions'),
    timerElement: document.getElementById('timer'),
    questionContent: document.getElementById('questionContent'),
    optionsContainer: document.getElementById('optionsContainer'),
    progressBar: document.getElementById('progressBar'),
    questionDots: document.getElementById('questionDots'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),
    getResultBtn: document.getElementById('getResultBtn'),
    submitModal: document.getElementById('submitModal'),
    resultsModal: document.getElementById('resultsModal'),
    cancelSubmit: document.getElementById('cancelSubmit'),
    confirmSubmit: document.getElementById('confirmSubmit'),
    answeredCount: document.getElementById('answeredCount'),
    totalQuestionsModal: document.getElementById('totalQuestionsModal'),
    finalScore: document.getElementById('finalScore'),
    scoreLabel: document.getElementById('scoreLabel'),
    correctCount: document.getElementById('correctCount'),
    totalQuestionsCount: document.getElementById('totalQuestionsCount'),
    performanceMessage: document.getElementById('performanceMessage'),
    backToDashboard: document.getElementById('backToDashboard'),
    subjectTabs: document.getElementById('subjectTabs'),
    subjectBreakdown: document.getElementById('subjectBreakdown'),
    subjectBreakdownList: document.getElementById('subjectBreakdownList'),

    // New elements
    fullscreenWarning: document.getElementById('fullscreenWarningModal'),
    antiCheatWarning: document.getElementById('antiCheatWarningModal'),
    offlineBanner: document.getElementById('offlineBanner'),
    autoSaveIndicator: document.getElementById('autoSaveIndicator'),
    sessionRestoredNotification: document.getElementById('sessionRestoredNotification'),
};

// ==============================
// MODULAR MANAGERS
// ==============================

// Fullscreen Manager
const fullscreenManager = {
    exitCount: 0,
    exitTimestamps: [],

    init() {
        this.requestFullscreen();
        document.addEventListener('fullscreenchange', () => {
            if (!document.fullscreenElement) this.onFullscreenExit();
        });
        document.addEventListener('webkitfullscreenchange', () => {
            if (!document.webkitFullscreenElement) this.onFullscreenExit();
        });
    },

    requestFullscreen() {
        const el = document.documentElement;
        if (el.requestFullscreen) {
            el.requestFullscreen().catch(() => {});
        } else if (el.webkitRequestFullscreen) {
            el.webkitRequestFullscreen();
        }
    },

    onFullscreenExit() {
        this.exitCount++;
        this.exitTimestamps.push(new Date().toISOString());
        violationLogger.log('fullscreen_exit');
        if (dom.fullscreenWarning) {
            dom.fullscreenWarning.style.display = 'flex';
            setTimeout(() => { dom.fullscreenWarning.style.display = 'none'; }, 5000);
        }
        setTimeout(() => this.requestFullscreen(), 2000);
    },

    getSummary() {
        return {
            fullscreenExits: this.exitCount,
            fullscreenExitTimestamps: this.exitTimestamps,
        };
    }
};

// Anti‑Cheat / Tab‑Switch Manager
const antiCheatManager = {
    violations: [],
    warningCount: 0,

    init() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.recordViolation('tab_hidden');
        });
        window.addEventListener('blur', () => {
            this.recordViolation('window_blur');
        });
        window.addEventListener('pagehide', () => {
            this.recordViolation('page_hide');
        });
    },

    recordViolation(type) {
        const timestamp = new Date().toISOString();
        this.violations.push({ type, timestamp });
        violationLogger.log(type);
        this.warningCount++;

        if (this.warningCount === 1) {
            this.showWarning('Warning: Do not leave the exam screen. This is your first warning.');
        } else if (this.warningCount === 2) {
            this.showWarning('Second warning! Leaving the exam screen may result in automatic submission.');
        } else if (this.warningCount >= MAX_VIOLATIONS) {
            this.autoSubmitExam();
        }
    },

    showWarning(msg) {
        if (dom.antiCheatWarning) {
            const msgEl = dom.antiCheatWarning.querySelector('.warning-message');
            if (msgEl) msgEl.textContent = msg;
            dom.antiCheatWarning.style.display = 'flex';
            setTimeout(() => { dom.antiCheatWarning.style.display = 'none'; }, 6000);
        }
    },

    autoSubmitExam() {
        if (!isSubmitting) {
            this.showWarning('Too many violations. Your test is being automatically submitted.');
            setTimeout(() => submitTest(), 1000);
        }
    },

    getSummary() {
        return {
            totalViolations: this.violations.length,
            violationDetails: this.violations,
        };
    }
};

// Timer Manager
const timerManager = {
    start() {
        updateTimerDisplay();
        timerInterval = setInterval(() => {
            timeRemaining--;
            updateTimerDisplay();
            if (timeRemaining <= 300) dom.timerElement.classList.add('warning');
            if (timeRemaining <= 0) {
                clearInterval(timerInterval);
                autoSubmitTest();
            }
        }, 1000);
    },

    stop() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
    },

    getTimeRemaining() {
        return timeRemaining;
    }
};

// Exam Session Manager (lock & restore)
const examSessionManager = {
    tokenKey: 'active_exam_token',
    stateKey: 'exam_autosave_state',

    init() {
        examSessionToken = Date.now().toString(36) + Math.random().toString(36).substr(2);
        sessionStorage.setItem(this.tokenKey, examSessionToken);
        window.addEventListener('storage', (e) => {
            if (e.key === this.tokenKey && e.newValue !== examSessionToken) {
                alert('Another exam tab was detected. This session may be invalidated.');
            }
        });
    },

    saveState() {
        const state = {
            userAnswers: testData.userAnswers,
            timeRemaining: timerManager.getTimeRemaining(),
            currentQuestionIndex: currentQuestionIndex,
            violations: antiCheatManager.violations,
            fullscreenExits: fullscreenManager.exitCount,
        };
        sessionStorage.setItem(this.stateKey, JSON.stringify(state));
        if (dom.autoSaveIndicator) {
            dom.autoSaveIndicator.style.display = 'block';
            setTimeout(() => { dom.autoSaveIndicator.style.display = 'none'; }, 2000);
        }
    },

    restoreState() {
        const saved = sessionStorage.getItem(this.stateKey);
        if (saved && !restoreStateApplied) {
            restoreStateApplied = true;
            try {
                const state = JSON.parse(saved);
                if (state.userAnswers) testData.userAnswers = state.userAnswers;
                timeRemaining = state.timeRemaining || timeRemaining;
                currentQuestionIndex = state.currentQuestionIndex || 0;
                antiCheatManager.violations = state.violations || [];
                fullscreenManager.exitCount = state.fullscreenExits || 0;
                updateTimerDisplay();
                loadQuestion(currentQuestionIndex);
                generateQuestionDots();
                updateAnsweredCount();
                if (dom.sessionRestoredNotification) {
                    dom.sessionRestoredNotification.style.display = 'block';
                    setTimeout(() => { dom.sessionRestoredNotification.style.display = 'none'; }, 5000);
                }
                return true;
            } catch (e) {}
        }
        return false;
    }
};

// Auto‑Save Manager
const autoSaveManager = {
    intervalId: null,

    start() {
        this.intervalId = setInterval(() => {
            examSessionManager.saveState();
        }, AUTO_SAVE_INTERVAL);
    },

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
};

// Violation Logger
const violationLogger = {
    log(type) {
        console.log(`[VIOLATION] ${type} at ${new Date().toISOString()}`);
    }
};

// Question Renderer (with CBT randomization)
const questionRenderer = {
    shouldRandomize() {
        return testData && (testData.examType === 'CBT' || testData.mode === 'cbt');
    },

    shuffle(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    },

    randomizeQuestions() {
        if (!this.shouldRandomize()) return;
        testData.originalQuestions = testData.questions.map(q => ({...q}));
        testData.questions = this.shuffle(testData.questions);
        testData.userAnswers = Array(testData.questions.length).fill(null);
    },

    randomizeOptions(question) {
        if (!this.shouldRandomize()) return question.options;
        const optionKeys = Object.keys(question.options);
        const optionsList = optionKeys.map(k => ({ letter: k, text: question.options[k] }));
        const shuffled = this.shuffle(optionsList);
        const newOptions = {};
        const letterMap = {};
        shuffled.forEach((item, idx) => {
            const newLetter = optionKeys[idx];
            newOptions[newLetter] = item.text;
            letterMap[item.letter] = newLetter;
        });
        question.options = newOptions;
        question.correctAnswer = letterMap[question.correctAnswer];
        return newOptions;
    }
};

// ==============================
// WEAKNESS DETECTION & RECOMMENDATION ENGINE (fully preserved)
// ==============================
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

// ==============================
// HELPER FUNCTIONS
// ==============================
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

// ==============================
// LOAD TEST DATA & INITIALISE
// ==============================
async function loadTestData() {
    const savedTest = sessionStorage.getItem('currentTest');
    if (!savedTest) {
        alert('No test found. Please start a test from the dashboard.');
        window.location.href = '../../student/student-portal.html';
        return;
    }
    try {
        testData = JSON.parse(savedTest);
        console.log("Test data loaded:", testData);
        initializeTest();
    } catch (error) {
        console.error('Error loading test data:', error);
        alert('Error loading test. Please try again.');
        window.location.href = '../../student/student-portal.html';
    }
}

function initializeTest() {
    if (!testData || !testData.questions) {
        alert('Error: Test questions not loaded properly.');
        window.location.href = '../../student/student-portal.html';
        return;
    }
    console.log("🔥 CBT test.js loaded - VERSION 2");
    // UI heading
    if (testData.mode === 'cbt') {
        dom.testSubject.innerHTML = `<i class="fas fa-laptop"></i> CBT: ${testData.title || 'Assigned Test'}`;
    } else if (testData.mode === 'jamb_drill') {
        const subjectsList = testData.subjects.map(s => s.name).join(' + ');
        dom.testSubject.innerHTML = `<i class="fas fa-graduation-cap"></i> JAMB Drill: ${subjectsList}`;
        let idx = 0;
        testData.subjects.forEach(subj => {
            subjectStartIndices[subj.value] = idx;
            subjectCounts[subj.value] = subj.count;
            idx += subj.count;
        });
        renderSubjectTabs();
    } else if (testData.mode === 'waec_neco') {
        const subjectName = testData.subject ? testData.subject.charAt(0).toUpperCase() + testData.subject.slice(1) : 'Unknown Subject';
        dom.testSubject.innerHTML = `<i class="fas fa-school"></i> WAEC/NECO Drill: ${subjectName}`;
    } else {
        const subjectName = testData.subject ? testData.subject.charAt(0).toUpperCase() + testData.subject.slice(1) : 'Unknown Subject';
        dom.testSubject.innerHTML = `<i class="fas fa-book"></i> Quick Test: ${subjectName} - ${testData.examType || 'Test'}`;
    }

    // Randomize questions if CBT mode
    questionRenderer.randomizeQuestions();

    // Session restore or fresh start
    examSessionManager.init();
    if (!examSessionManager.restoreState()) {
        dom.totalQuestionsSpan.textContent = testData.totalQuestions || testData.questions.length;
        dom.totalQuestionsModal.textContent = testData.totalQuestions || testData.questions.length;
        timeRemaining = testData.totalTime || (testData.questions.length * 120);
        currentQuestionIndex = 0;
        testData.userAnswers = Array(testData.questions.length).fill(null);
    }

    // Start core timers & auto‑save
    updateTimerDisplay();
    timerManager.start();
    autoSaveManager.start();
    generateQuestionDots();
    loadQuestion(currentQuestionIndex);
    updateProgressBar();
    updateAnsweredCount();

    // Activate security features
    fullscreenManager.init();
    antiCheatManager.init();

    // Network detection
    window.addEventListener('online', () => {
        if (dom.offlineBanner) dom.offlineBanner.style.display = 'none';
    });
    window.addEventListener('offline', () => {
        if (dom.offlineBanner) dom.offlineBanner.style.display = 'block';
    });

    // Block cheating actions (copy, paste, etc.)
    blockCheatingActions();
}

function blockCheatingActions() {
    document.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('copy', e => e.preventDefault());
    document.addEventListener('cut', e => e.preventDefault());
    document.addEventListener('paste', e => e.preventDefault());
    document.body.style.webkitUserSelect = 'none';
    document.body.style.mozUserSelect = 'none';
    document.body.style.msUserSelect = 'none';
    document.body.style.userSelect = 'none';

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) {
            const key = e.key.toLowerCase();
            if (key === 'c' || key === 'x' || key === 'a' || key === 's' || key === 'p' || key === 'u') {
                e.preventDefault();
                return false;
            }
            if (e.shiftKey && (key === 'i' || key === 'j')) {
                e.preventDefault();
                return false;
            }
        }
        if (e.key === 'F12') {
            e.preventDefault();
            return false;
        }
    });
}

// ==============================
// QUESTION RENDERING & NAVIGATION
// ==============================
function renderSubjectTabs() {
    if (!dom.subjectTabs || testData.mode !== 'jamb_drill') return;
    dom.subjectTabs.style.display = 'block';
    dom.subjectTabs.innerHTML = '';
    testData.subjects.forEach((subj) => {
        const tab = document.createElement('button');
        tab.className = 'subject-tab';
        tab.dataset.subject = subj.value;
        tab.textContent = subj.name;
        tab.addEventListener('click', () => switchToSubject(subj.value));
        dom.subjectTabs.appendChild(tab);
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

    // Randomize options for CBT (returns new options object)
    const rawOptions = question.options || { A: question.optionA || "", B: question.optionB || "", C: question.optionC || "", D: question.optionD || "" };
    const options = questionRenderer.randomizeOptions({...rawOptions});

    dom.questionContent.innerHTML = '';
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
    dom.questionContent.innerHTML = questionHTML;
    dom.currentQuestionSpan.textContent = index + 1;

    dom.optionsContainer.innerHTML = '';
    const optionKeys = Object.keys(options);
    optionKeys.forEach(letter => {
        const text = options[letter];
        const optionElement = document.createElement('div');
        optionElement.className = 'option';
        optionElement.dataset.option = letter;
        if (testData.userAnswers[index] === letter) optionElement.classList.add('selected');
        optionElement.innerHTML = `<div class="option-letter">${letter}</div><div class="option-text">${text}</div>`;
        optionElement.addEventListener('click', () => selectOption(letter));
        dom.optionsContainer.appendChild(optionElement);
    });

    dom.prevBtn.disabled = index === 0;
    dom.nextBtn.disabled = index === testData.questions.length - 1;
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
    examSessionManager.saveState();
}

function generateQuestionDots() {
    if (!testData || !testData.questions) return;
    dom.questionDots.innerHTML = '';
    for (let i = 0; i < testData.questions.length; i++) {
        const dot = document.createElement('div');
        dot.className = 'dot';
        if (i === currentQuestionIndex) dot.classList.add('active');
        if (testData.userAnswers && testData.userAnswers[i] !== null) dot.classList.add('answered');
        dot.dataset.index = i;
        dot.addEventListener('click', () => loadQuestion(i));
        dom.questionDots.appendChild(dot);
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
    dom.progressBar.style.width = `${progress}%`;
}

function updateAnsweredCount() {
    if (!testData || !testData.userAnswers) return;
    const answered = testData.userAnswers.filter(a => a !== null).length;
    dom.answeredCount.textContent = answered;
}

function showPreviousQuestion() {
    if (currentQuestionIndex > 0) {
        loadQuestion(currentQuestionIndex - 1);
        examSessionManager.saveState();
    }
}

function showNextQuestion() {
    if (currentQuestionIndex < testData.questions.length - 1) {
        loadQuestion(currentQuestionIndex + 1);
        examSessionManager.saveState();
    }
}

function startTimer() { timerManager.start(); }
function updateTimerDisplay() {
    const minutes = Math.floor(timeRemaining / 60);
    const seconds = timeRemaining % 60;
    dom.timerElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}
function showSubmitModal() { updateAnsweredCount(); dom.submitModal.style.display = 'flex'; }
function hideSubmitModal() { dom.submitModal.style.display = 'none'; }
function autoSubmitTest() {
    dom.getResultBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Time\'s Up! Submitting...';
    setTimeout(() => submitTest(), 1000);
}

// ==============================
// SAVE TEST RESULT TO FIRESTORE (including violation data)
// ==============================
async function saveTestResultToFirestore(score, correctAnswers, rawScore, subjectScores = null) {
    try {
        if (!currentUser) {
            await new Promise(resolve => setTimeout(resolve, 200));
            if (!auth.currentUser) throw new Error("User not authenticated");
            currentUser = auth.currentUser;
        }
        const schoolId = localStorage.getItem('userSchoolId');
        if (!schoolId) throw new Error("School ID missing");

        let classId = null, className = null, studentFullName = '';
        try {
            const studentDocRef = doc(db, 'students', currentUser.uid);
            const studentSnap = await getDoc(studentDocRef);
            if (studentSnap.exists()) {
                const studentData = studentSnap.data();
                classId = studentData.classId || null;
                className = studentData.className || null;
                studentFullName = studentData.name || '';
                if (classId && !className) {
                    const classDoc = await getDoc(doc(db, 'classes', classId));
                    if (classDoc.exists()) className = classDoc.data().name || null;
                }
            }
        } catch (err) { console.warn("Could not fetch student info:", err); }

        const subjectName = testData.mode === 'quick' ?
            (testData.subject ? testData.subject.charAt(0).toUpperCase() + testData.subject.slice(1) : 'Unknown Subject') :
            testData.mode === 'jamb_drill' ? 'JAMB Drill' : testData.mode === 'waec_neco' ? 'WAEC/NECO Drill' : (testData.title || 'CBT Test');

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

        let session = '', term = '';
        try {
            session = getCurrentSession();
            term = getCurrentTerm();
        } catch (e) { console.warn('Academic calendar not ready'); }

        const violationSummary = {
            ...fullscreenManager.getSummary(),
            ...antiCheatManager.getSummary(),
        };

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
            term: term,
            name: studentFullName,
            violationSummary: violationSummary,   // <-- new field
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
        setTimeout(() => document.body.removeChild(toast), 500);
    }, 5000);
}

// ==============================
// SUBMIT TEST (hardened)
// ==============================
async function submitTest() {
    if (isSubmitting) return;
    isSubmitting = true;
    hideSubmitModal();
    timerManager.stop();
    autoSaveManager.stop();
    dom.getResultBtn.classList.add('btn-loading');
    dom.getResultBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Calculating Score...';

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
            dom.scoreLabel.textContent = '/400 Score';
        } else if (testData.mode === 'waec_neco') {
            subjectScores = {};
            subjectScores[testData.subject] = { correct: correctAnswers, total: testData.totalQuestions };
            finalDisplayScore = Math.round((correctAnswers / testData.questions.length) * 100);
            dom.scoreLabel.textContent = '% Score';
        } else {
            finalDisplayScore = Math.round((correctAnswers / testData.questions.length) * 100);
            dom.scoreLabel.textContent = '% Score';
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
        dom.getResultBtn.classList.remove('btn-loading');
        dom.getResultBtn.innerHTML = '<i class="fas fa-check-circle"></i> Submit Test';
        alert(`❌ Error submitting test: ${error.message || 'Please try again.'}`);
        isSubmitting = false;
    }
}

// ==============================
// SHOW RESULTS (unchanged)
// ==============================
function showResults(score, correctAnswers, message, subjectScores) {
    dom.getResultBtn.classList.remove('btn-loading');
    dom.getResultBtn.innerHTML = '<i class="fas fa-check-circle"></i> Submit Test';
    dom.finalScore.textContent = score;
    dom.correctCount.textContent = correctAnswers;
    dom.totalQuestionsCount.textContent = testData.questions.length;
    if (dom.performanceMessage) dom.performanceMessage.textContent = message;

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
        dom.subjectBreakdown.style.display = 'block';
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
        dom.subjectBreakdownList.innerHTML = html;
    } else {
        dom.subjectBreakdown.style.display = 'none';
    }

    dom.resultsModal.style.display = 'flex';
    addSolutionButton();
    sessionStorage.removeItem('currentTest');
    try { sessionStorage.setItem('previousTest', JSON.stringify({ ...testData, finalScore: score, correctAnswers, completedAt: new Date().toISOString() })); } catch(e) {}
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
        dom.resultsModal.style.display = 'none';
        showSolutionsModal(testData.questions, testData.userAnswers);
    });

    const backBtn = dom.backToDashboard;
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

function goToDashboard() {
    window.location.href = 'cbt.html';
}

function handleKeyboardNavigation(e) {
    if (dom.submitModal.style.display === 'flex' || dom.resultsModal.style.display === 'flex') {
        if (e.key === 'Escape') { hideSubmitModal(); dom.resultsModal.style.display = 'none'; }
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

// ==============================
// INITIALISATION
// ==============================
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

    dom.prevBtn.addEventListener('click', showPreviousQuestion);
    dom.nextBtn.addEventListener('click', showNextQuestion);
    dom.getResultBtn.addEventListener('click', showSubmitModal);
    dom.cancelSubmit.addEventListener('click', hideSubmitModal);
    dom.confirmSubmit.addEventListener('click', submitTest);
    dom.backToDashboard.addEventListener('click', goToDashboard);
    document.addEventListener('keydown', handleKeyboardNavigation);

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        timerManager.stop();
        autoSaveManager.stop();
    });
});