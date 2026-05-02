// auth.js – Full rewrite: integrates Central Academic Calendar for term‑based subscription creation
import { auth, db } from './firebase-config.js';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
  fetchSignInMethodsForEmail
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import {
  doc,
  setDoc,
  getDoc,
  query,
  collection,
  where,
  getDocs,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getUserData, getSchoolById } from './app.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';
// ✅ Import central academic calendar for term/session and term dates
import { calculateTermAndSessionFromDate, getTermDates } from './academic-calendar.js';

function showMessage(message, isError = true) {
  showNotification(message, isError ? "error" : "success");
}

function formatSlug(slug) {
  return slug.toLowerCase().replace(/\s+/g, '-');
}

async function isSlugTaken(slug) {
  try {
    const schoolsRef = collection(db, 'schools');
    const q = query(schoolsRef, where('slug', '==', slug));
    const querySnapshot = await getDocs(q);
    return !querySnapshot.empty;
  } catch (err) {
    handleError(err, "Failed to check school URL availability.");
    return true; // assume taken to be safe
  }
}

async function isEmailAlreadyRegistered(email) {
  try {
    const methods = await fetchSignInMethodsForEmail(auth, email);
    return methods.length > 0;
  } catch (error) {
    console.warn('Email check failed:', error);
    return false;
  }
}

// ---------- Helper: get term start/end dates using central calendar ----------
function getTermStartEndDates(term, session) {
  // For a given term name ('First Term','Second Term','Third Term') and session (e.g., '2025/2026'),
  // return { startDate: Date, endDate: Date }.
  // We'll use calculateTermAndSessionFromDate but we need to determine the correct year from session.
  const sessionYear = parseInt(session.split('/')[0]); // e.g., 2025
  let year = sessionYear;
  let monthStart, dayStart, monthEnd, dayEnd;
  
  switch (term) {
    case 'First Term':
      monthStart = 8; dayStart = 1;   // September
      monthEnd = 11; dayEnd = 31;     // December
      break;
    case 'Second Term':
      monthStart = 0; dayStart = 1;    // January
      monthEnd = 3; dayEnd = 30;       // April 30
      break;
    case 'Third Term':
      monthStart = 4; dayStart = 1;    // May
      monthEnd = 7; dayEnd = 30;       // August 30
      break;
    default:
      throw new Error('Invalid term');
  }
  // Note: For terms that span year boundary (First Term), end year is same as start year.
  const startDate = new Date(Date.UTC(year, monthStart, dayStart));
  const endDate = new Date(Date.UTC(year, monthEnd, dayEnd));
  return { startDate, endDate };
}

