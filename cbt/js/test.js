// cbt/js/test.js - Acadex CBT Engine (with academic session/term integration)
// ADDED: Tab‑switching detector – first violation warns, second auto-submits.
// ADDED: Page refresh prevention (F5, Ctrl+R, beforeunload, etc.)
// FIXED: Double-trigger bug (blur + visibilitychange both counting), isSubmitting guard conflict.
//
// All Firestore operations go through service.js where possible.
// TODO: service.js does not yet support cumulative topic stats with increment (updateCumulativeTopicStats)
// – those remain as direct Firestore calls.
// All user-facing errors now show clear, friendly messages without technical jargon.
// MODIFIED: Assigned test questions are now randomised (shuffled) before starting the test.
//
// ANTI-CHEAT (this revision):
//   • ROOT-CAUSE FIX: dedupe window raised from 500 ms → 5000 ms. On mobile,
//     blur and visibilitychange from a single tab-switch can arrive several
//     seconds apart. 500 ms was too tight and caused a single switch to be
//     counted twice (warning + submission at once). 5000 ms fixes it.
//   • First violation  → 15-second warning ONLY. `return` before any submit.
//   • Second violation → persistent "submitting" modal + background submission
//     (`submitTest(true, 5000)`), redirect only after save completes.
//   • MODAL NOW CENTERED ON EVERY VIEWPORT: full-screen flex backdrop +
//     single centered card (`.antiCheatCard`). Previously every direct child
//     was styled as a card, so message + countdown collapsed into a two-column
//     layout that drifted to the top-left on phones.
//   • Wall-clock based countdown (checks every 250 ms against Date.now()) so
//     mobile timer throttling cannot shorten or lengthen the modal.

