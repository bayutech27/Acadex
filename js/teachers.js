// teachers.js - Manage teachers with subscription payment banner and validation
import { db, auth } from './firebase-config.js';
import { 
  collection, getDocs, deleteDoc, doc, updateDoc, query, where, getDoc, setDoc, serverTimestamp, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getAuth, createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getCurrentSchoolId } from './app.js';
import { isSubscriptionActive } from './plan.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

let currentSchoolId = null;
let subjectsMap = new Map();
let classesMap = new Map();
let editingTeacherId = null;
let unsubscribeSub = null;

let teacherForm, modal, nameInput, emailInput, subjectsSelect, classesSelect, classTeacherSelect;

// Secondary Firebase app for teacher creation (prevents admin logout)
let secondaryAuth = null;
function initSecondaryAuth() {
  if (!secondaryAuth) {
    const primaryApp = auth.app;
    const firebaseConfig = primaryApp.options;
    const secondaryApp = initializeApp(firebaseConfig, 'secondary');
    secondaryAuth = getAuth(secondaryApp);
  }
  return secondaryAuth;
}

export async function initTeachersPage() {
  teacherForm = document.getElementById('teacherForm');
  modal = document.getElementById('teacherModal');
  nameInput = document.getElementById('teacherName');
  emailInput = document.getElementById('teacherEmail');
  subjectsSelect = document.getElementById('teacherSubjects');
  classesSelect = document.getElementById('teacherClasses');
  classTeacherSelect = document.getElementById('teacherClassTeacher');

  if (!teacherForm || !modal || !nameInput || !emailInput || !subjectsSelect || !classesSelect || !classTeacherSelect) {
    console.error('Required DOM elements not found');
    return;
  }

  currentSchoolId = await getCurrentSchoolId();
  initSecondaryAuth();
  
  await loadSubjects();
  await loadClasses();
  await loadTeachers();

  const addBtn = document.getElementById('addTeacherBtn');
  if (addBtn) addBtn.addEventListener('click', () => openModal());
  const closeBtn = document.querySelector('.close-modal');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  const cancelBtn = document.getElementById('cancelModalBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  teacherForm.addEventListener('submit', handleTeacherSubmit);

  // Setup subscription UI and listener
  setupSubscriptionUI();
  initSubscriptionListener();
}

async function loadSubjects() {
  try {
    const subjectsRef = collection(db, 'subjects');
    const q = query(subjectsRef, where('schoolId', '==', currentSchoolId));
    const snapshot = await getDocs(q);
    subjectsMap.clear();
    snapshot.forEach(doc => {
      subjectsMap.set(doc.id, doc.data().name);
    });

    if (subjectsSelect) {
      subjectsSelect.innerHTML = '';
      if (subjectsMap.size === 0) {
        const option = document.createElement('option');
        option.disabled = true;
        option.textContent = 'No subjects available. Create subjects in Setup page first.';
        subjectsSelect.appendChild(option);
      } else {
        for (let [id, name] of subjectsMap) {
          const option = document.createElement('option');
          option.value = id;
          option.textContent = name;
          subjectsSelect.appendChild(option);
        }
      }
    }
  } catch (err) {
    handleError(err, "Failed to load subjects.");
  }
}

async function loadClasses() {
  try {
    const classesRef = collection(db, 'classes');
    const q = query(classesRef, where('schoolId', '==', currentSchoolId));
    const snapshot = await getDocs(q);
    classesMap.clear();
    snapshot.forEach(doc => {
      classesMap.set(doc.id, doc.data().name);
    });

    if (classesSelect) {
      classesSelect.innerHTML = '';
      if (classesMap.size === 0) {
        const option = document.createElement('option');
        option.disabled = true;
        option.textContent = 'No classes available. Create classes in Setup page first.';
        classesSelect.appendChild(option);
      } else {
        for (let [id, name] of classesMap) {
          const option = document.createElement('option');
          option.value = id;
          option.textContent = name;
          classesSelect.appendChild(option);
        }
      }
    }

    if (classTeacherSelect) {
      classTeacherSelect.innerHTML = '<option value="">None</option>';
      for (let [id, name] of classesMap) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = name;
        classTeacherSelect.appendChild(option);
      }
    }
  } catch (err) {
    handleError(err, "Failed to load classes.");
  }
}

