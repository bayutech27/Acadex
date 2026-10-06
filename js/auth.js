// auth.js – Full rewrite: integrates Central Academic Calendar, phone number, and username suggestions
// EXTENDED: Added student and parent role authentication and redirects.
// MODIFIED: Student redirect points to /student/student-portal.html (inside student folder).
// All existing admin and teacher functionality remains fully intact.
// All user-facing errors now show clear, friendly messages without technical jargon.
// FIXED: Signup now reliably creates Firestore documents using a batch write.
// FIXED: Login retries Firestore reads to handle eventual consistency.
// UPDATED: New school document is created with status = 'expired' to match security rules.
// UPDATED: New subscription document is also created with status = 'expired' and locked = true.
// UPDATED: Initial subscription plan is now 'freemium' (was 'basic').
//
// DIAGNOSTIC UPDATES (this revision):
//   • Added structured developer logging (logAuthError) for every authentication failure.
//     Logs include: operation, Firebase error code, Firebase error message, name, and
//     timestamp. Passwords, tokens, and user records are NEVER logged.
//   • Added getFriendlyAuthErrorMessage() — a single, central map of Firebase error
//     codes to safe user-facing messages that do not leak technical detail and do not
//     enable account enumeration.
//   • Removed the previous catch-all "check your internet connection" behaviour.
//     Network errors are ONLY shown as network errors when Firebase actually returns
//     auth/network-request-failed (or a Firestore 'unavailable' / 'deadline-exceeded').
//   • Unknown errors are logged for developers but the user only sees a safe generic
//     message that does NOT claim the failure was caused by the internet.
//   • No automatic retries were added — see summary. This keeps the actual error code
//     visible when you reproduce the Airtel problem.
//   • Nothing else in the authentication flow was changed.

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
import { showNotification, handleError, showLoader, hideLoader, toast } from './error-handler.js';
import { calculateTermAndSessionFromDate } from './academic-calendar.js';

import { enforcePasswordChange } from './security.js';

const VALID_ROLES = ['super-admin', 'admin', 'teacher', 'student', 'parent'];

const ROLE_REDIRECTS = {
  'super-admin': '/super-admin.html',
  'admin':       '/admin/admin-dashboard.html',
  'teacher':     '/teacher/teacher-dashboard.html',
  'student':     '/student/student-portal.html',
  'parent':      '/parent/parent-portal.html',
};

// ─────────────────────────────────────────────────────────────────────────────
// DIAGNOSTIC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured, safe diagnostic logger for authentication failures.
 *
 * What it logs:  operation name, Firebase error code, error name, error message,
 *                timestamp, and (for network-request-failed) a diagnostic hint.
 *
 * What it NEVER logs: passwords, tokens, ID tokens, refresh tokens, security codes,
 *                     full user records, or anything else that could expose secrets.
 *
 * @param {string} operation  Human-readable operation name, e.g. 'login', 'signup'.
 * @param {Error|*} error     The caught error (or any value).
 * @param {object} [extra]    Optional extra safe context (e.g. { phase: 'create-user' }).
 */
function logAuthError(operation, error, extra = {}) {
  const err = (error && typeof error === 'object') ? error : { message: String(error) };

  const safeInfo = {
    operation,
    code: err.code || '(none)',
    name: err.name || '(none)',
    message: err.message || '(none)',
    timestamp: new Date().toISOString(),
    ...extra
  };

  // Add a diagnostic hint specifically for genuine network failures so that the
  // Airtel-style connectivity issue is easy to spot in the console.
  if (err.code === 'auth/network-request-failed') {
    safeInfo.diagnostic =
      'Firebase could not reach the authentication service. Likely causes: ' +
      'blocked / misconfigured mobile network, DNS interference, firewall or VPN ' +
      'filtering, captive portal, TLS interception, or a temporary Firebase outage. ' +
      'Check the browser DevTools Network tab for failed requests to ' +
      'identitytoolkit.googleapis.com / securetoken.googleapis.com.';
  }

  // eslint-disable-next-line no-console
  console.error(`[Acadex Auth] ${operation} failed`, safeInfo);
}