import { auth, db } from '../../js/firebase-config.js';
import {
    collection, addDoc, getDocs, doc, updateDoc,
    increment, serverTimestamp, setDoc, getDoc
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";
import { initAcademicCalendar, getCurrentTerm, getCurrentSession } from '../../js/academic-calendar.js';
import * as service from '../../js/service.js';
import { toast } from '../../js/error-handler.js';

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
        await service.saveTopicStats(userId, {
          subject: subjectData.subject,
          topic: topic.topic,
          total: topic.total,
          correct: topic.correct,
          accuracy: topic.accuracy,
          level: topic.level,
          timestamp: new Date()
        });
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
        const stats = await service.getTopicCumulative(userId);
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

// ============================================================
// ANTI-CHEAT MODULE
// Handles: tab switch, window blur, right-click, copy/paste,
// screenshots, devtools shortcuts, refresh prevention.
//
// DESIGN:
//   • One violation handler feeds both `blur` and `visibilitychange`
//     through registerViolation(). A 5-second dedupe window ensures
//     that the two events from a SINGLE tab-switch count as one.
//   • First  violation → 15-second warning modal ONLY (no submission).
//   • Second violation → persistent "submitting" modal + background
//     submitTest(true, 5000). Redirect only after save completes.
//   • The modal is a full-screen centered backdrop with a single
//     responsive card. Centered on every viewport, mobile included.
//   • Countdown is wall-clock based (checks Date.now() every 250 ms)
//     so it can never be shortened by mobile timer throttling.
// ============================================================

/* Path to student dashboard (root/student/student-portal.html) */
const DASHBOARD_URL = '../../student/student-portal.html';

let tabSwitchCount = 0;
let isSubmitting = false;
let lastViolationTs = 0;

// Durations
const VIOLATION_DEDUPE_MS = 5000;    // >= 5 s: blur + visibilitychange = 1 violation
const FIRST_WARNING_MS    = 15000;   // 15-second first warning
const SECOND_MODAL_MS     = 5000;    // 5-second minimum before redirect

// Modal internals
let warningIntervalHandle = null;
let warningEndTime = 0;

const antiCheatWarningModal = document.getElementById('antiCheatWarningModal');

// ── Inject responsive CSS once ──────────────────────────────────────────────
function injectAntiCheatStyles() {
    if (document.getElementById('antiCheatStyles')) return;
    const style = document.createElement('style');
    style.id = 'antiCheatStyles';
    style.textContent = `
        /* Full-screen backdrop — always covers viewport */
        #antiCheatWarningModal {
            position: fixed !important;
            top: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            max-width: 100vw !important;
            max-height: 100vh !important;
            margin: 0 !important;
            padding: 16px !important;
            box-sizing: border-box !important;
            background: rgba(15, 23, 42, 0.85) !important;
            display: none !important;
            z-index: 2147483647 !important;
            overflow-y: auto !important;
            -webkit-overflow-scrolling: touch !important;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            text-align: center !important;
        }

        /* Visible state — flex centering, works on every viewport */
        #antiCheatWarningModal.is-visible {
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            justify-content: center !important;
        }

        /* Single card — the ONLY direct visual child */
        #antiCheatWarningModal .antiCheatCard {
            width: 100% !important;
            max-width: 480px !important;
            background: #ffffff !important;
            border-radius: 14px !important;
            padding: 24px 22px !important;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4) !important;
            box-sizing: border-box !important;
            text-align: center !important;
            border: 1px solid rgba(0, 0, 0, 0.08) !important;
            max-height: calc(100vh - 32px) !important;
            overflow-y: auto !important;
            margin: 0 auto !important;
            flex: 0 0 auto !important;
        }

        #antiCheatWarningModal .antiCheatIcon {
            display: block !important;
            font-size: clamp(32px, 8vw, 44px) !important;
            line-height: 1 !important;
            margin: 0 0 12px 0 !important;
        }

        #antiCheatWarningModal .antiCheatMessage {
            display: block !important;
            font-size: clamp(0.95rem, 3.8vw, 1.15rem) !important;
            line-height: 1.55 !important;
            color: #b91c1c !important;
            font-weight: 600 !important;
            word-break: break-word !important;
            overflow-wrap: anywhere !important;
            white-space: normal !important;
            margin: 0 !important;
        }

        #antiCheatWarningModal .antiCheatCountdown {
            display: block !important;
            margin-top: 16px !important;
            font-size: clamp(0.85rem, 3.2vw, 1rem) !important;
            color: #475569 !important;
            font-weight: 500 !important;
            letter-spacing: 0.01em !important;
        }

        /* Very narrow phones */
        @media (max-width: 360px) {
            #antiCheatWarningModal {
                padding: 10px !important;
            }
            #antiCheatWarningModal .antiCheatCard {
                padding: 18px 14px !important;
                border-radius: 12px !important;
            }
        }

        /* Short viewports (mobile landscape / soft keyboard raised) */
        @media (max-height: 500px) {
            #antiCheatWarningModal {
                padding: 8px !important;
            }
            #antiCheatWarningModal .antiCheatCard {
                padding: 14px 16px !important;
                border-radius: 10px !important;
                max-height: calc(100vh - 16px) !important;
            }
            #antiCheatWarningModal .antiCheatIcon {
                font-size: 26px !important;
                margin-bottom: 6px !important;
            }
            #antiCheatWarningModal .antiCheatMessage {
                font-size: clamp(0.85rem, 3.2vw, 1rem) !important;
                line-height: 1.4 !important;
            }
            #antiCheatWarningModal .antiCheatCountdown {
                margin-top: 10px !important;
            }
        }

        /* Extremely short viewports */
        @media (max-height: 360px) {
            #antiCheatWarningModal .antiCheatIcon {
                display: none !important;
            }
        }
    `;
    document.head.appendChild(style);
}

// ── Modal structure — a single centered card ───────────────────────────────
function _ensureModalStructure() {
    if (!antiCheatWarningModal) return null;
    let card = antiCheatWarningModal.querySelector('.antiCheatCard');
    if (card) return card;

    // Build our own clean card ONCE. Preserves the modal element itself
    // (id, role, external references) while giving us full layout control.
    // We keep .warning-message / .warning-countdown as extra class names
    // for backward compatibility with any existing CSS.
    antiCheatWarningModal.innerHTML = '';
    card = document.createElement('div');
    card.className = 'antiCheatCard';
    card.innerHTML =
        '<div class="antiCheatIcon" aria-hidden="true">⚠️</div>' +
        '<div class="antiCheatMessage warning-message" role="alert"></div>' +
        '<div class="antiCheatCountdown warning-countdown" aria-live="polite"></div>';
    antiCheatWarningModal.appendChild(card);
    return card;
}

/**
 * Show the anti-cheat modal.
 *
 *   autoCloseMs = number  → auto-close after N ms (wall-clock based).
 *   autoCloseMs = null    → stay open indefinitely (used by the second
 *                           violation's "submitting" modal).
 */
function showAntiCheatModal(message, autoCloseMs = 5000) {
    if (!antiCheatWarningModal) return;
    injectAntiCheatStyles();
    _ensureModalStructure();

    // Cancel any previous countdown
    if (warningIntervalHandle) {
        clearInterval(warningIntervalHandle);
        warningIntervalHandle = null;
    }

    const card = antiCheatWarningModal.querySelector('.antiCheatCard');
    const msgEl = card ? card.querySelector('.antiCheatMessage') : null;
    const cdEl  = card ? card.querySelector('.antiCheatCountdown') : null;

    if (msgEl) msgEl.textContent = message;

    antiCheatWarningModal.classList.add('is-visible');
    antiCheatWarningModal.setAttribute('aria-hidden', 'false');

    if (autoCloseMs === null || autoCloseMs === undefined) {
        // Persistent modal — no countdown, no auto-close.
        if (cdEl) cdEl.textContent = 'Please wait…';
        return;
    }

    warningEndTime = Date.now() + autoCloseMs;

    const tick = () => {
        const remaining = warningEndTime - Date.now();
        const seconds = Math.max(0, Math.ceil(remaining / 1000));
        if (cdEl) {
            cdEl.textContent = seconds > 0
                ? `Closing in ${seconds} second${seconds === 1 ? '' : 's'}…`
                : 'Closing…';
        }
        if (remaining <= 0) {
            antiCheatWarningModal.classList.remove('is-visible');
            antiCheatWarningModal.setAttribute('aria-hidden', 'true');
            if (warningIntervalHandle) {
                clearInterval(warningIntervalHandle);
                warningIntervalHandle = null;
            }
        }
    };
    tick();
    warningIntervalHandle = setInterval(tick, 250);
}

function hideAntiCheatModal() {
    if (!antiCheatWarningModal) return;
    if (warningIntervalHandle) {
        clearInterval(warningIntervalHandle);
        warningIntervalHandle = null;
    }
    antiCheatWarningModal.classList.remove('is-visible');
    antiCheatWarningModal.setAttribute('aria-hidden', 'true');
}

// ── Silent violation logger (fire-and-forget, never blocks) ────────────────
function logViolation(type, detail = '') {
    try {
        if (!currentUser || !currentUser.uid) return;
        const schoolId = localStorage.getItem('userSchoolId');
        if (!schoolId) return;
        addDoc(collection(db, 'cbtViolations'), {
            userId: currentUser.uid,
            schoolId,
            testId: (testData && testData.testId) ? testData.testId : null,
            cbtId:  (testData && testData.cbtId)  ? testData.cbtId  : null,
            type,
            detail: String(detail || '').slice(0, 200),
            remainingSeconds: typeof timeRemaining === 'number' ? timeRemaining : null,
            questionIndex: typeof currentQuestionIndex === 'number' ? currentQuestionIndex : null,
            timestamp: serverTimestamp()
        }).catch(() => { /* silent */ });
    } catch (_) { /* silent */ }
}

// ── Central violation handler ──────────────────────────────────────────────
function registerViolation(reason) {
    if (isSubmitting) return;

    const now = Date.now();

    // CRITICAL FIX: A single tab switch fires BOTH `blur` and
    // `visibilitychange`. On mobile these can arrive several seconds apart.
    // The 5-second dedupe window below guarantees they count as ONE event.
    if (now - lastViolationTs < VIOLATION_DEDUPE_MS) {
        return;
    }
    lastViolationTs = now;

    tabSwitchCount++;

    if (tabSwitchCount === 1) {
        // FIRST VIOLATION — 15-second warning, NO submission. Timer keeps running.
        logViolation('first_violation', reason);
        showAntiCheatModal(
            '⚠️ You left the exam window. This is your ONLY warning. ' +
            'The timer is still running. Doing it again will immediately auto-submit your test.',
            FIRST_WARNING_MS
        );
        return; // <-- absolutely no submission on the first violation
    }

    // SECOND VIOLATION — auto-submit with a persistent modal.
    logViolation('second_violation', reason);

    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

    // Persistent modal — removed only when the page redirects.
    showAntiCheatModal(
        '❌ Repeated violation detected. Your test is being submitted automatically…',
        null
    );

    // Background submission. Redirect happens only after BOTH the
    // SECOND_MODAL_MS window AND the Firestore save have completed.
    submitTest(true, SECOND_MODAL_MS).catch(err => {
        console.warn('Auto-submit failed, forcing redirect:', err);
        try { window.removeEventListener('beforeunload', preventBeforeUnload); } catch (_) {}
        window.location.href = DASHBOARD_URL;
    });
}

function handleVisibilityLoss() {
    if (!document.hidden) return;
    registerViolation('visibilitychange');
}

function handleWindowBlur() {
    // Fires on alt-tab, second window, DevTools focus, app-switch on mobile.
    registerViolation('window_blur');
}

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
            2500
        );
        return false;
    }
}

