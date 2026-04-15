import { db } from './firebase-config.js';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId } from './app.js';

let currentSchoolId = null;

export async function initClasses() {
  try {
    currentSchoolId = await getCurrentSchoolId();
    console.log('Classes initialized, schoolId:', currentSchoolId);
    
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => loadClassesAndSetupForm());
    } else {
      loadClassesAndSetupForm();
    }
  } catch (error) {
    console.error('Error initializing classes:', error);
  }
}

async function loadClassesAndSetupForm() {
  await loadClasses();
  setupClassForm();
}

async function loadClasses() {
  const classesRef = collection(db, 'classes');
  const q = query(classesRef, where('schoolId', '==', currentSchoolId));
  const snapshot = await getDocs(q);
  const classes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const container = document.getElementById('classesList');
  if (classes.length === 0) {
    container.innerHTML = '<h3>Existing Classes</h3><p>No classes yet. Add one above.</p>';
    return;
  }

  container.innerHTML = `
    <h3>Existing Classes</h3>
    <table class="data-table">
      <thead>
        <tr><th>Name</th><th>Actions</th> </thead>
      <tbody>
        ${classes.map(cls => `
          <tr>
            <td>${escapeHtml(cls.name)}</td>
            <td><button class="btn-danger" onclick="window.deleteClass('${cls.id}')">Delete</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  window.deleteClass = async (id) => {
    if (confirm('Delete this class?')) {
      await deleteDoc(doc(db, 'classes', id));
      await loadClasses();
    }
  };
}

function setupClassForm() {
  const classForm = document.getElementById('classForm');
  if (!classForm) {
    console.error('Class form not found');
    return;
  }

  classForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const classSelect = document.getElementById('className');
    if (!classSelect) {
      console.error('Class select element not found');
      alert('Form error: class selector missing.');
      return;
    }
    const selectedValue = classSelect.value;
    if (!selectedValue || selectedValue === '') {
      alert('Please select a class.');
      return;
    }
    try {
      await addClass(selectedValue);
      classForm.reset(); // Resets select to default empty option
    } catch (error) {
      console.error('Error adding class:', error);
      alert('Failed to add class. Check console.');
    }
  });
}

async function addClass(name) {
  await addDoc(collection(db, 'classes'), {
    name,
    schoolId: currentSchoolId,
    createdAt: new Date()
  });
  await loadClasses();
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