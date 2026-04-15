import { db, auth } from './firebase-config.js';
import { 
  collection, getDocs, deleteDoc, doc, updateDoc, query, where, getDoc, setDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getAuth, createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getCurrentSchoolId } from './app.js';

let currentSchoolId = null;
let subjectsMap = new Map();
let classesMap = new Map();
let editingTeacherId = null;

let teacherForm, modal, nameInput, emailInput, subjectsSelect, classesSelect, classTeacherSelect;

// Secondary Firebase app for teacher creation (prevents admin logout)
let secondaryAuth = null;
function initSecondaryAuth() {
  if (!secondaryAuth) {
    // Get the primary app's config from the existing auth object
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
  initSecondaryAuth(); // prepare secondary auth instance
  
  await loadSubjects();
  await loadClasses();
  await loadTeachers();

  document.getElementById('addTeacherBtn').addEventListener('click', () => openModal());
  document.querySelector('.close-modal').addEventListener('click', closeModal);
  document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
  teacherForm.addEventListener('submit', handleTeacherSubmit);
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

  classTeacherSelect.innerHTML = '<option value="">None</option>';
  for (let [id, name] of classesMap) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = name;
    classTeacherSelect.appendChild(option);
  }
}

async function loadTeachers() {
  const teachersRef = collection(db, 'teachers');
  const q = query(teachersRef, where('schoolId', '==', currentSchoolId));
  const snapshot = await getDocs(q);
  const teachers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const container = document.getElementById('teachersList');
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
      await deleteDoc(doc(db, 'teachers', id));
      await deleteDoc(doc(db, 'users', id)).catch(console.warn);
      await loadTeachers();
      alert('Teacher deleted from Firestore. Auth user still exists (delete manually from Firebase Console).');
    }
  };
}

function openModal(teacherId = null) {
  editingTeacherId = teacherId;
  const modalTitle = document.getElementById('modalTitle');
  if (teacherId) {
    modalTitle.textContent = 'Edit Teacher';
    emailInput.readOnly = true;
    loadTeacherData(teacherId);
  } else {
    modalTitle.textContent = 'Add Teacher';
    emailInput.readOnly = false;
    nameInput.value = '';
    emailInput.value = '';
    Array.from(subjectsSelect.options).forEach(opt => opt.selected = false);
    Array.from(classesSelect.options).forEach(opt => opt.selected = false);
    classTeacherSelect.value = '';
  }
  modal.style.display = 'flex';
}

async function loadTeacherData(teacherId) {
  const teacherDoc = await getDoc(doc(db, 'teachers', teacherId));
  if (teacherDoc.exists()) {
    const data = teacherDoc.data();
    nameInput.value = data.name;
    emailInput.value = data.email;
    const subjectIds = data.subjectIds || [];
    Array.from(subjectsSelect.options).forEach(opt => {
      opt.selected = subjectIds.includes(opt.value);
    });
    const classIds = data.classIds || [];
    Array.from(classesSelect.options).forEach(opt => {
      opt.selected = classIds.includes(opt.value);
    });
    if (data.isClassTeacher && data.hostClassId) {
      classTeacherSelect.value = data.hostClassId;
    } else {
      classTeacherSelect.value = '';
    }
  }
}

function closeModal() {
  modal.style.display = 'none';
  editingTeacherId = null;
  emailInput.readOnly = false;
  teacherForm.reset();
}

async function handleTeacherSubmit(e) {
  e.preventDefault();
  const name = nameInput.value.trim();
  const email = emailInput.value.trim();
  const selectedSubjectIds = Array.from(subjectsSelect.selectedOptions).map(opt => opt.value);
  const selectedClassIds = Array.from(classesSelect.selectedOptions).map(opt => opt.value);
  const hostClassIdValue = classTeacherSelect.value || null;
  const isClassTeacher = hostClassIdValue !== null && hostClassIdValue !== '';

  if (!name || !email) {
    alert('Please fill in all fields.');
    return;
  }

  const teacherData = {
    name,
    email,
    subjectIds: selectedSubjectIds,
    classIds: selectedClassIds,
    isClassTeacher,
    hostClassId: isClassTeacher ? hostClassIdValue : null,
    schoolId: currentSchoolId,
    updatedAt: new Date()
  };

  try {
    if (editingTeacherId) {
      await updateDoc(doc(db, 'teachers', editingTeacherId), teacherData);
      alert('Teacher updated successfully.');
      closeModal();
      await loadTeachers();
    } else {
      // --- CREATE NEW TEACHER using secondary auth ---
      const defaultPassword = '$Acadex123';
      const secondaryAuthInstance = initSecondaryAuth();
      
      // 1. Create Auth user with secondary instance (does NOT affect admin session)
      let userCredential;
      try {
        userCredential = await createUserWithEmailAndPassword(secondaryAuthInstance, email, defaultPassword);
      } catch (authError) {
        console.error('Secondary auth creation error:', authError);
        if (authError.code === 'auth/email-already-in-use') {
          alert('A user with this email already exists. Please use a different email.');
        } else {
          alert('Failed to create authentication: ' + authError.message);
        }
        return;
      }
      
      const uid = userCredential.user.uid;
      
      // 2. Prepare Firestore entries
      const timestamp = serverTimestamp();
      
      // Users collection (role document)
      const userDocData = {
        email,
        role: 'teacher',
        schoolId: currentSchoolId,
        subjects: selectedSubjectIds,
        classId: selectedClassIds.length === 1 ? selectedClassIds[0] : null,
        isClassTeacher: isClassTeacher,
        createdAt: timestamp
      };
      
      // Teachers collection (additional teacher-specific data)
      const teacherDocData = {
        ...teacherData,
        authUid: uid,
        createdAt: timestamp
      };
      
      // 3. Write both documents
      await setDoc(doc(db, 'users', uid), userDocData);
      await setDoc(doc(db, 'teachers', uid), teacherDocData);
      
      alert(`Teacher created successfully!\n\nEmail: ${email}\nPassword: ${defaultPassword}`);
      
      closeModal();
      await loadTeachers();
    }
  } catch (error) {
    console.error('Error saving teacher:', error);
    alert('Failed to save teacher: ' + error.message);
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