function preventBeforeUnload(e) {
    e.preventDefault();
    e.returnValue = 'Your test is in progress. Leaving this page will discard your answers.';
    return e.returnValue;
}

function preventClipboard(e) {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') return; // future-proof
    e.preventDefault();
    e.stopPropagation();
    showAntiCheatModal('⚠️ Copy / paste is disabled during the test.', 2000);
    logViolation('clipboard_blocked', e.type);
    return false;
}

function preventContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    showAntiCheatModal('⚠️ Right-click is disabled during the test.', 2000);
    logViolation('right_click_blocked');
    return false;
}

function handleKeyBlock(e) {
    const k = (e.key || '').toLowerCase();

    // 1. Clipboard + select-all shortcuts
    if ((e.ctrlKey || e.metaKey) && ['c','v','x','a'].includes(k)) {
        e.preventDefault(); e.stopPropagation();
        showAntiCheatModal('⚠️ This shortcut is disabled during the test.', 2000);
        logViolation('shortcut_blocked', `ctrl+${k}`);
        return false;
    }

    // 2. Save / Print / View-source
    if ((e.ctrlKey || e.metaKey) && ['s','p','u'].includes(k)) {
        e.preventDefault(); e.stopPropagation();
        showAntiCheatModal('⚠️ This action is disabled during the test.', 2000);
        logViolation('shortcut_blocked', `ctrl+${k}`);
        return false;
    }

    // 3. DevTools / Inspect
    if (k === 'f12' || ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i','j','c'].includes(k))) {
        e.preventDefault(); e.stopPropagation();
        showAntiCheatModal('⚠️ Developer tools are disabled during the test.', 2000);
        logViolation('devtools_blocked', k);
        return false;
    }

    // 4. PrintScreen (screenshot attempt — best effort)
    if (k === 'printscreen') {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText('').catch(() => {});
            }
        } catch (_) {}
        e.preventDefault();
        showAntiCheatModal('⚠️ Screenshots are not allowed during the test.', 2500);
        logViolation('screenshot_attempt');
        return false;
    }

    // 5. Ctrl/Cmd + Shift + S (browser screenshot)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 's') {
        e.preventDefault(); e.stopPropagation();
        showAntiCheatModal('⚠️ Screenshots are not allowed during the test.', 2500);
        logViolation('screenshot_attempt');
        return false;
    }
}

