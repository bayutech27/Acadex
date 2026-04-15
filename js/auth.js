import { auth, db } from './firebase-config.js';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import {
  doc,
  setDoc,
  getDoc,
  query,
  collection,
  where,
  getDocs
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getUserData, getSchoolById } from './app.js';

// ---------- Helper: Show message on page ----------
function showMessage(message, isError = true) {
  const msgDiv = document.getElementById('message');
  if (!msgDiv) return;
  msgDiv.textContent = message;
  msgDiv.className = `message ${isError ? 'error' : 'success'}`;
  msgDiv.style.display = 'block';
  setTimeout(() => {
    msgDiv.style.display = 'none';
    msgDiv.className = 'message';
  }, 4000);
}

// ---------- Slug formatting ----------
function formatSlug(slug) {
  return slug.toLowerCase().replace(/\s+/g, '-');
}

async function isSlugTaken(slug) {
  const schoolsRef = collection(db, 'schools');
  const q = query(schoolsRef, where('slug', '==', slug));
  const querySnapshot = await getDocs(q);
  return !querySnapshot.empty;
}

// ---------- Authentication Core Functions ----------
export async function signupSchool(schoolName, rawSlug, email, password) {
  const slug = formatSlug(rawSlug);
  if (!slug) {
    showMessage('Please enter a valid school URL.', true);
    return;
  }

  try {
    const slugExists = await isSlugTaken(slug);
    if (slugExists) {
      showMessage('This school URL is already taken. Please choose another.', true);
      return;
    }

    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    const schoolId = user.uid;

    await setDoc(doc(db, 'schools', schoolId), {
      name: schoolName,
      slug: slug
    });

    await setDoc(doc(db, 'users', user.uid), {
      role: 'admin',
      schoolId: schoolId,
      email: email
    });

    localStorage.setItem('schoolSlug', slug);
    window.location.href = `/?school=${slug}`;
  } catch (error) {
    console.error('Signup error:', error);
    let errorMessage = 'Signup failed. ';
    if (error.code === 'auth/email-already-in-use') {
      errorMessage += 'Email already in use.';
    } else {
      errorMessage += error.message;
    }
    showMessage(errorMessage, true);
  }
}

export async function loginUser(email, password) {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    // Fetch user document from 'users' collection
    const userDoc = await getDoc(doc(db, 'users', user.uid));
    if (!userDoc.exists()) {
      throw new Error('User account exists but no role document found.');
    }

    const userData = userDoc.data();
    const role = userData.role;
    const schoolId = userData.schoolId;

    // Store school context
    localStorage.setItem('userSchoolId', schoolId);
    localStorage.setItem('userRole', role);

    // Redirect based on role
    if (role === 'admin') {
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
  }
}

export async function logoutUser() {
  try {
    localStorage.removeItem('userSchoolId');
    localStorage.removeItem('userRole');
    localStorage.removeItem('teacherId');
    await signOut(auth);
    window.location.href = '/';
  } catch (error) {
    console.error('Logout error:', error);
    alert('Logout failed: ' + error.message);
  }
}

export async function resetPassword(email) {
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
  }
}

// ---------- Page Initializers ----------
export function initLoginPage() {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      const userDoc = await getDoc(doc(db, 'users', user.uid));
      if (userDoc.exists()) {
        const role = userDoc.data().role;
        if (role === 'admin') {
          window.location.href = '/admin/admin-dashboard.html';
        } else if (role === 'teacher') {
          window.location.href = '/teacher/teacher-dashboard.html';
        }
      }
    }
  });

  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      await loginUser(email, password);
    });
  }
}

export function initSignupPage() {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      window.location.href = '/admin/admin-dashboard.html';
    }
  });

  const signupForm = document.getElementById('signupForm');
  if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const schoolName = document.getElementById('schoolName').value;
      const schoolSlug = document.getElementById('schoolSlug').value;
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      await signupSchool(schoolName, schoolSlug, email, password);
    });
  }
}

export function initResetPasswordPage() {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      window.location.href = '/admin/admin-dashboard.html';
    }
  });

  const resetForm = document.getElementById('resetForm');
  if (resetForm) {
    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value;
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

    const userData = await getUserData();
    if (!userData || userData.role !== 'admin') {
      window.location.href = '/';
      return;
    }

    document.getElementById('userEmail').textContent = userData.email;
    const school = await getSchoolById(userData.schoolId);
    document.getElementById('schoolName').textContent = school ? school.name : 'Unknown School';
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