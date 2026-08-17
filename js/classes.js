// classes.js - Manage classes with subscription payment banner and level detection (Nursery/Primary/Secondary)
// All Firestore operations go through service.js where possible.
// TODO: service.js does not yet provide createClass/deleteClass/updateClass – direct Firestore writes kept temporarily.
// ADDED: Guaranteed horizontal and vertical scrolling using inline styles.
// NEW: Added Nursery level support and Edit functionality with modal.
// All user-facing errors now show clear, friendly messages without technical jargon.

import * as service from './service.js';
import { getCurrentSchoolId } from './admin.js';
import { showNotification, handleError, showLoader, hideLoader, toast } from './error-handler.js';
import { db } from './firebase-config.js';
import { collection, addDoc, deleteDoc, doc, updateDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

let currentSchoolId = null;
let unsubscribeSub = null;

function createScrollableWrapper(innerHtml) {
  return `<div class="table-responsive-wrapper" style="overflow-x: auto !important; overflow-y: auto !important; max-height: 60vh; width: 100%; border: 1px solid #e2e8f0; border-radius: 12px; margin: 1rem 0; background: #fff; -webkit-overflow-scrolling: touch;">${innerHtml}</div>`;
}

export async function initClasses() {
  try {
    currentSchoolId = await getCurrentSchoolId();
    console.log('Classes initialized, schoolId:', currentSchoolId);
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => loadClassesAndSetupForm());
    } else {
      loadClassesAndSetupForm();
    }
    
    setupSubscriptionUI();
    initSubscriptionListener();
  } catch (error) {
    console.error('Classes init error:', error);
    toast.error('Unable to initialise classes page. Please refresh.');
  }
}

async function loadClassesAndSetupForm() {
  await loadClasses();
  setupClassForm();
}

function getClassLevel(className) {
  if (!className) return 'secondary';
  const lowerName = className.toLowerCase();
  if (lowerName.includes('nursery')) {
    return 'nursery';
  }
  if (lowerName.includes('kindergarten') || lowerName.includes('primary')) {
    return 'primary';
  }
  if (lowerName.includes('jss') || lowerName.includes('sss')) {
    return 'secondary';
  }
  return 'secondary';
}

async function loadClasses() {
  const container = document.getElementById('classesList');
  if (!container) return;
  try {
    let classes = await service.getClassesBySchool(currentSchoolId);
    classes.sort((a, b) => a.name.localeCompare(b.name));

    if (classes.length === 0) {
      container.innerHTML = '<h3>Existing Classes</h3><p>No classes yet. Add one above.</p>';
      return;
    }

    let tableHtml = `<table class="data-table" style="min-width: 400px; width: 100%; border-collapse: collapse;">
      <thead>
        <tr>
          <th style="padding: 8px 12px; text-align: left; white-space: nowrap;">Name</th>
          <th style="padding: 8px 12px; text-align: left; white-space: nowrap;">Level</th>
          <th style="padding: 8px 12px; text-align: left; white-space: nowrap;">Actions</th>
        </tr>
      </thead>
      <tbody>`;
    for (const cls of classes) {
      const levelDisplay = cls.level === 'nursery' ? 'Nursery' : (cls.level === 'primary' ? 'Primary' : 'Secondary');
      tableHtml += `<tr>
        <td style="padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid #e2e8f0;">${escapeHtml(cls.name)}</td>
        <td style="padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid #e2e8f0;">${levelDisplay}</td>
        <td style="padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid #e2e8f0;">
          <button class="btn-secondary" onclick="window.editClass('${cls.id}')">Edit</button>
          <button class="btn-danger" onclick="window.deleteClass('${cls.id}')">Delete</button>
        </td>
      </tr>`;
    }
    tableHtml += `</tbody>`;
    
    container.innerHTML = createScrollableWrapper(tableHtml);
    
    window.deleteClass = async (id) => {
      if (confirm('Delete this class permanently? This action cannot be undone.')) {
        showLoader();
        try {
          await deleteDoc(doc(db, 'classes', id));
          toast.success('Class deleted successfully.');
          await loadClasses();
        } catch (err) {
          console.error('Class deletion error:', err);
          toast.error('Failed to delete class. Please try again.');
        } finally {
          hideLoader();
        }
      }
    };

    window.editClass = (id) => openEditClassModal(id);
  } catch (err) {
    console.error('Load classes error:', err);
    toast.error('Unable to load classes. Please refresh the page.');
  }
}

