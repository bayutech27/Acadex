// service.js – Single Source of Truth API Layer
// All Firestore access goes through this file.
// Uses cache.js for reads and offlineQueue.js for writes.

import { db } from './firebase-config.js';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  getDocs, collection, query, where, orderBy, limit, startAfter,
  onSnapshot, serverTimestamp, writeBatch, increment,
  arrayUnion, arrayRemove, documentId
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import * as cache from './cache.js';
import * as offlineQueue from './offlineQueue.js';

// ── TTL constants ─────────────────────────────────────────────────────────────
const TTL_SHORT  = 2  * 60 * 1000;   // 2  min  – subscription, live data
const TTL_MED    = 5  * 60 * 1000;   // 5  min  – students, teachers, scores
const TTL_LONG   = 15 * 60 * 1000;   // 15 min  – schools, classes, subjects
const TTL_STATIC = 60 * 60 * 1000;   // 60 min  – academic calendar, scoring config

// ── Helper: build a cache key ─────────────────────────────────────────────────
const _k = (...parts) => parts.join(':');

// ── Helper: is the app currently online? ─────────────────────────────────────
const _online = () => navigator.onLine;

// ── Helper: snapshot → plain object ─────────────────────────────────────────
function _docData(snap) {
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
function _queryData(snap) {
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ════════════════════════════════════════════════════════════════════════════
// CANONICAL SESSION SANITIZER (shared across the app)
// ════════════════════════════════════════════════════════════════════════════
export function sanitizeSession(session) {
  return session ? session.replace(/\//g, '-') : '';
}

// ════════════════════════════════════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════════════════════════════════════

export async function getUserById(uid) {
  return cache.getFreshOrCached(
    _k('user', uid),
    async () => _docData(await getDoc(doc(db, 'users', uid))),
    { ttl: TTL_MED, tags: ['users', _k('user', uid)] }
  );
}

export async function updateUser(uid, data) {
  if (_online()) {
    await updateDoc(doc(db, 'users', uid), { ...data, updatedAt: serverTimestamp() });
    cache.del(_k('user', uid));
    cache.invalidateByTag('users');
  } else {
    offlineQueue.enqueue({ type: 'UPDATE', collection: 'users', docId: uid, payload: data });
    const cur = cache.get(_k('user', uid));
    if (cur) cache.set(_k('user', uid), { ...cur, ...data }, { ttl: TTL_MED, tags: ['users', _k('user', uid)] });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SCHOOLS
// ════════════════════════════════════════════════════════════════════════════

export async function getSchoolById(schoolId) {
  if (!schoolId) return null;
  return cache.getFreshOrCached(
    _k('school', schoolId),
    async () => _docData(await getDoc(doc(db, 'schools', schoolId))),
    { ttl: TTL_LONG, tags: ['schools', _k('school', schoolId)] }
  );
}

export async function updateSchool(schoolId, data) {
  if (_online()) {
    await updateDoc(doc(db, 'schools', schoolId), { ...data, updatedAt: serverTimestamp() });
    cache.del(_k('school', schoolId));
    cache.invalidateByTag('schools');
  } else {
    offlineQueue.enqueue({ type: 'UPDATE', collection: 'schools', docId: schoolId, payload: data });
    const cur = cache.get(_k('school', schoolId));
    if (cur) cache.set(_k('school', schoolId), { ...cur, ...data }, { ttl: TTL_LONG, tags: ['schools'] });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION
// ════════════════════════════════════════════════════════════════════════════

export async function getSubscription(schoolId) {
  return cache.getFreshOrCached(
    _k('subscription', schoolId),
    async () => {
      const snap = await getDoc(doc(db, 'schools', schoolId, 'subscription', 'current'));
      return snap.exists() ? snap.data() : null;
    },
    { ttl: TTL_SHORT, tags: ['subscription', _k('subscription', schoolId)] }
  );
}

export async function updateSubscription(schoolId, data) {
  const ref = doc(db, 'schools', schoolId, 'subscription', 'current');
  if (_online()) {
    await updateDoc(ref, { ...data, lastUpdated: serverTimestamp() });
    cache.del(_k('subscription', schoolId));
    cache.invalidateByTag('subscription');
  } else {
    offlineQueue.enqueue({
      type: 'UPDATE',
      collection: `schools/${schoolId}/subscription`,
      docId: 'current',
      payload: data,
    });
  }
}

export function subscribeToSubscription(schoolId, callback) {
  const ref = doc(db, 'schools', schoolId, 'subscription', 'current');
  return onSnapshot(ref, snap => {
    const data = snap.exists() ? snap.data() : null;
    if (data) {
      cache.set(_k('subscription', schoolId), data, { ttl: TTL_SHORT, tags: ['subscription'] });
    }
    callback(data);
  });
}

export async function getRawSubscription(schoolId) {
  const snap = await getDoc(doc(db, 'schools', schoolId, 'subscription', 'current'));
  return snap.exists() ? snap.data() : null;
}

// ════════════════════════════════════════════════════════════════════════════
// STUDENTS
// ════════════════════════════════════════════════════════════════════════════

export async function getStudentById(studentId) {
  return cache.getFreshOrCached(
    _k('student', studentId),
    async () => _docData(await getDoc(doc(db, 'students', studentId))),
    { ttl: TTL_MED, tags: ['students', _k('student', studentId)] }
  );
}

export async function getStudentsBySchool(schoolId, statusFilter = 'active') {
  const key = _k('students', schoolId, statusFilter);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = statusFilter
        ? query(collection(db, 'students'), where('schoolId', '==', schoolId), where('status', '==', statusFilter))
        : query(collection(db, 'students'), where('schoolId', '==', schoolId));
      const snap = await getDocs(q);
      const list = _queryData(snap);
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return list;
    },
    { ttl: TTL_MED, tags: ['students', _k('students', schoolId)] }
  );
}

export async function getStudentsByClass(schoolId, classId) {
  const key = _k('students', schoolId, 'class', classId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'students'),
        where('schoolId', '==', schoolId),
        where('classId', '==', classId),
        where('status', '==', 'active')
      );
      const snap = await getDocs(q);
      const list = _queryData(snap);
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return list;
    },
    { ttl: TTL_MED, tags: ['students', _k('students', schoolId)] }
  );
}

export async function getStudentsByIds(studentIds) {
  if (!studentIds || studentIds.length === 0) return [];
  // chunk into 10s because Firestore 'in' limit
  const chunks = [];
  for (let i = 0; i < studentIds.length; i += 10) chunks.push(studentIds.slice(i, i+10));
  const results = [];
  for (const chunk of chunks) {
    const q = query(collection(db, 'students'), where(documentId(), 'in', chunk));
    const snap = await getDocs(q);
    results.push(..._queryData(snap));
  }
  return results;
}

export async function countStudents(schoolId, statusFilter = null) {
  const key = _k('students-count', schoolId, statusFilter || 'all');
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = statusFilter
        ? query(collection(db, 'students'), where('schoolId', '==', schoolId), where('status', '==', statusFilter))
        : query(collection(db, 'students'), where('schoolId', '==', schoolId));
      const snap = await getDocs(q);
      return snap.size;
    },
    { ttl: TTL_SHORT, tags: ['students', _k('students', schoolId)] }
  );
}

