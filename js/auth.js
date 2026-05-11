// auth.js – Full rewrite: integrates Central Academic Calendar, phone number, and username suggestions
// EXTENDED: Added student and parent role authentication and redirects.
// MODIFIED: Student redirect points to /student/student-portal.html (inside student folder).
// All existing admin and teacher functionality remains fully intact.

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

// ---------- VALID ROLES ----------
const VALID_ROLES = ['super-admin', 'admin', 'teacher', 'student', 'parent'];

// ---------- ROLE → REDIRECT MAP ----------
// UPDATED: student now goes to /student/student-portal.html
const ROLE_REDIRECTS = {
  'super-admin': '/super-admin.html',
  'admin':       '/admin/admin-dashboard.html',
  'teacher':     '/teacher/teacher-dashboard.html',
  'student':     '/student/student-portal.html',
  'parent':      '/parent/parent-portal.html',
};

// ---------- Notification helper ----------
function showMessage(message, isError = true) {
  showNotification(message, isError ? 'error' : 'success');
}

// ---------- Helper: redirect an authenticated user based on their role ----------
function redirectByRole(role) {
  const destination = ROLE_REDIRECTS[role];
  if (destination) {
    window.location.href = destination;
  }
}

// ---------- Helper: slugify a string ----------
function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

// ---------- Check if a username (slug) already exists ----------
async function isUsernameTaken(username) {
  try {
    const schoolsRef = collection(db, 'schools');
    const q = query(schoolsRef, where('slug', '==', username));
    const querySnapshot = await getDocs(q);
    return !querySnapshot.empty;
  } catch (err) {
    handleError(err, 'Failed to check username availability.');
    return true;
  }
}

// ---------- Generate username suggestions based on school name ----------
async function generateUsernameSuggestions(schoolName) {
  const base = slugify(schoolName);
  if (!base) return [];

  const suggestions = [base, base + '1', base + '2'];

  const availability = await Promise.all(
    suggestions.map(async (name) => ({
      name,
      taken: await isUsernameTaken(name),
    }))
  );

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
  const year = sessionYear;
  let monthStart, dayStart, monthEnd, dayEnd;

  switch (term) {
    case 'First Term':
      monthStart = 8;  dayStart = 1;  monthEnd = 11; dayEnd = 31; break;
    case 'Second Term':
      monthStart = 0;  dayStart = 1;  monthEnd = 3;  dayEnd = 30; break;
    case 'Third Term':
      monthStart = 4;  dayStart = 1;  monthEnd = 7;  dayEnd = 30; break;
    default:
      throw new Error('Invalid term');
  }

  const startDate = new Date(Date.UTC(year, monthStart, dayStart));
  const endDate   = new Date(Date.UTC(year, monthEnd,   dayEnd));
  return { startDate, endDate };
}

// =============================================================================
// SIGNUP (unchanged)
// =============================================================================
export async function signupSchool(schoolName, username, address, phone, email, password) {
  if (!username) {
    showMessage('Please enter a username.', true);
    return;
  }

  showLoader();
  try {
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

    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    const schoolId = user.uid;

    const now = new Date();
    const { session: currentSession, term: currentTerm } = calculateTermAndSessionFromDate(now);
    const { startDate, endDate } = getTermStartEndDates(currentTerm, currentSession);
    const nowTimestamp = new Date();

    const batch = writeBatch(db);

    const schoolRef = doc(db, 'schools', schoolId);
    batch.set(schoolRef, {
      name:           schoolName,
      slug:           username,
      phone:          phone || '',
      address:        address || '',
      status:         'pending',
      createdAt:      nowTimestamp,
      currentSession: currentSession,
      currentTerm:    currentTerm,
      lastUpdated:    nowTimestamp,
      ownerId:        user.uid,
    });

    const userRef = doc(db, 'users', user.uid);
    batch.set(userRef, {
      role:      'admin',
      schoolId:  schoolId,
      email:     email,
      createdAt: nowTimestamp,
    });

    const subRef = doc(db, 'schools', schoolId, 'subscription', 'current');
    batch.set(subRef, {
      status:                      'inactive',
      locked:                      true,
      term:                        currentTerm,
      session:                     currentSession,
      startDate:                   startDate,
      endDate:                     endDate,
      plan:                        'basic',
      costPerStudent:              1000,
      coveredStudents:             0,
      totalStudents:               0,
      extraStudentsPendingApproval: 0,
      totalAmount:                 0,
      lastUpdated:                 nowTimestamp,
      paymentRef:                  null,
      autoExpired:                 false,
    });

    await batch.commit();
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
    if (error.code !== 'auth/email-already-in-use') {
      try { await userCredential?.user?.delete(); } catch (e) { /* ignore */ }
    }
  } finally {
    hideLoader();
  }
}

