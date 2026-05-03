// plan.js – Subscription management
// FIXED: Subscriptions only expire when real endDate passes — never due to term/session mismatch.

import { db } from './firebase-config.js';
import {
  doc, getDoc, updateDoc, setDoc, collection, query, where, getDocs,
  writeBatch, orderBy, limit, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { handleError } from './error-handler.js';

const SUBSCRIPTION_DOC_ID = 'current';

// ------------------- FIX 4: Rolling 3-month end date (replaces hardcoded term dates) -------------------
// No longer uses term-based hardcoded dates that could immediately expire new activations.
function getRollingEndDate(monthsAhead = 3) {
  const end = new Date();
  end.setMonth(end.getMonth() + monthsAhead);
  return end;
}

// Kept for display/legacy use only — NOT used for expiry decisions.
function getTermEndDateFromSessionAndTerm(session, term) {
  if (!session || !term) return null;
  const startYear = parseInt(session.split('/')[0]);
  if (isNaN(startYear)) return null;
  let monthEnd, dayEnd;
  switch (term) {
    case 'First Term':  monthEnd = 11; dayEnd = 31; break;
    case 'Second Term': monthEnd = 3;  dayEnd = 30; break;
    case 'Third Term':  monthEnd = 7;  dayEnd = 30; break;
    default: return null;
  }
  return new Date(Date.UTC(startYear, monthEnd, dayEnd, 23, 59, 59));
}

// ------------------- Core subscription helpers -------------------
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
 * Never checks term/session. Never triggers writes.
 */
export async function getSubscriptionDisplayStatus(schoolId) {
  const sub = await getSubscriptionStatus(schoolId);
  if (!sub) return 'expired';
  if (sub.locked === true) return 'expired';
  return sub.status === 'active' ? 'active' : 'expired';
}

/**
 * FIX 1 & 2: isSubscriptionActive checks ONLY:
 *   1. status === 'active'
 *   2. locked !== true
 *   3. endDate has NOT passed
 *
 * Term/session mismatch is NO LONGER a reason to return false.
 * This keeps manually activated schools active until their real endDate passes.
 */
export async function isSubscriptionActive(schoolId) {
  const sub = await getSubscriptionStatus(schoolId);
  if (!sub) return false;
  if (sub.status !== 'active') return false;
  if (sub.locked === true) return false;

  // FIX 2: Only real date expiry matters
  if (sub.endDate) {
    const endDate = sub.endDate.toDate ? sub.endDate.toDate() : new Date(sub.endDate);
    if (endDate < new Date()) return false;
  }

  return true;
}

export async function canEnterScores(schoolId) {
  return await isSubscriptionActive(schoolId);
}

/**
 * FIX 1: enforceAccessGuard no longer uses term/session validation.
 * Access is denied only if the subscription is genuinely inactive
 * (status !== active, locked, or past endDate).
 */
export async function enforceAccessGuard(user, schoolId) {
  if (user.role === 'super-admin') return { allowed: true };
  const active = await isSubscriptionActive(schoolId);
  if (!active) {
    return { allowed: false, reason: 'subscription_expired', onboardingOnly: true };
  }
  return { allowed: true };
}

// ------------------- Lock / Unlock school -------------------
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

// ------------------- Payment & student coverage -------------------
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

// ------------------- FIX 8: Safe autoLockExpiredSubscriptions -------------------
// ONLY expires schools whose endDate has genuinely passed.
// NEVER creates new expired records.
// NEVER overwrites active subscriptions due to term/session mismatch.
export async function autoLockExpiredSubscriptions() {
  const now = new Date();
  try {
    const schoolsSnapshot = await getDocs(collection(db, 'schools'));
    const batch = writeBatch(db);
    let updateCount = 0;

    for (const schoolDoc of schoolsSnapshot.docs) {
      const schoolId = schoolDoc.id;
      const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
      const subSnap = await getDoc(subRef);

      // FIX 8: Skip schools with no subscription doc — do NOT create expired records
      if (!subSnap.exists()) continue;

      const data = subSnap.data();

      // FIX 2: Only expire when real endDate has passed and subscription is currently active
      if (
        data.status === 'active' &&
        data.locked !== true &&
        data.endDate
      ) {
        const endDate = data.endDate.toDate ? data.endDate.toDate() : new Date(data.endDate);
        if (endDate < now) {
          batch.update(subRef, {
            status: 'expired',
            locked: true,
            lastUpdated: now,
            autoExpired: true
          });
          updateCount++;
        }
      }
      // All other cases: do nothing. Term/session mismatch is NOT a reason to expire.
    }

    if (updateCount > 0) {
      await batch.commit();
      console.log(`autoLockExpiredSubscriptions: expired ${updateCount} school(s) whose endDate has passed.`);
    }
  } catch (err) {
    handleError(err, "Failed to run autoLockExpiredSubscriptions.");
  }
}

// ------------------- FIX 4: renewSubscriptionForCurrentTerm uses rolling end date -------------------
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

    // FIX 4: Use rolling 3-month end date so activation is always future-dated
    const endDate = getRollingEndDate(3);

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

// ------------------- Raw subscription helpers for teacher/realtime pages -------------------
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
 * FIX 6: Real-time subscription listener — unchanged API, behaviour preserved.
 * isActive = status === 'active' && locked !== true (no term/session check here).
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

// ------------------- Deprecated -------------------
export async function syncAcademicSession(schoolId) {
  console.warn('syncAcademicSession is deprecated; academic calendar is now centralised.');
}