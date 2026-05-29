// onboard-student.js - Teacher onboards students only for his/her assigned class
// STRICT: Only teachers with a host classId can use this page.
// Duplicate name prevention, Firestore students collection, subscription lock.
// All Firestore reads/writes go through service.js where possible.
// TODO: service.js does not yet support student status updates, bulk deletion of scores/reports,
// or auth account creation – these remain as direct Firestore/auth calls.

import { auth } from './firebase-config.js';
import { getAuth, createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { firebaseConfig } from './firebase-config.js';
import {
  collection,
  deleteDoc,
  doc,
  updateDoc,
  query,
  where,
  getDocs,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { db } from './firebase-config.js';
import * as service from './service.js';
import { getRawSubscription } from './plan.js';  // plan.js is separate – keep as is
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

// Global state
let currentSchoolId = null;
let teacherClassId = null;
let className = '';
let classLevel = '';
let subjectsMap = new Map();
let editingStudentId = null;
let schoolName = '';
let isClassTeacher = false;

// DOM elements
let studentForm, modal, admissionNoInput;
let surnameInput, firstNameInput, otherNameInput;
let emailInput, levelDisplay, levelHidden, classDisplay, classHidden;
let subjectsSelect, statusSelect, genderSelect, dobInput, ageDisplay, clubInput;
let passportInput, passportPreviewContainer, passportErrorSpan;
let nationalitySelect, stateSelect, religionSelect, parentPhoneInput;
let addStudentBtn, studentsContainer, classInfoContainer;

// Secondary Firebase app (for student account creation)
let secondaryAuth = null;
function getSecondaryAuth() {
  if (!secondaryAuth) {
    const secondaryApp = initializeApp(firebaseConfig, 'secondaryStudent');
    secondaryAuth = getAuth(secondaryApp);
  }
  return secondaryAuth;
}

// Nigerian states & countries
const NIGERIAN_STATES = [
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno",
  "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu", "Gombe", "Imo", "Jigawa",
  "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger",
  "Ogun", "Ondo", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara",
  "FCT Abuja"
];
const COUNTRIES = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia",
  "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium",
  "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria",
  "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia", "Cameroon", "Canada", "Central African Republic", "Chad",
  "Chile", "China", "Colombia", "Comoros", "Congo", "Costa Rica", "Côte d'Ivoire", "Croatia", "Cuba", "Cyprus",
  "Czech Republic", "Denmark", "Djibouti", "Dominica", "Dominican Republic", "Ecuador", "Egypt", "El Salvador",
  "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji", "Finland", "France", "Gabon", "Gambia",
  "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana", "Haiti",
  "Honduras", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Jamaica",
  "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon",
  "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar", "Malawi", "Malaysia",
  "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova",
  "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal", "Netherlands",
  "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan",
  "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal",
  "Qatar", "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines",
  "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone",
  "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea", "South Sudan",
  "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania",
  "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu",
  "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu",
  "Vatican City", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe"
];

// Helper functions
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
  return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}
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

/**
 * Verify teacher is a class teacher using service.
 * Looks for classId OR hostClassId field on teacher doc.
 */
async function verifyAndGetClassTeacherData() {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');

  const teacherData = await service.getTeacherById(user.uid);
  if (!teacherData) throw new Error('Teacher record not found');

  currentSchoolId = teacherData.schoolId;

  // Try both possible field names
  teacherClassId = teacherData.classId || teacherData.hostClassId || null;

  if (!teacherClassId) {
    throw new Error('You are not assigned as a class teacher. Access to onboard students is restricted.');
  }

  // Fetch class details via service
  const classData = await service.getClassById(teacherClassId);
  if (!classData) throw new Error('Assigned class not found.');
  className = classData.name;
  classLevel = classData.level;

  // Get school name for admission number
  const schoolData = await service.getSchoolById(currentSchoolId);
  if (schoolData) schoolName = schoolData.name || '';

  isClassTeacher = true;
  return { classId: teacherClassId, className, classLevel, schoolId: currentSchoolId };
}

