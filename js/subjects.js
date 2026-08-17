// subjects.js - Manage subjects with Nursery/Primary/Secondary levels, manual entry, and formatting
// MODIFIED: Guaranteed horizontal and vertical scrolling using inline styles.
// NEW: Added Nursery level support and Edit functionality with modal.
// All Firestore operations go through service.js where possible.
// TODO: service.js does not yet support deleteSubject or updateSubject – those remain as direct Firestore calls.
// All user-facing errors now show clear, friendly messages without technical jargon.

import * as service from './service.js';
import { db } from './firebase-config.js';
import { collection, addDoc, deleteDoc, doc, updateDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId } from './admin.js';
import { showNotification, handleError, showLoader, hideLoader, toast } from './error-handler.js';

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
        setupNurseryPrimaryForm();
      });
    } else {
      loadSubjects();
      setupSecondaryForm();
      setupNurseryPrimaryForm();
    }
  } catch (error) {
    console.error('Init subjects error:', error);
    toast.error('Unable to initialise subjects page. Please refresh.');
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
      const levelDisplay = sub.level === 'nursery' ? 'Nursery' : (sub.level === 'primary' ? 'Primary' : (sub.level === 'secondary' ? 'Secondary' : '—'));
      tableHtml += `<tr>
        <td style="padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid #e2e8f0;">${escapeHtml(sub.name)}</td>
        <td style="padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid #e2e8f0;">${escapeHtml(sub.code || '-')}</td>
        <td style="padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid #e2e8f0;">${levelDisplay}</td>
        <td style="padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid #e2e8f0;">
          <button class="btn-secondary" onclick="window.editSubject('${sub.id}')">Edit</button>
          <button class="btn-danger" onclick="window.deleteSubject('${sub.id}')">Delete</button>
        </td>
      </tr>`;
    }
    tableHtml += `</tbody>`;
    
    container.innerHTML = createScrollableWrapper(tableHtml);
    
    window.deleteSubject = async (id) => {
      if (confirm('Delete this subject permanently? This action cannot be undone.')) {
        showLoader();
        try {
          await deleteDoc(doc(db, 'subjects', id));
          toast.success('Subject deleted successfully.');
          await loadSubjects();
        } catch (err) {
          console.error('Delete subject error:', err);
          toast.error('Failed to delete subject. Please try again.');
        } finally {
          hideLoader();
        }
      }
    };

    window.editSubject = (id) => openEditSubjectModal(id);
  } catch (err) {
    console.error('Load subjects error:', err);
    toast.error('Unable to load subjects. Please refresh the page.');
  }
}

function formatSubjectName(rawName) {
  if (!rawName) return '';
  let trimmed = rawName.trim().replace(/\s+/g, ' ');
  return trimmed.replace(/\b\w/g, char => char.toUpperCase());
}

async function isDuplicateSubject(name, level, excludeId = null) {
  const normalizedName = formatSubjectName(name);
  const existing = await service.getSubjectsByLevel(currentSchoolId, level);
  return existing.some(sub => sub.name === normalizedName && sub.id !== excludeId);
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

async function updateSubjectInFirestore(id, name, code, level) {
  const formattedName = formatSubjectName(name);
  const duplicate = await isDuplicateSubject(formattedName, level, id);
  if (duplicate) {
    throw new Error(`Subject "${formattedName}" already exists for ${level} level.`);
  }
  await updateDoc(doc(db, 'subjects', id), {
    name: formattedName,
    code: code || '',
    level: level,
    updatedAt: new Date()
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
      toast.error('Please select a subject from the list or enter a subject name manually.');
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
      toast.success('Secondary subject added successfully.');
      await loadSubjects();
    } catch (err) {
      console.error('Add secondary subject error:', err);
      toast.error(err.message || 'Failed to add secondary subject. Please try again.');
    } finally {
      hideLoader();
    }
  });
}