/**
 * Map a Firebase Auth (or Firestore) error code to a safe, non-technical message
 * suitable for end users (teachers, parents, students, admins).
 *
 * Security notes:
 *   • Account enumeration is prevented — "user not found" and "wrong password"
 *     produce the SAME message on login.
 *   • Technical details (codes, endpoints, rule names, UID, schoolId) are never
 *     included in the returned string.
 *   • Genuine network failures are the ONLY case that mentions the user's
 *     connection. All other errors get an honest, accurate description.
 *
 * @param {Error|*} error
 * @param {string} [operation]  Reserved for future operation-specific wording.
 * @returns {string}
 */
function getFriendlyAuthErrorMessage(error, operation = 'auth') { // eslint-disable-line no-unused-vars
  const code = (error && typeof error === 'object' && error.code) ? error.code : '';

  // ── Credential errors ─────────────────────────────────────────────────
  // Grouped deliberately so login cannot be used to enumerate accounts.
  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found' ||
    code === 'auth/invalid-login-credentials'
  ) {
    return 'Email or password is incorrect. Please check your details and try again.';
  }

  // ── Account state ─────────────────────────────────────────────────────
  if (code === 'auth/user-disabled') {
    return 'This account is currently unavailable. Please contact your school administrator.';
  }
  if (code === 'auth/requires-recent-login') {
    return 'For your security, please log in again to continue.';
  }

  // ── Input problems ────────────────────────────────────────────────────
  if (code === 'auth/invalid-email') {
    return 'Please enter a valid email address.';
  }
  if (code === 'auth/missing-email') {
    return 'Please enter your email address.';
  }
  if (code === 'auth/missing-password') {
    return 'Please enter your password.';
  }

  // ── Rate limiting ─────────────────────────────────────────────────────
  if (code === 'auth/too-many-requests') {
    return 'Too many attempts. Please wait a little while and try again.';
  }

  // ── Genuine network failures ──────────────────────────────────────────
  // Only these codes receive a message that mentions the user's connection.
  if (
    code === 'auth/network-request-failed' ||
    code === 'unavailable' ||        // Firestore offline / service unreachable
    code === 'deadline-exceeded'     // Firestore timeout
  ) {
    return "We couldn't complete your request right now. Please check your connection and try again.";
  }

  // ── Signup-specific ───────────────────────────────────────────────────
  if (code === 'auth/email-already-in-use') {
    return 'This email is already registered. Please log in or use a different email.';
  }
  if (code === 'auth/weak-password') {
    return 'Password is too weak. Please use at least 6 characters.';
  }
  if (code === 'auth/account-exists-with-different-credential') {
    return 'An account already exists with this email using a different sign-in method.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'This sign-in method is currently unavailable. Please try again later.';
  }

  // ── Password reset link problems ──────────────────────────────────────
  if (code === 'auth/expired-action-code' || code === 'auth/invalid-action-code') {
    return 'This link is no longer valid. Please request a new one.';
  }

  // ── Service / configuration problems ──────────────────────────────────
  // These are NOT the user's fault and must not be blamed on their internet.
  if (
    code === 'auth/api-key-not-valid' ||
    code === 'auth/invalid-api-key' ||
    code === 'auth/app-deleted' ||
    code === 'auth/internal-error'
  ) {
    return "We're having trouble completing this right now. Please try again shortly. " +
           'If the problem continues, please contact Acadex support.';
  }

  // ── Firestore permission-denied (surfaces during signup / reads) ──────
  if (code === 'permission-denied') {
    return "We couldn't complete this action right now. Please try again later.";
  }

  // ── Safe fallback ─────────────────────────────────────────────────────
  return "We couldn't complete your request right now. Please try again. " +
         'If the problem continues, contact Acadex support.';
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS (unchanged behaviour, only error handling improved below)
// ─────────────────────────────────────────────────────────────────────────────

function redirectByRole(role) {
  const destination = ROLE_REDIRECTS[role];
  if (destination) {
    window.location.href = destination;
  }
}

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

async function isUsernameTaken(username) {
  try {
    const schoolsRef = collection(db, 'schools');
    const q = query(schoolsRef, where('slug', '==', username));
    const querySnapshot = await getDocs(q);
    return !querySnapshot.empty;
  } catch (err) {
    logAuthError('username-check', err, { phase: 'schools-query' });
    toast.error('Unable to check username availability. Please try again.');
    return true;
  }
}

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
    logAuthError('email-check', error, { phase: 'fetchSignInMethodsForEmail' });
    toast.warning('Unable to verify email. Please try again.');
    return false;
  }
}

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

// ─────────────────────────────────────────────────────────────────────────────
// SIGNUP
// ─────────────────────────────────────────────────────────────────────────────