// Load subjects for the class level via service
async function loadSubjectsByLevel(level) {
  if (!level) return;
  try {
    const subjects = await service.getSubjectsByLevel(currentSchoolId, level);
    subjectsMap.clear();
    subjects.forEach(sub => {
      subjectsMap.set(sub.id, { name: sub.name });
    });
    if (subjectsSelect) {
      subjectsSelect.innerHTML = '';
      if (subjectsMap.size === 0) {
        const opt = document.createElement('option');
        opt.disabled = true;
        opt.textContent = 'No subjects available for this level';
        subjectsSelect.appendChild(opt);
        subjectsSelect.disabled = true;
      } else {
        subjectsMap.forEach((sub, id) => {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = sub.name;
          subjectsSelect.appendChild(opt);
        });
        subjectsSelect.disabled = false;
      }
    }
  } catch (err) {
    handleError(err, 'Failed to load subjects');
  }
}

// Admission number helpers (use service to get all students for the school)
function getSchoolCode() {
  if (!schoolName) return 'XX';
  return schoolName.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 2);
}
async function getNextSequenceNumber() {
  try {
    const allStudents = await service.getStudentsBySchool(currentSchoolId);
    const schoolCode = getSchoolCode();
    const currentYear = new Date().getFullYear();
    const pattern = new RegExp(`^${schoolCode}/${currentYear}/0*(\\d+)$`);
    let maxSeq = 0;
    allStudents.forEach(student => {
      const no = student.admissionNumber;
      const match = no?.match(pattern);
      if (match) {
        const seq = parseInt(match[1], 10);
        if (seq > maxSeq) maxSeq = seq;
      }
    });
    return maxSeq + 1;
  } catch (err) {
    return 1;
  }
}
async function generateAdmissionNumber() {
  const schoolCode = getSchoolCode();
  const currentYear = new Date().getFullYear();
  const nextSeq = await getNextSequenceNumber();
  return `${schoolCode}/${currentYear}/${String(nextSeq).padStart(3, '0')}`;
}
async function isAdmissionNumberUnique(admissionNo, excludeStudentId = null) {
  const allStudents = await service.getStudentsBySchool(currentSchoolId);
  const duplicate = allStudents.find(s => s.admissionNumber === admissionNo && s.id !== excludeStudentId);
  return !duplicate;
}

// Duplicate name check within the same class using service
async function isDuplicateStudentName(fullName, classId, excludeStudentId = null) {
  const normalizedName = fullName.trim().toLowerCase();
  const classStudents = await service.getStudentsByClass(currentSchoolId, classId);
  return classStudents.some(s => s.id !== excludeStudentId && (s.name || '').toLowerCase() === normalizedName);
}

// Image compression (unchanged, not Firestore related)
async function compressAndResizeImage(file, maxSizeKB = 750, targetWidth = 100, targetHeight = 100) {
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
  const file = e.target.files[0];
  if (passportErrorSpan) passportErrorSpan.style.display = 'none';
  if (passportPreviewContainer) passportPreviewContainer.innerHTML = '';
  if (!file) return;
  if (file.size > 800 * 1024) {
    if (passportErrorSpan) {
      passportErrorSpan.textContent = 'File size exceeds 800KB. Please choose a smaller image.';
      passportErrorSpan.style.display = 'block';
    }
    passportInput.value = '';
    return;
  }
  try {
    const base64 = await compressAndResizeImage(file, 750, 100, 100);
    passportInput.dataset.base64 = base64;
    const imgEl = document.createElement('img');
    imgEl.src = base64;
    imgEl.className = 'passport-preview';
    imgEl.alt = 'Passport Preview';
    passportPreviewContainer.appendChild(imgEl);
  } catch (err) {
    if (passportErrorSpan) {
      passportErrorSpan.textContent = err;
      passportErrorSpan.style.display = 'block';
    }
    passportInput.value = '';
  }
}