// =============================================================================
// LOGIN
// =============================================================================
export async function loginUser(email, password) {
  showLoader();
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    const userDocSnap = await getDoc(doc(db, 'users', user.uid));
    if (!userDocSnap.exists()) {
      await signOut(auth);
      throw new Error('User account exists but no role document found. Please contact support.');
    }

    const userData = userDocSnap.data();
    const role     = userData.role;
    const schoolId = userData.schoolId;

    if (!VALID_ROLES.includes(role)) {
      await signOut(auth);
      throw new Error(`Unknown role "${role}". Please contact support.`);
    }

    if (role !== 'super-admin' && !schoolId) {
      await signOut(auth);
      throw new Error('Account is not linked to a school. Please contact support.');
    }

    localStorage.setItem('userSchoolId', schoolId || '');
    localStorage.setItem('userRole', role);

    if (role === 'teacher') {
      localStorage.setItem('teacherId', user.uid);
    } else if (role === 'student') {
      localStorage.setItem('studentId', user.uid);
    } else if (role === 'parent') {
      localStorage.setItem('parentId', user.uid);
    }

    showMessage(`Welcome back! Redirecting to your dashboard.`, false);
    redirectByRole(role);

  } catch (error) {
    console.error('Login error:', error);
    let errorMessage = 'Login failed. ';
    if (
      error.code === 'auth/user-not-found' ||
      error.code === 'auth/wrong-password' ||
      error.code === 'auth/invalid-credential'
    ) {
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

// =============================================================================
// LOGOUT
// =============================================================================
export async function logoutUser() {
  try {
    localStorage.removeItem('userSchoolId');
    localStorage.removeItem('userRole');
    localStorage.removeItem('teacherId');
    localStorage.removeItem('studentId');
    localStorage.removeItem('parentId');
    await signOut(auth);
    showNotification('Logged out successfully.', 'success');
    window.location.href = '/';   // redirect to index.html (login page)
  } catch (error) {
    handleError(error, 'Logout failed. Please try again.');
  }
}

// =============================================================================
// PASSWORD RESET
// =============================================================================
export async function resetPassword(email) {
  showLoader();
  try {
    await sendPasswordResetEmail(auth, email);
    showMessage('Password reset email sent! Check your inbox or SPAM message.', false);
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

// =============================================================================
// SHARED onAuthStateChanged GUARD
// =============================================================================
function handleAlreadyLoggedIn(user, onNotLoggedIn) {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        const userDocSnap = await getDoc(doc(db, 'users', user.uid));
        if (userDocSnap.exists()) {
          const role = userDocSnap.data().role;
          if (VALID_ROLES.includes(role)) {
            redirectByRole(role);
            return;
          }
        }
      } catch (err) {
        handleError(err, 'Failed to verify user role.');
      }
    }
    if (typeof onNotLoggedIn === 'function') onNotLoggedIn();
  });
}

// =============================================================================
// PAGE INITIALISERS
// =============================================================================

export function initLoginPage() {
  handleAlreadyLoggedIn(null, () => {
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email    = document.getElementById('email')?.value;
        const password = document.getElementById('password')?.value;
        if (!email || !password) {
          showNotification('Please enter both email and password.', 'error');
          return;
        }
        await loginUser(email, password);
      });
    }
    setupPasswordToggles();
  });
}