export async function countLockedStudents(schoolId) {
  const key = _k('students-locked-count', schoolId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const snap = await getDocs(
        query(collection(db, 'students'), where('schoolId', '==', schoolId), where('locked', '==', true))
      );
      return snap.size;
    },
    { ttl: TTL_SHORT, tags: ['students', _k('students', schoolId)] }
  );
}

export async function createStudent(uid, data) {
  const studentData = { ...data, createdAt: new Date(), updatedAt: new Date() };
  if (_online()) {
    await setDoc(doc(db, 'students', uid), studentData);
    cache.invalidateByTag('students');
  } else {
    offlineQueue.enqueue({ type: 'SET', collection: 'students', docId: uid, payload: studentData });
    cache.set(_k('student', uid), { id: uid, ...studentData }, { ttl: TTL_MED, tags: ['students'] });
    cache.invalidateByTag(_k('students', data.schoolId));
  }
}

export async function updateStudent(studentId, data) {
  const updateData = { ...data, updatedAt: new Date() };
  if (_online()) {
    await updateDoc(doc(db, 'students', studentId), updateData);
    cache.del(_k('student', studentId));
    cache.invalidateByTag('students');
  } else {
    offlineQueue.enqueue({ type: 'UPDATE', collection: 'students', docId: studentId, payload: updateData });
    const cur = cache.get(_k('student', studentId));
    if (cur) cache.set(_k('student', studentId), { ...cur, ...updateData }, { ttl: TTL_MED, tags: ['students'] });
  }
}

export async function deleteStudent(studentId) {
  if (_online()) {
    await deleteDoc(doc(db, 'students', studentId));
    cache.del(_k('student', studentId));
    cache.invalidateByTag('students');
  } else {
    offlineQueue.enqueue({ type: 'DELETE', collection: 'students', docId: studentId, payload: {} });
    cache.del(_k('student', studentId));
    cache.invalidateByTag('students');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TEACHERS
// ════════════════════════════════════════════════════════════════════════════

export async function getTeacherById(teacherId) {
  return cache.getFreshOrCached(
    _k('teacher', teacherId),
    async () => _docData(await getDoc(doc(db, 'teachers', teacherId))),
    { ttl: TTL_MED, tags: ['teachers', _k('teacher', teacherId)] }
  );
}

export async function getTeachersBySchool(schoolId) {
  const key = _k('teachers', schoolId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(collection(db, 'teachers'), where('schoolId', '==', schoolId));
      const snap = await getDocs(q);
      const list = _queryData(snap);
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return list;
    },
    { ttl: TTL_MED, tags: ['teachers', _k('teachers', schoolId)] }
  );
}

export async function countTeachers(schoolId) {
  const key = _k('teachers-count', schoolId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const snap = await getDocs(query(collection(db, 'teachers'), where('schoolId', '==', schoolId)));
      return snap.size;
    },
    { ttl: TTL_SHORT, tags: ['teachers', _k('teachers', schoolId)] }
  );
}

export async function createTeacher(uid, data) {
  const teacherData = { ...data, createdAt: new Date(), updatedAt: new Date() };
  if (_online()) {
    await setDoc(doc(db, 'teachers', uid), teacherData);
    cache.invalidateByTag('teachers');
  } else {
    offlineQueue.enqueue({ type: 'SET', collection: 'teachers', docId: uid, payload: teacherData });
    cache.set(_k('teacher', uid), { id: uid, ...teacherData }, { ttl: TTL_MED, tags: ['teachers'] });
  }
}

