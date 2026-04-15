import { db } from './firebase-config.js';
import { collection, getDocs, query, where, doc, updateDoc, arrayUnion, arrayRemove, getDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId } from './app.js';
import { getTeacherSubjects } from './teacher-dashboard.js';

let currentSchoolId = null;
let teacherId = null;
let currentSubjectId = null;
let allStudents = []; // all students in school
let subjectStudents = []; // students assigned to this subject via teacherSubjectStudents collection

// We'll use a collection `teacherSubjectStudents` with fields: teacherId, subjectId, studentId

export async function initMyStudents() {
  currentSchoolId = await getCurrentSchoolId();
  const user = await import('./auth.js').then(m => m.auth.currentUser);
  teacherId = user.uid;
  
  const subjects = getTeacherSubjects();
  const subjectSelect = document.getElementById('subjectSelect');
  subjectSelect.innerHTML = '<option value="">-- Select Subject --</option>';
  for (const subId of subjects) {
    const subDoc = await getDoc(doc(db, 'subjects', subId));
    if (subDoc.exists()) {
      const option = document.createElement('option');
      option.value = subId;
      option.textContent = subDoc.data().name;
      subjectSelect.appendChild(option);
    }
  }
  
  subjectSelect.addEventListener('change', async () => {
    currentSubjectId = subjectSelect.value;
    if (currentSubjectId) {
      await loadStudentsForSubject();
      document.getElementById('addStudentBtn').style.display = 'block';
    } else {
      document.getElementById('studentsContainer').innerHTML = '<p>Select a subject to load students.</p>';
      document.getElementById('addStudentBtn').style.display = 'none';
    }
  });
  
  document.getElementById('addStudentBtn').addEventListener('click', showAddStudentModal);
  setupModal();
}

async function loadStudentsForSubject() {
  const teacherSubjectStudentsRef = collection(db, 'teacherSubjectStudents');
  const q = query(teacherSubjectStudentsRef, 
    where('teacherId', '==', teacherId),
    where('subjectId', '==', currentSubjectId));
  const snapshot = await getDocs(q);
  const studentIds = snapshot.docs.map(doc => doc.data().studentId);
  
  // Fetch student details
  const studentsRef = collection(db, 'students');
  const studentsSnap = await getDocs(query(studentsRef, where('schoolId', '==', currentSchoolId)));
  const allStudentsMap = new Map();
  studentsSnap.forEach(doc => allStudentsMap.set(doc.id, doc.data()));
  
  subjectStudents = [];
  for (const sid of studentIds) {
    if (allStudentsMap.has(sid)) {
      subjectStudents.push({ id: sid, name: allStudentsMap.get(sid).name });
    }
  }
  
  displayStudents();
}

function displayStudents() {
  const container = document.getElementById('studentsContainer');
  if (subjectStudents.length === 0) {
    container.innerHTML = '<p>No students assigned to this subject yet.</p>';
    return;
  }
  let html = '<div class="student-list">';
  for (const student of subjectStudents) {
    html += `
      <div class="student-item">
        <span>${escapeHtml(student.name)}</span>
        <button class="remove-btn" data-id="${student.id}">Remove</button>
      </div>
    `;
  }
  html += '</div>';
  container.innerHTML = html;
  
  document.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const studentId = btn.getAttribute('data-id');
      if (confirm(`Remove ${studentId} from this subject?`)) {
        await removeStudentFromSubject(studentId);
        await loadStudentsForSubject();
      }
    });
  });
}

async function removeStudentFromSubject(studentId) {
  const q = query(collection(db, 'teacherSubjectStudents'),
    where('teacherId', '==', teacherId),
    where('subjectId', '==', currentSubjectId),
    where('studentId', '==', studentId));
  const snapshot = await getDocs(q);
  for (const docSnap of snapshot.docs) {
    await deleteDoc(doc(db, 'teacherSubjectStudents', docSnap.id));
  }
  // Also remove subject from student's subjects array? Optional.
}

async function showAddStudentModal() {
  // Fetch all students not already assigned to this subject
  const studentsRef = collection(db, 'students');
  const studentsSnap = await getDocs(query(studentsRef, where('schoolId', '==', currentSchoolId)));
  const assignedIds = new Set(subjectStudents.map(s => s.id));
  const availableStudents = [];
  studentsSnap.forEach(doc => {
    if (!assignedIds.has(doc.id)) {
      availableStudents.push({ id: doc.id, name: doc.data().name });
    }
  });
  
  const select = document.getElementById('studentSelectModal');
  select.innerHTML = '<option value="">-- Select Student --</option>';
  for (const s of availableStudents) {
    const option = document.createElement('option');
    option.value = s.id;
    option.textContent = s.name;
    select.appendChild(option);
  }
  
  document.getElementById('addStudentModal').style.display = 'flex';
}

function setupModal() {
  const modal = document.getElementById('addStudentModal');
  const close = modal.querySelector('.close-modal');
  const cancel = document.getElementById('cancelAddBtn');
  const confirmBtn = document.getElementById('confirmAddBtn');
  
  const closeModal = () => modal.style.display = 'none';
  close.addEventListener('click', closeModal);
  cancel.addEventListener('click', closeModal);
  
  confirmBtn.addEventListener('click', async () => {
    const studentId = document.getElementById('studentSelectModal').value;
    if (!studentId) {
      alert('Please select a student.');
      return;
    }
    // Add to teacherSubjectStudents
    await addDoc(collection(db, 'teacherSubjectStudents'), {
      teacherId,
      subjectId: currentSubjectId,
      studentId,
      createdAt: new Date()
    });
    closeModal();
    await loadStudentsForSubject();
  });
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