function preventSelectStart(e) {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') return;
    e.preventDefault();
}

function preventDragStart(e) {
    e.preventDefault();
}

function initAntiCheat() {
    // Inject responsive modal styles as early as possible.
    injectAntiCheatStyles();

    // Tab hidden + window blur (both feed the same registerViolation)
    document.addEventListener('visibilitychange', handleVisibilityLoss);
    window.addEventListener('blur', handleWindowBlur);

    // Refresh / unload
    window.addEventListener('keydown', preventRefresh, true);
    window.addEventListener('beforeunload', preventBeforeUnload);

    // Keyboard-level blocks (shortcuts, devtools, screenshots)
    document.addEventListener('keydown', handleKeyBlock, true);

    // Clipboard blocking
    document.addEventListener('copy',  preventClipboard, true);
    document.addEventListener('cut',   preventClipboard, true);
    document.addEventListener('paste', preventClipboard, true);

    // Right-click / context menu
    document.addEventListener('contextmenu', preventContextMenu, true);

    // Text selection / drag of content
    document.addEventListener('selectstart', preventSelectStart, true);
    document.addEventListener('dragstart',   preventDragStart,   true);
}

// Kept for backward compatibility with any external reference.
async function forceSubmitAndRedirect() {
    if (isSubmitting) {
        try { window.removeEventListener('beforeunload', preventBeforeUnload); } catch (_) {}
        window.location.href = DASHBOARD_URL;
        return;
    }
    try { window.removeEventListener('beforeunload', preventBeforeUnload); } catch (_) {}
    await submitTest(true);
}

