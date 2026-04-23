// classes.js - Manage classes with subscription payment banner
import { db } from './firebase-config.js';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId } from './app.js';
import { isSubscriptionActive } from './plan.js';
import { showNotification, handleError, showLoader, hideLoader } from './error-handler.js';

let currentSchoolId = null;
let unsubscribeSub = null;

export async function initClasses() {
  try {
    currentSchoolId = await getCurrentSchoolId();
    console.log('Classes initialized, schoolId:', currentSchoolId);
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => loadClassesAndSetupForm());
    } else {
      loadClassesAndSetupForm();
    }
    
    // Setup subscription UI and listener
    setupSubscriptionUI();
    initSubscriptionListener();
  } catch (error) {
    handleError(error, "Failed to initialize classes page.");
  }
}

async function loadClassesAndSetupForm() {
  await loadClasses();
  setupClassForm();
}

async function loadClasses() {
  const container = document.getElementById('classesList');
  if (!container) return;
  try {
    const classesRef = collection(db, 'classes');
    const q = query(classesRef, where('schoolId', '==', currentSchoolId));
    const snapshot = await getDocs(q);
    const classes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

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
        showLoader();
        try {
          await deleteDoc(doc(db, 'classes', id));
          showNotification("Class deleted successfully.", "success");
          await loadClasses();
        } catch (err) {
          handleError(err, "Failed to delete class.");
        } finally {
          hideLoader();
        }
      }
    };
  } catch (err) {
    handleError(err, "Failed to load classes.");
  }
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
      showNotification("Form error: class selector missing.", "error");
      return;
    }
    const selectedValue = classSelect.value;
    if (!selectedValue || selectedValue === '') {
      showNotification("Please select a class.", "error");
      return;
    }
    showLoader();
    try {
      // Check for duplicate class name
      const q = query(
        collection(db, 'classes'),
        where('schoolId', '==', currentSchoolId),
        where('name', '==', selectedValue)
      );
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        showNotification(`Class "${selectedValue}" already exists. Duplicate classes are not allowed.`, "error");
        return;
      }
      await addClass(selectedValue);
      classForm.reset();
      showNotification("Class added successfully.", "success");
    } catch (error) {
      handleError(error, "Failed to add class.");
    } finally {
      hideLoader();
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