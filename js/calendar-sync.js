// Calendar Sync Engine – Automatic Rollover Management
// All Firestore operations go through service.js (cache + offline queue).

import * as service from './service.js';
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

    // Use service to read the document
    const storedData = await service.getAcademicCalendarDoc();

    if (!storedData) {
      console.error('[CalendarSync] Firestore document missing');
      return false;
    }

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

      // Prepare updated data (merge with existing)
      const updatedData = {
        ...storedData,
        currentSession: calculated.session,
        currentTerm: calculated.term,
        termStart: calculated.termStart,
        termEnd: calculated.termEnd,
        lastUpdated: new Date(),
        autoManaged: true,
        forceSyncVersion: (storedData.forceSyncVersion || 0) + 1
      };
      await service.setAcademicCalendarDoc(updatedData);

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

    const storedData = await service.getAcademicCalendarDoc();

    if (!storedData) {
      throw new Error('Firestore document missing');
    }

    if (storedData.manualOverride === true) {
      throw new Error('Cannot force sync while manual override is active');
    }

    const referenceDate = testDate || getCurrentUTCDate();
    const calculated = calculateTermAndSessionFromDate(referenceDate);

    const updatedData = {
      ...storedData,
      currentSession: calculated.session,
      currentTerm: calculated.term,
      termStart: calculated.termStart,
      termEnd: calculated.termEnd,
      lastUpdated: new Date(),
      autoManaged: true,
      forceSyncVersion: (storedData.forceSyncVersion || 0) + 1
    };
    await service.setAcademicCalendarDoc(updatedData);

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
  const doc = await service.getAcademicCalendarDoc();
  return doc ? (doc.manualOverride || false) : false;
}