async function loadTeachers() {
  try {
    const teachersRef = collection(db, 'teachers');
    const q = query(teachersRef, where('schoolId', '==', currentSchoolId));
    const snapshot = await getDocs(q);
    const teachers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const container = document.getElementById('teachersList');
    if (!container) return;
    if (teachers.length === 0) {
      container.innerHTML = '<p>No teachers yet. Click "Add Teacher" to create one.</p>';
      return;
    }

    container.innerHTML = `
      <table class="data-table">
        <thead>
          <tr><th>Name</th><th>Email</th><th>Subjects</th><th>Classes</th><th>Class Teacher</th><th>Actions</th></tr>
        </thead>
        <tbody>
          ${teachers.map(teacher => {
            const subjectNames = (teacher.subjectIds || [])
              .map(subjId => subjectsMap.get(subjId) || subjId)
              .join(', ');
            const classNames = (teacher.classIds || [])
              .map(classId => classesMap.get(classId) || classId)
              .join(', ');
            const hostClassName = teacher.isClassTeacher && teacher.hostClassId 
              ? (classesMap.get(teacher.hostClassId) || 'Unknown')
              : '-';
            return `
              <tr>
                <td>${escapeHtml(teacher.name)}</td>
                <td>${escapeHtml(teacher.email)}</td>
                <td>${escapeHtml(subjectNames || '-')}</td>
                <td>${escapeHtml(classNames || '-')}</td>
                <td>${escapeHtml(hostClassName)}</td>
                <td>
                  <button class="btn-secondary" onclick="window.editTeacher('${teacher.id}')">Edit</button>
                  <button class="btn-danger" onclick="window.deleteTeacher('${teacher.id}')">Delete</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
    window.editTeacher = (id) => openModal(id);
    window.deleteTeacher = async (id) => {
      if (confirm('Delete this teacher? This action cannot be undone.')) {
        showLoader();
        try {
          await deleteDoc(doc(db, 'teachers', id));
          await deleteDoc(doc(db, 'users', id)).catch(console.warn);
          showNotification("Teacher deleted from Firestore. Auth user still exists (delete manually from Firebase Console).", "success");
          await loadTeachers();
        } catch (err) {
          handleError(err, "Failed to delete teacher.");
        } finally {
          hideLoader();
        }
      }
    };
  } catch (err) {
    handleError(err, "Failed to load teachers.");
  }
}

function openModal(teacherId = null) {
  editingTeacherId = teacherId;
  const modalTitle = document.getElementById('modalTitle');
  if (!modalTitle) return;
  if (teacherId) {
    modalTitle.textContent = 'Edit Teacher';
    if (emailInput) emailInput.readOnly = true;
    loadTeacherData(teacherId);
  } else {
    modalTitle.textContent = 'Add Teacher';
    if (emailInput) emailInput.readOnly = false;
    if (nameInput) nameInput.value = '';
    if (emailInput) emailInput.value = '';
    if (subjectsSelect) Array.from(subjectsSelect.options).forEach(opt => opt.selected = false);
    if (classesSelect) Array.from(classesSelect.options).forEach(opt => opt.selected = false);
    if (classTeacherSelect) classTeacherSelect.value = '';
  }
  if (modal) modal.style.display = 'flex';
}

async function loadTeacherData(teacherId) {
  try {
    const teacherDoc = await getDoc(doc(db, 'teachers', teacherId));
    if (teacherDoc.exists()) {
      const data = teacherDoc.data();
      if (nameInput) nameInput.value = data.name;
      if (emailInput) emailInput.value = data.email;
      const subjectIds = data.subjectIds || [];
      if (subjectsSelect) {
        Array.from(subjectsSelect.options).forEach(opt => {
          opt.selected = subjectIds.includes(opt.value);
        });
      }
      const classIds = data.classIds || [];
      if (classesSelect) {
        Array.from(classesSelect.options).forEach(opt => {
          opt.selected = classIds.includes(opt.value);
        });
      }
      if (data.isClassTeacher && data.hostClassId && classTeacherSelect) {
        classTeacherSelect.value = data.hostClassId;
      } else if (classTeacherSelect) {
        classTeacherSelect.value = '';
      }
    }
  } catch (err) {
    handleError(err, "Failed to load teacher data.");
  }
}

function closeModal() {
  if (modal) modal.style.display = 'none';
  editingTeacherId = null;
  if (emailInput) emailInput.readOnly = false;
  if (teacherForm) teacherForm.reset();
}