// ---------- Signup (only schools, users, subscription) ----------
export async function signupSchool(schoolName, rawSlug, address, email, password) {
  const slug = formatSlug(rawSlug);
  if (!slug) {
    showMessage('Please enter a valid school URL.', true);
    return;
  }

  showLoader();
  try {
    const slugExists = await isSlugTaken(slug);
    if (slugExists) {
      showMessage('This school URL is already taken. Please choose another.', true);
      return;
    }

    const emailRegistered = await isEmailAlreadyRegistered(email);
    if (emailRegistered) {
      showMessage('This email is already registered. Please log in or use a different email.', true);
      return;
    }

    // Create Firebase Auth user
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    const schoolId = user.uid; // School document ID = owner's UID

    // Get current academic session and term from central calendar
    const now = new Date();
    const { session: currentSession, term: currentTerm } = calculateTermAndSessionFromDate(now);
    // Get term dates for the subscription
    const { startDate, endDate } = getTermStartEndDates(currentTerm, currentSession);

    const nowTimestamp = new Date();

    // Use a batch to write the three essential documents atomically
    const batch = writeBatch(db);

    // 1. School document
    const schoolRef = doc(db, 'schools', schoolId);
    batch.set(schoolRef, {
      name: schoolName,
      slug: slug,
      address: address || '',
      status: 'pending',           // Will be activated after super‑admin approval
      createdAt: nowTimestamp,
      currentSession: currentSession,
      currentTerm: currentTerm,
      lastUpdated: nowTimestamp,
      ownerId: user.uid
    });

    // 2. User document (admin)
    const userRef = doc(db, 'users', user.uid);
    batch.set(userRef, {
      role: 'admin',
      schoolId: schoolId,
      email: email,
      createdAt: nowTimestamp
    });

    // 3. Subscription document (subcollection) – initial state: pending, locked
    const subRef = doc(db, 'schools', schoolId, 'subscription', 'current');
    batch.set(subRef, {
      status: 'pending',           // 'pending' until super‑admin approves
      locked: true,                // locked until subscription is paid for the term
      term: currentTerm,           // ✅ store the term and session for term‑based expiration
      session: currentSession,
      startDate: startDate,
      endDate: endDate,
      plan: 'basic',
      costPerStudent: 1000,
      coveredStudents: 0,
      totalStudents: 0,
      extraStudentsPendingApproval: 0,
      totalAmount: 0,
      lastUpdated: nowTimestamp,
      paymentRef: null,
      autoExpired: false
    });

    // Commit the batch
    await batch.commit();
    console.log('Signup successful – school, user, and subscription created.');
    showMessage('Account created successfully! Redirecting...', false);

    localStorage.setItem('schoolSlug', slug);
    window.location.href = `/?school=${slug}`;
  } catch (error) {
    console.error('Signup error:', error);
    let errorMessage = 'Signup failed. ';
    if (error.code === 'auth/email-already-in-use') {
      errorMessage += 'Email already in use.';
    } else if (error.code === 'auth/weak-password') {
      errorMessage += 'Password should be at least 6 characters.';
    } else if (error.code === 'permission-denied') {
      errorMessage += 'Permission denied. Please check Firestore rules.';
    } else {
      errorMessage += error.message;
    }
    showMessage(errorMessage, true);
    // If user was created but batch failed, delete the auth user? (optional cleanup)
    if (error.code !== 'auth/email-already-in-use') {
      try {
        await userCredential.user.delete();
      } catch (cleanupErr) {
        console.warn('Could not delete auth user after failed batch:', cleanupErr);
      }
    }
  } finally {
    hideLoader();
  }
}

// ---------- LOGIN – STRICT ROLE REDIRECT (using relative paths) ----------
export async function loginUser(email, password) {
  showLoader();
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    const userDoc = await getDoc(doc(db, 'users', user.uid));
    if (!userDoc.exists()) {
      throw new Error('User account exists but no role document found.');
    }

    const userData = userDoc.data();
    const role = userData.role;
    const schoolId = userData.schoolId;

    localStorage.setItem('userSchoolId', schoolId);
    localStorage.setItem('userRole', role);

    showMessage(`Welcome back! Redirecting to ${role} dashboard.`, false);

    if (role === 'super-admin') {
      window.location.href = '/super-admin.html';
    } else if (role === 'admin') {
      window.location.href = '/admin/admin-dashboard.html';
    } else if (role === 'teacher') {
      window.location.href = '/teacher/teacher-dashboard.html';
    } else {
      throw new Error('Unknown role. Please contact support.');
    }
  } catch (error) {
    console.error('Login error:', error);
    let errorMessage = 'Login failed. ';
    if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password') {
      errorMessage += 'Invalid email or password.';
    } else if (error.message === 'Network error') {
      errorMessage = 'Login failed due to network failure.';
    } else {
      errorMessage += error.message;
    }
    showMessage(errorMessage, true);
  } finally {
    hideLoader();
  }
}

export async function logoutUser() {
  try {
    localStorage.removeItem('userSchoolId');
    localStorage.removeItem('userRole');
    localStorage.removeItem('teacherId');
    await signOut(auth);
    showNotification("Logged out successfully.", "success");
    window.location.href = '/';
  } catch (error) {
    handleError(error, "Logout failed. Please try again.");
  }
}

