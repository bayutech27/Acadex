// academic-calendar.js - Central Academic Calendar Engine (Robust)
// Manually read/write Firestore, with client-side fallback.
// All user-facing errors now show clear, friendly messages without technical jargon.

import { db } from './firebase-config.js';
import { doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import * as service from './service.js';
import { toast } from './error-handler.js';

let calendarState = {
  initialized: false,
  currentSession: null,
  currentTerm: null,
  termStart: null,
  termEnd: null,
  manualOverride: false,
  lastUpdated: null,
  offlineMode: false,
  listeners: []
};

let retryCount = 0;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Pure client-side calculation (no Firestore)
export function calculateTermAndSessionFromDate(date = new Date()) {
  const utcYear = date.getUTCFullYear();
  const utcMonth = date.getUTCMonth();
  const utcDay = date.getUTCDate();
  let term = null, termStart = null, termEnd = null;
  if ((utcMonth === 8 && utcDay >= 1) || (utcMonth > 8 && utcMonth <= 11)) {
    term = "First Term";
    termStart = `${utcYear}-09-01`;
    termEnd = `${utcYear}-12-31`;
  } else if ((utcMonth === 0) || (utcMonth === 1) || (utcMonth === 2) || (utcMonth === 3 && utcDay <= 30)) {
    term = "Second Term";
    termStart = `${utcYear}-01-01`;
    termEnd = `${utcYear}-04-30`;
  } else if ((utcMonth === 4 && utcDay >= 1) || (utcMonth === 5) || (utcMonth === 6) || (utcMonth === 7 && utcDay <= 30)) {
    term = "Third Term";
    termStart = `${utcYear}-05-01`;
    termEnd = `${utcYear}-08-30`;
  } else {
    term = utcMonth === 11 && utcDay === 31 ? "First Term" : "Third Term";
    termStart = term === "First Term" ? `${utcYear}-09-01` : `${utcYear}-05-01`;
    termEnd = term === "First Term" ? `${utcYear}-12-31` : `${utcYear}-08-30`;
  }
  let session = utcMonth >= 8 ? `${utcYear}/${utcYear + 1}` : `${utcYear - 1}/${utcYear}`;
  return { term, session, termStart, termEnd };
}

// Core initialisation with retry
async function fetchFromFirestoreWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const docRef = doc(db, 'academicCalendar', 'current');
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        const data = snap.data();
        return { exists: true, data };
      } else {
        return { exists: false };
      }
    } catch (err) {
      lastError = err;
      console.warn(`[AcademicCalendar] Firestore attempt ${attempt} failed:`, err.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw lastError;
}

// Write the calculated values back to Firestore (to heal the document)
async function writeFallbackToFirestore(calculated) {
  try {
    const docRef = doc(db, 'academicCalendar', 'current');
    await setDoc(docRef, {
      currentSession: calculated.session,
      currentTerm: calculated.term,
      termStart: calculated.termStart,
      termEnd: calculated.termEnd,
      lastUpdated: serverTimestamp(),
      autoManaged: true,
      manualOverride: false,
      forceSyncVersion: 1
    }, { merge: true });
    console.log('[AcademicCalendar] Successfully wrote fallback values to Firestore.');
    return true;
  } catch (err) {
    console.error('[AcademicCalendar] Failed to write fallback to Firestore:', err);
    toast.warning('Unable to sync calendar with server. Using local date estimates.');
    return false;
  }
}

export async function initAcademicCalendar() {
  if (calendarState.initialized) return calendarState;

  try {
    const result = await fetchFromFirestoreWithRetry();
    let firestoreData = null;
    if (result.exists) {
      firestoreData = result.data;
      console.log('[AcademicCalendar] Loaded from Firestore');
    } else {
      console.warn('[AcademicCalendar] Firestore document missing – will create one');
      toast.info('Calendar is being set up. Using current date estimates.');
    }

    // Determine actual calendar values
    let session, term, termStart, termEnd, manualOverride = false;
    const now = new Date();
    const calculated = calculateTermAndSessionFromDate(now);

    if (firestoreData && firestoreData.manualOverride === true) {
      manualOverride = true;
      session = firestoreData.overrideSession || firestoreData.currentSession || calculated.session;
      term = firestoreData.overrideTerm || firestoreData.currentTerm || calculated.term;
      termStart = firestoreData.termStart || calculated.termStart;
      termEnd = firestoreData.termEnd || calculated.termEnd;
    } else if (firestoreData && !firestoreData.manualOverride) {
      session = firestoreData.currentSession || calculated.session;
      term = firestoreData.currentTerm || calculated.term;
      termStart = firestoreData.termStart || calculated.termStart;
      termEnd = firestoreData.termEnd || calculated.termEnd;
    } else {
      // No Firestore doc – use client-side and try to create one
      session = calculated.session;
      term = calculated.term;
      termStart = calculated.termStart;
      termEnd = calculated.termEnd;
      await writeFallbackToFirestore(calculated);
    }

    calendarState.currentSession = session;
    calendarState.currentTerm = term;
    calendarState.termStart = termStart;
    calendarState.termEnd = termEnd;
    calendarState.manualOverride = manualOverride;
    calendarState.lastUpdated = firestoreData?.lastUpdated || null;
    calendarState.offlineMode = !firestoreData;
    calendarState.initialized = true;

    // Notify subscribers
    calendarState.listeners.forEach(cb => cb({ ...calendarState }));
    return calendarState;
  } catch (err) {
    console.error('[AcademicCalendar] All Firestore attempts failed. Using client-side fallback only.', err);
    toast.warning('Unable to connect to calendar server. Using local date estimates.');
    const calculated = calculateTermAndSessionFromDate(new Date());
    calendarState.currentSession = calculated.session;
    calendarState.currentTerm = calculated.term;
    calendarState.termStart = calculated.termStart;
    calendarState.termEnd = calculated.termEnd;
    calendarState.manualOverride = false;
    calendarState.offlineMode = true;
    calendarState.initialized = true;
    calendarState.listeners.forEach(cb => cb({ ...calendarState }));
    return calendarState;
  }
}

// Public getters (safe – will never throw, but we keep the error for developers)
export function getCurrentTerm() {
  if (!calendarState.initialized) throw new Error('Call initAcademicCalendar first');
  return calendarState.currentTerm;
}
export function getCurrentSession() {
  if (!calendarState.initialized) throw new Error('Call initAcademicCalendar first');
  return calendarState.currentSession;
}
export function getTermDates() {
  if (!calendarState.initialized) throw new Error('Call initAcademicCalendar first');
  return { start: calendarState.termStart, end: calendarState.termEnd };
}
export function getAcademicCalendar() {
  if (!calendarState.initialized) throw new Error('Call initAcademicCalendar first');
  return { ...calendarState };
}

export function subscribeToCalendar(callback) {
  calendarState.listeners.push(callback);
  if (calendarState.initialized) callback({ ...calendarState });
  return () => {
    calendarState.listeners = calendarState.listeners.filter(cb => cb !== callback);
  };
}

export function shouldCalendarUpdate(calculated, stored) {
  return calculated.session !== stored.currentSession || calculated.term !== stored.currentTerm;
}

export async function adminOverrideCalendar(overrideData) {
  const { term, session, expiryDate } = overrideData;
  try {
    const docRef = doc(db, 'academicCalendar', 'current');
    const currentDoc = await getDoc(docRef);
    const currentVersion = currentDoc.exists() ? (currentDoc.data().forceSyncVersion || 0) : 0;
    await setDoc(docRef, {
      manualOverride: true,
      overrideSession: session,
      overrideTerm: term,
      overrideExpiry: expiryDate || null,
      lastUpdated: serverTimestamp(),
      forceSyncVersion: currentVersion + 1
    }, { merge: true });
    await initAcademicCalendar(); // reload
    toast.success('Calendar override applied successfully.');
    return getAcademicCalendar();
  } catch (err) {
    console.error('[AcademicCalendar] Admin override failed:', err);
    toast.error('Failed to apply calendar override. Please try again.');
    throw err;
  }
}

export async function adminResetToAuto() {
  try {
    const now = new Date();
    const calc = calculateTermAndSessionFromDate(now);
    const docRef = doc(db, 'academicCalendar', 'current');
    const currentDoc = await getDoc(docRef);
    const currentVersion = currentDoc.exists() ? (currentDoc.data().forceSyncVersion || 0) : 0;
    await setDoc(docRef, {
      manualOverride: false,
      overrideSession: null,
      overrideTerm: null,
      currentSession: calc.session,
      currentTerm: calc.term,
      termStart: calc.termStart,
      termEnd: calc.termEnd,
      lastUpdated: serverTimestamp(),
      forceSyncVersion: currentVersion + 1
    }, { merge: true });
    await initAcademicCalendar();
    toast.success('Calendar reset to automatic mode successfully.');
    return getAcademicCalendar();
  } catch (err) {
    console.error('[AcademicCalendar] Reset to auto failed:', err);
    toast.error('Failed to reset calendar. Please try again.');
    throw err;
  }
}

export function getCurrentUTCDate() {
  return new Date(new Date().toISOString().slice(0,19)+'Z');
}

export function destroyAcademicCalendar() {
  // no-op
}