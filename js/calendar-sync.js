// Calendar Sync Engine – Automatic Rollover Management
// Import your initialised Firestore db from your project's config
import { db } from './firebase-config.js';
// Import Firestore helper functions from the SDK
import { 
  doc, 
  getDoc, 
  updateDoc, 
  serverTimestamp, 
  FieldValue 
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { 
  initAcademicCalendar, 
  getAcademicCalendar, 
  shouldCalendarUpdate,
  getCurrentUTCDate,
  calculateTermAndSessionFromDate 
} from './academic-calendar.js';

let syncInProgress = false;
let lastSyncTimestamp = null;

// ----------------------------------- Core Sync Logic -----------------------------------
export async function syncAcademicCalendar() {
  if (syncInProgress) {
    console.log('[CalendarSync] Sync already in progress, skipping');
    return false;
  }

  try {
    syncInProgress = true;

    await initAcademicCalendar();

    const calendarDocRef = doc(db, 'academicCalendar', 'current');
    const firestoreSnapshot = await getDoc(calendarDocRef);

    if (!firestoreSnapshot.exists()) {
      console.error('[CalendarSync] Firestore document missing');
      return false;
    }

    const storedData = firestoreSnapshot.data();

    if (storedData.manualOverride === true) {
      console.log('[CalendarSync] Manual override active, skipping auto-sync');
      return false;
    }

    const now = getCurrentUTCDate();
    const calculated = calculateTermAndSessionFromDate(now);
    const needsUpdate = shouldCalendarUpdate(calculated, storedData);

    if (needsUpdate) {
      console.log('[CalendarSync] Rollover detected - Updating Firestore', {
        from: `${storedData.currentTerm} ${storedData.currentSession}`,
        to: `${calculated.term} ${calculated.session}`
      });

      await updateDoc(calendarDocRef, {
        currentSession: calculated.session,
        currentTerm: calculated.term,
        termStart: calculated.termStart,
        termEnd: calculated.termEnd,
        lastUpdated: serverTimestamp(),
        autoManaged: true,
        forceSyncVersion: FieldValue.increment(1)
      });

      lastSyncTimestamp = now;
      console.log('[CalendarSync] Firestore updated successfully');
      return true;
    }

    lastSyncTimestamp = now;
    return false;

  } catch (error) {
    console.error('[CalendarSync] Sync failed:', error);
    return false;
  } finally {
    syncInProgress = false;
  }
}

// ----------------------------------- Force Sync -----------------------------------
export async function forceCalendarSync(testDate = null) {
  if (syncInProgress) {
    throw new Error('Sync already in progress');
  }

  try {
    syncInProgress = true;
    await initAcademicCalendar();

    const calendarDocRef = doc(db, 'academicCalendar', 'current');
    const firestoreSnapshot = await getDoc(calendarDocRef);

    if (!firestoreSnapshot.exists()) {
      throw new Error('Firestore document missing');
    }

    const storedData = firestoreSnapshot.data();

    if (storedData.manualOverride === true) {
      throw new Error('Cannot force sync while manual override is active');
    }

    const referenceDate = testDate || getCurrentUTCDate();
    const calculated = calculateTermAndSessionFromDate(referenceDate);

    await updateDoc(calendarDocRef, {
      currentSession: calculated.session,
      currentTerm: calculated.term,
      termStart: calculated.termStart,
      termEnd: calculated.termEnd,
      lastUpdated: serverTimestamp(),
      autoManaged: true,
      forceSyncVersion: FieldValue.increment(1)
    });

    lastSyncTimestamp = referenceDate;
    return calculated;

  } finally {
    syncInProgress = false;
  }
}

// ----------------------------------- Periodic Sync -----------------------------------
export function startPeriodicSync(intervalMinutes = 60) {
  const intervalId = setInterval(() => {
    syncAcademicCalendar().catch(console.error);
  }, intervalMinutes * 60 * 1000);
  return () => clearInterval(intervalId);
}

// ----------------------------------- Status Helper -----------------------------------
export function getSyncStatus() {
  return {
    syncInProgress,
    lastSyncTimestamp,
    isManualOverride: () => checkManualOverrideStatus()
  };
}

async function checkManualOverrideStatus() {
  const calendarDocRef = doc(db, 'academicCalendar', 'current');
  const snapshot = await getDoc(calendarDocRef);
  return snapshot.exists() ? snapshot.data().manualOverride || false : false;
}