export async function updateTeacher(teacherId, data) {
  const updateData = { ...data, updatedAt: new Date() };
  if (_online()) {
    await updateDoc(doc(db, 'teachers', teacherId), updateData);
    cache.del(_k('teacher', teacherId));
    cache.invalidateByTag('teachers');
  } else {
    offlineQueue.enqueue({ type: 'UPDATE', collection: 'teachers', docId: teacherId, payload: updateData });
    const cur = cache.get(_k('teacher', teacherId));
    if (cur) cache.set(_k('teacher', teacherId), { ...cur, ...updateData }, { ttl: TTL_MED, tags: ['teachers'] });
  }
}

export async function deleteTeacher(teacherId) {
  if (_online()) {
    await deleteDoc(doc(db, 'teachers', teacherId));
    cache.del(_k('teacher', teacherId));
    cache.invalidateByTag('teachers');
  } else {
    offlineQueue.enqueue({ type: 'DELETE', collection: 'teachers', docId: teacherId, payload: {} });
    cache.del(_k('teacher', teacherId));
    cache.invalidateByTag('teachers');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CLASSES
// ════════════════════════════════════════════════════════════════════════════

export async function getClassesBySchool(schoolId) {
  const key = _k('classes', schoolId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(collection(db, 'classes'), where('schoolId', '==', schoolId));
      const snap = await getDocs(q);
      const list = _queryData(snap);
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return list;
    },
    { ttl: TTL_LONG, tags: ['classes', _k('classes', schoolId)] }
  );
}

export async function getClassById(classId) {
  return cache.getFreshOrCached(
    _k('class', classId),
    async () => _docData(await getDoc(doc(db, 'classes', classId))),
    { ttl: TTL_LONG, tags: ['classes', _k('class', classId)] }
  );
}

export async function getClassesBySchoolAndLevel(schoolId, level) {
  const key = _k('classes', schoolId, level);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(collection(db, 'classes'), where('schoolId', '==', schoolId), where('level', '==', level));
      const snap = await getDocs(q);
      const list = _queryData(snap);
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return list;
    },
    { ttl: TTL_LONG, tags: ['classes', _k('classes', schoolId)] }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SUBJECTS
// ════════════════════════════════════════════════════════════════════════════

export async function getSubjectsBySchool(schoolId) {
  const key = _k('subjects', schoolId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(collection(db, 'subjects'), where('schoolId', '==', schoolId));
      const snap = await getDocs(q);
      const list = _queryData(snap);
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return list;
    },
    { ttl: TTL_LONG, tags: ['subjects', _k('subjects', schoolId)] }
  );
}

export async function getSubjectsByLevel(schoolId, level) {
  const key = _k('subjects', schoolId, level);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(collection(db, 'subjects'), where('schoolId', '==', schoolId), where('level', '==', level));
      const snap = await getDocs(q);
      const list = _queryData(snap);
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return list;
    },
    { ttl: TTL_LONG, tags: ['subjects', _k('subjects', schoolId)] }
  );
}

export async function countSubjects(schoolId) {
  const key = _k('subjects-count', schoolId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const snap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', schoolId)));
      return snap.size;
    },
    { ttl: TTL_LONG, tags: ['subjects', _k('subjects', schoolId)] }
  );
}

export async function createSubject(data) {
  const subjectData = { ...data, createdAt: new Date() };
  if (_online()) {
    const ref = await addDoc(collection(db, 'subjects'), subjectData);
    cache.invalidateByTag('subjects');
    return ref.id;
  } else {
    const opId = offlineQueue.enqueue({ type: 'CREATE', collection: 'subjects', payload: subjectData });
    cache.invalidateByTag('subjects');
    return opId;
  }
}

export async function deleteSubject(subjectId) {
  if (_online()) {
    await deleteDoc(doc(db, 'subjects', subjectId));
    cache.invalidateByTag('subjects');
  } else {
    offlineQueue.enqueue({ type: 'DELETE', collection: 'subjects', docId: subjectId, payload: {} });
    cache.invalidateByTag('subjects');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SCORES
// ════════════════════════════════════════════════════════════════════════════

export async function getScoresByStudent(studentId, schoolId, term, session) {
  const key = _k('scores', 'student', studentId, term, session);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'scores'),
        where('studentId', '==', studentId),
        where('schoolId',  '==', schoolId),
        where('term',      '==', term),
        where('session',   '==', session)
      );
      const snap = await getDocs(q);
      return _queryData(snap);
    },
    { ttl: TTL_MED, tags: ['scores', _k('scores', 'student', studentId)] }
  );
}

export async function getScoresByClass(classId, schoolId, term, session) {
  const key = _k('scores', 'class', classId, term, session);
  return cache.getFreshOrCached(
    key,
    async () => {
      const studentsRaw = await getStudentsByClass(schoolId, classId);
      const studentIds = studentsRaw.map(s => s.id);
      if (!studentIds.length) return [];
      const allScores = [];
      for (let i = 0; i < studentIds.length; i += 30) {
        const chunk = studentIds.slice(i, i + 30);
        const q = query(
          collection(db, 'scores'),
          where('studentId', 'in', chunk),
          where('schoolId',  '==', schoolId),
          where('term',      '==', term),
          where('session',   '==', session)
        );
        const snap = await getDocs(q);
        snap.forEach(d => allScores.push({ id: d.id, ...d.data() }));
      }
      return allScores;
    },
    { ttl: TTL_MED, tags: ['scores', _k('scores', 'class', classId)] }
  );
}

