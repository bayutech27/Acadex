// plan.js – Subscription management with granular permissions
import { db } from './firebase-config.js';
import {
  doc, getDoc, updateDoc, collection, query, where, getDocs,
  writeBatch, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentAcademicSessionAndTerm } from './admin.js';
import { handleError, showNotification } from './error-handler.js';

const SUBSCRIPTION_DOC_ID = 'current';

// ------------------- Subscription Helpers -------------------
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

export async function isSubscriptionActive(schoolId) {
  const sub = await getSubscriptionStatus(schoolId);
  if (!sub) return false;
  if (sub.status !== 'active') return false;
  if (sub.locked === true) return false;
  if (sub.endDate && sub.endDate.toDate() < new Date()) return false;
  return true;
}

// Granular check for score entry and report generation
export async function canEnterScores(schoolId) {
  const sub = await getSubscriptionStatus(schoolId);
  if (!sub) return false;
  return sub.status === 'active' && sub.locked === false;
}

// Enforce subscription for any admin/teacher action (legacy)
export async function enforceAccessGuard(user, schoolId) {
  if (user.role === 'super-admin') return { allowed: true };

  const active = await isSubscriptionActive(schoolId);
  if (!active) {
    const sub = await getSubscriptionStatus(schoolId);
    const isExpired = !sub || sub.status === 'expired' || sub.locked === true;
    if (isExpired) {
      return { allowed: false, reason: 'subscription_expired', onboardingOnly: true };
    }
    return { allowed: false, reason: 'subscription_inactive' };
  }
  return { allowed: true };
}

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
    if (data.status !== 'active') return null;

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
      await updateDoc(subRef, {
        totalStudents: newTotal,
        lastUpdated: new Date()
      });
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

export async function autoLockExpiredSubscriptions() {
  const now = new Date();
  try {
    const schoolsSnapshot = await getDocs(collection(db, 'schools'));
    const batch = writeBatch(db);
    let lockCount = 0;

    for (const schoolDoc of schoolsSnapshot.docs) {
      const schoolId = schoolDoc.id;
      const subRef = doc(db, 'schools', schoolId, 'subscription', SUBSCRIPTION_DOC_ID);
      const subSnap = await getDoc(subRef);
      if (!subSnap.exists()) continue;

      const subData = subSnap.data();
      if (subData.status !== 'active') continue;
      if (subData.locked === true) continue;

      const endDate = subData.endDate?.toDate();
      if (endDate && endDate < now) {
        batch.update(subRef, {
          status: 'expired',
          locked: true,
          lastUpdated: now
        });
        lockCount++;
      }
    }

    if (lockCount > 0) {
      await batch.commit();
      console.log(`Auto‑locked ${lockCount} schools due to term end.`);
    }
  } catch (err) {
    handleError(err, "Failed to auto-lock expired subscriptions.");
  }
}

export async function syncAcademicSession(schoolId) {
  const { session, term } = getCurrentAcademicSessionAndTerm();
  const schoolRef = doc(db, 'schools', schoolId);
  try {
    const snap = await getDoc(schoolRef);
    if (!snap.exists()) return;

    const data = snap.data();
    if (data.currentSession !== session || data.currentTerm !== term) {
      await updateDoc(schoolRef, {
        currentSession: session,
        currentTerm: term,
        lastAcademicUpdate: new Date()
      });
      console.log(`Academic session updated to ${session} Term ${term}`);
    }
  } catch (err) {
    handleError(err, "Failed to sync academic session.");
  }
}