export function initSignupPage() {
  handleAlreadyLoggedIn(null, () => {
    const signupForm     = document.getElementById('signupForm');
    const schoolNameInput = document.getElementById('schoolName');
    const usernameInput  = document.getElementById('username');
    const suggestionsDiv = document.getElementById('usernameSuggestions');

    if (schoolNameInput && usernameInput && suggestionsDiv) {
      schoolNameInput.addEventListener('input', async () => {
        const schoolName = schoolNameInput.value.trim();
        if (!schoolName) { suggestionsDiv.innerHTML = ''; return; }

        const suggestions = await generateUsernameSuggestions(schoolName);
        if (suggestions.length) {
          let html = '<div class="suggestions-label">Suggested usernames:</div><div class="suggestions-list">';
          suggestions.forEach(s => {
            html += `<button type="button" class="suggestion-chip ${s.taken ? 'taken' : ''}"
              data-username="${s.name}" ${s.taken ? 'disabled' : ''}>
              ${s.name} ${s.taken ? '(taken)' : ''}
            </button>`;
          });
          html += '</div>';
          suggestionsDiv.innerHTML = html;

          document.querySelectorAll('.suggestion-chip:not(.taken)').forEach(chip => {
            chip.addEventListener('click', () => {
              usernameInput.value = chip.dataset.username;
              suggestionsDiv.innerHTML = '';
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
        const schoolName    = document.getElementById('schoolName')?.value;
        const username      = document.getElementById('username')?.value;
        const schoolAddress = document.getElementById('schoolAddress')?.value;
        const phone         = document.getElementById('schoolPhone')?.value;
        const email         = document.getElementById('email')?.value;
        const password      = document.getElementById('password')?.value;
        if (!schoolName || !username || !email || !password) {
          showNotification('Please fill all required fields.', 'error');
          return;
        }
        await signupSchool(schoolName, username, schoolAddress, phone, email, password);
      });
    }

    setupPasswordToggles();
  });
}

export function initResetPasswordPage() {
  handleAlreadyLoggedIn(null, () => {
    const resetForm = document.getElementById('resetForm');
    if (resetForm) {
      resetForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('email')?.value;
        if (!email) {
          showNotification('Please enter your email address.', 'error');
          return;
        }
        await resetPassword(email);
      });
    }
  });
}

export async function initAdminDashboard() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = '/'; return; }
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
      handleError(err, 'Failed to load admin dashboard data.');
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

// =============================================================================
// PORTAL PAGE GUARDS
// =============================================================================

/**
 * Protects the student portal page.
 * Signs out and redirects to home if the authenticated user is not a student
 * belonging to the expected school.
 */
export function initStudentPortal() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = '/'; return; }
    try {
      const userDocSnap = await getDoc(doc(db, 'users', user.uid));
      if (!userDocSnap.exists()) {
        await signOut(auth);
        window.location.href = '/';
        return;
      }
      const userData = userDocSnap.data();
      if (userData.role !== 'student' || !userData.schoolId) {
        await signOut(auth);
        window.location.href = '/';
        return;
      }
      localStorage.setItem('userSchoolId', userData.schoolId);
      localStorage.setItem('userRole', 'student');
      localStorage.setItem('studentId', user.uid);
    } catch (err) {
      handleError(err, 'Failed to verify student session.');
      await signOut(auth);
      window.location.href = '/';
    }
  });

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => await logoutUser());
  }
}

export function initParentPortal() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = '/'; return; }
    try {
      const userDocSnap = await getDoc(doc(db, 'users', user.uid));
      if (!userDocSnap.exists()) {
        await signOut(auth);
        window.location.href = '/';
        return;
      }
      const userData = userDocSnap.data();
      if (userData.role !== 'parent' || !userData.schoolId) {
        await signOut(auth);
        window.location.href = '/';
        return;
      }
      localStorage.setItem('userSchoolId', userData.schoolId);
      localStorage.setItem('userRole', 'parent');
      localStorage.setItem('parentId', user.uid);
    } catch (err) {
      handleError(err, 'Failed to verify parent session.');
      await signOut(auth);
      window.location.href = '/';
    }
  });

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => await logoutUser());
  }
}

// =============================================================================
// PASSWORD VISIBILITY TOGGLES
// =============================================================================
function setupPasswordToggles() {
  document.querySelectorAll('.toggle-password').forEach(button => {
    button.removeEventListener('click', togglePasswordVisibility);
    button.addEventListener('click', togglePasswordVisibility);
  });
}

function togglePasswordVisibility(e) {
  const button  = e.currentTarget;
  const wrapper = button.closest('.password-wrapper');
  const input   = wrapper?.querySelector('input');
  if (!input) return;

  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';

  const eyeIcon = button.querySelector('.eye-icon');
  if (eyeIcon) {
    if (isPassword) {
      eyeIcon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />`;
    } else {
      eyeIcon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />`;
    }
  }
}