function setupNurseryPrimaryForm() {
  const form = document.getElementById('nurseryPrimarySubjectForm');
  if (!form) return;
  
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('nurseryPrimarySubjectName');
    const levelSelect = document.getElementById('nurseryPrimaryLevel');
    const codeInput = document.getElementById('nurseryPrimarySubjectCode');
    
    const name = nameInput ? nameInput.value.trim() : '';
    const level = levelSelect ? levelSelect.value : '';
    
    if (!name) {
      toast.error('Please enter a subject name.');
      return;
    }
    if (!level) {
      toast.error('Please select a level (Nursery or Primary).');
      return;
    }
    
    const code = codeInput ? codeInput.value.trim() : '';
    
    showLoader();
    try {
      await addSubjectToFirestore(name, code, level);
      form.reset();
      toast.success('Subject added successfully.');
      await loadSubjects();
    } catch (err) {
      console.error('Add nursery/primary subject error:', err);
      toast.error(err.message || 'Failed to add subject. Please try again.');
    } finally {
      hideLoader();
    }
  });
}

// Edit Subject Modal
function openEditSubjectModal(subjectId) {
  // Get subject data from service or find from already loaded list
  service.getSubjectsBySchool(currentSchoolId).then(subjects => {
    const subject = subjects.find(s => s.id === subjectId);
    if (!subject) {
      toast.error('Subject not found.');
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'editSubjectModal';
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9998;`;
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:24px;max-width:480px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.18);font-family:inherit;">
        <h3 style="margin:0 0 6px;font-size:1.1rem;color:#1e293b;">Edit Subject</h3>
        <p style="margin:0 0 18px;color:#64748b;font-size:.9rem;">Update subject details below.</p>
        <div class="form-group" style="margin-bottom:16px;">
          <label for="editSubjectName">Subject Name</label>
          <input type="text" id="editSubjectName" value="${escapeHtml(subject.name)}" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
        </div>
        <div class="form-group" style="margin-bottom:16px;">
          <label for="editSubjectCode">Subject Code</label>
          <input type="text" id="editSubjectCode" value="${escapeHtml(subject.code || '')}" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
        </div>
        <div class="form-group" style="margin-bottom:16px;">
          <label for="editSubjectLevel">Level</label>
          <select id="editSubjectLevel" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
            <option value="nursery" ${subject.level === 'nursery' ? 'selected' : ''}>Nursery</option>
            <option value="primary" ${subject.level === 'primary' ? 'selected' : ''}>Primary</option>
            <option value="secondary" ${subject.level === 'secondary' ? 'selected' : ''}>Secondary</option>
          </select>
        </div>
        <div style="display:flex;gap:10px;">
          <button id="updateSubjectBtn" style="flex:1;padding:9px;border:none;border-radius:8px;background:#0ea5e9;color:#fff;font-weight:600;cursor:pointer;">Update</button>
          <button id="cancelEditSubjectBtn" style="flex:1;padding:9px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;color:#374151;font-weight:600;cursor:pointer;">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('cancelEditSubjectBtn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('updateSubjectBtn').addEventListener('click', async () => {
      const newName = document.getElementById('editSubjectName').value.trim();
      const newCode = document.getElementById('editSubjectCode').value.trim();
      const newLevel = document.getElementById('editSubjectLevel').value;

      if (!newName) {
        toast.error('Subject name cannot be empty.');
        return;
      }

      showLoader();
      try {
        await updateSubjectInFirestore(subjectId, newName, newCode, newLevel);
        overlay.remove();
        toast.success('Subject updated successfully.');
        await loadSubjects();
      } catch (err) {
        console.error('Update subject error:', err);
        toast.error(err.message || 'Failed to update subject. Please try again.');
      } finally {
        hideLoader();
      }
    });
  }).catch(err => {
    console.error('Error fetching subject for edit:', err);
    toast.error('Unable to load subject details.');
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