export async function resetPassword(email) {
  showLoader();
  try {
    await sendPasswordResetEmail(auth, email);
    showMessage('Password reset email sent! Check your inbox.', false);
  } catch (error) {
    console.error('Reset password error:', error);
    let errorMessage = 'Reset failed. ';
    if (error.code === 'auth/user-not-found') {
      errorMessage += 'No account found with this email.';
    } else {
      errorMessage += error.message;
    }
    showMessage(errorMessage, true);
  } finally {
    hideLoader();
  }
}

// ---------- PAGE INITIALIZERS (unchanged, but ensure redirect paths are correct) ----------
export function initLoginPage() {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (userDoc.exists()) {
          const role = userDoc.data().role;
          if (role === 'super-admin') {
            window.location.href = '/super-admin.html';
          } else if (role === 'admin') {
            window.location.href = '/admin/admin-dashboard.html';
          } else if (role === 'teacher') {
            window.location.href = '/teacher/teacher-dashboard.html';
          }
        }
      } catch (err) {
        handleError(err, "Failed to verify user role.");
      }
    }
  });

  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email')?.value;
      const password = document.getElementById('password')?.value;
      if (!email || !password) {
        showNotification("Please enter both email and password.", "error");
        return;
      }
      await loginUser(email, password);
    });
  } else {
    console.warn("Login form not found on this page.");
  }
}

export function initSignupPage() {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (userDoc.exists()) {
          const role = userDoc.data().role;
          if (role === 'super-admin') {
            window.location.href = '/super-admin.html';
          } else if (role === 'admin') {
            window.location.href = '/admin/admin-dashboard.html';
          } else if (role === 'teacher') {
            window.location.href = '/teacher/teacher-dashboard.html';
          }
        }
      } catch (err) {
        handleError(err, "Failed to verify user role.");
      }
    }
  });

  const signupForm = document.getElementById('signupForm');
  if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const schoolName = document.getElementById('schoolName')?.value;
      const schoolSlug = document.getElementById('schoolSlug')?.value;
      const schoolAddress = document.getElementById('schoolAddress')?.value;
      const email = document.getElementById('email')?.value;
      const password = document.getElementById('password')?.value;
      if (!schoolName || !schoolSlug || !email || !password) {
        showNotification("Please fill all required fields.", "error");
        return;
      }
      await signupSchool(schoolName, schoolSlug, schoolAddress, email, password);
    });
  } else {
    console.warn("Signup form not found on this page.");
  }
}

export function initResetPasswordPage() {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (userDoc.exists()) {
          const role = userDoc.data().role;
          if (role === 'super-admin') {
            window.location.href = '/super-admin.html';
          } else if (role === 'admin') {
            window.location.href = '/admin/admin-dashboard.html';
          } else if (role === 'teacher') {
            window.location.href = '/teacher/teacher-dashboard.html';
          }
        }
      } catch (err) {
        handleError(err, "Failed to verify user role.");
      }
    }
  });

  const resetForm = document.getElementById('resetForm');
  if (resetForm) {
    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email')?.value;
      if (!email) {
        showNotification("Please enter your email address.", "error");
        return;
      }
      await resetPassword(email);
    });
  } else {
    console.warn("Reset form not found on this page.");
  }
}

// ---------- Dashboard helpers (unchanged) ----------
export async function initAdminDashboard() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = '/';
      return;
    }

    try {
      const userData = await getUserData();
      if (!userData || userData.role !== 'admin') {
        window.location.href = '/';
        return;
      }

      const userEmailEl = document.getElementById('userEmail');
      if (userEmailEl) userEmailEl.textContent = userData.email;
      const school = await getSchoolById(userData.schoolId);
      const schoolNameEl = document.getElementById('schoolName');
      if (schoolNameEl) schoolNameEl.textContent = school ? school.name : 'Unknown School';
    } catch (err) {
      handleError(err, "Failed to load admin dashboard data.");
    }
  });

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await logoutUser();
    });
  }
}

export function getCurrentTeacherSchoolId() {
  return localStorage.getItem('userSchoolId');
}