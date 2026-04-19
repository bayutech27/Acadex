// students.js - Manage students with subscription tracking
import { db } from './firebase-config.js';
import { 
  collection, addDoc, getDocs, deleteDoc, doc, updateDoc, query, where, getDoc
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId, protectAdminPage } from './admin.js';
import { handleNewStudentAddition } from './plan.js';

let currentSchoolId = null;
let subjectsMap = new Map();
let classesMap = new Map();
let editingStudentId = null;
let currentFilter = 'all';
let schoolName = '';

// DOM elements
let studentForm, modal, nameInput, emailInput, classSelect, subjectsSelect, statusSelect;
let genderSelect, dobInput, ageDisplay, clubInput, passportInput, passportPreviewContainer, passportErrorSpan;
let admissionNoInput;

export async function initStudentsPage() {
  // Enforce subscription and authentication
  await protectAdminPage();
  currentSchoolId = await getCurrentSchoolId();
  if (!currentSchoolId) {
    alert('School ID missing.');
    return;
  }

  // Get DOM elements
  studentForm = document.getElementById('studentForm');
  modal = document.getElementById('studentModal');
  admissionNoInput = document.getElementById('studentAdmissionNo');
  nameInput = document.getElementById('studentName');
  emailInput = document.getElementById('studentEmail');
  classSelect = document.getElementById('studentClass');
  subjectsSelect = document.getElementById('studentSubjects');
  statusSelect = document.getElementById('studentStatus');
  genderSelect = document.getElementById('studentGender');
  dobInput = document.getElementById('studentDob');
  ageDisplay = document.getElementById('studentAgeDisplay');
  clubInput = document.getElementById('studentClub');
  passportInput = document.getElementById('studentPassport');
  passportPreviewContainer = document.getElementById('passportPreviewContainer');
  passportErrorSpan = document.getElementById('passportError');

  if (!studentForm || !modal) {
    console.error('Required DOM elements not found');
    return;
  }
  
  // Fetch school name for admission number generation
  const schoolDoc = await getDoc(doc(db, 'schools', currentSchoolId));
  if (schoolDoc.exists()) {
    schoolName = schoolDoc.data().name || '';
  }
  
  await loadSubjects();
  await loadClasses();
  await loadAndDisplayStudents();

  // Event listeners
  document.getElementById('addStudentBtn').addEventListener('click', () => openModal());
  const closeBtn = document.querySelector('#studentModal .close-modal');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
  studentForm.addEventListener('submit', handleStudentSubmit);
  
  dobInput.addEventListener('change', () => calculateAndDisplayAge());
  passportInput.addEventListener('change', handlePassportUpload);

  // Filter buttons
  const filterBtns = document.querySelectorAll('.filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.getAttribute('data-class');
      loadAndDisplayStudents();
    });
  });
}

// Helper: calculate age from DOB (YYYY-MM-DD)
function calculateAge(dobString) {
  if (!dobString) return null;
  const birthDate = new Date(dobString);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

function calculateAndDisplayAge() {
  const dob = dobInput.value;
  if (dob) {
    const age = calculateAge(dob);
    ageDisplay.textContent = age !== null ? age : 'Invalid date';
  } else {
    ageDisplay.textContent = '-';
  }
}

// Admission number helpers
function getSchoolCode() {
  if (!schoolName) return 'XX';
  const letters = schoolName.replace(/[^a-zA-Z]/g, '').toUpperCase();
  return letters.substring(0, 2);
}

async function getNextSequenceNumber() {
  const studentsRef = collection(db, 'students');
  const q = query(studentsRef, where('schoolId', '==', currentSchoolId));
  const snapshot = await getDocs(q);
  const students = snapshot.docs.map(doc => doc.data());
  
  const schoolCode = getSchoolCode();
  const currentYear = new Date().getFullYear();
  const pattern = new RegExp(`^${schoolCode}/${currentYear}/0*(\\d+)$`);
  
  let maxSeq = 0;
  for (const student of students) {
    const admissionNo = student.admissionNumber;
    if (admissionNo) {
      const match = admissionNo.match(pattern);
      if (match) {
        const seq = parseInt(match[1], 10);
        if (seq > maxSeq) maxSeq = seq;
      }
    }
  }
  return maxSeq + 1;
}

async function generateAdmissionNumber() {
  const schoolCode = getSchoolCode();
  const currentYear = new Date().getFullYear();
  const nextSeq = await getNextSequenceNumber();
  const paddedSeq = String(nextSeq).padStart(3, '0');
  return `${schoolCode}/${currentYear}/${paddedSeq}`;
}

async function isAdmissionNumberUnique(admissionNo, excludeStudentId = null) {
  const studentsRef = collection(db, 'students');
  const q = query(studentsRef, where('schoolId', '==', currentSchoolId), where('admissionNumber', '==', admissionNo));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return true;
  if (excludeStudentId && snapshot.docs.length === 1 && snapshot.docs[0].id === excludeStudentId) return true;
  return false;
}

// Image compression
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
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > targetWidth) {
            height = (height * targetWidth) / width;
            width = targetWidth;
          }
        } else {
          if (height > targetHeight) {
            width = (width * targetHeight) / height;
            height = targetHeight;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
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
    const img = document.createElement('img');
    img.src = base64;
    img.className = 'passport-preview';
    img.alt = 'Passport Preview';
    passportPreviewContainer.appendChild(img);
  } catch (err) {
    passportErrorSpan.textContent = err;
    passportErrorSpan.style.display = 'block';
    passportInput.value = '';
  }
}

