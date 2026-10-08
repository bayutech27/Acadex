// teachers.js - Manage teachers (primary exemption + Auth deletion via Cloud Function)
// All Firestore operations go through service.js where possible.
// MODIFIED: Removed Subjects column from teacher list.
// MODIFIED: Fixed malformed HTML table cells.
// MODIFIED: Added Nursery level support. When selected, saved as "nursery".
// NEW: Added "Type" dropdown (full-time/part-time) to teacher form and save it in Firestore.
// NEW: Delete confirmation is now a styled in-page modal (not browser confirm()).
//      The modal warns the user that all teacher data will be lost and cannot be
//      recovered. Its Confirm button performs the actual deletion.
//
// UPDATED: Delete error handling is now accurate. The outcome is classified by
//          whether the MAIN teacher document was deleted from Firestore:
//            • Main teacher deleted → GREEN success toast. Cleanup of the user
//              document and the Firebase Auth account is best-effort; if any
//              cleanup step fails, the toast is STILL green but the message
//              notes that the login account may need manual cleanup (details
//              logged to the console).
//            • Main teacher NOT deleted → RED error toast. No misleading success.
//          The toast color always matches whether the teacher is actually gone.
//
// All other functionality unchanged.

import { db, auth, functions } from './firebase-config.js';
import {
  collection, getDocs, deleteDoc, doc, updateDoc, query, where, getDoc, setDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getAuth, createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-functions.js';
import { getCurrentSchoolId } from './admin.js';
import { showNotification, handleError, showLoader, hideLoader, toast } from './error-handler.js';
import * as service from './service.js';

let currentSchoolId = null;
let subjectsMap = new Map();
let classesMap = new Map();
let editingTeacherId = null;
let unsubscribeSub = null;

let teacherForm, modal, nameInput, emailInput, typeSelect, levelSelect, subjectsSelect, classesSelect, classTeacherSelect;
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
  typeSelect = document.getElementById('teacherType');
  levelSelect = document.getElementById('teacherLevel');
  subjectsSelect = document.getElementById('teacherSubjects');
  classesSelect = document.getElementById('teacherClasses');
  classTeacherSelect = document.getElementById('teacherClassTeacher');

  if (!teacherForm || !modal || !nameInput || !emailInput || !typeSelect || !levelSelect || !subjectsSelect || !classesSelect || !classTeacherSelect) {
    console.error('Required DOM elements not found');
    toast.error('Page not loaded correctly. Please refresh.');
    return;
  }

  if (classTeacherSelect && !classTeacherSelect.multiple) {
    classTeacherSelect.multiple = true;
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
      while (classTeacherSelect.options.length) classTeacherSelect.remove(0);
      const helperOption = document.createElement('option');
      helperOption.disabled = true;
      helperOption.selected = true;
      helperOption.textContent = 'Select level first';
      classTeacherSelect.appendChild(helperOption);
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
    while (classTeacherSelect.options.length) classTeacherSelect.remove(0);
    const helperOption = document.createElement('option');
    helperOption.disabled = true;
    helperOption.selected = true;
    helperOption.textContent = 'Select level first';
    classTeacherSelect.appendChild(helperOption);
    classTeacherSelect.disabled = true;
    return;
  }

  try {
    const classes = await service.getClassesBySchoolAndLevel(currentSchoolId, level);
    classes.sort((a, b) => a.name.localeCompare(b.name));

    while (classTeacherSelect.options.length) classTeacherSelect.remove(0);

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
    while (classTeacherSelect.options.length) classTeacherSelect.remove(0);
    const errorOption = document.createElement('option');
    errorOption.disabled = true;
    errorOption.textContent = 'Error loading classes';
    classTeacherSelect.appendChild(errorOption);
    classTeacherSelect.disabled = true;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Helper: Delete confirmation modal
// Returns a Promise<boolean> — true if the user confirms deletion, false otherwise.
// The Confirm (Delete) button is the ONLY path that proceeds with deletion.
// ───────────────────────────────────────────────────────────────────────────────
function showDeleteConfirmModal(teacherName) {
  return new Promise((resolve) => {
    document.getElementById('deleteConfirmModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'deleteConfirmModal';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;
      align-items:center;justify-content:center;z-index:9999;
      font-family:inherit;
    `;

    const safeName = escapeHtml(teacherName || 'this teacher');

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:26px 28px;max-width:440px;
                  width:90%;box-shadow:0 8px 32px rgba(0,0,0,.18);">
        <h3 style="margin:0 0 8px;font-size:1.1rem;color:#b91c1c;">
          ⚠️ Delete Teacher
        </h3>
        <p style="margin:0 0 14px;color:#334155;font-size:.95rem;line-height:1.5;">
          Are you sure you want to delete <strong>${safeName}</strong>?
        </p>
        <p style="margin:0 0 20px;color:#ef4444;font-size:.85rem;line-height:1.5;">
          All data will be lost and cannot be recovered.
        </p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="cancelDeleteBtn" style="padding:9px 16px;border:1px solid #e2e8f0;
            border-radius:8px;background:#fff;color:#374151;font-weight:600;cursor:pointer;
            font-size:.9rem;">
            Cancel
          </button>
          <button id="confirmDeleteBtn" style="padding:9px 16px;border:none;border-radius:8px;
            background:#dc2626;color:#fff;font-weight:600;cursor:pointer;font-size:.9rem;">
            Delete
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const cleanup = (result) => {
      overlay.remove();
      resolve(result);
    };

    document.getElementById('cancelDeleteBtn').addEventListener('click', () => cleanup(false));
    document.getElementById('confirmDeleteBtn').addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
  });
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
            <col style="width: 20%">
            <col style="width: 25%">
            <col style="width: 10%">
            <col style="width: 20%">
            <col style="width: 15%">
            <col style="width: 10%">
          </colgroup>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Level</th>
              <th>Classes</th>
              <th>Class Teacher</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${teachers.map(teacher => {
              const classNames = (teacher.classIds || [])
                .map(classId => classesMap.get(classId)?.name || classId)
                .join(', ') || '-';
              const hostClassNames = (teacher.hostClassIds || [])
                .map(classId => classesMap.get(classId)?.name || classId)
                .join(', ') || '-';
              const levelDisplay = teacher.level === 'nursery' ? 'Nursery' : (teacher.level === 'primary' ? 'Primary' : (teacher.level === 'secondary' ? 'Secondary' : '—'));
              return `
                <tr>
                  <td>${escapeHtml(teacher.name)}</td>
                  <td>${escapeHtml(teacher.email)}</td>
                  <td>${escapeHtml(levelDisplay)}</td>
                  <td>${escapeHtml(classNames)}</td>
                  <td>${escapeHtml(hostClassNames)}</td>
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

    // ─────────────────────────────────────────────────────────────────────────
    // DELETE TEACHER — accurate outcome reporting
    //
    // The outcome is classified by whether the MAIN teacher document is deleted
    // from Firestore:
    //   • Main teacher deleted   → GREEN success toast. Cleanup of the user doc
    //     and the Firebase Auth account is best-effort; failures there do NOT
    //     turn the operation into a failure — they are logged for developers
    //     and (if any occurred) mentioned briefly in the success message.
    //   • Main teacher NOT deleted → RED error toast. No misleading success.
    // ─────────────────────────────────────────────────────────────────────────
    window.deleteTeacher = async (id) => {
      const teacherForModal = teachers.find(t => t.id === id);
      const teacherDisplayName = teacherForModal?.name || 'this teacher';

      const confirmed = await showDeleteConfirmModal(teacherDisplayName);
      if (!confirmed) return;

      showLoader();

      // ── STEP 1 (critical): delete the main teacher document ──
      let mainDeleteSucceeded = false;
      try {
        await deleteDoc(doc(db, 'teachers', id));
        mainDeleteSucceeded = true;
      } catch (deleteErr) {
        console.error('[Delete Teacher] Failed to delete teacher document:', deleteErr);
        toast.error('Failed to delete teacher. Please try again.');
      }

      if (!mainDeleteSucceeded) {
        hideLoader();
        await loadTeachers();
        return;
      }

      // ── STEP 2 (best-effort): clean up related records ──
      // The teacher is already deleted at this point. Any failure below is
      // logged for developers but does NOT change the success outcome.
      const cleanupIssues = [];

      // Delete user document — its absence is not treated as a failure.
      try {
        await deleteDoc(doc(db, 'users', id));
      } catch (userErr) {
        // User doc may not exist; that's fine. Log for diagnostics only.
        console.warn('[Delete Teacher] Could not delete user document (may not exist):', userErr);
      }

      // Delete Firebase Auth account via Cloud Function.
      try {
        const deleteTeacherAccount = httpsCallable(functions, 'deleteTeacherAccount');
        await deleteTeacherAccount({ teacherUid: id });
      } catch (cloudErr) {
        cleanupIssues.push('login account');
        console.error('[Delete Teacher] Failed to delete auth account via Cloud Function:', cloudErr);
      }

      hideLoader();
      await loadTeachers();

      // ── STEP 3: report the outcome truthfully ──
      if (cleanupIssues.length === 0) {
        toast.success('Teacher and login account deleted successfully.');
      } else {
        // Main delete succeeded → still GREEN success.
        // The note is honest: the login account may still exist and needs
        // manual cleanup by support.
        toast.success('Teacher deleted successfully. (The login account could not be removed automatically.)');
        console.warn('[Delete Teacher] Cleanup issues (main delete succeeded):', cleanupIssues);
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
  while (classTeacherSelect.options.length) classTeacherSelect.remove(0);
  const helperOption = document.createElement('option');
  helperOption.disabled = true;
  helperOption.selected = true;
  helperOption.textContent = 'Select level first';
  classTeacherSelect.appendChild(helperOption);
  classTeacherSelect.disabled = true;

  levelSelect.value = '';
  typeSelect.value = '';
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
      if (typeSelect) typeSelect.value = teacher.type || '';

      const teacherLevel = teacher.level || 'secondary';
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
      const hostClassIds = teacher.hostClassIds || [];
      if (classTeacherSelect) {
        Array.from(classTeacherSelect.options).forEach(opt => {
          opt.selected = hostClassIds.includes(opt.value);
        });
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

async function checkClassTeacherConflict(hostClassIds, level, excludeTeacherId = null) {
  if (!hostClassIds || hostClassIds.length === 0) return null;

  try {
    const teachers = await service.getTeachersBySchool(currentSchoolId);
    const conflictingClasses = [];
    for (const classId of hostClassIds) {
      const conflicting = teachers.find(t =>
        t.level === level &&
        t.isClassTeacher === true &&
        (t.hostClassIds || []).includes(classId) &&
        (!excludeTeacherId || t.id !== excludeTeacherId)
      );
      if (conflicting) {
        const className = classesMap.get(classId)?.name || classId;
        conflictingClasses.push(className);
      }
    }
    if (conflictingClasses.length) {
      const message = `Class(es) already have a class teacher: ${conflictingClasses.join(', ')}. Only one class teacher is allowed per class.`;
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
  const type = typeSelect ? typeSelect.value : '';
  const level = levelSelect ? levelSelect.value : '';
  const selectedSubjectIds = subjectsSelect ? Array.from(subjectsSelect.selectedOptions).map(opt => opt.value) : [];
  const selectedClassIds = classesSelect ? Array.from(classesSelect.selectedOptions).map(opt => opt.value) : [];
  const selectedHostClassIds = classTeacherSelect
    ? Array.from(classTeacherSelect.selectedOptions)
        .filter(opt => opt.value && opt.value !== '' && !opt.disabled)
        .map(opt => opt.value)
    : [];
  const isClassTeacher = selectedHostClassIds.length > 0;

  if (!name || !email || !type || !level) {
    toast.error('Please fill in all required fields (Name, Email, Type, Level).');
    return;
  }

  if (isClassTeacher) {
    const classTeacherConflictMsg = await checkClassTeacherConflict(selectedHostClassIds, level, editingTeacherId);
    if (classTeacherConflictMsg) return;
  }

  const teacherDataObj = {
    name,
    email,
    type,
    level,
    subjectIds: selectedSubjectIds,
    classIds: selectedClassIds,
    isClassTeacher,
    hostClassIds: selectedHostClassIds,
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
        type,
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