// js/parent-account-creator.js
// Handles parent account creation (Firebase Auth + Firestore) AND the Admin Parents page logic.
// Updated: multi-class selection and multi-student selection in modal.

import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getAuth, createUserWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';
import { db } from './firebase-config.js';
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  writeBatch,
  collection,
  query,
  where,
  getDocs,
  arrayUnion,
  arrayRemove
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { toast } from './error-handler.js';
import * as service from './service.js';
import { initAdminPage, getCurrentSchoolId } from './admin.js';

// ────────────────────────────────────────────────────────────
// Account Creation Functions (used by both page and external)
// ────────────────────────────────────────────────────────────

/**
 * Creates a parent account with full Firestore setup.
 * @param {Object} data - Parent data
 * @param {string} data.title
 * @param {string} data.name
 * @param {string} data.phone
 * @param {string} data.email
 * @param {string} data.schoolId
 * @param {string[]} data.childIds
 * @param {string} data.password - default '$Acadex123'
 * @returns {Promise<{uid: string}>}
 */
export async function createParentAccount(data) {
  const {
    title,
    name,
    phone,
    email,
    schoolId,
    childIds,
    password = '$Acadex123'
  } = data;

  if (!email || !name || !schoolId || !childIds || childIds.length === 0) {
    throw new Error('Missing required fields: email, name, schoolId, childIds');
  }

  let uid = null;
  const tempApp = initializeApp(firebaseConfig, `parent-creator-${Date.now()}`);
  const tempAuth = getAuth(tempApp);

  try {
    // 1. Create Auth account
    const cred = await createUserWithEmailAndPassword(tempAuth, email, password);
    uid = cred.user.uid;
    await signOut(tempAuth);

    // 2. Firestore user document
    const userRef = doc(db, 'users', uid);
    await setDoc(userRef, {
      role: 'parent',
      schoolId: schoolId,
      email: email,
      createdAt: new Date()
    });

    // 3. Parent document
    const parentRef = doc(db, 'parents', uid);
    await setDoc(parentRef, {
      title: title || '',
      name: name,
      phone: phone || '',
      email: email,
      schoolId: schoolId,
      childIds: childIds,
      mustChangePassword: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // 4. Update each student with the new parentId
    const batch = writeBatch(db);
    childIds.forEach(studentId => {
      const studentRef = doc(db, 'students', studentId);
      batch.update(studentRef, {
        parentIds: arrayUnion(uid)
      });
    });
    await batch.commit();

    return { uid };

  } catch (error) {
    console.error('createParentAccount error:', error);
    if (uid) {
      try {
        const cleanupApp = initializeApp(firebaseConfig, `parent-cleanup-${Date.now()}`);
        const cleanupAuth = getAuth(cleanupApp);
        const user = cleanupAuth.currentUser;
        if (user) await user.delete();
        await deleteApp(cleanupApp);
      } catch (cleanupError) {
        console.error('Failed to delete auth user after error:', cleanupError);
      }
    }
    throw error;
  } finally {
    await deleteApp(tempApp);
  }
}

/**
 * Legacy wrapper: creates only the Auth account (no Firestore).
 * Use createParentAccount for full setup.
 */
export async function createParentAuthAccount(email, password) {
  const tempApp = initializeApp(firebaseConfig, `parent-creator-${Date.now()}`);
  const tempAuth = getAuth(tempApp);
  try {
    const cred = await createUserWithEmailAndPassword(tempAuth, email, password);
    const uid = cred.user.uid;
    await tempAuth.signOut();
    return uid;
  } finally {
    await deleteApp(tempApp);
  }
}

// ────────────────────────────────────────────────────────────
// Admin Parents Page Initialisation
// ────────────────────────────────────────────────────────────

let editingParentId = null;
let allStudents = [];
let selectedStudentIds = new Set(); // Keep track of selected student IDs

function resetModalToCreate() {
  editingParentId = null;
  document.getElementById('editingParentId').value = '';
  document.getElementById('addParentForm').reset();
  document.querySelector('#addParentModal .modal-header h2').innerHTML =
    '<i class="fa-solid fa-user-plus"></i> Add Parent';
  document.getElementById('createParentBtn').textContent = 'Create Parent';
  document.getElementById('selectedChildrenChips').innerHTML = '';
  selectedStudentIds.clear();
  // Clear class multi-select
  const classSelect = document.getElementById('classFilterSelect');
  if (classSelect) {
    for (let opt of classSelect.options) opt.selected = false;
  }
  // Clear student checkbox list
  document.getElementById('studentCheckboxList').innerHTML = '';
}

async function loadParentsTable() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) {
    toast.error('School ID not found.');
    return;
  }
  try {
    const parents = await service.getParentsBySchool(schoolId);
    const tbody = document.getElementById('parentsTableBody');
    if (!parents || parents.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6">No parents found.</td></tr>';
      return;
    }
    let html = '';
    for (const p of parents) {
      let childNames = 'None';
      if (p.childIds && p.childIds.length > 0) {
        try {
          const students = await service.getStudentsByIds(p.childIds);
          childNames = students.map(s => s.name).join(', ');
        } catch (_) { /* ignore */ }
      }
      html += `<tr>
        <td>${p.title || ''}</td>
        <td>${p.name || ''}</td>
        <td>${p.phone || ''}</td>
        <td>${p.email || ''}</td>
        <td>${childNames}</td>
        <td>
          <button class="btn-secondary btn-sm edit-parent" data-id="${p.id}">Edit</button>
          <button class="btn-danger btn-sm delete-parent" data-id="${p.id}">Delete</button>
        </td>
      </tr>`;
    }
    tbody.innerHTML = html;

    document.querySelectorAll('.edit-parent').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.dataset.id;
        openEditModal(id);
      });
    });

    document.querySelectorAll('.delete-parent').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.dataset.id;
        if (confirm('Are you sure you want to delete this parent? This will also disable their login.')) {
          try {
            // Delete parent doc
            await service.deleteParent(id);
            // Mark user as disabled
            await updateDoc(doc(db, 'users', id), { disabled: true, disabledAt: new Date() });
            toast.success('Parent deleted and login disabled.');
            await loadParentsTable();
          } catch (err) {
            console.error('Delete parent error:', err);
            toast.error('Failed to delete parent. Please try again.');
          }
        }
      });
    });
  } catch (err) {
    console.error('Load parents error:', err);
    toast.error('Could not load parents list.');
  }
}