export async function signupSchool(schoolName, username, address, phone, email, password) {
  if (!username) {
    toast.error('Please enter a username.');
    return;
  }

  showLoader();
  let userCredential = null;

  try {
    const usernameTaken = await isUsernameTaken(username);
    if (usernameTaken) {
      toast.error('This username is already taken. Please choose another.');
      return;
    }

    const emailRegistered = await isEmailAlreadyRegistered(email);
    if (emailRegistered) {
      toast.error('This email is already registered. Please log in or use a different email.');
      return;
    }

    userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    const schoolId = user.uid;

    const now = new Date();
    const { session: currentSession, term: currentTerm } = calculateTermAndSessionFromDate(now);
    const { startDate, endDate } = getTermStartEndDates(currentTerm, currentSession);
    const nowTimestamp = new Date();

    const schoolRef = doc(db, 'schools', schoolId);
    const userRef = doc(db, 'users', user.uid);
    const subRef = doc(db, 'schools', schoolId, 'subscription', 'current');

    const batch = writeBatch(db);

    // School document: expired by default
    batch.set(schoolRef, {
      name:           schoolName,
      slug:           username,
      phone:          phone || '',
      address:        address || '',
      status:         'expired',
      createdAt:      nowTimestamp,
      currentSession: currentSession,
      currentTerm:    currentTerm,
      lastUpdated:    nowTimestamp,
      ownerId:        user.uid,
    });

    batch.set(userRef, {
      role:      'admin',
      schoolId:  schoolId,
      email:     email,
      createdAt: nowTimestamp,
    });

    // Subscription document: also expired and locked.
    // Initial plan is now 'freemium' (matches expired status).
    batch.set(subRef, {
      status:                      'expired',
      locked:                      true,
      term:                        currentTerm,
      session:                     currentSession,
      startDate:                   startDate,
      endDate:                     endDate,
      plan:                        'freemium',
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

    const verifyUser = await getDoc(userRef);
    if (!verifyUser.exists()) {
      throw new Error('User document was not saved properly');
    }

    localStorage.setItem('schoolSlug', username);
    localStorage.setItem('userSchoolId', schoolId);
    localStorage.setItem('userRole', 'admin');

    toast.success('Account created successfully! Redirecting to your dashboard...');

    setTimeout(() => {
      window.location.href = `/admin/admin-dashboard.html?school=${username}`;
    }, 1500);

  } catch (error) {
    logAuthError('signup', error);

    // Custom non-Firebase error — preserve its specific wording.
    let errorMessage;
    if (error && error.message === 'User document was not saved properly') {
      errorMessage = 'Account created but setup incomplete. Please contact support.';
    } else if (error && error.code === 'permission-denied') {
      // Signup surfaces permission-denied when security rules reject the batch write.
      errorMessage = 'Unable to create your school at the moment. Please try again later.';
    } else {
      errorMessage = getFriendlyAuthErrorMessage(error, 'signup');
    }

    toast.error(errorMessage);

    if (userCredential && (!error || error.message !== 'User document was not saved properly')) {
      try {
        await userCredential.user.delete();
      } catch (deleteError) {
        logAuthError('signup-cleanup', deleteError, { phase: 'delete-orphan-auth-user' });
      }
    }
  } finally {
    hideLoader();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────────────────────

export async function loginUser(email, password) {
  showLoader();
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    let userDocSnap = null;
    let retries = 0;
    const maxRetries = 3;

    while (retries < maxRetries && !userDocSnap?.exists()) {
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
      }
      userDocSnap = await getDoc(doc(db, 'users', user.uid));
      retries++;
    }

    if (!userDocSnap.exists()) {
      // Developer diagnostic — user-facing message is intentionally generic.
      // eslint-disable-next-line no-console
      console.error('[Acadex Auth] login failed', {
        operation: 'login',
        phase: 'user-doc-missing',
        code: '(no-doc)',
        message: 'Firestore user document not found after retries.',
        uidPresent: Boolean(user && user.uid),
        retries,
        timestamp: new Date().toISOString()
      });
      await signOut(auth);
      toast.error('Account exists but is not fully set up. Please contact support or try again in a few moments.');
      return;
    }

    const userData = userDocSnap.data();
    const role     = userData.role;
    const schoolId = userData.schoolId;

    if (userData.mustChangePassword) {
      localStorage.setItem('mustChangePassword', 'true');
      window.location.href = `change-password.html?redirect=${encodeURIComponent(ROLE_REDIRECTS[role])}`;
      return;
    }

    if (userData.disabled) {
      toast.error('Your account has been disabled. Contact the school.');
      await signOut(auth);
      return;
    }

    if (!VALID_ROLES.includes(role)) {
      await signOut(auth);
      toast.error(`Account type "${role}" is not recognised. Please contact support.`);
      return;
    }

    if (role !== 'super-admin' && !schoolId) {
      await signOut(auth);
      toast.error('Account is not linked to a school. Please contact support.');
      return;
    }

    if (role !== 'super-admin') {
      const schoolDoc = await getDoc(doc(db, 'schools', schoolId));
      if (!schoolDoc.exists()) {
        await signOut(auth);
        toast.error('School record not found. Please contact support.');
        return;
      }
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

    toast.success('Welcome back! Redirecting to your dashboard...');
    redirectByRole(role);

  } catch (error) {
    logAuthError('login', error);
    toast.error(getFriendlyAuthErrorMessage(error, 'login'));
  } finally {
    hideLoader();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────────────────────────────────────

export async function logoutUser() {
  try {
    localStorage.removeItem('userSchoolId');
    localStorage.removeItem('userRole');
    localStorage.removeItem('teacherId');
    localStorage.removeItem('studentId');
    localStorage.removeItem('parentId');
    await signOut(auth);
    toast.success('Logged out successfully.');
    window.location.href = '/';
  } catch (error) {
    logAuthError('logout', error);
    toast.error(getFriendlyAuthErrorMessage(error, 'logout'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD RESET
// ─────────────────────────────────────────────────────────────────────────────

export async function resetPassword(email) {
  showLoader();
  try {
    await sendPasswordResetEmail(auth, email);
    toast.success('Password reset email sent! Check your inbox or spam folder.');
  } catch (error) {
    logAuthError('password-reset', error);

    // Preserve the existing specific wording for user-not-found. Changing it
    // would alter product behaviour, and that is outside the scope of this task.
    let errorMessage;
    if (error && error.code === 'auth/user-not-found') {
      errorMessage = 'No account found with this email address.';
    } else {
      errorMessage = getFriendlyAuthErrorMessage(error, 'password-reset');
    }
    toast.error(errorMessage);
  } finally {
    hideLoader();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH GUARD / PAGE INITIALISERS
// ─────────────────────────────────────────────────────────────────────────────

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
        logAuthError('auth-guard', err, { phase: 'get-user-doc' });
        toast.error('We had trouble verifying your session. Please try again.');
      }
    }
    if (typeof onNotLoggedIn === 'function') onNotLoggedIn();
  });
}

export function initLoginPage() {
  handleAlreadyLoggedIn(null, () => {
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email    = document.getElementById('email')?.value;
        const password = document.getElementById('password')?.value;
        if (!email || !password) {
          toast.error('Please enter both email and password.');
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
          toast.error('Please fill all required fields.');
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
          toast.error('Please enter your email address.');
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
      logAuthError('admin-dashboard', err, { phase: 'load-dashboard-data' });
      toast.error('Failed to load dashboard data. Please refresh the page.');
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

      await enforcePasswordChange(window.location.href);

      if (userData.disabled) {
        toast.error('Your account has been disabled. Contact the school.');
        await signOut(auth);
        window.location.href = '/';
        return;
      }

      localStorage.setItem('userSchoolId', userData.schoolId);
      localStorage.setItem('userRole', 'student');
      localStorage.setItem('studentId', user.uid);
    } catch (err) {
      logAuthError('student-portal-guard', err);
      toast.error('Failed to verify student session. Please log in again.');
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

      await enforcePasswordChange(window.location.href);

      if (userData.disabled) {
        toast.error('Your account has been disabled. Contact the school.');
        await signOut(auth);
        window.location.href = '/';
        return;
      }

      localStorage.setItem('userSchoolId', userData.schoolId);
      localStorage.setItem('userRole', 'parent');
      localStorage.setItem('parentId', user.uid);
    } catch (err) {
      logAuthError('parent-portal-guard', err);
      toast.error('Failed to verify parent session. Please log in again.');
      await signOut(auth);
      window.location.href = '/';
    }
  });

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => await logoutUser());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD VISIBILITY TOGGLES (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

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