// app.js - Core application functions (schools, users, academic helpers)
// All user-facing errors now show clear, friendly messages without technical jargon.

import { auth } from './firebase-config.js';
import { toast, handleError } from './error-handler.js';
import * as service from './service.js';

// Get currently logged-in user (returns user object or null)
export function getCurrentUser() {
  return new Promise((resolve) => {
    const unsubscribe = auth.onAuthStateChanged(user => {
      unsubscribe();
      resolve(user);
    });
  });
}

// Get user document from Firestore by user ID
export async function getUserData(userId = null) {
  try {
    const user = userId ? null : await getCurrentUser();
    const uid = userId || (user ? user.uid : null);
    if (!uid) return null;

    const userData = await service.getUserById(uid);
    return userData;
  } catch (err) {
    console.error('getUserData error:', err);
    toast.error('Unable to load your profile. Please refresh the page.');
    return null;
  }
}

// Get school document by school ID
export async function getSchoolById(schoolId) {
  if (!schoolId) return null;
  try {
    return await service.getSchoolById(schoolId);
  } catch (err) {
    console.error('getSchoolById error:', err);
    toast.error('Unable to load school information. Please check your internet connection.');
    return null;
  }
}

// Get school document by slug
// TODO: service.js does not yet provide a query-by-slug method.
// This direct Firestore call remains because caching this specific read
// is not critical for the current migration. Later, extend service.js
// with getSchoolBySlug(slug) that uses cache.getFreshOrCached.
export async function getSchoolBySlug(slug) {
  try {
    // Direct Firestore query – keep original behaviour
    const { collection, query, where, getDocs } = await import('https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js');
    const { db } = await import('./firebase-config.js');
    const schoolsRef = collection(db, 'schools');
    const q = query(schoolsRef, where('slug', '==', slug));
    const querySnapshot = await getDocs(q);
    if (!querySnapshot.empty) {
      const doc = querySnapshot.docs[0];
      return { id: doc.id, ...doc.data() };
    }
    return null;
  } catch (err) {
    console.error('getSchoolBySlug error:', err);
    toast.error('Unable to find school. Please check the link or contact support.');
    return null;
  }
}

// Get current school ID from logged-in user
export async function getCurrentSchoolId() {
  const userData = await getUserData();
  return userData ? userData.schoolId : null;
}

// Store slug from URL into localStorage
export function storeSlugFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('school');
  if (slug) {
    localStorage.setItem('schoolSlug', slug);
  }
}

// ========== ACADEMIC SESSION & TERM (Nigerian Calendar) ==========
export function getCurrentAcademicSessionAndTerm() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed: 0=Jan, 8=Sep
  
  let sessionStartYear, sessionEndYear, term;
  
  // Session starts in September
  if (month >= 8) { // Sept to Dec
    sessionStartYear = year;
    sessionEndYear = year + 1;
  } else { // Jan to Aug
    sessionStartYear = year - 1;
    sessionEndYear = year;
  }
  const session = `${sessionStartYear}/${sessionEndYear}`;
  
  // Term: 1 = Sept-Dec, 2 = Jan-Apr, 3 = May-Aug
  if (month >= 8) term = 1;      // Sept, Oct, Nov, Dec
  else if (month >= 4) term = 3; // May, Jun, Jul, Aug
  else term = 2;                 // Jan, Feb, Mar, Apr
  
  return { session, term };
}

// Archive students for a given class
// TODO: service.js does not yet expose an archive method.
// The write to 'archives' collection is kept as direct Firestore for now.
// Later, add service.archiveClassStudents(schoolId, classId, className, session, term)
export async function archiveClassStudents(schoolId, classId, className, session, term) {
  try {
    // Use service to fetch students (cached)
    const students = await service.getStudentsByClass(schoolId, classId);
    
    const { addDoc, collection } = await import('https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js');
    const { db } = await import('./firebase-config.js');
    const archiveRef = collection(db, 'archives');
    await addDoc(archiveRef, {
      schoolId,
      classId,
      className,
      session,
      term,
      students,
      archivedAt: new Date()
    });
    toast.success(`Archived ${students.length} students for ${className}`);
  } catch (err) {
    console.error('archiveClassStudents error:', err);
    toast.error('Failed to archive students. Please try again.');
  }
}

// Archive all classes for current term if not already archived
export async function archiveCurrentTermIfNeeded(schoolId) {
  try {
    const { session, term } = getCurrentAcademicSessionAndTerm();
    const { collection, query, where, getDocs } = await import('https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js');
    const { db } = await import('./firebase-config.js');
    const archivesRef = collection(db, 'archives');
    const q = query(archivesRef, where('schoolId', '==', schoolId), 
                    where('session', '==', session), where('term', '==', term));
    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      // Use service to get all classes
      const classes = await service.getClassesBySchool(schoolId);
      for (const classDoc of classes) {
        await archiveClassStudents(schoolId, classDoc.id, classDoc.name, session, term);
      }
      toast.success('Current term archived successfully.');
      return true;
    }
    return false;
  } catch (err) {
    console.error('archiveCurrentTermIfNeeded error:', err);
    toast.error('Failed to archive current term. Please try again later.');
    return false;
  }
}

// Call on module load
storeSlugFromUrl();