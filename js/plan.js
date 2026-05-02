// plan.js – Term‑based subscription management with raw Firestore helpers for teacher pages
import { db } from './firebase-config.js';
import {
  doc, getDoc, updateDoc, setDoc, collection, query, where, getDocs,
  writeBatch, orderBy, limit, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { handleError } from './error-handler.js';

const SUBSCRIPTION_DOC_ID = 'current';

// ------------------- Helper: Compute term end date from session and term name -------------------
function getTermEndDateFromSessionAndTerm(session, term) {
  if (!session || !term) return null;
  const startYear = parseInt(session.split('/')[0]);
  if (isNaN(startYear)) return null;
  let year = startYear;
  let monthEnd, dayEnd;
  switch (term) {
    case 'First Term':
      monthEnd = 11; dayEnd = 31;   // December 31
      break;
    case 'Second Term':
      monthEnd = 3; dayEnd = 30;    // April 30
      break;
    case 'Third Term':
      monthEnd = 7; dayEnd = 30;    // August 30
      break;
    default:
      return null;
  }
  return new Date(Date.UTC(year, monthEnd, dayEnd, 23, 59, 59));
}

// ------------------- Core subscription helpers (existing) -------------------
export async function getSubscriptionStatus(schoolId) {
  try {
    const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
    const snap = await getDoc(subRef);
    if (!snap.exists()) return null;
    return snap.data();
  } catch (err) {
    handleError(err, "Failed to get subscription status.");
    return null;
  }
}

/**
 * FOR DISPLAY ONLY – returns status exactly as stored in Firestore.
 * Ignores term/session matching.
 * @returns {string} 'active' or 'expired'
 */
export async function getSubscriptionDisplayStatus(schoolId) {
  const sub = await getSubscriptionStatus(schoolId);
  if (!sub) return 'expired';
  if (sub.locked === true) return 'expired';
  return sub.status === 'active' ? 'active' : 'expired';
}

/**
 * Strict permission check for academic features (scores, reports, etc.).
 * Requires term/session match and active status.
 */
export async function isSubscriptionActive(schoolId) {
  const sub = await getSubscriptionStatus(schoolId);
  if (!sub) return false;
  if (sub.status !== 'active') return false;
  if (sub.locked === true) return false;

  const { getCurrentTerm, getCurrentSession, initAcademicCalendar } = await import('./academic-calendar.js');
  await initAcademicCalendar();
  let currentTerm, currentSession;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      currentTerm = getCurrentTerm();
      currentSession = getCurrentSession();
      break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (!currentTerm || !currentSession) return false;

  if (sub.term !== currentTerm || sub.session !== currentSession) return false;
  if (sub.endDate && sub.endDate.toDate() < new Date()) return false;

  return true;
}

// Granular check for score entry and report generation (uses strict check)
export async function canEnterScores(schoolId) {
  return await isSubscriptionActive(schoolId);
}

/**
 * Enforce subscription access for admin/teacher actions.
 * If subscription is inactive, allow only onboarding (adding students/teachers)
 * but deny all core academic functions (scores, reports, broadsheets).
 */
export async function enforceAccessGuard(user, schoolId) {
  if (user.role === 'super-admin') return { allowed: true };
  const active = await isSubscriptionActive(schoolId);
  if (!active) {
    return { allowed: false, reason: 'subscription_expired', onboardingOnly: true };
  }
  return { allowed: true };
}

// ------------------- Lock / Unlock school (by admin) -------------------
export async function lockSchool(schoolId) {
  try {
    const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
    await updateDoc(subRef, { locked: true, status: 'expired', lastUpdated: new Date() });
  } catch (err) {
    handleError(err, "Failed to lock school subscription.");
  }
}

export async function unlockSchool(schoolId) {
  try {
    const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
    await updateDoc(subRef, { locked: false, status: 'active', lastUpdated: new Date() });
  } catch (err) {
    handleError(err, "Failed to unlock school subscription.");
  }
}

// ------------------- Payment & student coverage (unchanged) -------------------
export function calculateSubscriptionCost(coveredStudents, costPerStudent = 1000) {
  return coveredStudents * costPerStudent;
}

export async function checkSubscription(schoolId) {
  return await getSubscriptionStatus(schoolId);
}

export async function updateSubscriptionAmount(schoolId) {
  try {
    const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
    const sub = await getDoc(subRef);
    if (!sub.exists()) return;
    const data = sub.data();
    const totalAmount = (data.coveredStudents || 0) * (data.costPerStudent || 1000);
    await updateDoc(subRef, { totalAmount, lastUpdated: new Date() });
  } catch (err) {
    handleError(err, "Failed to update subscription amount.");
  }
}

export async function handleNewStudentAddition(schoolId, studentCount = 1) {
  try {
    const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
    const sub = await getDoc(subRef);
    if (!sub.exists()) return null;
    const data = sub.data();
    if (!(await isSubscriptionActive(schoolId))) return null;

    const currentTotal = data.totalStudents || 0;
    const covered = data.coveredStudents || 0;
    const extra = currentTotal + studentCount - covered;
    const newTotal = currentTotal + studentCount;

    if (extra > 0) {
      await updateDoc(subRef, {
        extraStudentsPendingApproval: (data.extraStudentsPendingApproval || 0) + extra,
        totalStudents: newTotal,
        lastUpdated: new Date()
      });
      return { extra, totalPending: (data.extraStudentsPendingApproval || 0) + extra };
    } else {
      await updateDoc(subRef, { totalStudents: newTotal, lastUpdated: new Date() });
    }
    return null;
  } catch (err) {
    handleError(err, "Failed to process new student addition.");
    return null;
  }
}

export async function approveExtraStudents(schoolId, approveCount) {
  try {
    const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
    const sub = await getDoc(subRef);
    if (!sub.exists()) return false;
    const data = sub.data();
    const pending = data.extraStudentsPendingApproval || 0;
    if (approveCount > pending) approveCount = pending;
    const newCovered = (data.coveredStudents || 0) + approveCount;
    const newPending = pending - approveCount;
    const totalAmount = newCovered * (data.costPerStudent || 1000);
    await updateDoc(subRef, {
      coveredStudents: newCovered,
      extraStudentsPendingApproval: newPending,
      totalAmount,
      lastUpdated: new Date()
    });
    await markStudentsAsCovered(schoolId, approveCount);
    return true;
  } catch (err) {
    handleError(err, "Failed to approve extra students.");
    return false;
  }
}

async function markStudentsAsCovered(schoolId, count) {
  try {
    const studentsRef = collection(db, 'students');
    const q = query(
      studentsRef,
      where('schoolId', '==', schoolId),
      where('status', '==', 'active'),
      where('subscriptionCovered', '==', false),
      orderBy('createdAt', 'asc'),
      limit(count)
    );
    const snap = await getDocs(q);
    const batch = writeBatch(db);
    snap.forEach(docSnap => {
      batch.update(docSnap.ref, { subscriptionCovered: true });
    });
    await batch.commit();
  } catch (err) {
    handleError(err, "Failed to mark students as covered.");
  }
}

// ------------------- Term‑based auto‑lock (only on calendar change) -------------------
export async function autoLockExpiredSubscriptions() {
  const { getCurrentTerm, getCurrentSession, initAcademicCalendar } = await import('./academic-calendar.js');
  await initAcademicCalendar();

  let currentTerm, currentSession;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      currentTerm = getCurrentTerm();
      currentSession = getCurrentSession();
      break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (!currentTerm || !currentSession) {
    console.warn('autoLockExpiredSubscriptions: Could not retrieve current term/session, aborting.');
    return;
  }

  const endDate = getTermEndDateFromSessionAndTerm(currentSession, currentTerm);
  const now = new Date();

  try {
    const schoolsSnapshot = await getDocs(collection(db, 'schools'));
    const batch = writeBatch(db);
    let updateCount = 0;

    for (const schoolDoc of schoolsSnapshot.docs) {
      const schoolId = schoolDoc.id;
      const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
      const subSnap = await getDoc(subRef);
      const existingData = subSnap.exists() ? subSnap.data() : null;
      const matchesCurrent = existingData && existingData.term === currentTerm && existingData.session === currentSession;

      if (!existingData || !matchesCurrent) {
        const subscriptionData = {
          term: currentTerm,
          session: currentSession,
          startDate: now,
          endDate: endDate,
          status: 'expired',
          locked: true,
          plan: existingData?.plan || 'basic',
          costPerStudent: existingData?.costPerStudent || 1000,
          totalStudents: existingData?.totalStudents || 0,
          coveredStudents: existingData?.coveredStudents || 0,
          extraStudentsPendingApproval: existingData?.extraStudentsPendingApproval || 0,
          totalAmount: existingData?.totalAmount || 0,
          lastUpdated: now,
          autoExpired: true
        };
        batch.set(subRef, subscriptionData, { merge: true });
        updateCount++;
      } else if (existingData.status === 'active' && existingData.endDate && existingData.endDate.toDate() < now) {
        batch.update(subRef, { status: 'expired', locked: true, lastUpdated: now, autoExpired: true });
        updateCount++;
      }
    }

    if (updateCount > 0) {
      await batch.commit();
      console.log(`Term rollover: updated ${updateCount} subscriptions to ${currentTerm} ${currentSession} (all set to expired).`);
    }
  } catch (err) {
    handleError(err, "Failed to sync subscriptions for the new term.");
  }
}

// ------------------- Renew subscription for current term (used when school pays) -------------------
export async function renewSubscriptionForCurrentTerm(schoolId, coveredStudents, costPerStudent = 1000) {
  try {
    const { getCurrentTerm, getCurrentSession, initAcademicCalendar } = await import('./academic-calendar.js');
    await initAcademicCalendar();
    let currentTerm, currentSession;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        currentTerm = getCurrentTerm();
        currentSession = getCurrentSession();
        break;
      } catch (e) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    if (!currentTerm || !currentSession) throw new Error('Cannot renew: calendar not ready');

    const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
    const subSnap = await getDoc(subRef);
    const now = new Date();
    const endDate = getTermEndDateFromSessionAndTerm(currentSession, currentTerm);

    const data = {
      status: 'active',
      locked: false,
      term: currentTerm,
      session: currentSession,
      startDate: now,
      endDate: endDate,
      coveredStudents: coveredStudents,
      costPerStudent: costPerStudent,
      totalAmount: coveredStudents * costPerStudent,
      lastUpdated: now,
      autoExpired: false
    };

    if (subSnap.exists()) {
      const existing = subSnap.data();
      data.totalStudents = existing.totalStudents || coveredStudents;
      data.extraStudentsPendingApproval = existing.extraStudentsPendingApproval || 0;
      await updateDoc(subRef, data);
    } else {
      data.totalStudents = coveredStudents;
      data.extraStudentsPendingApproval = 0;
      await setDoc(subRef, data);
    }
    return true;
  } catch (err) {
    handleError(err, "Failed to renew subscription for the current term.");
    return false;
  }
}

