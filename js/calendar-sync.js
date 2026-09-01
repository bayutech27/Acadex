// Calendar Sync Engine – Automatic Rollover Management
// All Firestore operations go through service.js (cache + offline queue).
// User-facing errors now show clear, friendly messages without technical jargon.

import * as service from './service.js';
import { toast } from './error-handler.js';
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
      // Don't show toast here – this is a background process, and the calendar will use fallback
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

      // NEW: Automatically align subscriptions to new term/session
      try {
        const { autoLockExpiredSubscriptions } = await import('./plan.js');
        await autoLockExpiredSubscriptions();
      } catch (err) {
        console.warn('[CalendarSync] Failed to auto-lock expired subscriptions:', err);
      }

      return true;
    }

    lastSyncTimestamp = now;
    return false;

  } catch (error) {
    console.error('[CalendarSync] Sync failed:', error);
    // Only show toast for network/permission errors that might affect the user
    if (error.message?.includes('permission') || error.code === 'permission-denied') {
      toast.warning('Calendar sync permission issue. Please refresh the page.');
    } else if (error.message?.includes('network') || error.message?.includes('offline')) {
      toast.warning('Network issue – calendar will sync automatically when connection is restored.');
    }
    return false;
  } finally {
    syncInProgress = false;
  }
}

// ----------------------------------- Force Sync -----------------------------------
export async function forceCalendarSync(testDate = null) {
  if (syncInProgress) {
    toast.error('Calendar sync is already in progress. Please wait.');
    throw new Error('Sync already in progress');
  }

  try {
    syncInProgress = true;
    await initAcademicCalendar();

    const storedData = await service.getAcademicCalendarDoc();

    if (!storedData) {
      toast.error('Calendar document not found. Please refresh the page.');
      throw new Error('Firestore document missing');
    }

    if (storedData.manualOverride === true) {
      toast.warning('Cannot force sync while calendar is manually overridden.');
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
    toast.success('Calendar synced successfully.');
    return calculated;

  } catch (error) {
    console.error('[CalendarSync] Force sync error:', error);
    if (!error.message?.includes('already in progress')) {
      toast.error('Failed to sync calendar. Please try again.');
    }
    throw error;
  } finally {
    syncInProgress = false;
  }
}

// ----------------------------------- Periodic Sync -----------------------------------
export function startPeriodicSync(intervalMinutes = 60) {
  const intervalId = setInterval(() => {
    syncAcademicCalendar().catch(err => {
      console.error('[CalendarSync] Periodic sync error:', err);
      // Silent failure – don't spam user with toasts every hour
    });
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
  try {
    const doc = await service.getAcademicCalendarDoc();
    return doc ? (doc.manualOverride || false) : false;
  } catch (error) {
    console.error('[CalendarSync] Failed to check manual override status:', error);
    return false; // Assume no override if we can't check
  }
}

// NEW: Helper that initialises and syncs in one call
export async function initAndSyncCalendar() {
  await initAcademicCalendar();
  await syncAcademicCalendar();
  return getAcademicCalendar();
}