// =============================================
// HELPER: Shuffle array for assigned test randomisation
// =============================================
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// =============================================
// INITIALIZATION with Acadex session validation
// =============================================
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('currentYear').textContent = new Date().getFullYear();

    const schoolId = localStorage.getItem('userSchoolId');
    const studentId = localStorage.getItem('studentId');
    if (!schoolId || !studentId) {
        toast.error('Invalid session. Please log in again.');
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
        toast.error('No test found. Please start a test from the dashboard.');
        window.location.href = DASHBOARD_URL;
        return;
    }
    try {
        testData = JSON.parse(savedTest);
        console.log("Test data loaded:", testData);
        initializeTest();
    } catch (error) {
        console.error('Error loading test data:', error);
        toast.error('Error loading test. Please try again.');
        window.location.href = DASHBOARD_URL;
    }
}

function initializeTest() {
    if (!testData || !testData.questions) {
        toast.error('Error: Test questions not loaded properly.');
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
// SAVE TEST RESULT TO FIRESTORE (with session & term) — using service.js
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
            const studentData = await service.getStudentById(currentUser.uid);
            if (studentData) {
                classId = studentData.classId || null;
                className = studentData.className || null;
                if (classId && !className) {
                    const classData = await service.getClassById(classId);
                    if (classData) {
                        className = classData.name || null;
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
            completedAt: new Date(),
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

        console.log("Saving test result to Firestore via service:", resultData);
        const docRef = await service.saveTestResult(resultData);
        console.log('✅ Test result saved to Firestore with ID:', docRef);
        toast.success('Test result saved successfully!');
        return docRef;
    } catch (error) {
        console.error('❌ ERROR SAVING TO FIRESTORE:', error);
        toast.error(`Failed to save test result: ${error.message || 'Please try again.'}`);
        throw error;
    }
}

// =============================================
// SUBMIT TEST
// -----------------------------------------------------------------------------
// UPDATED: optional 2nd param `minRedirectDelayMs` (default 0). When set,
// the redirect to the dashboard will wait until at least this many ms have
// elapsed since submission started — used by the anti-cheat auto-submit path
// so the modal is guaranteed to display for its full duration.
// All existing callers pass only one argument (or none), so their behaviour
// is unchanged.
// =============================================
async function submitTest(redirectAfter = false, minRedirectDelayMs = 0) {
    if (isSubmitting) return;
    isSubmitting = true;
    const submissionStartTs = Date.now();

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

        if (redirectAfter) {
            // Honour the optional minimum-display window (used by auto-submit).
            if (minRedirectDelayMs > 0) {
                const elapsed = Date.now() - submissionStartTs;
                const wait = minRedirectDelayMs - elapsed;
                if (wait > 0) await new Promise(r => setTimeout(r, wait));
            }
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
        toast.error(`Error submitting test: ${error.message || 'Please try again.'}`);
        isSubmitting = false;
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
    try { sessionStorage.setItem('previousTest', JSON.stringify({ ...testData, finalScore: score, correctAnswers