export async function getExistingScore(studentId, subjectId, schoolId, term, session) {
  const key = _k('score', studentId, subjectId, term, session);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'scores'),
        where('studentId', '==', studentId),
        where('subjectId', '==', subjectId),
        where('schoolId',  '==', schoolId),
        where('term',      '==', term),
        where('session',   '==', session)
      );
      const snap = await getDocs(q);
      if (snap.empty) return null;
      return { id: snap.docs[0].id, ...snap.docs[0].data() };
    },
    { ttl: TTL_SHORT, tags: ['scores', _k('scores', 'student', studentId)] }
  );
}

export async function saveScore(scoreData, existingId = null) {
  const data = { ...scoreData, updatedAt: new Date() };
  if (!existingId) data.createdAt = new Date();

  if (_online()) {
    if (existingId) {
      await updateDoc(doc(db, 'scores', existingId), data);
    } else {
      const ref = await addDoc(collection(db, 'scores'), data);
      existingId = ref.id;
    }
    cache.invalidateByTag('scores');
    cache.del(_k('scores', 'student', scoreData.studentId, scoreData.term, scoreData.session));
    return existingId;
  } else {
    if (existingId) {
      offlineQueue.enqueue({ type: 'UPDATE', collection: 'scores', docId: existingId, payload: data });
    } else {
      offlineQueue.enqueue({ type: 'CREATE', collection: 'scores', payload: data });
    }
    cache.invalidateByTag('scores');
    return existingId;
  }
}

export async function saveScoresBatch(scoresArray, schoolId, term, session) {
  if (!_online()) {
    for (const score of scoresArray) {
      offlineQueue.enqueue({ type: 'CREATE', collection: 'scores', payload: { ...score, schoolId, term, session, updatedAt: new Date() } });
    }
    cache.invalidateByTag('scores');
    return;
  }

  const batch = writeBatch(db);
  for (const score of scoresArray) {
    const data = { ...score, schoolId, term, session, updatedAt: new Date() };
    if (score.existingId) {
      batch.set(doc(db, 'scores', score.existingId), data, { merge: true });
    } else {
      const newRef = doc(collection(db, 'scores'));
      data.createdAt = new Date();
      batch.set(newRef, data);
    }
  }
  await batch.commit();
  cache.invalidateByTag('scores');
}

export async function loadSessionOptions(schoolId) {
  const key = _k('sessions', schoolId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(collection(db, 'scores'), where('schoolId', '==', schoolId));
      const snap = await getDocs(q);
      const set = new Set();
      snap.forEach(d => { const s = d.data().session; if (s) set.add(s); });
      return Array.from(set).sort((a, b) => parseInt(b) - parseInt(a));
    },
    { ttl: TTL_MED, tags: ['scores', _k('sessions', schoolId)] }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// REPORTS (Report Cards)
// ════════════════════════════════════════════════════════════════════════════

export async function getReportByStudent(studentId, schoolId, term, session) {
  const key = _k('report', studentId, term, session);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'reports'),
        where('studentId', '==', studentId),
        where('schoolId',  '==', schoolId),
        where('term',      '==', term),
        where('session',   '==', session)
      );
      const snap = await getDocs(q);
      if (snap.empty) return null;
      return { id: snap.docs[0].id, ...snap.docs[0].data() };
    },
    { ttl: TTL_MED, tags: ['reports', _k('reports', studentId)] }
  );
}

export async function saveReport(reportData, existingId = null) {
  const data = { ...reportData, updatedAt: new Date() };
  if (!existingId) data.createdAt = new Date();

  if (_online()) {
    if (existingId) {
      await updateDoc(doc(db, 'reports', existingId), data);
    } else {
      const ref = await addDoc(collection(db, 'reports'), data);
      existingId = ref.id;
    }
    cache.invalidateByTag('reports');
    cache.del(_k('report', reportData.studentId, reportData.term, reportData.session));
    return existingId;
  } else {
    if (existingId) {
      offlineQueue.enqueue({ type: 'UPDATE', collection: 'reports', docId: existingId, payload: data });
    } else {
      offlineQueue.enqueue({ type: 'CREATE', collection: 'reports', payload: data });
    }
    cache.invalidateByTag('reports');
    return existingId;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BROADSHEETS
// ════════════════════════════════════════════════════════════════════════════

export async function saveBroadsheet(docId, data) {
  if (_online()) {
    await setDoc(doc(db, 'broadsheets', docId), { ...data, updatedAt: new Date() }, { merge: true });
    cache.del(_k('broadsheet', docId));
  } else {
    offlineQueue.enqueue({ type: 'SET', collection: 'broadsheets', docId, payload: { ...data, updatedAt: new Date() } });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ATTENDANCE (Class)
// ════════════════════════════════════════════════════════════════════════════

export async function getAttendanceByClass(schoolId, classId, session, term) {
  const key = _k('attendance', schoolId, classId, session, term);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'attendance'),
        where('schoolId',        '==', schoolId),
        where('classId',         '==', classId),
        where('academicSession', '==', session),
        where('term',            '==', term)
      );
      const snap = await getDocs(q);
      return _queryData(snap);
    },
    { ttl: TTL_SHORT, tags: ['attendance', _k('attendance', classId)] }
  );
}

