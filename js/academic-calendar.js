// Central Academic Calendar Engine - SINGLE SOURCE OF TRUTH
// This file is the ONLY source of truth for current term, session, and rollover logic.
// Import your initialized Firestore db instance from firebase-config.js
import { db } from './firebase-config.js';
import { 
  doc, 
  getDoc, 
  updateDoc, 
  setDoc, 
  serverTimestamp, 
  onSnapshot, 
  FieldValue 
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

// ----------------------------------- State -----------------------------------
let calendarState = {
  initialized: false,
  currentSession: null,
  currentTerm: null,
  termStart: null,
  termEnd: null,
  manualOverride: false,
  overrideSession: null,
  overrideTerm: null,
  lastUpdated: null,
  listeners: []
};

let unsubscribeFirestore = null;

// ----------------------------------- Core Calculation (UTC) -----------------------------------
/**
 * Calculate term, session, and term start/end dates based on a given date (default now).
 * @param {Date} date - JavaScript Date object (will be interpreted in UTC)
 * @returns {Object} { term, session, termStart, termEnd }
 */
export function calculateTermAndSessionFromDate(date = new Date()) {
  // Use UTC methods to avoid timezone shifts
  const utcYear = date.getUTCFullYear();
  const utcMonth = date.getUTCMonth();   // 0-11 (Jan=0, Dec=11)
  const utcDay = date.getUTCDate();

  let term = null;
  let termStart = null;
  let termEnd = null;

  // ---- TERM DETERMINATION (based on Nigerian academic calendar) ----
  if ((utcMonth === 8 && utcDay >= 1) || (utcMonth > 8 && utcMonth <= 11)) {
    // First Term: September 1 – December 31
    term = "First Term";
    termStart = `${utcYear}-09-01`;
    termEnd = `${utcYear}-12-31`;
  } 
  else if ((utcMonth === 0) || (utcMonth === 1) || (utcMonth === 2) || 
           (utcMonth === 3 && utcDay <= 30)) {
    // Second Term: January 1 – April 30
    term = "Second Term";
    termStart = `${utcYear}-01-01`;
    termEnd = `${utcYear}-04-30`;
  }
  else if ((utcMonth === 4 && utcDay >= 1) || (utcMonth === 5) || (utcMonth === 6) || 
           (utcMonth === 7 && utcDay <= 30)) {
    // Third Term: May 1 – August 30
    term = "Third Term";
    termStart = `${utcYear}-05-01`;
    termEnd = `${utcYear}-08-30`;
  }
  else {
    // Fallback for rare edge cases (e.g., December 31, April 31 doesn't exist)
    if (utcMonth === 11 && utcDay === 31) {
      term = "First Term";
      termStart = `${utcYear}-09-01`;
      termEnd = `${utcYear}-12-31`;
    } else {
      term = "Third Term";
      termStart = `${utcYear}-05-01`;
      termEnd = `${utcYear}-08-30`;
    }
  }

  // ---- SESSION DETERMINATION ----
  // Session changes only when First Term starts in September.
  let session = null;
  if (utcMonth >= 8) {                     // September or later
    session = `${utcYear}/${utcYear + 1}`;
  } else {                                 // January to August
    session = `${utcYear - 1}/${utcYear}`;
  }

  return { term, session, termStart, termEnd };
}

// ----------------------------------- Initialisation & Firestore Sync -----------------------------------
/**
 * Initialise the academic calendar – sets up real‑time listener to Firestore
 * and creates the document if it does not exist.
 * @returns {Promise<Object>} current calendar state
 */
export async function initAcademicCalendar() {
  // Already initialised? Return current state.
  if (calendarState.initialized) return calendarState;

  const calendarDocRef = doc(db, 'academicCalendar', 'current');

  // Real‑time listener (handles both updates and initial creation)
  unsubscribeFirestore = onSnapshot(calendarDocRef, async (docSnapshot) => {
    if (docSnapshot.exists()) {
      const data = docSnapshot.data();
      calendarState.manualOverride = data.manualOverride || false;
      calendarState.overrideSession = data.overrideSession || null;
      calendarState.overrideTerm = data.overrideTerm || null;

      if (calendarState.manualOverride && calendarState.overrideSession && calendarState.overrideTerm) {
        // Use manually overridden values (admin override)
        calendarState.currentSession = calendarState.overrideSession;
        calendarState.currentTerm = calendarState.overrideTerm;
        calendarState.termStart = data.termStart || null;
        calendarState.termEnd = data.termEnd || null;
      } else {
        // Auto‑calculate from current date (UTC)
        const now = new Date();
        const calculated = calculateTermAndSessionFromDate(now);
        calendarState.currentSession = calculated.session;
        calendarState.currentTerm = calculated.term;
        calendarState.termStart = calculated.termStart;
        calendarState.termEnd = calculated.termEnd;
      }

      calendarState.lastUpdated = data.lastUpdated;
      calendarState.initialized = true;

      // Notify all subscribers
      calendarState.listeners.forEach(callback => callback({ ...calendarState }));
    } else {
      // No document exists – create one with auto‑calculated values
      const now = new Date();
      const calculated = calculateTermAndSessionFromDate(now);
      const initialData = {
        currentSession: calculated.session,
        currentTerm: calculated.term,
        termStart: calculated.termStart,
        termEnd: calculated.termEnd,
        lastUpdated: serverTimestamp(),
        autoManaged: true,
        manualOverride: false,
        overrideSession: null,
        overrideTerm: null,
        forceSyncVersion: 1
      };
      await setDoc(calendarDocRef, initialData);
      calendarState.currentSession = calculated.session;
      calendarState.currentTerm = calculated.term;
      calendarState.termStart = calculated.termStart;
      calendarState.termEnd = calculated.termEnd;
      calendarState.initialized = true;
      calendarState.listeners.forEach(callback => callback({ ...calendarState }));
    }
  });

  return calendarState;
}

// ----------------------------------- Public Getters -----------------------------------
/**
 * @returns {string} current term (e.g., "First Term")
 */
export function getCurrentTerm() {
  if (!calendarState.initialized) {
    throw new Error('Academic Calendar not initialized. Call initAcademicCalendar() first.');
  }
  return calendarState.currentTerm;
}

/**
 * @returns {string} current academic session (e.g., "2025/2026")
 */
export function getCurrentSession() {
  if (!calendarState.initialized) {
    throw new Error('Academic Calendar not initialized. Call initAcademicCalendar() first.');
  }
  return calendarState.currentSession;
}

/**
 * @returns {Object} { start: string (YYYY-MM-DD), end: string (YYYY-MM-DD) }
 */
export function getTermDates() {
  if (!calendarState.initialized) {
    throw new Error('Academic Calendar not initialized. Call initAcademicCalendar() first.');
  }
  return { start: calendarState.termStart, end: calendarState.termEnd };
}

/**
 * @returns {Object} full calendar information
 */
export function getAcademicCalendar() {
  if (!calendarState.initialized) {
    throw new Error('Academic Calendar not initialized. Call initAcademicCalendar() first.');
  }
  return {
    currentTerm: calendarState.currentTerm,
    currentSession: calendarState.currentSession,
    termStart: calendarState.termStart,
    termEnd: calendarState.termEnd,
    manualOverride: calendarState.manualOverride,
    lastUpdated: calendarState.lastUpdated
  };
}

/**
 * Compare calculated data with stored Firestore data.
 * @param {Object} calculatedData - result of calculateTermAndSessionFromDate()
 * @param {Object} storedData - Firestore document data
 * @returns {boolean} true if an update is needed
 */
export function shouldCalendarUpdate(calculatedData, storedData) {
  return (calculatedData.session !== storedData.currentSession ||
          calculatedData.term !== storedData.currentTerm);
}

/**
 * Subscribe to calendar changes (real‑time updates).
 * @param {Function} callback - receives the current calendar state
 * @returns {Function} unsubscribe function
 */
export function subscribeToCalendar(callback) {
  if (typeof callback !== 'function') {
    return () => {};
  }
  calendarState.listeners.push(callback);
  if (calendarState.initialized) {
    callback({ ...calendarState });
  }
  return () => {
    calendarState.listeners = calendarState.listeners.filter(cb => cb !== callback);
  };
}

// ----------------------------------- Admin Override Functions -----------------------------------
/**
 * Manually override the current term/session (admin only).
 * @param {Object} overrideData - { term, session, expiryDate (optional) }
 * @returns {Promise<Object>} updated calendar
 */
export async function adminOverrideCalendar(overrideData) {
  const { term, session, expiryDate } = overrideData;
  const calendarDocRef = doc(db, 'academicCalendar', 'current');
  const updatePayload = {
    manualOverride: true,
    overrideSession: session,
    overrideTerm: term,
    overrideExpiry: expiryDate || null,
    lastUpdated: serverTimestamp(),
    forceSyncVersion: FieldValue.increment(1)
  };
  await updateDoc(calendarDocRef, updatePayload);
  return getAcademicCalendar();
}

/**
 * Reset calendar to automatic mode (remove admin override).
 * @returns {Promise<Object>} updated calendar
 */
export async function adminResetToAuto() {
  const calendarDocRef = doc(db, 'academicCalendar', 'current');
  const now = new Date();
  const calculated = calculateTermAndSessionFromDate(now);
  const updatePayload = {
    manualOverride: false,
    overrideSession: null,
    overrideTerm: null,
    currentSession: calculated.session,
    currentTerm: calculated.term,
    termStart: calculated.termStart,
    termEnd: calculated.termEnd,
    lastUpdated: serverTimestamp(),
    overrideExpiry: null,
    forceSyncVersion: FieldValue.increment(1)
  };
  await updateDoc(calendarDocRef, updatePayload);
  return getAcademicCalendar();
}

// ----------------------------------- Utilities -----------------------------------
/**
 * Get current UTC date as a Date object (timezone‑safe).
 * @returns {Date}
 */
export function getCurrentUTCDate() {
  return new Date(new Date().toISOString().slice(0, 19) + 'Z');
}

/**
 * Clean up resources (unsubscribe from Firestore).
 */
export function destroyAcademicCalendar() {
  if (unsubscribeFirestore) {
    unsubscribeFirestore();
    unsubscribeFirestore = null;
  }
  calendarState = {
    initialized: false,
    currentSession: null,
    currentTerm: null,
    termStart: null,
    termEnd: null,
    manualOverride: false,
    overrideSession: null,
    overrideTerm: null,
    lastUpdated: null,
    listeners: []
  };
}