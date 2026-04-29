// subjects.js - Manage subjects with Primary/Secondary levels, manual entry, and formatting
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
        setupSecondaryForm();
        setupPrimaryForm();
      });
    } else {
      loadSubjects();
      setupSecondaryForm();
      setupPrimaryForm();
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
    
    let html = '<h3>Existing Subjects</h3><table class="data-table"><thead><tr><th>Name</th><th>Code</th><th>Level</th><th>Actions</th><tr></thead><tbody>';
    for (const sub of subjects) {
      const levelDisplay = sub.level === 'primary' ? 'Primary' : (sub.level === 'secondary' ? 'Secondary' : '—');
      html += `<tr>
        <td>${escapeHtml(sub.name)}</td>
        <td>${escapeHtml(sub.code || '-')}</td>
        <td>${levelDisplay}</td>
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

// Helper: capitalize first letter of each word, trim extra spaces
function formatSubjectName(rawName) {
  if (!rawName) return '';
  // Trim and collapse multiple spaces
  let trimmed = rawName.trim().replace(/\s+/g, ' ');
  // Capitalize first letter of each word
  return trimmed.replace(/\b\w/g, char => char.toUpperCase());
}

// Helper: check for duplicate subject (same name, same level, same school)
async function isDuplicateSubject(name, level) {
  const normalizedName = formatSubjectName(name);
  const q = query(
    collection(db, 'subjects'),
    where('schoolId', '==', currentSchoolId),
    where('name', '==', normalizedName),
    where('level', '==', level)
  );
  const snapshot = await getDocs(q);
  return !snapshot.empty;
}

// Helper: add subject to Firestore
async function addSubjectToFirestore(name, code, level) {
  const formattedName = formatSubjectName(name);
  const duplicate = await isDuplicateSubject(formattedName, level);
  if (duplicate) {
    throw new Error(`Subject "${formattedName}" already exists for ${level} level.`);
  }
  await addDoc(collection(db, 'subjects'), {
    name: formattedName,
    code: code || '',
    schoolId: currentSchoolId,
    level: level,
    createdAt: new Date()
  });
}

// SECONDARY SUBJECT FORM (dropdown + manual entry)
function setupSecondaryForm() {
  const form = document.getElementById('secondarySubjectForm');
  if (!form) return;
  
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const select = document.getElementById('subjectName');
    const manualInput = document.getElementById('manualSecondarySubject');
    const codeInput = document.getElementById('secondarySubjectCode');
    
    let name = '';
    if (manualInput && manualInput.value.trim()) {
      name = manualInput.value.trim();
    } else if (select && select.value) {
      name = select.value;
    }
    
    if (!name) {
      showNotification("Please select a subject from the list or enter a subject name manually.", "error");
      return;
    }
    
    const code = codeInput ? codeInput.value.trim() : '';
    
    showLoader();
    try {
      await addSubjectToFirestore(name, code, 'secondary');
      form.reset();
      if (manualInput) manualInput.value = '';
      if (codeInput) codeInput.value = '';
      if (select) select.value = '';
      showNotification("Secondary subject added successfully.", "success");
      await loadSubjects();
    } catch (err) {
      handleError(err, err.message || "Failed to add secondary subject.");
    } finally {
      hideLoader();
    }
  });
}

// PRIMARY SUBJECT FORM (manual only)
function setupPrimaryForm() {
  const form = document.getElementById('primarySubjectForm');
  if (!form) return;
  
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('primarySubjectName');
    const codeInput = document.getElementById('primarySubjectCode');
    
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
      showNotification("Please enter a subject name.", "error");
      return;
    }
    
    const code = codeInput ? codeInput.value.trim() : '';
    
    showLoader();
    try {
      await addSubjectToFirestore(name, code, 'primary');
      form.reset();
      showNotification("Primary subject added successfully.", "success");
      await loadSubjects();
    } catch (err) {
      handleError(err, err.message || "Failed to add primary subject.");
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