async function populateStudentCheckboxes() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  try {
    const students = await service.getStudentsBySchool(schoolId);
    allStudents = students;
    const container = document.getElementById('studentCheckboxList');
    const classSelect = document.getElementById('classFilterSelect');
    
    // Load classes into multi-select
    const classes = await service.getClassesBySchool(schoolId);
    classSelect.innerHTML = '';
    classes.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      classSelect.appendChild(opt);
    });

    // Render function: filters students by selected classes
    const renderStudents = () => {
      const selectedClassIds = Array.from(classSelect.selectedOptions).map(opt => opt.value);
      let filtered = allStudents;
      if (selectedClassIds.length > 0) {
        filtered = filtered.filter(s => selectedClassIds.includes(s.classId));
      }
      if (filtered.length === 0) {
        container.innerHTML = '<p style="color:#64748b;padding:0.5rem;">No students found.</p>';
        return;
      }
      let html = '';
      filtered.forEach(s => {
        const checked = selectedStudentIds.has(s.id) ? 'checked' : '';
        html += `
          <label style="display:flex; align-items:center; padding:4px 0;">
            <input type="checkbox" value="${s.id}" ${checked} style="margin-right:8px;" />
            ${s.name}
          </label>
        `;
      });
      container.innerHTML = html;

      // Add event listeners to checkboxes
      container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.checked) {
            selectedStudentIds.add(cb.value);
          } else {
            selectedStudentIds.delete(cb.value);
          }
          updateChips();
        });
      });
    };

    // Event listener for multi-select change
    classSelect.addEventListener('change', renderStudents);
    renderStudents();
  } catch (err) {
    console.error('Student checkbox error:', err);
    toast.error('Could not load student list.');
  }
}

function updateChips() {
  const container = document.getElementById('selectedChildrenChips');
  if (!container) return;
  let html = '';
  for (const id of selectedStudentIds) {
    const student = allStudents.find(s => s.id === id);
    if (student) {
      html += `<span class="parent-chip" data-id="${id}">${student.name} <span class="remove-parent-chip" data-id="${id}"><i class="fa-solid fa-xmark"></i></span></span>`;
    }
  }
  container.innerHTML = html;

  // Add click handlers for removal
  container.querySelectorAll('.remove-parent-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      selectedStudentIds.delete(id);
      updateChips();
      // Also uncheck corresponding checkbox if visible
      const cb = document.querySelector(`#studentCheckboxList input[value="${id}"]`);
      if (cb) cb.checked = false;
    });
  });
}

async function openEditModal(parentId) {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;

  try {
    const parent = await service.getParentById(parentId);
    if (!parent) {
      toast.error('Parent not found.');
      return;
    }

    editingParentId = parentId;
    document.getElementById('editingParentId').value = parentId;

    document.getElementById('parentTitle').value = parent.title || 'Mr';
    document.getElementById('parentFullName').value = parent.name || '';
    document.getElementById('parentPhone').value = parent.phone || '';
    document.getElementById('parentEmail').value = parent.email || '';

    // Reset selectedStudentIds
    selectedStudentIds = new Set(parent.childIds || []);
    updateChips();

    // Load classes and students
    await populateStudentCheckboxes();

    // Pre-select classes based on children's class IDs
    const classSelect = document.getElementById('classFilterSelect');
    const childIds = parent.childIds || [];
    const childClassIds = new Set();
    for (const student of allStudents) {
      if (childIds.includes(student.id)) {
        childClassIds.add(student.classId);
      }
    }
    for (let opt of classSelect.options) {
      opt.selected = childClassIds.has(opt.value);
    }

    // Re-render students with selected classes
    const event = new Event('change');
    classSelect.dispatchEvent(event);

    document.querySelector('#addParentModal .modal-header h2').innerHTML =
      '<i class="fa-solid fa-user-pen"></i> Edit Parent';
    document.getElementById('createParentBtn').textContent = 'Update Parent';

    document.getElementById('addParentModal').style.display = 'flex';
  } catch (err) {
    console.error('Open edit modal error:', err);
    toast.error('Failed to load parent details.');
  }
}

