// notification-service.js
// All Firestore operations go through service.js where possible.
// TODO: service.js does not yet support notification creation, bulk creation,
// real‑time listeners, or marking read/unread. These operations remain as direct Firestore
// calls and should be added to the service layer in the future.
// All user-facing errors now show clear, friendly messages without technical jargon.

import * as service from './service.js';
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
import { db } from './firebase-config.js';
import { toast } from './error-handler.js';

/**
 * Create a single notification document.
 * TODO: Add service.createNotification() to the service layer.
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
    toast.warning('Unable to send notification. Please try again.');
  }
}

/**
 * Bulk create notifications (uses Promise.all for concurrency).
 * TODO: Add service.createBulkNotifications() to the service layer.
 */
export async function createBulkNotifications(notifications) {
  try {
    await Promise.all(
      notifications.map(n => createNotification(n))
    );
  } catch (err) {
    console.error('Error creating bulk notifications:', err);
    toast.warning('Unable to send notifications. Some students may not receive updates.');
  }
}

/**
 * Real‑time listener for a student's latest 10 notifications.
 * Calls callback with an array of notification objects ({ id, ...data }).
 * Returns the unsubscribe function.
 * TODO: Replace with service.subscribeToStudentNotifications() when available.
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
      toast.warning('Unable to load notifications. Please refresh the page.');
      callback([]);
    }
  );
}

/**
 * Real‑time listener for the student's unread notification count.
 * Calls callback with the count (number). Returns unsubscribe function.
 * TODO: Replace with service.subscribeToUnreadCount() when available.
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
      toast.warning('Unable to load notification count. Please refresh the page.');
      callback(0);
    }
  );
}

/**
 * Mark a single notification as read.
 * TODO: Add service.markNotificationAsRead() to the service layer.
 */
export async function markNotificationAsRead(notificationId) {
  try {
    await updateDoc(doc(db, 'notifications', notificationId), { read: true });
  } catch (err) {
    console.error('Error marking notification as read:', err);
    toast.warning('Unable to mark notification as read. Please try again.');
  }
}

/**
 * Mark all notifications as read for a given student.
 * TODO: Add service.markAllNotificationsAsRead() to the service layer.
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
    toast.warning('Unable to mark all notifications as read. Please try again.');
  }
}