// Load and display students for the teacher's class only (using service)
async function loadAndDisplayStudents() {
  if (!teacherClassId || !isClassTeacher) return;
  let students;
  try {
    // Get all students for the school, then filter by class and active status
    const allStudents = await service.getStudentsBySchool(currentSchoolId);
    students = allStudents.filter(s => s.classId === teacherClassId && s.status === 'active');
    students.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } catch (err) {
    handleError(err, 'Failed to load students');
    return;
  }
  if (!studentsContainer) return;
  if (students.length === 0) {
    studentsContainer.innerHTML = '<p>No active students found in your class.</p>';
    return;
  }
  studentsContainer.innerHTML = `
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
          ${students.map(student => `
            <tr>
              <td>${student.passport ? `<img src="${student.passport}" class="student-passport" style="width:40px;height:40px;object-fit:cover;border-radius:50%;">` : '<div class="student-passport" style="width:40px;height:40px;background:#e2e8f0;border-radius:50%;"></div>'}</td>
              <td>${escapeHtml(student.admissionNumber || '—')}</td>
              <td>${escapeHtml(student.name)}</td>
              <td>${escapeHtml(student.email)}</td>
              <td>${escapeHtml(className)}</td>
              <td><select class="status-select" data-id="${student.id}" data-current="${student.status || 'active'}">
                <option value="active" ${(student.status || 'active') === 'active' ? 'selected' : ''}>Active</option>
                <option value="inactive" ${student.status === 'inactive' ? 'selected' : ''}>Inactive</option>
                <option value="graduated" ${student.status === 'graduated' ? 'selected' : ''}>Graduated</option>
              </select></td>
              <td>${student.locked ? 'Yes' : 'No'}</td>
              <td><button class="btn-secondary" onclick="window.editStudent('${student.id}')">Edit</button>
                  <button class="btn-danger" onclick="window.deleteStudent('${student.id}')">Delete</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  // Status change listeners (direct Firestore update – TODO: add to service)
  document.querySelectorAll('.status-select').forEach(select => {
    select.addEventListener('change', async () => {
      const studentId = select.getAttribute('data-id');
      const newStatus = select.value;
      showLoader();
      try {
        // TODO: Add service.updateStudentStatus(studentId, newStatus) to service layer
        await updateDoc(doc(db, 'students', studentId), { status: newStatus, updatedAt: new Date() });
        select.setAttribute('data-current', newStatus);
        await loadAndDisplayStudents();
        showNotification('Student status updated.', 'success');
      } catch (err) {
        handleError(err, 'Failed to update status');
      } finally {
        hideLoader();
      }
    });
  });
  window.editStudent = (id) => openModal(id);
  window.deleteStudent = async (id) => {
    if (!confirm('Delete this student permanently? All scores and reports will be removed.')) return;
    showLoader();
    try {
      // Use service.deleteStudent (deletes the student doc and invalidates cache)
      await service.deleteStudent(id);
      // TODO: service.deleteStudent should also delete scores/reports, but currently doesn't.
      // Manually delete scores and reports – direct Firestore calls
      const scoresSnap = await getDocs(query(collection(db, 'scores'), where('studentId', '==', id)));
      for (const d of scoresSnap.docs) await deleteDoc(d.ref);
      const reportsSnap = await getDocs(query(collection(db, 'reports'), where('studentId', '==', id)));
      for (const d of reportsSnap.docs) await deleteDoc(d.ref);
      await loadAndDisplayStudents();
      showNotification('Student and related data deleted.', 'success');
    } catch (err) {
      handleError(err, 'Deletion failed');
    } finally {
      hideLoader();
    }
  };
}