async function syncStudentsForParent(parentId, newChildIds, oldChildIds = []) {
  const added   = newChildIds.filter(id => !oldChildIds.includes(id));
  const removed = oldChildIds.filter(id => !newChildIds.includes(id));

  const batch = writeBatch(db);

  added.forEach(id => {
    const studentRef = doc(db, 'students', id);
    batch.update(studentRef, { parentIds: arrayUnion(parentId) });
  });

  removed.forEach(id => {
    const studentRef = doc(db, 'students', id);
    batch.update(studentRef, { parentIds: arrayRemove(parentId) });
  });

  await batch.commit();
}

async function handleAddParentSubmit(e) {
  e.preventDefault();
  const title = document.getElementById('parentTitle').value;
  const name = document.getElementById('parentFullName').value.trim();
  const phone = document.getElementById('parentPhone').value.trim();
  const email = document.getElementById('parentEmail').value.trim();

  if (!name || !phone || !email) {
    toast.error('Please fill in all required fields.');
    return;
  }
  if (!email.includes('@')) {
    toast.error('Please enter a valid email address.');
    return;
  }

  if (selectedStudentIds.size === 0) {
    toast.error('Please select at least one child.');
    return;
  }

  const btn = document.getElementById('createParentBtn');
  btn.disabled = true;

  const schoolId = await getCurrentSchoolId();
  const childIds = Array.from(selectedStudentIds);

  if (editingParentId) {
    // UPDATE
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Updating…';
    try {
      await service.updateParent(editingParentId, {
        title,
        name,
        phone,
        email,
        childIds,
        updatedAt: new Date()
      });

      const parentDoc = await service.getParentById(editingParentId);
      const oldChildIds = parentDoc?.childIds || [];
      await syncStudentsForParent(editingParentId, childIds, oldChildIds);

      toast.success('Parent updated successfully.');
      document.getElementById('addParentModal').style.display = 'none';
      resetModalToCreate();
      await loadParentsTable();
    } catch (err) {
      console.error('Update parent error:', err);
      toast.error('Failed to update parent. ' + (err.message || ''));
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'Update Parent';
    }
  } else {
    // CREATE
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Creating…';
    try {
      await createParentAccount({
        title,
        name,
        phone,
        email,
        schoolId,
        childIds,
        password: '$Acadex123'
      });

      toast.success('Parent account created. They can log in with their email and default password.');
      document.getElementById('addParentModal').style.display = 'none';
      resetModalToCreate();
      await loadParentsTable();
    } catch (err) {
      console.error('Create parent error:', err);
      let msg = 'Failed to create parent. ';
      if (err.code === 'auth/email-already-in-use') {
        msg = 'This email is already registered. Please use a different email.';
      } else if (err.message) {
        msg += err.message;
      }
      toast.error(msg);
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'Create Parent';
    }
  }
}

/**
 * Initialises the Admin Parents page.
 * Call this from the page's script tag.
 */
export async function initParentsPage() {
  // Boot the admin shell (auth, school info, sidebar, etc.)
  await initAdminPage(async () => {
    // Load initial data
    await loadParentsTable();

    // Wire up UI elements
    const addBtn = document.getElementById('addParentBtn');
    const modal = document.getElementById('addParentModal');
    const closeBtns = modal.querySelectorAll('.close-modal, [data-modal-close]');
    const form = document.getElementById('addParentForm');

    addBtn.addEventListener('click', () => {
      resetModalToCreate();
      modal.style.display = 'flex';
      populateStudentCheckboxes();
    });

    closeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        modal.style.display = 'none';
      });
    });

    form.addEventListener('submit', handleAddParentSubmit);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
      }
    });

    // Year stamps
    document.getElementById('currentYear').innerText = new Date().getFullYear();
    document.getElementById('sidebarYear').innerText = new Date().getFullYear();

    // Service Worker
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
          .then(registration => {
            console.log('Service Worker registered with scope:', registration.scope);
            setInterval(() => registration.update(), 60 * 60 * 1000);
          })
          .catch(err => {
            console.error('Service Worker registration failed:', err);
          });
      });
    }
  });
}