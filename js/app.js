import { auth, db } from './firebase-config.js';
import { 
  doc, getDoc, collection, query, where, getDocs, 
  addDoc, updateDoc, deleteDoc 
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

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
  const user = userId ? null : await getCurrentUser();
  const uid = userId || (user ? user.uid : null);
  if (!uid) return null;

  const userDocRef = doc(db, 'users', uid);
  const userDoc = await getDoc(userDocRef);
  if (userDoc.exists()) {
    return { id: userDoc.id, ...userDoc.data() };
  }
  return null;
}

// Get school document by school ID
export async function getSchoolById(schoolId) {
  if (!schoolId) return null;
  const schoolDocRef = doc(db, 'schools', schoolId);
  const schoolDoc = await getDoc(schoolDocRef);
  if (schoolDoc.exists()) {
    return { id: schoolDoc.id, ...schoolDoc.data() };
  }
  return null;
}

// Get school document by slug
export async function getSchoolBySlug(slug) {
  const schoolsRef = collection(db, 'schools');
  const q = query(schoolsRef, where('slug', '==', slug));
  const querySnapshot = await getDocs(q);
  if (!querySnapshot.empty) {
    const doc = querySnapshot.docs[0];
    return { id: doc.id, ...doc.data() };
  }
  return null;
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
export async function archiveClassStudents(schoolId, classId, className, session, term) {
  const studentsRef = collection(db, 'students');
  const q = query(studentsRef, where('schoolId', '==', schoolId), where('classId', '==', classId));
  const snapshot = await getDocs(q);
  const students = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  
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
}

// Archive all classes for current term if not already archived
export async function archiveCurrentTermIfNeeded(schoolId) {
  const { session, term } = getCurrentAcademicSessionAndTerm();
  const archivesRef = collection(db, 'archives');
  const q = query(archivesRef, where('schoolId', '==', schoolId), 
                  where('session', '==', session), where('term', '==', term));
  const snapshot = await getDocs(q);
  if (snapshot.empty) {
    const classesRef = collection(db, 'classes');
    const classesQuery = query(classesRef, where('schoolId', '==', schoolId));
    const classesSnap = await getDocs(classesQuery);
    for (const classDoc of classesSnap.docs) {
      await archiveClassStudents(schoolId, classDoc.id, classDoc.data().name, session, term);
    }
    return true;
  }
  return false;
}

// Call on module load
storeSlugFromUrl();