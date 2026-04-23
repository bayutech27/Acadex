// subjects.js - Manage subjects
import { db } from './firebase-config.js';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId } from './app.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

let currentSchoolId = null;

export async function initSubjects() {
  try {
    currentSchoolId = await getCurrentSchoolId();
    console.log('initSubjects called, schoolId:', currentSchoolId);
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        loadSubjects();
        setupForm();
      });
    } else {
      loadSubjects();
      setupForm();
    }
  } catch (error) {
    handleError(error, "Failed to initialize subjects page.");
  }
}

async function loadSubjects() {
  const container = document.getElementById('subjectsList');
  if (!container) return;
  
  try {
    const q = query(collection(db, 'subjects'), where('schoolId', '==', currentSchoolId));
    const snapshot = await getDocs(q);
    const subjects = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    if (subjects.length === 0) {
      container.innerHTML = '<h3>Existing Subjects</h3><p>No subjects yet. Add one above.</p>';
      return;
    }
    
    let html = '<h3>Existing Subjects</h3><table class="data-table"><thead><tr><th>Name</th><th>Code</th><th>Actions</th></tr></thead><tbody>';
    for (const sub of subjects) {
      html += `<tr>
        <td>${escapeHtml(sub.name)}</td>
        <td>${escapeHtml(sub.code || '-')}</td>
        <td><button class="btn-danger" onclick="window.deleteSubject('${sub.id}')">Delete</button></td>
      </tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
    
    window.deleteSubject = async (id) => {
      if (confirm('Delete this subject?')) {
        showLoader();
        try {
          await deleteDoc(doc(db, 'subjects', id));
          showNotification("Subject deleted.", "success");
          await loadSubjects();
        } catch (err) {
          handleError(err, "Failed to delete subject.");
        } finally {
          hideLoader();
        }
      }
    };
  } catch (err) {
    handleError(err, "Failed to load subjects.");
  }
}

function setupForm() {
  const form = document.getElementById('subjectForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const select = document.getElementById('subjectName');
    const name = select ? select.value : '';
    const code = document.getElementById('subjectCode')?.value.trim() || '';
    if (!name) {
      showNotification("Please select a subject.", "error");
      return;
    }
    showLoader();
    try {
      // Check for duplicate subject name (case‑insensitive)
      const lowerName = name.toLowerCase();
      const q = query(
        collection(db, 'subjects'),
        where('schoolId', '==', currentSchoolId)
      );
      const snapshot = await getDocs(q);
      const existing = snapshot.docs.some(doc => doc.data().name.toLowerCase() === lowerName);
      if (existing) {
        showNotification(`Subject "${name}" already exists (case‑insensitive). Duplicate subjects are not allowed.`, "error");
        return;
      }
      await addDoc(collection(db, 'subjects'), {
        name,
        code,
        schoolId: currentSchoolId,
        createdAt: new Date()
      });
      form.reset();
      showNotification("Subject added successfully.", "success");
      await loadSubjects();
    } catch (err) {
      handleError(err, "Failed to add subject.");
    } finally {
      hideLoader();
    }
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