async function loadSubjects() {
  const subjectsRef = collection(db, 'subjects');
  const q = query(subjectsRef, where('schoolId', '==', currentSchoolId));
  const snapshot = await getDocs(q);
  subjectsMap.clear();
  snapshot.forEach(doc => {
    subjectsMap.set(doc.id, doc.data().name);
  });

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

async function loadClasses() {
  const classesRef = collection(db, 'classes');
  const q = query(classesRef, where('schoolId', '==', currentSchoolId));
  const snapshot = await getDocs(q);
  classesMap.clear();
  snapshot.forEach(doc => {
    classesMap.set(doc.id, doc.data().name);
  });

  classSelect.innerHTML = '<option value="">Select Class</option>';
  for (let [id, name] of classesMap) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = name;
    classSelect.appendChild(option);
  }
}

async function loadAndDisplayStudents() {
  let studentsQuery;
  const studentsRef = collection(db, 'students');
  
  if (currentFilter === 'all') {
    studentsQuery = query(
      studentsRef,
      where('schoolId', '==', currentSchoolId),
      where('status', '==', 'active')
    );
  } else {
    let classId = null;
    for (let [id, name] of classesMap) {
      if (name === currentFilter) {
        classId = id;
        break;
      }
    }
    if (!classId) {
      document.getElementById('studentsList').innerHTML = '<p>No students found.</p>';
      return;
    }
    studentsQuery = query(
      studentsRef,
      where('schoolId', '==', currentSchoolId),
      where('classId', '==', classId),
      where('status', '==', 'active')
    );
  }
  
  const snapshot = await getDocs(studentsQuery);
  const students = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const container = document.getElementById('studentsList');
  if (students.length === 0) {
    container.innerHTML = `<p>No active students found${currentFilter !== 'all' ? ` in ${currentFilter}` : ''}.</p>`;
    return;
  }

  container.innerHTML = `
    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Photo</th>
            <th>Admission No</th>
            <th>Name</th>
            <th>Email</th>
            <th>Class</th>
            <th>Subjects</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${students.map(student => {
            const className = classesMap.get(student.classId) || 'Unknown';
            const subjectNames = (student.subjects || [])
              .map(subjId => subjectsMap.get(subjId) || subjId)
              .join(', ');
            const passportSrc = student.passport || '';
            return `
              <tr>
                <td>
                  ${passportSrc ? `<img src="${passportSrc}" class="student-passport" alt="passport">` : '<div class="student-passport" style="background:#e2e8f0;"></div>'}
                </td>
                <td>${escapeHtml(student.admissionNumber || '—')}</td>
                <td>${escapeHtml(student.name)}</td>
                <td>${escapeHtml(student.email)}</td>
                <td>${escapeHtml(className)}</td>
                <td>${escapeHtml(subjectNames || '-')}</td>
                <td>
                  <select class="status-select" data-id="${student.id}" data-current="${student.status || 'active'}">
                    <option value="active" ${(student.status || 'active') === 'active' ? 'selected' : ''}>Active</option>
                    <option value="inactive" ${student.status === 'inactive' ? 'selected' : ''}>Inactive</option>
                    <option value="graduated" ${student.status === 'graduated' ? 'selected' : ''}>Graduated</option>
                  </select>
                </td>
                <td>
                  <button class="btn-secondary" onclick="window.editStudent('${student.id}')">Edit</button>
                  <button class="btn-danger" onclick="window.deleteStudent('${student.id}')">Delete</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.querySelectorAll('.status-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const studentId = select.getAttribute('data-id');
      const newStatus = select.value;
      const className = await getStudentClass(studentId);
      if (newStatus === 'graduated') {
        if (className !== 'JSS 3' && className !== 'SSS 3') {
          alert('Graduated status can only be set for JSS 3 or SSS 3 students.');
          select.value = select.getAttribute('data-current');
          return;
        }
      }
      await updateDoc(doc(db, 'students', studentId), { status: newStatus, updatedAt: new Date() });
      select.setAttribute('data-current', newStatus);
      await loadAndDisplayStudents();
    });
  });

  window.editStudent = (id) => openModal(id);
  window.deleteStudent = async (id) => {
    if (confirm('Delete this student? This will also remove their results!')) {
      await deleteDoc(doc(db, 'students', id));
      const resultsRef = collection(db, 'results');
      const qResults = query(resultsRef, where('studentId', '==', id));
      const resultsSnap = await getDocs(qResults);
      for (const resultDoc of resultsSnap.docs) {
        await deleteDoc(doc(db, 'results', resultDoc.id));
      }
      await loadAndDisplayStudents();
    }
  };
}