// Modal logic (unchanged, uses service for loading student data)
function openModal(studentId = null) {
  if (!isClassTeacher) {
    showNotification('Access denied: You are not a class teacher.', 'error');
    return;
  }
  editingStudentId = studentId;
  const modalTitle = document.getElementById('modalTitle');
  if (!modalTitle) return;
  studentForm.reset();
  if (passportPreviewContainer) passportPreviewContainer.innerHTML = '';
  if (passportErrorSpan) passportErrorSpan.style.display = 'none';
  if (passportInput) passportInput.dataset.base64 = '';
  if (ageDisplay) ageDisplay.textContent = '-';
  if (admissionNoInput) admissionNoInput.value = '';
  if (nationalitySelect) nationalitySelect.value = '';
  if (stateSelect) stateSelect.value = '';
  if (religionSelect) religionSelect.value = '';
  if (parentPhoneInput) parentPhoneInput.value = '';
  if (clubInput) clubInput.value = '';
  // Prefill fixed class & level
  if (levelDisplay) levelDisplay.value = classLevel ? classLevel.charAt(0).toUpperCase() + classLevel.slice(1) : '';
  if (levelHidden) levelHidden.value = classLevel;
  if (classDisplay) classDisplay.value = className;
  if (classHidden) classHidden.value = teacherClassId;
  if (classLevel) loadSubjectsByLevel(classLevel);
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
    const studentData = await service.getStudentById(studentId);
    if (!studentData) return;
    if (admissionNoInput) admissionNoInput.value = studentData.admissionNumber || '';
    const nameParts = (studentData.name || '').split(' ');
    if (surnameInput) surnameInput.value = nameParts[0] || '';
    if (firstNameInput) firstNameInput.value = nameParts[1] || '';
    if (otherNameInput) otherNameInput.value = nameParts.slice(2).join(' ') || '';
    if (emailInput) emailInput.value = studentData.email || '';
    if (statusSelect) statusSelect.value = studentData.status || 'active';
    if (genderSelect) genderSelect.value = studentData.gender || '';
    if (dobInput) dobInput.value = studentData.dob || '';
    if (clubInput) clubInput.value = studentData.club || '';
    if (studentData.dob) calculateAndDisplayAge();
    if (nationalitySelect) nationalitySelect.value = studentData.nationality || '';
    if (stateSelect) stateSelect.value = studentData.state || '';
    if (religionSelect) religionSelect.value = studentData.religion || '';
    if (parentPhoneInput) parentPhoneInput.value = studentData.parentPhone || '';
    const subjectIds = studentData.subjects || [];
    if (subjectsSelect) {
      Array.from(subjectsSelect.options).forEach(opt => {
        opt.selected = subjectIds.includes(opt.value);
      });
    }
    if (studentData.passport && passportPreviewContainer) {
      const imgEl = document.createElement('img');
      imgEl.src = studentData.passport;
      imgEl.className = 'passport-preview';
      passportPreviewContainer.appendChild(imgEl);
      if (passportInput) passportInput.dataset.base64 = studentData.passport;
    }
  } catch (err) {
    handleError(err, 'Failed to load student data');
  }
}
function closeModal() {
  if (modal) modal.style.display = 'none';
  editingStudentId = null;
  studentForm.reset();
  if (passportPreviewContainer) passportPreviewContainer.innerHTML = '';
  if (passportInput) passportInput.dataset.base64 = '';
}