export async function getAttendanceByStudent(schoolId, studentId, classId, session, term) {
  const key = _k('attendance', 'student', studentId, session, term);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'attendance'),
        where('schoolId',  '==', schoolId),
        where('studentId', '==', studentId),
        where('classId',   '==', classId)
      );
      const snap = await getDocs(q);
      return _queryData(snap);
    },
    { ttl: TTL_SHORT, tags: ['attendance', _k('attendance', studentId)] }
  );
}

export async function saveAttendance(docId, data) {
  if (_online()) {
    await setDoc(doc(db, 'attendance', docId), { ...data, updatedAt: new Date() }, { merge: true });
    cache.invalidateByTag(_k('attendance', data.classId));
  } else {
    offlineQueue.enqueue({ type: 'SET', collection: 'attendance', docId, payload: { ...data, updatedAt: new Date() } });
    cache.invalidateByTag(_k('attendance', data.classId));
  }
}

export async function saveAttendanceBatch(operations) {
  if (!_online()) {
    for (const op of operations) {
      offlineQueue.enqueue({ type: 'SET', collection: 'attendance', docId: op.docId, payload: { ...op.data, updatedAt: new Date() } });
    }
    cache.invalidateByTag('attendance');
    return;
  }
  const batch = writeBatch(db);
  for (const op of operations) {
    batch.set(doc(db, 'attendance', op.docId), { ...op.data, updatedAt: new Date() }, { merge: true });
  }
  await batch.commit();
  cache.invalidateByTag('attendance');
}

// ════════════════════════════════════════════════════════════════════════════
// TEACHER ATTENDANCE
// ════════════════════════════════════════════════════════════════════════════

export async function getTeacherAttendanceForDate(schoolId, dateStr) {
  const key = _k('teacher-att', schoolId, dateStr);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'teacher_attendance'),
        where('schoolId', '==', schoolId),
        where('date',     '==', dateStr)
      );
      const snap = await getDocs(q);
      return _queryData(snap);
    },
    { ttl: TTL_SHORT, tags: ['teacher-attendance'] }
  );
}

