// teachers.js - Manage teachers (primary exemption + Auth deletion via Cloud Function)
// All Firestore operations go through service.js where possible.
// TODO: service.js does not yet support teacher deletion (cloud function) or conflict checks – those remain direct.
// All user-facing errors now show clear, friendly messages without technical jargon.

import { db, auth, functions } from './firebase-config.js';
import {
  collection, getDocs, deleteDoc, doc, updateDoc, query, where, getDoc, setDoc, serverTimestamp, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getAuth, createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-functions.js';
import { getCurrentSchoolId } from './admin.js';
import { isSubscriptionActive } from './plan.js';
import { showNotification, handleError, showLoader, hideLoader, toast } from './error-handler.js';
import * as service from './service.js';

let currentSchoolId = null;
let subjectsMap = new Map();
let classesMap = new Map();
let editingTeacherId = null;
let unsubscribeSub = null;

let teacherForm, modal, nameInput, emailInput, levelSelect, subjectsSelect, classesSelect, classTeacherSelect;
let currentTeacherLevel = null;

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
  levelSelect = document.getElementById('teacherLevel');
  subjectsSelect = document.getElementById('teacherSubjects');
  classesSelect = document.getElementById('teacherClasses');
  classTeacherSelect = document.getElementById('teacherClassTeacher');

  if (!teacherForm || !modal || !nameInput || !emailInput || !levelSelect || !subjectsSelect || !classesSelect || !classTeacherSelect) {
    console.error('Required DOM elements not found');
    toast.error('Page not loaded correctly. Please refresh.');
    return;
  }

  currentSchoolId = await getCurrentSchoolId();
  initSecondaryAuth();
  
  await loadAllSubjects();
  await loadAllClasses();
  await loadTeachers();

  levelSelect.addEventListener('change', async (e) => {
    currentTeacherLevel = e.target.value;
    if (currentTeacherLevel) {
      await loadSubjectsByLevel(currentTeacherLevel);
      await loadClassesByLevel(currentTeacherLevel);
      await loadClassTeacherOptions(currentTeacherLevel);
    } else {
      subjectsSelect.innerHTML = '<option value="">-- Select level first --</option>';
      subjectsSelect.disabled = true;
      classesSelect.innerHTML = '<option value="">-- Select level first --</option>';
      classesSelect.disabled = true;
      classTeacherSelect.innerHTML = '<option value="">None</option>';
      classTeacherSelect.disabled = true;
    }
  });

  const addBtn = document.getElementById('addTeacherBtn');
  if (addBtn) addBtn.addEventListener('click', () => openModal());
  const closeBtn = document.querySelector('.close-modal');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  const cancelBtn = document.getElementById('cancelModalBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  teacherForm.addEventListener('submit', handleTeacherSubmit);

  setupSubscriptionUI();
  initSubscriptionListener();
}

async function loadAllSubjects() {
  try {
    const subjects = await service.getSubjectsBySchool(currentSchoolId);
    subjectsMap.clear();
    subjects.forEach(sub => {
      subjectsMap.set(sub.id, { name: sub.name, level: sub.level });
    });
  } catch (err) {
    console.error('Load subjects error:', err);
    toast.error('Unable to load subjects. Please refresh the page.');
  }
}

async function loadAllClasses() {
  try {
    const classes = await service.getClassesBySchool(currentSchoolId);
    classesMap.clear();
    classes.forEach(cls => {
      classesMap.set(cls.id, { name: cls.name, level: cls.level });
    });
  } catch (err) {
    console.error('Load classes error:', err);
    toast.error('Unable to load classes. Please refresh the page.');
  }
}

async function loadSubjectsByLevel(level) {
  if (!level) {
    subjectsSelect.innerHTML = '<option value="">-- Select level first --</option>';
    subjectsSelect.disabled = true;
    return;
  }
  
  showLoader();
  try {
    const subjects = await service.getSubjectsByLevel(currentSchoolId, level);
    subjects.sort((a, b) => a.name.localeCompare(b.name));
    
    subjectsSelect.innerHTML = '';
    if (subjects.length === 0) {
      const option = document.createElement('option');
      option.disabled = true;
      option.textContent = `No subjects available for ${level} level`;
      subjectsSelect.appendChild(option);
      subjectsSelect.disabled = true;
    } else {
      for (const sub of subjects) {
        const option = document.createElement('option');
        option.value = sub.id;
        option.textContent = sub.name;
        subjectsSelect.appendChild(option);
      }
      subjectsSelect.disabled = false;
    }
  } catch (err) {
    console.error('Load subjects by level error:', err);
    toast.error(`Unable to load subjects for ${level} level. Please refresh.`);
    subjectsSelect.innerHTML = '<option value="">Error loading subjects</option>';
    subjectsSelect.disabled = true;
  } finally {
    hideLoader();
  }
}

async function loadClassesByLevel(level) {
  if (!level) {
    classesSelect.innerHTML = '<option value="">-- Select level first --</option>';
    classesSelect.disabled = true;
    return;
  }
  
  showLoader();
  try {
    const classes = await service.getClassesBySchoolAndLevel(currentSchoolId, level);
    classes.sort((a, b) => a.name.localeCompare(b.name));
    
    classesSelect.innerHTML = '';
    if (classes.length === 0) {
      const option = document.createElement('option');
      option.disabled = true;
      option.textContent = `No classes available for ${level} level`;
      classesSelect.appendChild(option);
      classesSelect.disabled = true;
    } else {
      for (const cls of classes) {
        const option = document.createElement('option');
        option.value = cls.id;
        option.textContent = cls.name;
        classesSelect.appendChild(option);
      }
      classesSelect.disabled = false;
    }
  } catch (err) {
    console.error('Load classes by level error:', err);
    toast.error(`Unable to load classes for ${level} level. Please refresh.`);
    classesSelect.innerHTML = '<option value="">Error loading classes</option>';
    classesSelect.disabled = true;
  } finally {
    hideLoader();
  }
}

async function loadClassTeacherOptions(level) {
  if (!level) {
    classTeacherSelect.innerHTML = '<option value="">None</option>';
    classTeacherSelect.disabled = true;
    return;
  }
  
  try {
    const classes = await service.getClassesBySchoolAndLevel(currentSchoolId, level);
    classes.sort((a, b) => a.name.localeCompare(b.name));
    
    classTeacherSelect.innerHTML = '<option value="">None</option>';
    for (const cls of classes) {
      const option = document.createElement('option');
      option.value = cls.id;
      option.textContent = cls.name;
      classTeacherSelect.appendChild(option);
    }
    classTeacherSelect.disabled = false;
  } catch (err) {
    console.error('Load class teacher options error:', err);
    toast.error('Unable to load classes for class teacher selection. Please refresh.');
    classTeacherSelect.innerHTML = '<option value="">None</option>';
    classTeacherSelect.disabled = true;
  }
}

async function loadTeachers() {
  try {
    let teachers = await service.getTeachersBySchool(currentSchoolId);
    teachers.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const container = document.getElementById('teachersList');
    if (!container) return;
    if (teachers.length === 0) {
      container.innerHTML = '<p>No teachers yet. Click "Add Teacher" to create one.</p>';
      return;
    }

    const html = `
      <div class="table-responsive-wrapper">
        <table class="data-table">
          <colgroup>
            <col style="width: 18%">
            <col style="width: 20%">
            <col style="width: 8%">
            <col style="width: 10%">
            <col style="width: 18%">
            <col style="width: 12%">
            <col style="width: 14%">
          </colgroup>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Level</th>
              <th>Subjects</th>
              <th>Classes</th>
              <th>Class Teacher</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${teachers.map(teacher => {
              const subjectCount = (teacher.subjectIds || []).length;
              const subjectDisplay = subjectCount === 0 ? '-' : `${subjectCount} subject${subjectCount !== 1 ? 's' : ''}`;
              const classNames = (teacher.classIds || [])
                .map(classId => classesMap.get(classId)?.name || classId)
                .join(', ');
              const hostClassName = teacher.isClassTeacher && teacher.hostClassId 
                ? (classesMap.get(teacher.hostClassId)?.name || 'Unknown')
                : '-';
              const levelDisplay = teacher.level === 'primary' ? 'Primary' : (teacher.level === 'secondary' ? 'Secondary' : '—');
              return `
                <tr>
                  <td>${escapeHtml(teacher.name)}</td>
                  <td>${escapeHtml(teacher.email)}</td>
                  <td>${levelDisplay}</td>
                  <td>${escapeHtml(subjectDisplay)}</td>
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
      </div>
    `;
    container.innerHTML = html;
    
    window.editTeacher = (id) => openModal(id);

    window.deleteTeacher = async (id) => {
      if (confirm('Delete this teacher permanently? This action cannot be undone.')) {
        showLoader();
        try {
          await deleteDoc(doc(db, 'teachers', id));
          try {
            await deleteDoc(doc(db, 'users', id));
          } catch (e) {
            console.warn('User document may not exist:', e);
          }
          const deleteTeacherAccount = httpsCallable(functions, 'deleteTeacherAccount');
          await deleteTeacherAccount({ teacherUid: id });
          toast.success('Teacher and login account deleted successfully.');
        } catch (err) {
          console.error('Delete teacher error:', err);
          toast.error('Failed to delete teacher. Firestore data removed, but authentication may still exist. Please contact support.');
        } finally {
          hideLoader();
          await loadTeachers();
        }
      }
    };
  } catch (err) {
    console.error('Load teachers error:', err);
    toast.error('Unable to load teachers. Please refresh the page.');
  }
}

function openModal(teacherId = null) {
  editingTeacherId = teacherId;
  const modalTitle = document.getElementById('modalTitle');
  if (!modalTitle) return;
  
  teacherForm.reset();
  subjectsSelect.innerHTML = '<option value="">-- Select level first --</option>';
  subjectsSelect.disabled = true;
  classesSelect.innerHTML = '<option value="">-- Select level first --</option>';
  classesSelect.disabled = true;
  classTeacherSelect.innerHTML = '<option value="">None</option>';
  classTeacherSelect.disabled = true;
  levelSelect.value = '';
  currentTeacherLevel = null;
  
  if (teacherId) {
    modalTitle.textContent = 'Edit Teacher';
    if (emailInput) emailInput.readOnly = true;
    loadTeacherData(teacherId);
  } else {
    modalTitle.textContent = 'Add Teacher';
    if (emailInput) emailInput.readOnly = false;
  }
  if (modal) modal.style.display = 'flex';
}

async function loadTeacherData(teacherId) {
  try {
    const teacher = await service.getTeacherById(teacherId);
    if (teacher) {
      if (nameInput) nameInput.value = teacher.name;
      if (emailInput) emailInput.value = teacher.email;
      
      const teacherLevel = teacher.level || (teacher.isClassTeacher ? (classesMap.get(teacher.hostClassId)?.level || 'secondary') : 'secondary');
      if (levelSelect) levelSelect.value = teacherLevel;
      currentTeacherLevel = teacherLevel;
      
      await loadSubjectsByLevel(teacherLevel);
      await loadClassesByLevel(teacherLevel);
      await loadClassTeacherOptions(teacherLevel);
      
      const subjectIds = teacher.subjectIds || [];
      if (subjectsSelect) {
        Array.from(subjectsSelect.options).forEach(opt => {
          opt.selected = subjectIds.includes(opt.value);
        });
      }
      const classIds = teacher.classIds || [];
      if (classesSelect) {
        Array.from(classesSelect.options).forEach(opt => {
          opt.selected = classIds.includes(opt.value);
        });
      }
      if (teacher.isClassTeacher && teacher.hostClassId && classTeacherSelect) {
        classTeacherSelect.value = teacher.hostClassId;
      } else if (classTeacherSelect) {
        classTeacherSelect.value = '';
      }
    }
  } catch (err) {
    console.error('Load teacher data error:', err);
    toast.error('Failed to load teacher data. Please refresh.');
  }
}

function closeModal() {
  if (modal) modal.style.display = 'none';
  editingTeacherId = null;
  if (emailInput) emailInput.readOnly = false;
  if (teacherForm) teacherForm.reset();
  currentTeacherLevel = null;
}

async function checkSubjectConflicts(subjectIds, level, excludeTeacherId = null) {
  if (!subjectIds.length) return null;
  
  try {
    const teachers = await service.getTeachersBySchool(currentSchoolId);
    const levelTeachers = teachers.filter(t => t.level === level);
    const conflictingSubjects = [];

    for (const subjectId of subjectIds) {
      for (const teacher of levelTeachers) {
        if (excludeTeacherId && teacher.id === excludeTeacherId) continue;
        if (teacher.subjectIds && teacher.subjectIds.includes(subjectId)) {
          const subjectName = subjectsMap.get(subjectId)?.name || subjectId;
          conflictingSubjects.push(subjectName);
          break;
        }
      }
    }
    
    if (conflictingSubjects.length) {
      const message = `The following subjects are already assigned to another teacher at the same level: ${conflictingSubjects.join(', ')}`;
      toast.error(message);
      return message;
    }
    return null;
  } catch (err) {
    console.error('Check subject conflicts error:', err);
    toast.error('Unable to verify subject conflicts. Please try again.');
    return "Unable to verify subject conflicts. Please try again.";
  }
}

async function checkClassTeacherConflict(classId, level, excludeTeacherId = null) {
  if (!classId) return null;
  
  try {
    const teachers = await service.getTeachersBySchool(currentSchoolId);
    const conflicting = teachers.find(t =>
      t.level === level &&
      t.isClassTeacher === true &&
      t.hostClassId === classId &&
      (!excludeTeacherId || t.id !== excludeTeacherId)
    );
    if (conflicting) {
      const className = classesMap.get(classId)?.name || classId;
      const message = `Class "${className}" already has a class teacher. Only one class teacher is allowed per class.`;
      toast.error(message);
      return message;
    }
    return null;
  } catch (err) {
    console.error('Check class teacher conflict error:', err);
    toast.error('Unable to verify class teacher conflict. Please try again.');
    return "Unable to verify class teacher conflict. Please try again.";
  }
}

async function handleTeacherSubmit(e) {
  e.preventDefault();
  const name = nameInput ? nameInput.value.trim() : '';
  const email = emailInput ? emailInput.value.trim() : '';
  const level = levelSelect ? levelSelect.value : '';
  const selectedSubjectIds = subjectsSelect ? Array.from(subjectsSelect.selectedOptions).map(opt => opt.value) : [];
  const selectedClassIds = classesSelect ? Array.from(classesSelect.selectedOptions).map(opt => opt.value) : [];
  const hostClassIdValue = classTeacherSelect ? (classTeacherSelect.value || null) : null;
  const isClassTeacher = hostClassIdValue !== null && hostClassIdValue !== '';

  if (!name || !email || !level) {
    toast.error('Please fill in all required fields (Name, Email, Level).');
    return;
  }

  if (level !== 'primary') {
    const subjectConflictMsg = await checkSubjectConflicts(selectedSubjectIds, level, editingTeacherId);
    if (subjectConflictMsg) {
      return;
    }
  }

  if (isClassTeacher) {
    const classTeacherConflictMsg = await checkClassTeacherConflict(hostClassIdValue, level, editingTeacherId);
    if (classTeacherConflictMsg) {
      return;
    }
  }

  const teacherDataObj = {
    name,
    email,
    level,
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
      await service.updateTeacher(editingTeacherId, teacherDataObj);
      toast.success('Teacher updated successfully.');
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
          toast.error('A user with this email already exists. Please use a different email.');
        } else {
          toast.error('Failed to create login account. Please check your internet connection.');
        }
        return;
      }
      
      const uid = userCredential.user.uid;
      const timestamp = serverTimestamp();
      
      const userDocData = {
        email,
        role: 'teacher',
        schoolId: currentSchoolId,
        level,
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
      await service.createTeacher(uid, teacherDocData);
      
      toast.success(`Teacher created successfully! Email: ${email} | Password: ${defaultPassword}`);
      
      closeModal();
      await loadTeachers();
    }
  } catch (error) {
    console.error('Handle teacher submit error:', error);
    toast.error('Failed to save teacher. Please try again.');
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
  unsubscribeSub = service.subscribeToSubscription(currentSchoolId, (subData) => {
    if (!subData) {
      showPaymentBanner();
      return;
    }
    const isActive = subData.status === 'active' && subData.locked === false;
    if (isActive) {
      hidePaymentBanner();
    } else {
      showPaymentBanner();
    }
  });
}