// Save / Update student (with duplicate prevention) – uses service.createStudent/updateStudent
async function handleStudentSubmit(e) {
  e.preventDefault();
  if (!isClassTeacher) {
    showNotification('Access denied: You are not a class teacher.', 'error');
    return;
  }
  let admissionNumber = admissionNoInput?.value.trim() ?? '';
  const surname = capitalizeWords(surnameInput?.value ?? '');
  const firstName = capitalizeWords(firstNameInput?.value ?? '');
  const otherName = capitalizeWords(otherNameInput?.value ?? '');
  const fullName = formatFullName(surname, firstName, otherName);
  const email = emailInput?.value.trim() ?? '';
  const classId = teacherClassId;
  const level = classLevel;
  const selectedSubjects = Array.from(subjectsSelect?.selectedOptions ?? []).map(o => o.value);
  const status = statusSelect?.value ?? 'active';
  const gender = genderSelect?.value ?? '';
  const dob = dobInput?.value ?? '';
  const club = clubInput?.value.trim() || null;
  const passport = passportInput?.dataset.base64 || null;
  const nationality = nationalitySelect?.value ?? '';
  const state = stateSelect?.value ?? '';
  const religion = religionSelect?.value ?? '';
  const parentPhone = parentPhoneInput?.value.trim() ?? '';

  if (!surname || !firstName || !email || !gender || !dob || !nationality || !state || !religion || !parentPhone) {
    showNotification('Please fill all required fields (*).', 'error');
    return;
  }
  const age = calculateAge(dob);
  if (age === null || age < 0 || age > 100) {
    showNotification('Invalid date of birth', 'error');
    return;
  }
  // Duplicate name check
  const isDuplicate = await isDuplicateStudentName(fullName, classId, editingStudentId);
  if (isDuplicate) {
    showNotification(`A student with name "${fullName}" already exists in this class. Duplicate names are not allowed.`, 'error');
    return;
  }
  if (!admissionNumber) admissionNumber = await generateAdmissionNumber();
  const isUniqueAdm = await isAdmissionNumberUnique(admissionNumber, editingStudentId);
  if (!isUniqueAdm) {
    showNotification(`Admission number "${admissionNumber}" already exists.`, 'error');
    return;
  }

  let lockedValue = false;
  if (!editingStudentId) {
    const isRawActive = await getRawSubscription(currentSchoolId);
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
    nationality,
    state,
    religion,
    parentPhone
  };
  if (!editingStudentId) {
    studentBaseData.locked = lockedValue;
    studentBaseData.createdAt = timestamp;
  }

  showLoader();
  try {
    if (editingStudentId) {
      delete studentBaseData.locked;
      await service.updateStudent(editingStudentId, studentBaseData);
      showNotification('Student updated successfully.', 'success');
      closeModal();
      await loadAndDisplayStudents();
      return;
    }
    // Create auth account for new student (direct Firebase Auth – not in service)
    const secondaryAuthInstance = getSecondaryAuth();
    const defaultPassword = '$Acadex123';
    let userCredential;
    try {
      userCredential = await createUserWithEmailAndPassword(secondaryAuthInstance, email, defaultPassword);
    } catch (authError) {
      if (authError.code === 'auth/email-already-in-use') {
        showNotification('A user with this email already exists. Use a different email.', 'error');
      } else {
        showNotification('Failed to create login account: ' + authError.message, 'error');
      }
      return;
    }
    const uid = userCredential.user.uid;
    const studentDocData = { ...studentBaseData, uid: uid };
    // TODO: service.createStudent does not accept uid override – use direct setDoc for now
    const { setDoc, doc: fDoc } = await import('https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js');
    await setDoc(fDoc(db, 'students', uid), studentDocData);
    // Also create user doc (not in service)
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
    await setDoc(fDoc(db, 'users', uid), userDocData);
    showCredentialsModal(fullName, email, defaultPassword);
    closeModal();
    await loadAndDisplayStudents();
  } catch (error) {
    handleError(error, 'Failed to save student.');
  } finally {
    hideLoader();
  }
}

