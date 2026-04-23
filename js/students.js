// students.js - Manage students with subscription tracking + locked field + payment banner
import { db } from './firebase-config.js';
import { 
  collection, addDoc, getDocs, deleteDoc, doc, updateDoc, query, where, getDoc, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId, protectAdminPage } from './admin.js';
import { handleNewStudentAddition } from './plan.js';
import { isSubscriptionActive } from './plan.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

let currentSchoolId = null;
let subjectsMap = new Map();
let classesMap = new Map();
let editingStudentId = null;
let currentFilter = 'all';
let schoolName = '';
let unsubscribeSub = null;

// DOM elements
let studentForm, modal, nameInput, emailInput, classSelect, subjectsSelect, statusSelect;
let genderSelect, dobInput, ageDisplay, clubInput, passportInput, passportPreviewContainer, passportErrorSpan;
let admissionNoInput;

export async function initStudentsPage() {
  await protectAdminPage();
  currentSchoolId = await getCurrentSchoolId();
  if (!currentSchoolId) {
    showNotification("School ID missing.", "error");
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
  const addBtn = document.getElementById('addStudentBtn');
  if (addBtn) addBtn.addEventListener('click', () => openModal());
  const closeBtn = document.querySelector('#studentModal .close-modal');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  const cancelBtn = document.getElementById('cancelModalBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  studentForm.addEventListener('submit', handleStudentSubmit);
  
  if (dobInput) dobInput.addEventListener('change', () => calculateAndDisplayAge());
  if (passportInput) passportInput.addEventListener('change', handlePassportUpload);

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

  // Setup subscription UI and listener
  setupSubscriptionUI();
  initSubscriptionListener();
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
  if (!dobInput || !ageDisplay) return;
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
  try {
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
  } catch (err) {
    handleError(err, "Failed to generate admission number.");
    return 1;
  }
}

async function generateAdmissionNumber() {
  const schoolCode = getSchoolCode();
  const currentYear = new Date().getFullYear();
  const nextSeq = await getNextSequenceNumber();
  const paddedSeq = String(nextSeq).padStart(3, '0');
  return `${schoolCode}/${currentYear}/${paddedSeq}`;
}

async function isAdmissionNumberUnique(admissionNo, excludeStudentId = null) {
  try {
    const studentsRef = collection(db, 'students');
    const q = query(studentsRef, where('schoolId', '==', currentSchoolId), where('admissionNumber', '==', admissionNo));
    const snapshot = await getDocs(q);
    if (snapshot.empty) return true;
    if (excludeStudentId && snapshot.docs.length === 1 && snapshot.docs[0].id === excludeStudentId) return true;
    return false;
  } catch (err) {
    handleError(err, "Failed to check admission number uniqueness.");
    return false;
  }
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

    if (classSelect) {
      classSelect.innerHTML = '<option value="">Select Class</option>';
      for (let [id, name] of classesMap) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = name;
        classSelect.appendChild(option);
      }
    }
  } catch (err) {
    handleError(err, "Failed to load classes.");
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
      const container = document.getElementById('studentsList');
      if (container) container.innerHTML = '<p>No students found.</p>';
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
    handleError(err, "Failed to load students.");
    return;
  }
  const students = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const container = document.getElementById('studentsList');
  if (!container) return;
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
            <th>Status</th>
            <th>Locked</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${students.map(student => {
            const className = classesMap.get(student.classId) || 'Unknown';
            const passportSrc = student.passport || '';
            const lockedDisplay = student.locked ? 'Yes' : 'No';
            return `
              <tr>
                <td>
                  ${passportSrc ? `<img src="${passportSrc}" class="student-passport" alt="passport" style="width:40px;height:40px;object-fit:cover;border-radius:50%;">` : '<div class="student-passport" style="width:40px;height:40px;background:#e2e8f0;border-radius:50%;"></div>'}
                </td>
                <td>${escapeHtml(student.admissionNumber || '—')}</td>
                <td>${escapeHtml(student.name)}</td>
                <td>${escapeHtml(student.email)}</td>
                <td>${escapeHtml(className)}</td>
                <td>
                  <select class="status-select" data-id="${student.id}" data-current="${student.status || 'active'}">
                    <option value="active" ${(student.status || 'active') === 'active' ? 'selected' : ''}>Active</option>
                    <option value="inactive" ${student.status === 'inactive' ? 'selected' : ''}>Inactive</option>
                    <option value="graduated" ${student.status === 'graduated' ? 'selected' : ''}>Graduated</option>
                  </select>
                </td>
                <td>${lockedDisplay}</td>
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
          showNotification('Graduated status can only be set for JSS 3 or SSS 3 students.', "error");
          select.value = select.getAttribute('data-current');
          return;
        }
      }
      showLoader();
      try {
        await updateDoc(doc(db, 'students', studentId), { status: newStatus, updatedAt: new Date() });
        select.setAttribute('data-current', newStatus);
        await loadAndDisplayStudents();
        showNotification("Student status updated.", "success");
      } catch (err) {
        handleError(err, "Failed to update student status.");
      } finally {
        hideLoader();
      }
    });
  });

  window.editStudent = (id) => openModal(id);
  window.deleteStudent = async (id) => {
    if (confirm('Delete this student? This will also remove their results!')) {
      showLoader();
      try {
        await deleteDoc(doc(db, 'students', id));
        const resultsRef = collection(db, 'results');
        const qResults = query(resultsRef, where('studentId', '==', id));
        const resultsSnap = await getDocs(qResults);
        for (const resultDoc of resultsSnap.docs) {
          await deleteDoc(doc(db, 'results', resultDoc.id));
        }
        await loadAndDisplayStudents();
        showNotification("Student deleted.", "success");
      } catch (err) {
        handleError(err, "Failed to delete student.");
      } finally {
        hideLoader();
      }
    }
  };
}

async function getStudentClass(studentId) {
  try {
    const studentDoc = await getDoc(doc(db, 'students', studentId));
    if (studentDoc.exists()) {
      const classId = studentDoc.data().classId;
      return classesMap.get(classId) || 'Unknown';
    }
  } catch (err) {
    console.warn(err);
  }
  return 'Unknown';
}

function openModal(studentId = null) {
  editingStudentId = studentId;
  const modalTitle = document.getElementById('modalTitle');
  if (!modalTitle) return;
  // Reset form
  studentForm.reset();
  if (passportPreviewContainer) passportPreviewContainer.innerHTML = '';
  if (passportErrorSpan) passportErrorSpan.style.display = 'none';
  if (passportInput) passportInput.dataset.base64 = '';
  if (ageDisplay) ageDisplay.textContent = '-';
  if (genderSelect) genderSelect.value = '';
  if (dobInput) dobInput.value = '';
  if (clubInput) clubInput.value = '';
  if (admissionNoInput) admissionNoInput.value = '';
  
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
    if (studentDoc.exists()) {
      const data = studentDoc.data();
      if (admissionNoInput) admissionNoInput.value = data.admissionNumber || '';
      if (nameInput) nameInput.value = data.name || '';
      if (emailInput) emailInput.value = data.email || '';
      if (classSelect) classSelect.value = data.classId || '';
      if (statusSelect) statusSelect.value = data.status || 'active';
      if (genderSelect) genderSelect.value = data.gender || '';
      if (dobInput) dobInput.value = data.dob || '';
      if (clubInput) clubInput.value = data.club || '';
      if (data.dob && ageDisplay) calculateAndDisplayAge();
      
      const subjectIds = data.subjects || [];
      if (subjectsSelect) {
        Array.from(subjectsSelect.options).forEach(opt => {
          opt.selected = subjectIds.includes(opt.value);
        });
      }
      
      if (data.passport && passportPreviewContainer) {
        const img = document.createElement('img');
        img.src = data.passport;
        img.className = 'passport-preview';
        img.alt = 'Passport';
        passportPreviewContainer.appendChild(img);
        if (passportInput) passportInput.dataset.base64 = data.passport;
      }
    }
  } catch (err) {
    handleError(err, "Failed to load student data.");
  }
}

function closeModal() {
  if (modal) modal.style.display = 'none';
  editingStudentId = null;
  studentForm.reset();
  if (passportPreviewContainer) passportPreviewContainer.innerHTML = '';
  if (passportInput) passportInput.dataset.base64 = '';
}

async function handleStudentSubmit(e) {
  e.preventDefault();
  
  let admissionNumber = admissionNoInput ? admissionNoInput.value.trim() : '';
  const name = nameInput ? nameInput.value.trim() : '';
  const email = emailInput ? emailInput.value.trim() : '';
  const classId = classSelect ? classSelect.value : '';
  const selectedSubjects = subjectsSelect ? Array.from(subjectsSelect.selectedOptions).map(opt => opt.value) : [];
  const status = statusSelect ? statusSelect.value : 'active';
  const gender = genderSelect ? genderSelect.value : '';
  const dob = dobInput ? dobInput.value : '';
  const club = clubInput ? clubInput.value.trim() : null;
  let passport = passportInput ? passportInput.dataset.base64 : null;

  // Validation
  if (!name || !email || !classId || !gender || !dob) {
    showNotification("Please fill in all required fields (Name, Email, Class, Gender, Date of Birth).", "error");
    return;
  }
  const age = calculateAge(dob);
  if (age === null || age < 0 || age > 100) {
    showNotification("Please enter a valid date of birth.", "error");
    return;
  }

  // Auto‑generate admission number if empty
  if (!admissionNumber) {
    admissionNumber = await generateAdmissionNumber();
  }

  // Check uniqueness
  const isUnique = await isAdmissionNumberUnique(admissionNumber, editingStudentId);
  if (!isUnique) {
    showNotification(`Admission number "${admissionNumber}" already exists. Please use a different one.`, "error");
    return;
  }

  // Determine locked value for new students (only on creation)
  let lockedValue = false;
  if (!editingStudentId) {
    const isActive = await isSubscriptionActive(currentSchoolId);
    lockedValue = isActive ? true : false;
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
    subscriptionCovered: false
  };

  if (!editingStudentId) {
    studentData.locked = lockedValue;
    studentData.createdAt = new Date();
  }

  showLoader();
  try {
    if (editingStudentId) {
      // For update, never modify the 'locked' field
      delete studentData.locked;
      await updateDoc(doc(db, 'students', editingStudentId), studentData);
      showNotification("Student updated successfully.", "success");
    } else {
      await addDoc(collection(db, 'students'), studentData);
      await handleNewStudentAddition(currentSchoolId, 1);
      showNotification("Student added successfully.", "success");
    }
    closeModal();
    await loadAndDisplayStudents();
  } catch (error) {
    handleError(error, "Failed to save student.");
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