// subjects.js - Manage subjects with Primary/Secondary levels, manual entry, and formatting
// MODIFIED: Guaranteed horizontal and vertical scrolling using inline styles.
// All Firestore operations go through service.js where possible.
// TODO: service.js does not yet support deleteSubject or addSubject – those remain as direct Firestore calls.

import * as service from './service.js';
import { db } from './firebase-config.js';
import { collection, addDoc, deleteDoc, doc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId } from './admin.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

let currentSchoolId = null;

// Helper to create a scrollable wrapper with inline styles
function createScrollableWrapper(innerHtml) {
  return `<div class="table-responsive-wrapper" style="overflow-x: auto !important; overflow-y: auto !important; max-height: 60vh; width: 100%; border: 1px solid #e2e8f0; border-radius: 12px; margin: 1rem 0; background: #fff; -webkit-overflow-scrolling: touch;">${innerHtml}</div>`;
}

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
    let subjects = await service.getSubjectsBySchool(currentSchoolId);
    subjects.sort((a, b) => a.name.localeCompare(b.name));
    
    if (subjects.length === 0) {
      container.innerHTML = '<h3>Existing Subjects</h3><p>No subjects yet. Add one above.</p>';
      return;
    }
    
    // Build table with inline styles to force horizontal scroll
    let tableHtml = `<table class="data-table" style="min-width: 500px; width: 100%; border-collapse: collapse;">
      <thead>
        <tr>
          <th style="padding: 8px 12px; text-align: left; white-space: nowrap;">Name</th>
          <th style="padding: 8px 12px; text-align: left; white-space: nowrap;">Code</th>
          <th style="padding: 8px 12px; text-align: left; white-space: nowrap;">Level</th>
          <th style="padding: 8px 12px; text-align: left; white-space: nowrap;">Actions</th>
        </tr>
      </thead>
      <tbody>`;
    for (const sub of subjects) {
      const levelDisplay = sub.level === 'primary' ? 'Primary' : (sub.level === 'secondary' ? 'Secondary' : '—');
      tableHtml += `<tr>
        <td style="padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid #e2e8f0;">${escapeHtml(sub.name)}</td>
        <td style="padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid #e2e8f0;">${escapeHtml(sub.code || '-')}</td>
        <td style="padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid #e2e8f0;">${levelDisplay}</td>
        <td style="padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid #e2e8f0;"><button class="btn-danger" onclick="window.deleteSubject('${sub.id}')">Delete</button></td>
      </tr>`;
    }
    tableHtml += `</tbody>${'赶'}`;
    
    container.innerHTML = createScrollableWrapper(tableHtml);
    
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

function formatSubjectName(rawName) {
  if (!rawName) return '';
  let trimmed = rawName.trim().replace(/\s+/g, ' ');
  return trimmed.replace(/\b\w/g, char => char.toUpperCase());
}

async function isDuplicateSubject(name, level) {
  const normalizedName = formatSubjectName(name);
  const existing = await service.getSubjectsByLevel(currentSchoolId, level);
  return existing.some(sub => sub.name === normalizedName);
}

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