async function getStudentClass(studentId) {
  const studentDoc = await getDoc(doc(db, 'students', studentId));
  if (studentDoc.exists()) {
    const classId = studentDoc.data().classId;
    return classesMap.get(classId) || 'Unknown';
  }
  return 'Unknown';
}

function openModal(studentId = null) {
  editingStudentId = studentId;
  const modalTitle = document.getElementById('modalTitle');
  // Reset form
  studentForm.reset();
  passportPreviewContainer.innerHTML = '';
  passportErrorSpan.style.display = 'none';
  passportInput.dataset.base64 = '';
  ageDisplay.textContent = '-';
  genderSelect.value = '';
  dobInput.value = '';
  clubInput.value = '';
  admissionNoInput.value = '';   // leave empty – will generate on save
  
  if (studentId) {
    modalTitle.textContent = 'Edit Student';
    loadStudentData(studentId);
  } else {
    modalTitle.textContent = 'Add Student';
    statusSelect.value = 'active';
  }
  modal.style.display = 'flex';
}

async function loadStudentData(studentId) {
  const studentDoc = await getDoc(doc(db, 'students', studentId));
  if (studentDoc.exists()) {
    const data = studentDoc.data();
    admissionNoInput.value = data.admissionNumber || '';
    nameInput.value = data.name || '';
    emailInput.value = data.email || '';
    classSelect.value = data.classId || '';
    statusSelect.value = data.status || 'active';
    genderSelect.value = data.gender || '';
    dobInput.value = data.dob || '';
    clubInput.value = data.club || '';
    if (data.dob) calculateAndDisplayAge();
    
    const subjectIds = data.subjects || [];
    Array.from(subjectsSelect.options).forEach(opt => {
      opt.selected = subjectIds.includes(opt.value);
    });
    
    if (data.passport) {
      const img = document.createElement('img');
      img.src = data.passport;
      img.className = 'passport-preview';
      img.alt = 'Passport';
      passportPreviewContainer.appendChild(img);
      passportInput.dataset.base64 = data.passport;
    }
  }
}

function closeModal() {
  modal.style.display = 'none';
  editingStudentId = null;
  studentForm.reset();
  passportPreviewContainer.innerHTML = '';
  passportInput.dataset.base64 = '';
}

async function handleStudentSubmit(e) {
  e.preventDefault();
  
  let admissionNumber = admissionNoInput.value.trim();
  const name = nameInput.value.trim();
  const email = emailInput.value.trim();
  const classId = classSelect.value;
  const selectedSubjects = Array.from(subjectsSelect.selectedOptions).map(opt => opt.value);
  const status = statusSelect.value;
  const gender = genderSelect.value;
  const dob = dobInput.value;
  const club = clubInput.value.trim() || null;
  let passport = passportInput.dataset.base64 || null;

  // Validation
  if (!name || !email || !classId || !gender || !dob) {
    alert('Please fill in all required fields (Name, Email, Class, Gender, Date of Birth).');
    return;
  }
  const age = calculateAge(dob);
  if (age === null || age < 0 || age > 100) {
    alert('Please enter a valid date of birth.');
    return;
  }

  // Auto‑generate admission number if empty
  if (!admissionNumber) {
    admissionNumber = await generateAdmissionNumber();
  }

  // Check uniqueness
  const isUnique = await isAdmissionNumberUnique(admissionNumber, editingStudentId);
  if (!isUnique) {
    alert(`Admission number "${admissionNumber}" already exists. Please use a different one.`);
    return;
  }

  const studentData = {
    admissionNumber,
    name,
    email,
    classId,
    subjects: selectedSubjects,
    status,
    gender,
    dob,
    club,
    passport: passport || null,
    schoolId: currentSchoolId,
    updatedAt: new Date(),
    subscriptionCovered: false     // new students not yet covered
  };

  try {
    if (editingStudentId) {
      await updateDoc(doc(db, 'students', editingStudentId), studentData);
    } else {
      studentData.createdAt = new Date();
      await addDoc(collection(db, 'students'), studentData);
      
      // Update subscription counters (only for new students)
      await handleNewStudentAddition(currentSchoolId, 1);
    }
    closeModal();
    await loadAndDisplayStudents();
  } catch (error) {
    console.error('Error saving student:', error);
    alert('Failed to save student. Check console for details.');
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