// ========== VALIDATION FUNCTIONS ==========
async function checkSubjectConflicts(subjectIds, excludeTeacherId = null) {
  if (!subjectIds.length) return null;
  
  try {
    const teachersRef = collection(db, 'teachers');
    const q = query(teachersRef, where('schoolId', '==', currentSchoolId));
    const snapshot = await getDocs(q);
    const conflictingSubjects = [];

    for (const subjectId of subjectIds) {
      for (const docSnap of snapshot.docs) {
        const teacher = docSnap.data();
        if (excludeTeacherId && docSnap.id === excludeTeacherId) continue;
        if (teacher.subjectIds && teacher.subjectIds.includes(subjectId)) {
          const subjectName = subjectsMap.get(subjectId) || subjectId;
          conflictingSubjects.push(subjectName);
          break;
        }
      }
    }
    
    if (conflictingSubjects.length) {
      return `The following subjects are already assigned to another teacher: ${conflictingSubjects.join(', ')}`;
    }
    return null;
  } catch (err) {
    handleError(err, "Failed to check subject conflicts.");
    return "Unable to verify subject conflicts. Please try again.";
  }
}

async function checkClassTeacherConflict(classId, excludeTeacherId = null) {
  if (!classId) return null;
  
  try {
    const teachersRef = collection(db, 'teachers');
    const q = query(teachersRef, where('schoolId', '==', currentSchoolId), where('isClassTeacher', '==', true), where('hostClassId', '==', classId));
    const snapshot = await getDocs(q);
    
    for (const docSnap of snapshot.docs) {
      if (excludeTeacherId && docSnap.id === excludeTeacherId) continue;
      const className = classesMap.get(classId) || classId;
      return `Class "${className}" already has a class teacher. Only one class teacher is allowed per class.`;
    }
    return null;
  } catch (err) {
    handleError(err, "Failed to check class teacher conflict.");
    return "Unable to verify class teacher conflict. Please try again.";
  }
}

