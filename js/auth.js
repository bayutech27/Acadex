// auth.js – Full rewrite: creates only schools, users, and subscription on signup
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

function getTermDates(term) {
  const year = new Date().getFullYear();
  let startDate, endDate;
  if (term === '1') {
    startDate = new Date(year, 8, 1);
    endDate = new Date(year, 11, 31);
  } else if (term === '2') {
    startDate = new Date(year, 0, 1);
    endDate = new Date(year, 3, 30);
  } else {
    startDate = new Date(year, 4, 1);
    endDate = new Date(year, 7, 31);
  }
  return { startDate, endDate };
}

function getCurrentAcademicSessionAndTerm() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  let session = '';
  let term = '';

  if (month >= 9) {
    session = `${year}/${year + 1}`;
  } else {
    session = `${year - 1}/${year}`;
  }

  if (month >= 9 && month <= 12) term = '1';
  else if (month >= 1 && month <= 4) term = '2';
  else if (month >= 5 && month <= 8) term = '3';

  return { session, term };
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
    const schoolId = user.uid;

    const { session: currentSession, term: currentTerm } = getCurrentAcademicSessionAndTerm();
    const { startDate, endDate } = getTermDates(currentTerm);
    const now = new Date();

    // Use a batch to write the three essential documents atomically
    const batch = writeBatch(db);

    // 1. School document
    const schoolRef = doc(db, 'schools', schoolId);
    batch.set(schoolRef, {
      name: schoolName,
      slug: slug,
      address: address,
      status: 'pending',
      createdAt: now,
      currentSession: currentSession,
      currentTerm: currentTerm,
      lastUpdated: now,
      ownerId: user.uid
    });

    // 2. User document (admin)
    const userRef = doc(db, 'users', user.uid);
    batch.set(userRef, {
      role: 'admin',
      schoolId: schoolId,
      email: email,
      createdAt: now
    });

    // 3. Subscription document (subcollection)
    const subRef = doc(db, 'schools', schoolId, 'subscription', 'current');
    batch.set(subRef, {
      status: 'pending',
      locked: true,
      endDate: endDate,
      plan: 'basic',
      costPerStudent: 1000,
      coveredStudents: 0,
      totalStudents: 0,
      extraStudentsPendingApproval: 0,
      totalAmount: 0,
      startDate: startDate,
      lastUpdated: now,
      paymentRef: null
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
  } finally {
    hideLoader();
  }
}

// ---------- LOGIN – STRICT ROLE REDIRECT ----------
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

// ---------- PAGE INITIALIZERS ----------
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