function setupClassForm() {
  const classForm = document.getElementById('classForm');
  if (!classForm) {
    console.error('Class form not found');
    toast.error('Form not found. Please refresh the page.');
    return;
  }

  const classSelect = document.getElementById('className');
  const manualClassName = document.getElementById('manualClassName');
  const manualLevelSelect = document.getElementById('manualClassLevel');

  if (!classSelect || !manualClassName || !manualLevelSelect) {
    console.error('Form elements missing');
    toast.error('Form elements missing. Please refresh the page.');
    return;
  }

  classSelect.addEventListener('change', () => {
    if (classSelect.value !== '') {
      manualClassName.value = '';
      manualLevelSelect.value = '';
    }
  });

  manualClassName.addEventListener('input', () => {
    if (manualClassName.value.trim() !== '') {
      classSelect.value = '';
    }
  });
  manualLevelSelect.addEventListener('change', () => {
    if (manualLevelSelect.value !== '') {
      classSelect.value = '';
    }
  });

  classForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const dropdownValue = classSelect.value;
    const manualValue = manualClassName.value.trim();
    const manualLevel = manualLevelSelect.value;

    const isDropdownUsed = dropdownValue && dropdownValue !== '';
    const isManualUsed = manualValue !== '';

    if (!isDropdownUsed && !isManualUsed) {
      toast.error('Please either select a class from the list or enter a manual class name.');
      return;
    }

    if (isDropdownUsed && isManualUsed) {
      toast.error('Please use only one method: either select from dropdown OR enter manually, not both.');
      return;
    }

    let className = '';
    let classLevel = '';

    if (isDropdownUsed) {
      className = dropdownValue;
      classLevel = getClassLevel(className);
    } else {
      if (manualValue === '') {
        toast.error('Please enter a class name.');
        return;
      }
      if (!manualLevel) {
        toast.error('Please select a level (Nursery/Primary/Secondary) for the manual class.');
        return;
      }
      className = manualValue;
      classLevel = manualLevel;
    }

    showLoader();
    try {
      const existingClasses = await service.getClassesBySchool(currentSchoolId);
      if (existingClasses.some(c => c.name === className)) {
        toast.error(`Class "${className}" already exists. Duplicate classes are not allowed.`);
        return;
      }

      await addDoc(collection(db, 'classes'), {
        name: className,
        level: classLevel,
        schoolId: currentSchoolId,
        createdAt: new Date()
      });
      classForm.reset();
      toast.success('Class added successfully.');
      await loadClasses();
    } catch (error) {
      console.error('Add class error:', error);
      toast.error('Failed to add class. Please try again.');
    } finally {
      hideLoader();
    }
  });
}

// Edit Class Modal
function openEditClassModal(classId) {
  service.getClassesBySchool(currentSchoolId).then(classes => {
    const cls = classes.find(c => c.id === classId);
    if (!cls) {
      toast.error('Class not found.');
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'editClassModal';
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9998;`;
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:24px;max-width:480px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.18);font-family:inherit;">
        <h3 style="margin:0 0 6px;font-size:1.1rem;color:#1e293b;">Edit Class</h3>
        <p style="margin:0 0 18px;color:#64748b;font-size:.9rem;">Update class details below.</p>
        <div class="form-group" style="margin-bottom:16px;">
          <label for="editClassName">Class Name</label>
          <input type="text" id="editClassName" value="${escapeHtml(cls.name)}" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
        </div>
        <div class="form-group" style="margin-bottom:16px;">
          <label for="editClassLevel">Level</label>
          <select id="editClassLevel" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
            <option value="nursery" ${cls.level === 'nursery' ? 'selected' : ''}>Nursery</option>
            <option value="primary" ${cls.level === 'primary' ? 'selected' : ''}>Primary</option>
            <option value="secondary" ${cls.level === 'secondary' ? 'selected' : ''}>Secondary</option>
          </select>
        </div>
        <div style="display:flex;gap:10px;">
          <button id="updateClassBtn" style="flex:1;padding:9px;border:none;border-radius:8px;background:#0ea5e9;color:#fff;font-weight:600;cursor:pointer;">Update</button>
          <button id="cancelEditClassBtn" style="flex:1;padding:9px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;color:#374151;font-weight:600;cursor:pointer;">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('cancelEditClassBtn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('updateClassBtn').addEventListener('click', async () => {
      const newName = document.getElementById('editClassName').value.trim();
      const newLevel = document.getElementById('editClassLevel').value;

      if (!newName) {
        toast.error('Class name cannot be empty.');
        return;
      }

      showLoader();
      try {
        const existingClasses = await service.getClassesBySchool(currentSchoolId);
        if (existingClasses.some(c => c.name === newName && c.id !== classId)) {
          toast.error(`Class "${newName}" already exists. Duplicate classes are not allowed.`);
          return;
        }

        await updateDoc(doc(db, 'classes', classId), {
          name: newName,
          level: newLevel,
          updatedAt: new Date()
        });
        overlay.remove();
        toast.success('Class updated successfully.');
        await loadClasses();
      } catch (err) {
        console.error('Update class error:', err);
        toast.error('Failed to update class. Please try again.');
      } finally {
        hideLoader();
      }
    });
  }).catch(err => {
    console.error('Error fetching class for edit:', err);
    toast.error('Unable to load class details.');
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
  unsubscribeSub = service.subscribeToSubscription(currentSchoolId, (subData) => {
    const isActive = subData ? (subData.status === 'active' && subData.locked === false) : false;
    if (isActive) {
      hidePaymentBanner();
    } else {
      showPaymentBanner();
    }
  });
}