function showCredentialsModal(fullName, email, tempPassword) {
  document.getElementById('credentialsModal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'credentialsModal';
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;`;
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.18);">
      <h3 style="margin:0 0 6px;font-size:1.1rem;">✅ Student Account Created</h3>
      <p style="margin:0 0 18px;color:#64748b;">Share credentials with <strong>${escapeHtml(fullName)}</strong>. Change password on first login.</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin-bottom:18px;">
        <div><span style="color:#64748b;">Email:</span> <strong>${escapeHtml(email)}</strong></div>
        <div style="margin-top:8px;"><span style="color:#64748b;">Temp Password:</span> <strong>${escapeHtml(tempPassword)}</strong></div>
      </div>
      <p style="color:#ef4444;font-size:.82rem;">⚠️ Copy now, it won't be shown again.</p>
      <div style="display:flex;gap:10px;">
        <button id="copyCredsBtn" style="flex:1;padding:9px;background:#0ea5e9;color:#fff;border:none;border-radius:8px;cursor:pointer;">📋 Copy</button>
        <button id="closeCredsBtn" style="flex:1;padding:9px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('copyCredsBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(`Email: ${email}\nPassword: ${tempPassword}`).then(() => showNotification('Copied', 'success'));
  });
  document.getElementById('closeCredsBtn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// Show a blocking error message when teacher is not a class teacher
function showAccessDenied(message) {
  if (classInfoContainer) {
    classInfoContainer.innerHTML = `<div style="background:#fee2e2; border-left:5px solid #dc2626; padding:15px; border-radius:12px; color:#991b1b;">
      <i class="fa-solid fa-ban" style="margin-right:8px;"></i> ${escapeHtml(message)}
    </div>`;
  }
  if (addStudentBtn) {
    addStudentBtn.disabled = true;
    addStudentBtn.style.opacity = '0.6';
    addStudentBtn.style.cursor = 'not-allowed';
    addStudentBtn.title = 'Only class teachers can onboard students';
  }
  if (studentsContainer) {
    studentsContainer.innerHTML = '<p style="color:#b91c1c;">⛔ Access restricted. You are not a class teacher.</p>';
  }
}

// Main initializer with strict class teacher verification
export async function initOnboardStudentPage() {
  try {
    // STEP 1: Enforce class teacher status
    const teacherData = await verifyAndGetClassTeacherData();
    if (!teacherClassId) {
      throw new Error('No class assigned to this teacher.');
    }

    // Setup DOM references
    studentForm = document.getElementById('studentForm');
    modal = document.getElementById('studentModal');
    admissionNoInput = document.getElementById('studentAdmissionNo');
    surnameInput = document.getElementById('studentSurname');
    firstNameInput = document.getElementById('studentFirstName');
    otherNameInput = document.getElementById('studentOtherName');
    emailInput = document.getElementById('studentEmail');
    levelDisplay = document.getElementById('studentLevelDisplay');
    levelHidden = document.getElementById('studentLevelHidden');
    classDisplay = document.getElementById('studentClassDisplay');
    classHidden = document.getElementById('studentClassHidden');
    subjectsSelect = document.getElementById('studentSubjects');
    statusSelect = document.getElementById('studentStatus');
    genderSelect = document.getElementById('studentGender');
    dobInput = document.getElementById('studentDob');
    ageDisplay = document.getElementById('studentAgeDisplay');
    clubInput = document.getElementById('studentClub');
    passportInput = document.getElementById('studentPassport');
    passportPreviewContainer = document.getElementById('passportPreviewContainer');
    passportErrorSpan = document.getElementById('passportError');
    nationalitySelect = document.getElementById('studentNationality');
    stateSelect = document.getElementById('studentState');
    religionSelect = document.getElementById('studentReligion');
    parentPhoneInput = document.getElementById('studentParentPhone');
    addStudentBtn = document.getElementById('addStudentBtn');
    studentsContainer = document.getElementById('studentsList');
    classInfoContainer = document.getElementById('classInfoContainer');

    // Populate nationality & state dropdowns
    if (nationalitySelect) {
      nationalitySelect.innerHTML = '<option value="">-- Select Country --</option>';
      COUNTRIES.forEach(c => { const opt = document.createElement('option'); opt.value = c; opt.textContent = c; nationalitySelect.appendChild(opt); });
    }
    if (stateSelect) {
      stateSelect.innerHTML = '<option value="">-- Select State --</option>';
      NIGERIAN_STATES.forEach(s => { const opt = document.createElement('option'); opt.value = s; opt.textContent = s; stateSelect.appendChild(opt); });
    }

    // Display class info banner
    if (classInfoContainer) {
      classInfoContainer.innerHTML = `<i class="fa-solid fa-chalkboard"></i> Your Class: <strong>${escapeHtml(className)}</strong> (${classLevel.charAt(0).toUpperCase() + classLevel.slice(1)})`;
    }

    await loadSubjectsByLevel(classLevel);
    await loadAndDisplayStudents();

    // Attach event listeners only when teacher is authorized
    if (addStudentBtn) addStudentBtn.addEventListener('click', () => openModal());
    document.querySelector('#studentModal .close-modal')?.addEventListener('click', closeModal);
    document.getElementById('cancelModalBtn')?.addEventListener('click', closeModal);
    if (studentForm) studentForm.addEventListener('submit', handleStudentSubmit);
    if (dobInput) dobInput.addEventListener('change', calculateAndDisplayAge);
    if (passportInput) passportInput.addEventListener('change', handlePassportUpload);
  } catch (err) {
    console.error('Onboard init error:', err);
    showAccessDenied(err.message || 'You must be a class teacher to onboard students.');
  }
}