export async function createTeacherClockIn(data) {
  if (_online()) {
    const ref = await addDoc(collection(db, 'teacher_attendance'), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    cache.invalidateByTag('teacher-attendance');
    return ref.id;
  } else {
    const opId = offlineQueue.enqueue({ type: 'CREATE', collection: 'teacher_attendance', payload: data });
    return opId;
  }
}

export async function updateTeacherAttendance(docId, data) {
  if (_online()) {
    await updateDoc(doc(db, 'teacher_attendance', docId), { ...data, updatedAt: serverTimestamp() });
    cache.invalidateByTag('teacher-attendance');
  } else {
    offlineQueue.enqueue({ type: 'UPDATE', collection: 'teacher_attendance', docId, payload: data });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SCORING CONFIG
// ════════════════════════════════════════════════════════════════════════════

export async function getScoringConfig(schoolId, level) {
  const key = _k('scoring', schoolId, level || 'all');
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = level
        ? query(collection(db, 'scoring'), where('schoolId', '==', schoolId), where('level', '==', level))
        : query(collection(db, 'scoring'), where('schoolId', '==', schoolId));
      const snap = await getDocs(q);
      return _queryData(snap);
    },
    { ttl: TTL_STATIC, tags: ['scoring', _k('scoring', schoolId)] }
  );
}

export async function saveScoringConfig(docId, data) {
  if (_online()) {
    await setDoc(doc(db, 'scoring', docId), data, { merge: true });
    cache.invalidateByTag('scoring');
  } else {
    offlineQueue.enqueue({ type: 'SET', collection: 'scoring', docId, payload: data });
    cache.invalidateByTag('scoring');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ACADEMIC CALENDAR
// ════════════════════════════════════════════════════════════════════════════

export async function getAcademicCalendarDoc() {
  return cache.getFreshOrCached(
    'academicCalendar:current',
    async () => {
      const snap = await getDoc(doc(db, 'academicCalendar', 'current'));
      return snap.exists() ? snap.data() : null;
    },
    { ttl: TTL_STATIC, tags: ['academicCalendar'] }
  );
}

export async function setAcademicCalendarDoc(data) {
  if (_online()) {
    await setDoc(doc(db, 'academicCalendar', 'current'), data, { merge: true });
    cache.del('academicCalendar:current');
    cache.invalidateByTag('academicCalendar');
  } else {
    offlineQueue.enqueue({ type: 'SET', collection: 'academicCalendar', docId: 'current', payload: data });
    cache.invalidateByTag('academicCalendar');
  }
}

export function subscribeToAcademicCalendar(callback) {
  return onSnapshot(doc(db, 'academicCalendar', 'current'), snap => {
    const data = snap.exists() ? snap.data() : null;
    if (data) cache.set('academicCalendar:current', data, { ttl: TTL_STATIC, tags: ['academicCalendar'] });
    callback(data);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// CBT TESTS
// ════════════════════════════════════════════════════════════════════════════

export async function getCbtById(cbtId) {
  return cache.getFreshOrCached(
    _k('cbt', cbtId),
    async () => _docData(await getDoc(doc(db, 'cbt', cbtId))),
    { ttl: TTL_SHORT, tags: ['cbt', _k('cbt', cbtId)] }
  );
}

export async function getCbtByTeacher(teacherId, schoolId) {
  const key = _k('cbt', 'teacher', teacherId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'cbt'),
        where('teacherId', '==', teacherId),
        where('schoolId',  '==', schoolId)
      );
      const snap = await getDocs(q);
      return _queryData(snap);
    },
    { ttl: TTL_SHORT, tags: ['cbt'] }
  );
}

export function subscribeToTeacherCbt(teacherId, schoolId, callback) {
  const q = query(
    collection(db, 'cbt'),
    where('teacherId', '==', teacherId),
    where('schoolId',  '==', schoolId),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(q, snap => {
    const tests = _queryData(snap);
    cache.set(_k('cbt', 'teacher', teacherId), tests, { ttl: TTL_SHORT, tags: ['cbt'] });
    callback(tests);
  });
}

export async function createCbt(data) {
  const cbtData = { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  if (_online()) {
    const ref = await addDoc(collection(db, 'cbt'), cbtData);
    cache.invalidateByTag('cbt');
    return ref.id;
  } else {
    const opId = offlineQueue.enqueue({ type: 'CREATE', collection: 'cbt', payload: cbtData });
    return opId;
  }
}

export async function updateCbt(cbtId, data) {
  const updateData = { ...data, updatedAt: serverTimestamp() };
  if (_online()) {
    await updateDoc(doc(db, 'cbt', cbtId), updateData);
    cache.del(_k('cbt', cbtId));
    cache.invalidateByTag('cbt');
  } else {
    offlineQueue.enqueue({ type: 'UPDATE', collection: 'cbt', docId: cbtId, payload: updateData });
    cache.del(_k('cbt', cbtId));
  }
}

export async function deleteCbt(cbtId) {
  if (_online()) {
    await deleteDoc(doc(db, 'cbt', cbtId));
    cache.del(_k('cbt', cbtId));
    cache.invalidateByTag('cbt');
  } else {
    offlineQueue.enqueue({ type: 'DELETE', collection: 'cbt', docId: cbtId, payload: {} });
    cache.del(_k('cbt', cbtId));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TEST RESULTS
// ════════════════════════════════════════════════════════════════════════════

export async function saveTestResult(data) {
  const resultData = { ...data, completedAt: serverTimestamp() };
  if (_online()) {
    const ref = await addDoc(collection(db, 'test_results'), resultData);
    cache.invalidateByTag('test-results');
    return ref.id;
  } else {
    const opId = offlineQueue.enqueue({ type: 'CREATE', collection: 'test_results', payload: resultData });
    return opId;
  }
}

export async function getTestResultsByUser(userId) {
  const key = _k('test-results', userId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(collection(db, 'test_results'), where('userId', '==', userId));
      const snap = await getDocs(q);
      return _queryData(snap);
    },
    { ttl: TTL_SHORT, tags: ['test-results', _k('test-results', userId)] }
  );
}

// ── ASSIGNED CBT SCORES (for parent/student view) ──
export async function getAssignedCbtScoresByStudent(studentId) {
  const key = _k('assigned-cbt', studentId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'test_results'),
        where('userId', '==', studentId),
        where('examType', '==', 'CBT'),
        where('mode', '==', 'cbt'),
        orderBy('completedAt', 'desc')
      );
      const snap = await getDocs(q);
      return _queryData(snap);
    },
    { ttl: TTL_SHORT, tags: ['assigned-cbt', _k('assigned-cbt', studentId)] }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// QUESTIONS (CBT Bank)
// ════════════════════════════════════════════════════════════════════════════

export async function getQuestions(examType, subject) {
  const key = _k('questions', examType, subject);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'questions'),
        where('examType', '==', examType),
        where('subject',  '==', subject)
      );
      const snap = await getDocs(q);
      return _queryData(snap);
    },
    { ttl: TTL_LONG, tags: ['questions'] }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════════════════════════════════════════

export async function getStudentNotifications(studentId, maxItems = 10) {
  const key = _k('notifications', studentId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'students', studentId, 'notifications'),
        orderBy('timestamp', 'desc'),
        limit(maxItems)
      );
      const snap = await getDocs(q);
      return _queryData(snap);
    },
    { ttl: TTL_SHORT, tags: ['notifications', _k('notifications', studentId)] }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ASSIGNMENTS
// ════════════════════════════════════════════════════════════════════════════

export async function getAssignmentsByClass(schoolId, classId) {
  const key = _k('assignments', schoolId, classId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'assignments'),
        where('schoolId', '==', schoolId),
        where('classId',  '==', classId)
      );
      const snap = await getDocs(q);
      return _queryData(snap);
    },
    { ttl: TTL_MED, tags: ['assignments', _k('assignments', classId)] }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// TOPIC STATS (CBT analytics)
// ════════════════════════════════════════════════════════════════════════════

export async function saveTopicStats(userId, statData) {
  if (_online()) {
    await addDoc(collection(db, 'users', userId, 'topicStats'), { ...statData, timestamp: serverTimestamp() });
  } else {
    offlineQueue.enqueue({ type: 'CREATE', collection: `users/${userId}/topicStats`, payload: statData });
  }
}

export async function upsertTopicCumulative(userId, docId, data) {
  const ref = doc(db, 'users', userId, 'topicCumulative', docId);
  if (_online()) {
    await setDoc(ref, data, { merge: true });
  } else {
    offlineQueue.enqueue({ type: 'SET', collection: `users/${userId}/topicCumulative`, docId, payload: data });
  }
}

export async function getTopicCumulative(userId) {
  const key = _k('topicCumulative', userId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const snap = await getDocs(collection(db, 'users', userId, 'topicCumulative'));
      return _queryData(snap);
    },
    { ttl: TTL_MED, tags: ['topicCumulative', _k('topicCumulative', userId)] }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// GEOFENCE / SCHOOL SETTINGS
// ════════════════════════════════════════════════════════════════════════════

export async function updateGeofence(schoolId, geofenceData) {
  if (_online()) {
    await updateDoc(doc(db, 'schools', schoolId), { geofence: { ...geofenceData, updatedAt: serverTimestamp() } });
    cache.del(_k('school', schoolId));
    cache.invalidateByTag('schools');
  } else {
    offlineQueue.enqueue({ type: 'UPDATE', collection: 'schools', docId: schoolId, payload: { geofence: geofenceData } });
    cache.del(_k('school', schoolId));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PARENTS
// ════════════════════════════════════════════════════════════════════════════

export async function getParentsBySchool(schoolId) {
  const key = _k('parents', schoolId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(collection(db, 'parents'), where('schoolId', '==', schoolId));
      const snap = await getDocs(q);
      const list = _queryData(snap);
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return list;
    },
    { ttl: TTL_MED, tags: ['parents', _k('parents', schoolId)] }
  );
}

export async function getParentById(parentId) {
  return cache.getFreshOrCached(
    _k('parent', parentId),
    async () => _docData(await getDoc(doc(db, 'parents', parentId))),
    { ttl: TTL_MED, tags: ['parents', _k('parent', parentId)] }
  );
}

export async function createParent(uid, data) {
  const parentData = { ...data, createdAt: new Date(), updatedAt: new Date() };
  if (_online()) {
    await setDoc(doc(db, 'parents', uid), parentData);
    cache.invalidateByTag('parents');
  } else {
    offlineQueue.enqueue({ type: 'SET', collection: 'parents', docId: uid, payload: parentData });
    cache.set(_k('parent', uid), { id: uid, ...parentData }, { ttl: TTL_MED, tags: ['parents'] });
  }
}

export async function updateParent(parentId, data) {
  const updateData = { ...data, updatedAt: new Date() };
  if (_online()) {
    await updateDoc(doc(db, 'parents', parentId), updateData);
    cache.del(_k('parent', parentId));
    cache.invalidateByTag('parents');
  } else {
    offlineQueue.enqueue({ type: 'UPDATE', collection: 'parents', docId: parentId, payload: updateData });
    const cur = cache.get(_k('parent', parentId));
    if (cur) cache.set(_k('parent', parentId), { ...cur, ...updateData }, { ttl: TTL_MED, tags: ['parents'] });
  }
}

export async function addParentToStudents(parentId, studentIds) {
  if (!studentIds || studentIds.length === 0) return;
  const batch = writeBatch(db);
  for (const sid of studentIds) {
    const ref = doc(db, 'students', sid);
    batch.update(ref, { parentIds: arrayUnion(parentId) });
  }
  if (_online()) {
    await batch.commit();
    cache.invalidateByTag('students');
  } else {
    for (const sid of studentIds) {
      offlineQueue.enqueue({
        type: 'UPDATE',
        collection: 'students',
        docId: sid,
        payload: { parentIds: arrayUnion(parentId) }
      });
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FEES  (NESTED UNDER schools/{schoolId}/fees/{feeId})
// ════════════════════════════════════════════════════════════════════════════

export async function getFeeStructure(schoolId, studentId, term, session) {
  const safeSession = sanitizeSession(session);
  const docId = `${studentId}_${term}_${safeSession}`;
  const ref = doc(db, 'schools', schoolId, 'fees', docId);
  return cache.getFreshOrCached(
    _k('fee', docId),
    async () => _docData(await getDoc(ref)),
    { ttl: TTL_MED, tags: ['fees', _k('fees', schoolId)] }
  );
}

export async function setFeeStructure(schoolId, studentId, term, session, amount) {
  const safeSession = sanitizeSession(session);
  const docId = `${studentId}_${term}_${safeSession}`;
  const data = { schoolId, studentId, term, session, amount, updatedAt: new Date() };
  const ref = doc(db, 'schools', schoolId, 'fees', docId);
  if (_online()) {
    await setDoc(ref, data, { merge: true });
    cache.del(_k('fee', docId));
    cache.invalidateByTag('fees');
  } else {
    offlineQueue.enqueue({ type: 'SET', collection: `schools/${schoolId}/fees`, docId, payload: data });
  }
}

export async function getFeesByClass(schoolId, classId, term, session) {
  const key = _k('fees', schoolId, classId, term, session);
  return cache.getFreshOrCached(
    key,
    async () => {
      const students = await getStudentsByClass(schoolId, classId);
      const allFees = [];
      for (const s of students) {
        const docId = `${s.id}_${term}_${sanitizeSession(session)}`;
        const snap = await getDoc(doc(db, 'schools', schoolId, 'fees', docId));
        if (snap.exists()) allFees.push({ id: snap.id, ...snap.data() });
      }
      return allFees;
    },
    { ttl: TTL_MED, tags: ['fees', _k('fees', schoolId)] }
  );
}

// ── GET ALL FEE STRUCTURES FOR A STUDENT ──
export async function getFeesByStudent(schoolId, studentId) {
  if (!schoolId || !studentId) return [];
  const key = _k('feesByStudent', schoolId, studentId);
  return cache.getFreshOrCached(
    key,
    async () => {
      const q = query(
        collection(db, 'schools', schoolId, 'fees'),
        where('studentId', '==', studentId)
      );
      const snap = await getDocs(q);
      return _queryData(snap);
    },
    { ttl: TTL_MED, tags: ['fees', _k('fees', schoolId)] }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// PAYMENTS  (NESTED UNDER schools/{schoolId}/fees/{feeId}/payments)
// ════════════════════════════════════════════════════════════════════════════

export async function getPaymentsByStudent(schoolId, studentId, term, session) {
  const safeSession = sanitizeSession(session);
  const docId = `${studentId}_${term}_${safeSession}`;
  const feeRef = doc(db, 'schools', schoolId, 'fees', docId);
  const key = _k('payments', schoolId, studentId, term, session);
  return cache.getFreshOrCached(
    key,
    async () => {
      const snap = await getDocs(collection(feeRef, 'payments'));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    { ttl: TTL_SHORT, tags: ['payments', _k('payments', studentId)] }
  );
}

export async function getPaymentsByClass(schoolId, classId, term, session) {
  const students = await getStudentsByClass(schoolId, classId);
  const allPayments = [];
  for (const s of students) {
    const docId = `${s.id}_${term}_${sanitizeSession(session)}`;
    const feeRef = doc(db, 'schools', schoolId, 'fees', docId);
    const snap = await getDocs(collection(feeRef, 'payments'));
    snap.forEach(d => allPayments.push({ id: d.id, ...d.data() }));
  }
  return allPayments;
}

export async function recordPayment(paymentData) {
  const { schoolId, studentId, term, session } = paymentData;
  const safeSession = sanitizeSession(session);
  const docId = `${studentId}_${term}_${safeSession}`;
  const feeRef = doc(db, 'schools', schoolId, 'fees', docId);
  const data = { ...paymentData, createdAt: new Date(), updatedAt: new Date() };
  if (_online()) {
    const ref = await addDoc(collection(feeRef, 'payments'), data);
    cache.invalidateByTag('payments');
    return ref.id;
  } else {
    const opId = offlineQueue.enqueue({ type: 'CREATE', collection: `schools/${schoolId}/fees/${docId}/payments`, payload: data });
    return opId;
  }
}

export async function getTotalsForSchool(schoolId, term, session) {
  const classes = await getClassesBySchool(schoolId);
  let totalOwed = 0, totalPaid = 0;
  for (const cls of classes) {
    const students = await getStudentsByClass(schoolId, cls.id);
    for (const student of students) {
      const feeDoc = await getFeeStructure(schoolId, student.id, term, session);
      const feeAmount = feeDoc ? feeDoc.amount : 0;
      totalOwed += feeAmount;
      const payments = await getPaymentsByStudent(schoolId, student.id, term, session);
      totalPaid += payments.reduce((sum, p) => sum + (p.amountPaid || 0), 0);
    }
  }
  const arrears = Math.max(0, totalOwed - totalPaid);
  return { totalOwed, totalPaid, arrears };
}

export async function getTotalsForSession(schoolId, session) {
  const terms = ['First Term', 'Second Term', 'Third Term'];
  let totalPaidSession = 0;
  for (const term of terms) {
    const totals = await getTotalsForSchool(schoolId, term, session);
    totalPaidSession += totals.totalPaid;
  }
  return totalPaidSession;
}

// ════════════════════════════════════════════════════════════════════════════
// CACHE UTILITIES (exposed)
// ════════════════════════════════════════════════════════════════════════════

export function invalidateStudents(schoolId) {
  cache.invalidateByTag('students');
  if (schoolId) cache.invalidateByTag(_k('students', schoolId));
}

export function invalidateTeachers(schoolId) {
  cache.invalidateByTag('teachers');
  if (schoolId) cache.invalidateByTag(_k('teachers', schoolId));
}

export function invalidateScores() {
  cache.invalidateByTag('scores');
}

export function clearAllCache() {
  cache.clear();
}

export function getCacheStats() {
  return cache.stats();
}

export function getPendingCount() {
  return offlineQueue.pendingCount();
}

export function getOfflineQueue() {
  return offlineQueue.getQueue();
}

export async function forceSyncNow() {
  return offlineQueue.sync();
}

// ════════════════════════════════════════════════════════════════════════════
// DIRECT FIRESTORE PASSTHROUGH (legacy)
// ════════════════════════════════════════════════════════════════════════════

export async function readDoc(collectionPath, docId) {
  const key = _k('raw', collectionPath, docId);
  return cache.getFreshOrCached(
    key,
    async () => _docData(await getDoc(doc(db, collectionPath, docId))),
    { ttl: TTL_MED, tags: [collectionPath] }
  );
}

export function listenDoc(collectionPath, docId, callback) {
  return onSnapshot(doc(db, collectionPath, docId), snap => {
    const data = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    if (data) cache.set(_k('raw', collectionPath, docId), data, { ttl: TTL_SHORT, tags: [collectionPath] });
    callback(data);
  });
}