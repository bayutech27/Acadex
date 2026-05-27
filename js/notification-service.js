// notification-service.js
import { db } from './firebase-config.js';
import {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  updateDoc,
  doc,
  serverTimestamp,
  getDocs
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

/**
 * Create a single notification document.
 */
export async function createNotification({
  studentId,
  schoolId,
  title,
  message,
  type,
  relatedId = null
}) {
  try {
    await addDoc(collection(db, 'notifications'), {
      studentId,
      schoolId,
      title,
      message,
      type,
      relatedId,
      read: false,
      createdAt: serverTimestamp()
    });
  } catch (err) {
    console.error('Error creating notification:', err);
  }
}

/**
 * Bulk create notifications (uses Promise.all for concurrency).
 */
export async function createBulkNotifications(notifications) {
  try {
    await Promise.all(
      notifications.map(n => createNotification(n))
    );
  } catch (err) {
    console.error('Error creating bulk notifications:', err);
  }
}

/**
 * Real‑time listener for a student's latest 10 notifications.
 * Calls callback with an array of notification objects ({ id, ...data }).
 * Returns the unsubscribe function.
 */
export function onStudentNotifications(studentId, callback) {
  const q = query(
    collection(db, 'notifications'),
    where('studentId', '==', studentId),
    orderBy('createdAt', 'desc'),
    limit(10)
  );

  return onSnapshot(
    q,
    snapshot => {
      const notifications = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      callback(notifications);
    },
    err => {
      console.error('Notifications listener error:', err);
      callback([]);
    }
  );
}

/**
 * Real‑time listener for the student's unread notification count.
 * Calls callback with the count (number). Returns unsubscribe function.
 */
export function onUnreadCountChange(studentId, callback) {
  const q = query(
    collection(db, 'notifications'),
    where('studentId', '==', studentId),
    where('read', '==', false)
  );

  return onSnapshot(
    q,
    snapshot => callback(snapshot.size),
    err => {
      console.error('Unread count listener error:', err);
      callback(0);
    }
  );
}

/**
 * Mark a single notification as read.
 */
export async function markNotificationAsRead(notificationId) {
  try {
    await updateDoc(doc(db, 'notifications', notificationId), { read: true });
  } catch (err) {
    console.error('Error marking notification as read:', err);
  }
}

/**
 * Mark all notifications as read for a given student (optional).
 */
export async function markAllAsRead(studentId) {
  try {
    const q = query(
      collection(db, 'notifications'),
      where('studentId', '==', studentId),
      where('read', '==', false)
    );
    const snapshot = await getDocs(q);
    const batch = [];
    snapshot.docs.forEach(d => {
      batch.push(updateDoc(doc(db, 'notifications', d.id), { read: true }));
    });
    await Promise.all(batch);
  } catch (err) {
    console.error('Error marking all as read:', err);
  }
}