// auth.js – Full rewrite: integrates Central Academic Calendar, phone number, and username suggestions
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
import { calculateTermAndSessionFromDate } from './academic-calendar.js';

function showMessage(message, isError = true) {
  showNotification(message, isError ? "error" : "success");
}

// ---------- Helper: slugify a string (lowercase, replace spaces/hyphens) ----------
function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // replace spaces with -
    .replace(/[^\w\-]+/g, '')       // remove all non-word chars
    .replace(/\-\-+/g, '-')         // replace multiple - with single -
    .replace(/^-+/, '')             // trim - from start
    .replace(/-+$/, '');            // trim - from end
}

// ---------- Check if a username (slug) already exists ----------
async function isUsernameTaken(username) {
  try {
    const schoolsRef = collection(db, 'schools');
    const q = query(schoolsRef, where('slug', '==', username));
    const querySnapshot = await getDocs(q);
    return !querySnapshot.empty;
  } catch (err) {
    handleError(err, "Failed to check username availability.");
    return true; // assume taken on error
  }
}

// ---------- Generate username suggestions based on school name ----------
async function generateUsernameSuggestions(schoolName) {
  const base = slugify(schoolName);
  if (!base) return [];

  const suggestions = [];
  // First suggestion: the base slug
  suggestions.push(base);
  // Second: base + 1
  suggestions.push(base + '1');
  // Third: base + 2
  suggestions.push(base + '2');

  // Check each suggestion's availability (asynchronously)
  const availability = await Promise.all(suggestions.map(async (name) => ({
    name,
    taken: await isUsernameTaken(name)
  })));

  return availability;
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
  const sessionYear = parseInt(session.split('/')[0]);
  let year = sessionYear;
  let monthStart, dayStart, monthEnd, dayEnd;
  switch (term) {
    case 'First Term':
      monthStart = 8; dayStart = 1; monthEnd = 11; dayEnd = 31;
      break;
    case 'Second Term':
      monthStart = 0; dayStart = 1; monthEnd = 3; dayEnd = 30;
      break;
    case 'Third Term':
      monthStart = 4; dayStart = 1; monthEnd = 7; dayEnd = 30;
      break;
    default:
      throw new Error('Invalid term');
  }
  const startDate = new Date(Date.UTC(year, monthStart, dayStart));
  const endDate = new Date(Date.UTC(year, monthEnd, dayEnd));
  return { startDate, endDate };
}

// ---------- Signup (creates school, user, subscription) ----------
export async function signupSchool(schoolName, username, address, phone, email, password) {
  if (!username) {
    showMessage('Please enter a username.', true);
    return;
  }

  showLoader();
  try {
    // Check if username is already taken
    const usernameTaken = await isUsernameTaken(username);
    if (usernameTaken) {
      showMessage('This username is already taken. Please choose another.', true);
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
    const { startDate, endDate } = getTermStartEndDates(currentTerm, currentSession);
    const nowTimestamp = new Date();

    // Use a batch to write all documents atomically
    const batch = writeBatch(db);

    // 1. School document
    const schoolRef = doc(db, 'schools', schoolId);
    batch.set(schoolRef, {
      name: schoolName,
      slug: username,               // store username as 'slug' field for compatibility
      phone: phone || '',
      address: address || '',
      status: 'pending',           // Will be activated after super‑admin approves payment
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
      status: 'pending',           // 'pending' until super‑admin approves payment
      locked: true,
      term: currentTerm,
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

    await batch.commit();
    console.log('Signup successful – school, user, and subscription created.');
    showMessage('Account created successfully! Redirecting...', false);

    localStorage.setItem('schoolSlug', username);
    window.location.href = `/?school=${username}`;
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
    // If user was created but batch failed, delete the auth user
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

// ---------- LOGIN (unchanged) ----------
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

// ---------- PAGE INITIALIZERS ----------
export function initLoginPage() {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (userDoc.exists()) {
          const role = userDoc.data().role;
          if (role === 'super-admin') window.location.href = '/super-admin.html';
          else if (role === 'admin') window.location.href = '/admin/admin-dashboard.html';
          else if (role === 'teacher') window.location.href = '/teacher/teacher-dashboard.html';
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
  }
}

export function initSignupPage() {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (userDoc.exists()) {
          const role = userDoc.data().role;
          if (role === 'super-admin') window.location.href = '/super-admin.html';
          else if (role === 'admin') window.location.href = '/admin/admin-dashboard.html';
          else if (role === 'teacher') window.location.href = '/teacher/teacher-dashboard.html';
        }
      } catch (err) {
        handleError(err, "Failed to verify user role.");
      }
    }
  });

  const signupForm = document.getElementById('signupForm');
  const schoolNameInput = document.getElementById('schoolName');
  const usernameInput = document.getElementById('username');
  const suggestionsDiv = document.getElementById('usernameSuggestions');

  // Generate username suggestions when school name changes
  if (schoolNameInput && usernameInput && suggestionsDiv) {
    schoolNameInput.addEventListener('input', async () => {
      const schoolName = schoolNameInput.value.trim();
      if (!schoolName) {
        suggestionsDiv.innerHTML = '';
        return;
      }
      const suggestions = await generateUsernameSuggestions(schoolName);
      if (suggestions.length) {
        let html = '<div class="suggestions-label">Suggested usernames:</div><div class="suggestions-list">';
        suggestions.forEach(s => {
          const isTaken = s.taken;
          const clickable = !isTaken;
          html += `<button type="button" class="suggestion-chip ${isTaken ? 'taken' : ''}" data-username="${s.name}" ${!clickable ? 'disabled' : ''}>${s.name} ${isTaken ? '(taken)' : ''}</button>`;
        });
        html += '</div>';
        suggestionsDiv.innerHTML = html;
        // Attach click handlers to non-disabled chips
        document.querySelectorAll('.suggestion-chip:not(.taken)').forEach(chip => {
          chip.addEventListener('click', () => {
            usernameInput.value = chip.dataset.username;
            suggestionsDiv.innerHTML = ''; // hide suggestions after selection
          });
        });
      } else {
        suggestionsDiv.innerHTML = '';
      }
    });
  }

  if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const schoolName = document.getElementById('schoolName')?.value;
      const username = document.getElementById('username')?.value;
      const schoolAddress = document.getElementById('schoolAddress')?.value;
      const phone = document.getElementById('schoolPhone')?.value;
      const email = document.getElementById('email')?.value;
      const password = document.getElementById('password')?.value;
      if (!schoolName || !username || !email || !password) {
        showNotification("Please fill all required fields.", "error");
        return;
      }
      await signupSchool(schoolName, username, schoolAddress, phone, email, password);
    });
  }
}

export function initResetPasswordPage() {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (userDoc.exists()) {
          const role = userDoc.data().role;
          if (role === 'super-admin') window.location.href = '/super-admin.html';
          else if (role === 'admin') window.location.href = '/admin/admin-dashboard.html';
          else if (role === 'teacher') window.location.href = '/teacher/teacher-dashboard.html';
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