// ------------------- NEW: Raw subscription helpers for teacher pages (real‑time) -------------------
/**
 * Get the raw subscription data (no term validation)
 * @returns {Promise<Object|null>}
 */
export async function getRawSubscription(schoolId) {
  try {
    const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
    const snap = await getDoc(subRef);
    if (!snap.exists()) return null;
    return snap.data();
  } catch (err) {
    handleError(err, "Failed to fetch raw subscription.");
    return null;
  }
}

/**
 * Listen to real‑time changes of the raw subscription.
 * @param {string} schoolId
 * @param {Function} callback - receives { isActive: boolean, data: object|null }
 * @returns {Function} unsubscribe function
 */
export function onSubscriptionChange(schoolId, callback) {
  const subRef = doc(db, 'schools', schoolId, 'subscription', 'current');
  const unsubscribe = onSnapshot(subRef, (snap) => {
    let data = null;
    let isActive = false;
    if (snap.exists()) {
      data = snap.data();
      isActive = (data.status === 'active' && data.locked !== true);
    }
    callback({ isActive, data });
  }, (err) => {
    handleError(err, "Subscription listener error.");
  });
  return unsubscribe;
}

// ------------------- Deprecated (legacy) -------------------
export async function syncAcademicSession(schoolId) {
  console.warn('syncAcademicSession is deprecated; academic calendar is now centralised.');
  return;
}