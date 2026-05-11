// students.js - Manage students with name parts, level filtering, dynamic class/subject loading
// FULLY INTEGRATED with Central Academic Calendar (via admin.js exports)
// MODIFIED: New student locked status based on raw subscription (active→locked true, inactive→locked false)
// EXTENDED: Firebase Auth account creation using secondary app (same pattern as teachers.js)
//           Student can login with email and password ($Acadex123) to students-portal.html
//           All existing edit / delete / filter / display logic is UNCHANGED.
// ADDED: Alphabetical sorting of students by full name in the student list table.

import { db, auth, firebaseConfig } from './firebase-config.js';
import { getAuth, createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import {
  collection, addDoc, getDocs, deleteDoc, doc, updateDoc, query, where, getDoc, onSnapshot, setDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId, protectAdminPage } from './admin.js';
import { handleNewStudentAddition, getRawSubscription } from './plan.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

let currentSchoolId = null;
let subjectsMap = new Map();      // full map { id: { name, level } }
let classesMap = new Map();       // full map { id: { name, level } }
let editingStudentId = null;
let currentFilter = 'all';
let schoolName = '';
let unsubscribeSub = null;

// DOM elements
let studentForm, modal, admissionNoInput;
let surnameInput, firstNameInput, otherNameInput;
let emailInput, levelSelect, classSelect, subjectsSelect, statusSelect;
let genderSelect, dobInput, ageDisplay, clubInput, passportInput, passportPreviewContainer, passportErrorSpan;

// ───────────────────────────────────────────────────────────────────────────────
// SECONDARY FIREBASE APP (for student account creation – prevents admin logout)
// ───────────────────────────────────────────────────────────────────────────────
let secondaryAuth = null;

function getSecondaryAuth() {
  if (!secondaryAuth) {
    const secondaryApp = initializeApp(firebaseConfig, 'secondaryStudent');
    secondaryAuth = getAuth(secondaryApp);
  }
  return secondaryAuth;
}

// ───────────────────────────────────────────────────────────────────────────────
// HELPER: Raw subscription active check (status + locked only — no term/session)
// ───────────────────────────────────────────────────────────────────────────────
async function isRawSubscriptionActive(schoolId) {
  try {
    const sub = await getRawSubscription(schoolId);
    if (!sub) return false;
    return sub.status === 'active' && sub.locked !== true;
  } catch (err) {
    console.warn('Failed to get raw subscription:', err);
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Helper: Show credentials modal (unchanged)
// ───────────────────────────────────────────────────────────────────────────────
function showCredentialsModal(fullName, email, tempPassword) {
  document.getElementById('credentialsModal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'credentialsModal';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;
    align-items:center;justify-content:center;z-index:9999;
  `;

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:420px;
                width:90%;box-shadow:0 8px 32px rgba(0,0,0,.18);font-family:inherit;">
      <h3 style="margin:0 0 6px;font-size:1.1rem;color:#1e293b;">
        ✅ Student Account Created
      </h3>
      <p style="margin:0 0 18px;color:#64748b;font-size:.9rem;">
        Share these one-time login credentials with <strong>${escapeHtml(fullName)}</strong>.
        The password should be changed on first login.
      </p>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;
                  padding:14px 16px;margin-bottom:18px;font-size:.92rem;">
        <div style="margin-bottom:8px;">
          <span style="color:#64748b;">Email:</span>
          <strong style="margin-left:8px;color:#0f172a;">${escapeHtml(email)}</strong>
        </div>
        <div>
          <span style="color:#64748b;">Temp&nbsp;Password:</span>
          <strong style="margin-left:8px;color:#0f172a;font-family:monospace;letter-spacing:.04em;">
            ${escapeHtml(tempPassword)}
          </strong>
        </div>
      </div>

      <p style="margin:0 0 18px;color:#ef4444;font-size:.82rem;">
        ⚠️ This password will NOT be shown again. Copy it now.
      </p>

      <div style="display:flex;gap:10px;">
        <button id="copyCredsBtn" style="flex:1;padding:9px;border:none;border-radius:8px;
          background:#0ea5e9;color:#fff;font-weight:600;cursor:pointer;font-size:.9rem;">
          📋 Copy Credentials
        </button>
        <button id="closeCredsBtn" style="flex:1;padding:9px;border:1px solid #e2e8f0;
          border-radius:8px;background:#fff;color:#374151;font-weight:600;cursor:pointer;font-size:.9rem;">
          Done
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('copyCredsBtn').addEventListener('click', () => {
    const text = `Student Login\nEmail: ${email}\nPassword: ${tempPassword}`;
    navigator.clipboard.writeText(text)
      .then(() => showNotification('Credentials copied to clipboard.', 'success'))
      .catch(() => showNotification('Copy failed — please copy manually.', 'error'));
  });

  document.getElementById('closeCredsBtn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ───────────────────────────────────────────────────────────────────────────────
// PAGE INITIALISER
// ───────────────────────────────────────────────────────────────────────────────
export async function initStudentsPage() {
  await protectAdminPage();
  currentSchoolId = await getCurrentSchoolId();
  if (!currentSchoolId) {
    showNotification('School ID missing.', 'error');
    return;
  }

  studentForm              = document.getElementById('studentForm');
  modal                    = document.getElementById('studentModal');
  admissionNoInput         = document.getElementById('studentAdmissionNo');
  surnameInput             = document.getElementById('studentSurname');
  firstNameInput           = document.getElementById('studentFirstName');
  otherNameInput           = document.getElementById('studentOtherName');
  emailInput               = document.getElementById('studentEmail');
  levelSelect              = document.getElementById('studentLevel');
  classSelect              = document.getElementById('studentClass');
  subjectsSelect           = document.getElementById('studentSubjects');
  statusSelect             = document.getElementById('studentStatus');
  genderSelect             = document.getElementById('studentGender');
  dobInput                 = document.getElementById('studentDob');
  ageDisplay               = document.getElementById('studentAgeDisplay');
  clubInput                = document.getElementById('studentClub');
  passportInput            = document.getElementById('studentPassport');
  passportPreviewContainer = document.getElementById('passportPreviewContainer');
  passportErrorSpan        = document.getElementById('passportError');

  if (!studentForm || !modal || !surnameInput || !firstNameInput || !levelSelect || !classSelect || !subjectsSelect) {
    console.error('Required DOM elements not found');
    return;
  }

  const schoolDoc = await getDoc(doc(db, 'schools', currentSchoolId));
  if (schoolDoc.exists()) schoolName = schoolDoc.data().name || '';

  await loadAllClasses();
  await loadAllSubjects();
  await loadAndDisplayStudents();

  document.getElementById('addStudentBtn')?.addEventListener('click', () => openModal());
  document.querySelector('#studentModal .close-modal')?.addEventListener('click', closeModal);
  document.getElementById('cancelModalBtn')?.addEventListener('click', closeModal);
  studentForm.addEventListener('submit', handleStudentSubmit);

  if (dobInput)      dobInput.addEventListener('change', calculateAndDisplayAge);
  if (passportInput) passportInput.addEventListener('change', handlePassportUpload);

  if (levelSelect) {
    levelSelect.addEventListener('change', async (e) => {
      const level = e.target.value;
      if (level) {
        await loadClassesByLevel(level);
        await loadSubjectsByLevel(level);
        if (classSelect)   classSelect.disabled   = false;
        if (subjectsSelect) subjectsSelect.disabled = false;
      } else {
        if (classSelect) {
          classSelect.innerHTML = '<option value="">-- Select level first --</option>';
          classSelect.disabled = true;
        }
        if (subjectsSelect) {
          subjectsSelect.innerHTML = '<option value="">-- Select level first --</option>';
          subjectsSelect.disabled = true;
        }
      }
    });
  }

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.getAttribute('data-class');
      loadAndDisplayStudents();
    });
  });

  setupSubscriptionUI();
  initSubscriptionListener();
}

// ───────────────────────────────────────────────────────────────────────────────
// STRING HELPERS
// ───────────────────────────────────────────────────────────────────────────────
function capitalizeWords(str) {
  if (!str) return '';
  return str.trim().replace(/\b\w/g, char => char.toUpperCase());
}

function formatFullName(surname, firstName, otherName) {
  const parts = [surname, firstName];
  if (otherName?.trim()) parts.push(otherName);
  return parts.join(' ');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m =>
    m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// CLASS & SUBJECT LOADERS
// ───────────────────────────────────────────────────────────────────────────────
async function loadAllClasses() {
  try {
    const snapshot = await getDocs(query(collection(db, 'classes'), where('schoolId', '==', currentSchoolId)));
    classesMap.clear();
    snapshot.forEach(d => classesMap.set(d.id, { name: d.data().name, level: d.data().level }));
  } catch (err) {
    handleError(err, 'Failed to load classes reference.');
  }
}

async function loadAllSubjects() {
  try {
    const snapshot = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId)));
    subjectsMap.clear();
    snapshot.forEach(d => subjectsMap.set(d.id, { name: d.data().name, level: d.data().level }));
  } catch (err) {
    handleError(err, 'Failed to load subjects reference.');
  }
}

async function loadClassesByLevel(level) {
  if (!level) return;
  showLoader();
  try {
    const snapshot = await getDocs(
      query(collection(db, 'classes'), where('schoolId', '==', currentSchoolId), where('level', '==', level))
    );
    const classes = snapshot.docs.map(d => ({ id: d.id, name: d.data().name }));
    if (!classSelect) return;
    classSelect.innerHTML = '<option value="">Select Class</option>';
    if (classes.length === 0) {
      classSelect.innerHTML = '<option value="">No classes available for this level</option>';
      classSelect.disabled = true;
    } else {
      classes.forEach(cls => {
        const opt = document.createElement('option');
        opt.value = cls.id;
        opt.textContent = cls.name;
        classSelect.appendChild(opt);
      });
      classSelect.disabled = false;
    }
  } catch (err) {
    handleError(err, 'Failed to load classes for selected level.');
    if (classSelect) {
      classSelect.innerHTML = '<option value="">Error loading classes</option>';
      classSelect.disabled = true;
    }
  } finally {
    hideLoader();
  }
}

async function loadSubjectsByLevel(level) {
  if (!level) return;
  showLoader();
  try {
    const snapshot = await getDocs(
      query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId), where('level', '==', level))
    );
    const subjects = snapshot.docs.map(d => ({ id: d.id, name: d.data().name }));
    if (!subjectsSelect) return;
    subjectsSelect.innerHTML = '';
    if (subjects.length === 0) {
      const opt = document.createElement('option');
      opt.disabled = true;
      opt.textContent = 'No subjects available for this level';
      subjectsSelect.appendChild(opt);
      subjectsSelect.disabled = true;
    } else {
      subjects.forEach(sub => {
        const opt = document.createElement('option');
        opt.value = sub.id;
        opt.textContent = sub.name;
        subjectsSelect.appendChild(opt);
      });
      subjectsSelect.disabled = false;
    }
  } catch (err) {
    handleError(err, 'Failed to load subjects for selected level.');
    if (subjectsSelect) {
      subjectsSelect.innerHTML = '<option value="">Error loading subjects</option>';
      subjectsSelect.disabled = true;
    }
  } finally {
    hideLoader();
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// AGE HELPERS
// ───────────────────────────────────────────────────────────────────────────────
function calculateAge(dobString) {
  if (!dobString) return null;
  const birth = new Date(dobString);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

function calculateAndDisplayAge() {
  if (!dobInput || !ageDisplay) return;
  const dob = dobInput.value;
  ageDisplay.textContent = dob ? (calculateAge(dob) ?? 'Invalid date') : '-';
}

// ───────────────────────────────────────────────────────────────────────────────
// ADMISSION NUMBER HELPERS
// ───────────────────────────────────────────────────────────────────────────────
function getSchoolCode() {
  if (!schoolName) return 'XX';
  return schoolName.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 2);
}

async function getNextSequenceNumber() {
  try {
    const snapshot = await getDocs(
      query(collection(db, 'students'), where('schoolId', '==', currentSchoolId))
    );
    const schoolCode   = getSchoolCode();
    const currentYear  = new Date().getFullYear();
    const pattern      = new RegExp(`^${schoolCode}/${currentYear}/0*(\\d+)$`);
    let maxSeq = 0;
    snapshot.docs.forEach(d => {
      const no    = d.data().admissionNumber;
      const match = no?.match(pattern);
      if (match) {
        const seq = parseInt(match[1], 10);
        if (seq > maxSeq) maxSeq = seq;
      }
    });
    return maxSeq + 1;
  } catch (err) {
    handleError(err, 'Failed to generate admission number.');
    return 1;
  }
}

async function generateAdmissionNumber() {
  const schoolCode  = getSchoolCode();
  const currentYear = new Date().getFullYear();
  const nextSeq     = await getNextSequenceNumber();
  return `${schoolCode}/${currentYear}/${String(nextSeq).padStart(3, '0')}`;
}

async function isAdmissionNumberUnique(admissionNo, excludeStudentId = null) {
  try {
    const snapshot = await getDocs(
      query(
        collection(db, 'students'),
        where('schoolId', '==', currentSchoolId),
        where('admissionNumber', '==', admissionNo)
      )
    );
    if (snapshot.empty) return true;
    if (excludeStudentId && snapshot.docs.length === 1 && snapshot.docs[0].id === excludeStudentId) return true;
    return false;
  } catch (err) {
    handleError(err, 'Failed to check admission number uniqueness.');
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// IMAGE COMPRESSION
// ───────────────────────────────────────────────────────────────────────────────
async function compressAndResizeImage(file, maxSizeKB = 800, targetWidth = 100, targetHeight = 100) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject('Invalid file type. Please upload an image.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width, height = img.height;
        if (width > height) {
          if (width > targetWidth) { height = (height * targetWidth) / width; width = targetWidth; }
        } else {
          if (height > targetHeight) { width = (width * targetHeight) / height; height = targetHeight; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        let quality = 0.7;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length > maxSizeKB * 1024 && quality > 0.1) {
          quality -= 0.1;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        if (dataUrl.length > maxSizeKB * 1024) {
          reject(`Image too large after compression (${(dataUrl.length / 1024).toFixed(1)}KB). Please upload a smaller image.`);
        } else {
          resolve(dataUrl);
        }
      };
      img.onerror = () => reject('Failed to load image');
      img.src = e.target.result;
    };
    reader.onerror = () => reject('File reading error');
    reader.readAsDataURL(file);
  });
}

async function handlePassportUpload(e) {
  if (!passportErrorSpan || !passportPreviewContainer || !passportInput) return;
  const file = e.target.files[0];
  passportErrorSpan.style.display = 'none';
  passportPreviewContainer.innerHTML = '';
  if (!file) return;

  if (file.size > 800 * 1024) {
    passportErrorSpan.textContent = 'File size exceeds 800KB. Please choose a smaller image.';
    passportErrorSpan.style.display = 'block';
    passportInput.value = '';
    return;
  }

  try {
    const base64 = await compressAndResizeImage(file, 800, 100, 100);
    passportInput.dataset.base64 = base64;
    const imgEl = document.createElement('img');
    imgEl.src = base64;
    imgEl.className = 'passport-preview';
    imgEl.alt = 'Passport Preview';
    passportPreviewContainer.appendChild(imgEl);
  } catch (err) {
    passportErrorSpan.textContent = err;
    passportErrorSpan.style.display = 'block';
    passportInput.value = '';
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// STUDENT LIST DISPLAY (with alphabetical sorting by name)
// ───────────────────────────────────────────────────────────────────────────────
async function loadAndDisplayStudents() {
  const studentsRef = collection(db, 'students');
  let studentsQuery;

  if (currentFilter === 'all') {
    studentsQuery = query(studentsRef, where('schoolId', '==', currentSchoolId), where('status', '==', 'active'));
  } else {
    let classId = null;
    for (const [id, data] of classesMap.entries()) {
      if (data.name === currentFilter) { classId = id; break; }
    }
    if (!classId) {
      const container = document.getElementById('studentsList');
      if (container) container.innerHTML = '<p>No students found for this class.</p>';
      return;
    }
    studentsQuery = query(
      studentsRef,
      where('schoolId', '==', currentSchoolId),
      where('classId', '==', classId),
      where('status', '==', 'active')
    );
  }

  let snapshot;
  try {
    snapshot = await getDocs(studentsQuery);
  } catch (err) {
    handleError(err, 'Failed to load students.');
    return;
  }
  let students = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  // ✅ Sort students alphabetically by full name
  students.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const container = document.getElementById('studentsList');
  if (!container) return;

  if (students.length === 0) {
    container.innerHTML = `<p>No active students found${currentFilter !== 'all' ? ` in ${currentFilter}` : ''}.</p>`;
    return;
  }

  container.innerHTML = `
    <div class="table-responsive-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>Photo</th>
            <th>Admission No</th>
            <th>Name</th>
            <th>Email</th>
            <th>Class</th>
            <th>Status</th>
            <th>Locked</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${students.map(student => {
            const className   = classesMap.get(student.classId)?.name ?? 'Unknown';
            const passportSrc = student.passport || '';
            return `
              <tr>
                <td>
                  ${passportSrc
                    ? `<img src="${passportSrc}" class="student-passport" alt="passport"
                            style="width:40px;height:40px;object-fit:cover;border-radius:50%;">`
                    : '<div class="student-passport" style="width:40px;height:40px;background:#e2e8f0;border-radius:50%;"></div>'}
                 </td>
                 <td>${escapeHtml(student.admissionNumber || '—')}</td>
                 <td>${escapeHtml(student.name)}</td>
                 <td>${escapeHtml(student.email)}</td>
                 <td>${escapeHtml(className)}</td>
                 <td>
                  <select class="status-select" data-id="${student.id}" data-current="${student.status || 'active'}">
                    <option value="active"    ${(student.status || 'active') === 'active'    ? 'selected' : ''}>Active</option>
                    <option value="inactive"  ${student.status === 'inactive'  ? 'selected' : ''}>Inactive</option>
                    <option value="graduated" ${student.status === 'graduated' ? 'selected' : ''}>Graduated</option>
                  </select>
                 </td>
                 <td>${student.locked ? 'Yes' : 'No'}</td>
                 <td>
                  <button class="btn-secondary" onclick="window.editStudent('${student.id}')">Edit</button>
                  <button class="btn-danger"    onclick="window.deleteStudent('${student.id}')">Delete</button>
                 </td>
               </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.querySelectorAll('.status-select').forEach(select => {
    select.addEventListener('change', async () => {
      const studentId = select.getAttribute('data-id');
      const newStatus = select.value;
      const studentDoc = await getDoc(doc(db, 'students', studentId));
      const className  = classesMap.get(studentDoc.data().classId)?.name ?? '';

      if (newStatus === 'graduated') {
        if (!['Primary 6', 'JSS 3', 'SSS 3'].includes(className)) {
          showNotification('Graduated status can only be set for final year classes (Primary 6, JSS 3, or SSS 3).', 'error');
          select.value = select.getAttribute('data-current');
          return;
        }
      }
      showLoader();
      try {
        await updateDoc(doc(db, 'students', studentId), { status: newStatus, updatedAt: new Date() });
        select.setAttribute('data-current', newStatus);
        await loadAndDisplayStudents();
        showNotification('Student status updated.', 'success');
      } catch (err) {
        handleError(err, 'Failed to update student status.');
      } finally {
        hideLoader();
      }
    });
  });

  window.editStudent = (id) => openModal(id);
  window.deleteStudent = async (id) => {
    if (!confirm('Delete this student? This will also remove ALL their scores and reports permanently!')) return;
    showLoader();
    try {
      await deleteDoc(doc(db, 'students', id));
      const scoresSnap = await getDocs(query(collection(db, 'scores'), where('studentId', '==', id)));
      for (const d of scoresSnap.docs) await deleteDoc(d.ref);
      const reportsSnap = await getDocs(query(collection(db, 'reports'), where('studentId', '==', id)));
      for (const d of reportsSnap.docs) await deleteDoc(d.ref);
      await loadAndDisplayStudents();
      showNotification('Student and all associated data (scores, reports) deleted successfully.', 'success');
    } catch (err) {
      handleError(err, 'Failed to delete student and related data.');
    } finally {
      hideLoader();
    }
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// MODAL OPEN / CLOSE
// ───────────────────────────────────────────────────────────────────────────────
function openModal(studentId = null) {
  editingStudentId = studentId;
  const modalTitle = document.getElementById('modalTitle');
  if (!modalTitle) return;

  studentForm.reset();
  if (passportPreviewContainer) passportPreviewContainer.innerHTML = '';
  if (passportErrorSpan)        passportErrorSpan.style.display = 'none';
  if (passportInput)            passportInput.dataset.base64 = '';
  if (ageDisplay)               ageDisplay.textContent = '-';
  if (genderSelect)             genderSelect.value = '';
  if (dobInput)                 dobInput.value = '';
  if (clubInput)                clubInput.value = '';
  if (admissionNoInput)         admissionNoInput.value = '';
  if (levelSelect)              levelSelect.value = '';

  if (classSelect) {
    classSelect.innerHTML = '<option value="">-- Select level first --</option>';
    classSelect.disabled = true;
  }
  if (subjectsSelect) {
    subjectsSelect.innerHTML = '<option value="">-- Select level first --</option>';
    subjectsSelect.disabled = true;
  }

  if (studentId) {
    modalTitle.textContent = 'Edit Student';
    loadStudentData(studentId);
  } else {
    modalTitle.textContent = 'Add Student';
    if (statusSelect) statusSelect.value = 'active';
  }
  if (modal) modal.style.display = 'flex';
}

async function loadStudentData(studentId) {
  try {
    const studentDoc = await getDoc(doc(db, 'students', studentId));
    if (!studentDoc.exists()) return;
    const data = studentDoc.data();

    if (admissionNoInput) admissionNoInput.value = data.admissionNumber || '';
    const nameParts = (data.name || '').split(' ');
    if (surnameInput)   surnameInput.value   = nameParts[0] || '';
    if (firstNameInput) firstNameInput.value = nameParts[1] || '';
    if (otherNameInput) otherNameInput.value = nameParts.slice(2).join(' ') || '';
    if (emailInput)     emailInput.value     = data.email || '';

    const studentLevel = data.level || 'secondary';
    if (levelSelect) levelSelect.value = studentLevel;

    if (studentLevel) {
      await loadClassesByLevel(studentLevel);
      await loadSubjectsByLevel(studentLevel);
      if (classSelect)   classSelect.disabled   = false;
      if (subjectsSelect) subjectsSelect.disabled = false;
      if (classSelect && data.classId) classSelect.value = data.classId;
      const subjectIds = data.subjects || [];
      if (subjectsSelect) {
        Array.from(subjectsSelect.options).forEach(opt => {
          opt.selected = subjectIds.includes(opt.value);
        });
      }
    }

    if (statusSelect) statusSelect.value = data.status || 'active';
    if (genderSelect) genderSelect.value = data.gender || '';
    if (dobInput)     dobInput.value     = data.dob || '';
    if (clubInput)    clubInput.value    = data.club || '';
    if (data.dob)     calculateAndDisplayAge();

    if (data.passport && passportPreviewContainer) {
      const imgEl = document.createElement('img');
      imgEl.src = data.passport;
      imgEl.className = 'passport-preview';
      imgEl.alt = 'Passport';
      passportPreviewContainer.appendChild(imgEl);
      if (passportInput) passportInput.dataset.base64 = data.passport;
    }
  } catch (err) {
    handleError(err, 'Failed to load student data.');
  }
}

function closeModal() {
  if (modal) modal.style.display = 'none';
  editingStudentId = null;
  studentForm.reset();
  if (passportPreviewContainer) passportPreviewContainer.innerHTML = '';
  if (passportInput)            passportInput.dataset.base64 = '';
}

// ───────────────────────────────────────────────────────────────────────────────
// FORM SUBMIT — CREATE / UPDATE STUDENT (with Auth account creation)
// ───────────────────────────────────────────────────────────────────────────────
async function handleStudentSubmit(e) {
  e.preventDefault();

  let admissionNumber = admissionNoInput?.value.trim() ?? '';
  const surname   = capitalizeWords(surnameInput?.value   ?? '');
  const firstName = capitalizeWords(firstNameInput?.value ?? '');
  const otherName = capitalizeWords(otherNameInput?.value ?? '');
  const fullName  = formatFullName(surname, firstName, otherName);
  const email     = emailInput?.value.trim() ?? '';
  const level     = levelSelect?.value ?? '';
  const classId   = classSelect?.value ?? '';
  const selectedSubjects = Array.from(subjectsSelect?.selectedOptions ?? []).map(o => o.value);
  const status  = statusSelect?.value ?? 'active';
  const gender  = genderSelect?.value ?? '';
  const dob     = dobInput?.value ?? '';
  const club    = clubInput?.value.trim() || null;
  const passport = passportInput?.dataset.base64 || null;

  if (!surname || !firstName || !email || !classId || !gender || !dob || !level) {
    showNotification('Please fill in all required fields (Surname, First Name, Email, Level, Class, Gender, Date of Birth).', 'error');
    return;
  }
  const age = calculateAge(dob);
  if (age === null || age < 0 || age > 100) {
    showNotification('Please enter a valid date of birth.', 'error');
    return;
  }
  if (!admissionNumber) admissionNumber = await generateAdmissionNumber();
  const isUnique = await isAdmissionNumberUnique(admissionNumber, editingStudentId);
  if (!isUnique) {
    showNotification(`Admission number "${admissionNumber}" already exists. Please use a different one.`, 'error');
    return;
  }

  let lockedValue = false;
  if (!editingStudentId) {
    const isRawActive = await isRawSubscriptionActive(currentSchoolId);
    lockedValue = isRawActive ? true : false;
  }

  const timestamp = new Date();
  const studentBaseData = {
    admissionNumber,
    surname,
    firstName,
    otherName: otherName || null,
    name: fullName,
    email,
    level,
    classId,
    subjects: selectedSubjects,
    status,
    gender,
    dob,
    club: club || null,
    passport: passport || null,
    schoolId: currentSchoolId,
    updatedAt: timestamp,
    subscriptionCovered: false,
  };
  if (!editingStudentId) {
    studentBaseData.locked = lockedValue;
    studentBaseData.createdAt = timestamp;
  }

  showLoader();
  try {
    if (editingStudentId) {
      delete studentBaseData.locked;
      await updateDoc(doc(db, 'students', editingStudentId), studentBaseData);
      showNotification('Student updated successfully.', 'success');
      closeModal();
      await loadAndDisplayStudents();
      return;
    }

    const secondaryAuthInstance = getSecondaryAuth();
    const defaultPassword = '$Acadex123';
    let userCredential;
    try {
      userCredential = await createUserWithEmailAndPassword(secondaryAuthInstance, email, defaultPassword);
    } catch (authError) {
      console.error('Student Auth creation error:', authError);
      if (authError.code === 'auth/email-already-in-use') {
        showNotification('A user with this email already exists. Please use a different email.', 'error');
      } else {
        showNotification('Failed to create login account: ' + authError.message, 'error');
      }
      return;
    }

    const uid = userCredential.user.uid;
    const studentDocData = { ...studentBaseData, uid: uid };
    await setDoc(doc(db, 'students', uid), studentDocData);

    const userDocData = {
      uid: uid,
      email: email,
      role: 'student',
      schoolId: currentSchoolId,
      fullName: fullName,
      studentId: uid,
      classId: classId,
      level: level,
      createdAt: serverTimestamp(),
    };
    await setDoc(doc(db, 'users', uid), userDocData);

    await handleNewStudentAddition(currentSchoolId, 1);
    showCredentialsModal(fullName, email, defaultPassword);

    closeModal();
    await loadAndDisplayStudents();

  } catch (error) {
    handleError(error, 'Failed to save student.');
  } finally {
    hideLoader();
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// SUBSCRIPTION PAYMENT BANNER
// ───────────────────────────────────────────────────────────────────────────────
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
  document.getElementById('paymentBanner')?.remove();

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
      <a id="whatsappLink"
         href="https://wa.me/2349044784225?text=Hello%20Acadex%2C%20I%20want%20to%20renew%20my%20subscription"
         target="_blank" class="whatsapp-btn">
        <svg class="whatsapp-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
             width="18" height="18" fill="currentColor">
          <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-5.46-4.45-9.91-9.91-9.91zm0 2c4.4 0 7.91 3.51 7.91 7.91 0 4.4-3.51 7.91-7.91 7.91-1.43 0-2.78-.38-3.97-1.07l-.6-.34-3.11.82.83-3.04-.34-.6c-.7-1.2-1.07-2.55-1.07-3.97 0-4.4 3.51-7.91 7.91-7.91zM8.53 7.5c-.18 0-.48.07-.73.33-.26.26-.95.93-.95 2.28 0 1.35.98 2.66 1.12 2.84.14.18 1.88 2.98 4.56 4.07.64.26 1.14.42 1.53.54.64.2 1.22.17 1.68.1.51-.08 1.57-.64 1.79-1.26.22-.62.22-1.15.15-1.26-.07-.11-.26-.18-.55-.31-.29-.13-1.7-.84-1.96-.94-.26-.1-.45-.15-.64.15-.19.3-.73.94-.9 1.13-.17.19-.34.21-.63.07-.29-.13-1.22-.45-2.32-1.43-.86-.76-1.44-1.7-1.61-1.99-.17-.29-.02-.45.13-.59.13-.13.29-.34.44-.51.14-.17.19-.29.29-.48.1-.19.05-.36-.03-.51-.08-.15-.64-1.54-.88-2.11-.23-.56-.46-.48-.64-.49h-.55z"/>
        </svg>
        09044784225 (WhatsApp)
      </a>
    </div>
  `;
  container.appendChild(banner);

  document.getElementById('paystackPaymentBtn')?.addEventListener('click', () => {
    window.open('https://paystack.shop/pay/fmj267paou', '_blank');
  });
}

function hidePaymentBanner() {
  document.getElementById('paymentBanner')?.remove();
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
    if (!snap.exists()) { showPaymentBanner(); return; }
    const sub = snap.data();
    if (sub.status === 'active' && sub.locked === false) {
      hidePaymentBanner();
    } else {
      showPaymentBanner();
    }
  }, (err) => handleError(err, 'Subscription listener error.'));
}