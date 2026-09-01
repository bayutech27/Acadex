// plan.js – Subscription management
// FIXED: Subscriptions only expire when real endDate passes — never due to term/session mismatch.
// All Firestore operations go through service.js where possible.
// TODO: service.js does not yet support lockSchool/unlockSchool, handleNewStudentAddition,
// approveExtraStudents, autoLockExpiredSubscriptions, renewSubscriptionForCurrentTerm.
// These remain as direct Firestore calls and should be moved to the service layer in the future.
// All user-facing errors now show clear, friendly messages without technical jargon.

import * as service from './service.js';
import {
  doc, updateDoc, setDoc, collection, query, where, getDocs,
  writeBatch, orderBy, limit, onSnapshot, getDoc
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { db } from './firebase-config.js';
import { toast } from './error-handler.js';

const SUBSCRIPTION_DOC_ID = 'current';

// ------------------- FIX 4: Rolling 3-month end date (kept for fallback) -------------------
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

// ------------------- Core subscription helpers (via service) -------------------
export async function getSubscriptionStatus(schoolId) {
  try {
    return await service.getSubscription(schoolId);
  } catch (err) {
    console.error('Get subscription status error:', err);
    toast.error('Unable to check subscription status. Please refresh the page.');
    return null;
  }
}

/**
 * FOR DISPLAY ONLY – returns status exactly as stored in Firestore.
 */
export async function getSubscriptionDisplayStatus(schoolId) {
  const sub = await getSubscriptionStatus(schoolId);
  if (!sub) return 'expired';
  if (sub.locked === true) return 'expired';
  return sub.status === 'active' ? 'active' : 'expired';
}

/**
 * isSubscriptionActive checks ONLY:
 *   1. status === 'active'
 *   2. locked !== true
 *   3. endDate has NOT passed
 *   4. term and session match current academic calendar
 */
export async function isSubscriptionActive(schoolId) {
  const sub = await getSubscriptionStatus(schoolId);
  if (!sub) return false;
  if (sub.status !== 'active') return false;
  if (sub.locked === true) return false;

  if (sub.endDate) {
    const endDate = sub.endDate.toDate ? sub.endDate.toDate() : new Date(sub.endDate);
    if (endDate < new Date()) return false;
  }

  // NEW: must match current term/session
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

  return true;
}

export async function canEnterScores(schoolId) {
  return await isSubscriptionActive(schoolId);
}

export async function enforceAccessGuard(user, schoolId) {
  if (user.role === 'super-admin') return { allowed: true };
  const active = await isSubscriptionActive(schoolId);
  if (!active) {
    return { allowed: false, reason: 'subscription_expired', onboardingOnly: true };
  }
  return { allowed: true };
}

// ------------------- Lock / Unlock school (direct Firestore) -------------------
export async function lockSchool(schoolId) {
  try {
    const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
    await updateDoc(subRef, { locked: true, status: 'expired', lastUpdated: new Date() });
    console.log(`School ${schoolId} locked`);
  } catch (err) {
    console.error('Lock school error:', err);
    toast.error('Failed to lock subscription. Please try again.');
  }
}

export async function unlockSchool(schoolId) {
  try {
    const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
    await updateDoc(subRef, { locked: false, status: 'active', lastUpdated: new Date() });
    console.log(`School ${schoolId} unlocked`);
  } catch (err) {
    console.error('Unlock school error:', err);
    toast.error('Failed to unlock subscription. Please try again.');
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
    console.error('Update subscription amount error:', err);
    toast.warning('Unable to update subscription amount. Please refresh the page.');
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
    console.error('Handle new student addition error:', err);
    toast.error('Failed to process new student. Please contact support.');
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
    console.error('Approve extra students error:', err);
    toast.error('Failed to approve extra students. Please try again.');
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
    console.error('Mark students as covered error:', err);
    toast.warning('Unable to mark students as covered. Please contact support.');
  }
}

// ------------------- Safe autoLockExpiredSubscriptions -------------------
export async function autoLockExpiredSubscriptions() {
  const now = new Date();
  const { getCurrentTerm, getCurrentSession } = await import('./academic-calendar.js');
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
  if (!currentTerm || !currentSession) return;

  try {
    const schoolsSnapshot = await getDocs(collection(db, 'schools'));
    const batch = writeBatch(db);
    let updateCount = 0;

    for (const schoolDoc of schoolsSnapshot.docs) {
      const schoolId = schoolDoc.id;
      const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
      const subSnap = await getDoc(subRef);

      if (!subSnap.exists()) continue;

      const data = subSnap.data();

      if (data.status !== 'active' || data.locked === true) continue;

      let shouldExpire = false;

      // Check date-based expiry
      if (data.endDate) {
        const endDate = data.endDate.toDate ? data.endDate.toDate() : new Date(data.endDate);
        if (endDate < now) shouldExpire = true;
      }

      // NEW: also expire if term/session no longer matches current calendar
      if (data.term !== currentTerm || data.session !== currentSession) {
        shouldExpire = true;
      }

      if (shouldExpire) {
        batch.update(subRef, {
          status: 'expired',
          locked: true,
          lastUpdated: now,
          autoExpired: true
        });
        updateCount++;
      }
    }

    if (updateCount > 0) {
      await batch.commit();
      console.log(`autoLockExpiredSubscriptions: expired ${updateCount} school(s).`);
    }
  } catch (err) {
    console.error('Auto-lock expired subscriptions error:', err);
    toast.warning('Failed to check for expired subscriptions. Please try again later.');
  }
}

// ------------------- renewSubscriptionForCurrentTerm -------------------
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
    if (!currentTerm || !currentSession) throw new Error('Calendar not ready');

    // Use actual term end date (no rolling fallback)
    const termEnd = getTermEndDateFromSessionAndTerm(currentSession, currentTerm);
    if (!termEnd) throw new Error('Unable to determine term end date');

    const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
    const subSnap = await getDoc(subRef);
    const now = new Date();

    const data = {
      status: 'active',
      locked: false,
      term: currentTerm,
      session: currentSession,
      startDate: now,
      endDate: termEnd,
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
    console.error('Renew subscription error:', err);
    toast.error('Failed to renew subscription. Please try again or contact support.');
    return false;
  }
}

// ------------------- Raw subscription helpers (via service) -------------------
export async function getRawSubscription(schoolId) {
  try {
    return await service.getRawSubscription(schoolId);
  } catch (err) {
    console.error('Get raw subscription error:', err);
    toast.error('Unable to fetch subscription details. Please refresh the page.');
    return null;
  }
}

/**
 * Real-time subscription listener — now using service.subscribeToSubscription.
 */
export function onSubscriptionChange(schoolId, callback) {
  const unsubscribe = service.subscribeToSubscription(schoolId, (subData) => {
    let isActive = false;
    if (subData) {
      isActive = (subData.status === 'active' && subData.locked !== true);
    }
    callback({ isActive, data: subData });
  });
  return unsubscribe;
}

// ------------------- Deprecated -------------------
export async function syncAcademicSession(schoolId) {
  console.warn('syncAcademicSession is deprecated; academic calendar is now centralised.');
}