async function handleTeacherSubmit(e) {
  e.preventDefault();
  const name = nameInput ? nameInput.value.trim() : '';
  const email = emailInput ? emailInput.value.trim() : '';
  const selectedSubjectIds = subjectsSelect ? Array.from(subjectsSelect.selectedOptions).map(opt => opt.value) : [];
  const selectedClassIds = classesSelect ? Array.from(classesSelect.selectedOptions).map(opt => opt.value) : [];
  const hostClassIdValue = classTeacherSelect ? (classTeacherSelect.value || null) : null;
  const isClassTeacher = hostClassIdValue !== null && hostClassIdValue !== '';

  if (!name || !email) {
    showNotification("Please fill in all fields.", "error");
    return;
  }

  // 1. Check subject conflicts
  const subjectConflictMsg = await checkSubjectConflicts(selectedSubjectIds, editingTeacherId);
  if (subjectConflictMsg) {
    showNotification(subjectConflictMsg, "error");
    return;
  }

  // 2. Check class teacher conflict
  if (isClassTeacher) {
    const classTeacherConflictMsg = await checkClassTeacherConflict(hostClassIdValue, editingTeacherId);
    if (classTeacherConflictMsg) {
      showNotification(classTeacherConflictMsg, "error");
      return;
    }
  }

  const teacherDataObj = {
    name,
    email,
    subjectIds: selectedSubjectIds,
    classIds: selectedClassIds,
    isClassTeacher,
    hostClassId: isClassTeacher ? hostClassIdValue : null,
    schoolId: currentSchoolId,
    updatedAt: new Date()
  };

  showLoader();
  try {
    if (editingTeacherId) {
      await updateDoc(doc(db, 'teachers', editingTeacherId), teacherDataObj);
      showNotification("Teacher updated successfully.", "success");
      closeModal();
      await loadTeachers();
    } else {
      const defaultPassword = '$Acadex123';
      const secondaryAuthInstance = initSecondaryAuth();
      
      let userCredential;
      try {
        userCredential = await createUserWithEmailAndPassword(secondaryAuthInstance, email, defaultPassword);
      } catch (authError) {
        console.error('Secondary auth creation error:', authError);
        if (authError.code === 'auth/email-already-in-use') {
          showNotification("A user with this email already exists. Please use a different email.", "error");
        } else {
          showNotification("Failed to create authentication: " + authError.message, "error");
        }
        return;
      }
      
      const uid = userCredential.user.uid;
      const timestamp = serverTimestamp();
      
      const userDocData = {
        email,
        role: 'teacher',
        schoolId: currentSchoolId,
        subjects: selectedSubjectIds,
        classId: selectedClassIds.length === 1 ? selectedClassIds[0] : null,
        isClassTeacher: isClassTeacher,
        createdAt: timestamp
      };
      
      const teacherDocData = {
        ...teacherDataObj,
        authUid: uid,
        createdAt: timestamp
      };
      
      await setDoc(doc(db, 'users', uid), userDocData);
      await setDoc(doc(db, 'teachers', uid), teacherDocData);
      
      showNotification(`Teacher created successfully!\n\nEmail: ${email}\nPassword: ${defaultPassword}`, "success");
      
      closeModal();
      await loadTeachers();
    }
  } catch (error) {
    handleError(error, "Failed to save teacher.");
  } finally {
    hideLoader();
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}

// ========== SUBSCRIPTION PAYMENT BANNER ==========
function injectSubscriptionUI() {
  if (!document.getElementById('paymentBannerContainer')) {
    const contentDiv = document.querySelector('.content');
    if (contentDiv) {
      const paymentDiv = document.createElement('div');
      paymentDiv.id = 'paymentBannerContainer';
      paymentDiv.style.margin = '16px 0';
      contentDiv.insertBefore(paymentDiv, contentDiv.firstChild);
    }
  }
}

function showPaymentBanner() {
  const container = document.getElementById('paymentBannerContainer');
  if (!container) return;
  const existing = document.getElementById('paymentBanner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'paymentBanner';
  banner.className = 'payment-banner';
  banner.innerHTML = `
    <div class="payment-banner-content">
      <h3>💰 Activate Your Subscription</h3>
      <p>Pay securely online with your ATM card via Paystack, or contact us on WhatsApp for assistance.</p>
    </div>
    <div class="payment-buttons">
      <button id="paystackPaymentBtn" class="paystack-btn">💳 Pay Now (Card/Online)</button>
      <a id="whatsappLink" href="https://wa.me/2349044784225?text=Hello%20Acadex%2C%20I%20want%20to%20renew%20my%20subscription" target="_blank" class="whatsapp-btn">
        <svg class="whatsapp-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-5.46-4.45-9.91-9.91-9.91zm0 2c4.4 0 7.91 3.51 7.91 7.91 0 4.4-3.51 7.91-7.91 7.91-1.43 0-2.78-.38-3.97-1.07l-.6-.34-3.11.82.83-3.04-.34-.6c-.7-1.2-1.07-2.55-1.07-3.97 0-4.4 3.51-7.91 7.91-7.91zM8.53 7.5c-.18 0-.48.07-.73.33-.26.26-.95.93-.95 2.28 0 1.35.98 2.66 1.12 2.84.14.18 1.88 2.98 4.56 4.07.64.26 1.14.42 1.53.54.64.2 1.22.17 1.68.1.51-.08 1.57-.64 1.79-1.26.22-.62.22-1.15.15-1.26-.07-.11-.26-.18-.55-.31-.29-.13-1.7-.84-1.96-.94-.26-.1-.45-.15-.64.15-.19.3-.73.94-.9 1.13-.17.19-.34.21-.63.07-.29-.13-1.22-.45-2.32-1.43-.86-.76-1.44-1.7-1.61-1.99-.17-.29-.02-.45.13-.59.13-.13.29-.34.44-.51.14-.17.19-.29.29-.48.1-.19.05-.36-.03-.51-.08-.15-.64-1.54-.88-2.11-.23-.56-.46-.48-.64-.49h-.55z"/>
        </svg>
        09044784225 (WhatsApp)
      </a>
    </div>
  `;
  container.appendChild(banner);

  const payBtn = document.getElementById('paystackPaymentBtn');
  if (payBtn) {
    payBtn.addEventListener('click', () => {
      window.open('https://paystack.shop/pay/fmj267paou', '_blank');
    });
  }
}

function hidePaymentBanner() {
  const banner = document.getElementById('paymentBanner');
  if (banner) banner.remove();
}

async function setupSubscriptionUI() {
  injectSubscriptionUI();
  hidePaymentBanner();
}

async function initSubscriptionListener() {
  if (!currentSchoolId) return;
  if (unsubscribeSub) unsubscribeSub();
  const subRef = doc(db, 'schools', currentSchoolId, 'subscription', 'current');
  unsubscribeSub = onSnapshot(subRef, (snap) => {
    if (!snap.exists()) {
      showPaymentBanner();
      return;
    }
    const sub = snap.data();
    const isActive = sub.status === 'active' && sub.locked === false;
    if (isActive) {
      hidePaymentBanner();
    } else {
      showPaymentBanner();
    }
  }, (err) => handleError(err, "Subscription listener error."));
}