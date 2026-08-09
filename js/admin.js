// admin.js - Admin dashboard with subscription UI (Paystack + WhatsApp)
// FULLY INTEGRATED with Central Academic Calendar Engine
// ADDED: offline caching, retry logic, fallback for school info, centralised admin page boot.

import { auth, db } from './firebase-config.js';
import {
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import {
  doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs,
  onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { logoutUser } from './auth.js';
import {
  enforceAccessGuard,
  isSubscriptionActive,
  handleNewStudentAddition,
  getSubscriptionStatus,
  // approveExtraStudents, // ✅ REMOVED – unused import
  getSubscriptionDisplayStatus,
} from './plan.js';
import { showNotification, handleError, showLoader, hideLoader, toast } from './error-handler.js';
import { showPageLoader, hidePageLoader } from './loading.js';
import { initMobileMenu } from './menu.js'; // ✅ Added import

// ========== ACADEMIC CALENDAR IMPORTS ==========
import {
  initAcademicCalendar as initCentralCalendar,
  getCurrentTerm,
  getCurrentSession,
  getTermDates,
  subscribeToCalendar,
  adminOverrideCalendar,
  adminResetToAuto,
  getAcademicCalendar,
} from './academic-calendar.js';
import { syncAcademicCalendar, startPeriodicSync } from './calendar-sync.js';

// ───────────────────────────────────────────────────────────────────────────────
// AUTH STATE
// ───────────────────────────────────────────────────────────────────────────────
let currentUser     = null;
let currentUserData = null;
let unsubscribeAuth = null;
let authInitialised = false;
let authResolve     = null;
const authReadyPromise = new Promise((resolve) => { authResolve = resolve; });

function initAuthListener() {
  if (unsubscribeAuth) return;
  unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        currentUserData = userDoc.exists() ? userDoc.data() : null;
      } catch (err) {
        console.error('Auth listener error:', err);
        toast.error('Unable to load your profile. Please refresh the page.');
        currentUserData = null;
      }
    } else {
      currentUserData = null;
    }
    if (!authInitialised) {
      authInitialised = true;
      if (authResolve) authResolve();
    }
  });
}
initAuthListener();

async function waitForAuth() {
  if (authInitialised) return;
  await authReadyPromise;
}

export function getCurrentUser()     { return currentUser; }
export function getCurrentUserData() { return currentUserData; }

export async function getCurrentSchoolId() {
  await waitForAuth();
  return currentUserData?.schoolId ?? null;
}

// Calendar sync periodic timer handle
let calendarStopPeriodicSync = null;

// ───────────────────────────────────────────────────────────────────────────────
// ADMIN PAGE PROTECTION
// ───────────────────────────────────────────────────────────────────────────────
export async function protectAdminPage() {
  await waitForAuth();

  if (!currentUser) {
    toast.error('Please log in to access this page.');
    window.location.href = '/';
    return null;
  }
  if (!currentUserData || currentUserData.role !== 'admin') {
    toast.error('Access denied. Admin privileges required.');
    window.location.href = '/';
    return null;
  }

  const schoolId = currentUserData.schoolId;
  if (!schoolId) {
    toast.error('School configuration error. Please contact support.');
    window.location.href = '/';
    return null;
  }

  showPageLoader();
  try {
    await initCentralCalendar();
    await syncAcademicCalendar();
    if (calendarStopPeriodicSync) calendarStopPeriodicSync();
    calendarStopPeriodicSync = startPeriodicSync(30);
  } catch (err) {
    console.error('Calendar init error:', err);
    toast.warning('Calendar is still loading. Some date features may be delayed.');
  } finally {
    hidePageLoader();
  }

  let access;
  try {
    access = await enforceAccessGuard(currentUserData, schoolId);
  } catch (err) {
    console.error('Access check error:', err);
    toast.error('Unable to verify subscription status. Please refresh the page.');
    window.__subscriptionExpired = true;
    showSubscriptionExpiredBanner();
    access = { allowed: false, onboardingOnly: true };
  }

  if (!access.allowed) {
    window.__subscriptionExpired = true;
    showSubscriptionExpiredBanner();
  }

  injectSubscriptionUI();
  updateSubscriptionBadge(schoolId);
  initSubscriptionUI(schoolId);
  setupLogout();

  // ========== Load school info with retry and caching ==========
  await loadSchoolInfoWithRetry();

  return { user: currentUser, userData: currentUserData };
}

// ───────────────────────────────────────────────────────────────────────────────
// LOGOUT
// ───────────────────────────────────────────────────────────────────────────────
let logoutHandlersAttached = false;

export function setupLogout() {
  if (logoutHandlersAttached) return;
  logoutHandlersAttached = true;

  const performLogout = async (event) => {
    event.preventDefault();
    showLoader();
    try {
      if (calendarStopPeriodicSync) {
        calendarStopPeriodicSync();
        calendarStopPeriodicSync = null;
      }
      await logoutUser();
    } catch (err) {
      console.error('Logout error:', err);
      toast.error('Could not log out. Please try again.');
      hideLoader();
    }
  };

  const headerLogoutBtn = document.getElementById('logoutBtn');
  if (headerLogoutBtn) {
    headerLogoutBtn.removeEventListener('click', performLogout);
    headerLogoutBtn.addEventListener('click', performLogout);
  }

  const mobileLogoutBtn = document.querySelector('.mobile-logout-btn');
  if (mobileLogoutBtn) {
    mobileLogoutBtn.removeEventListener('click', performLogout);
    mobileLogoutBtn.addEventListener('click', performLogout);
  }

  document.querySelectorAll('.logout-nav-item').forEach(btn => {
    btn.removeEventListener('click', performLogout);
    btn.addEventListener('click', performLogout);
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// SUBSCRIPTION BANNERS
// ───────────────────────────────────────────────────────────────────────────────
function showSubscriptionExpiredBanner() {
  const existingBanner = document.getElementById('subscriptionExpiredBanner');
  if (existingBanner) existingBanner.remove();

  const banner = document.createElement('div');
  banner.id = 'subscriptionExpiredBanner';
  banner.style.cssText = `
    background: #fef3c7; color: #92400e; padding: 12px 20px;
    text-align: center; font-weight: 500; border-bottom: 1px solid #fbbf24;
    position: sticky; top: 0; z-index: 1000;
  `;
  banner.innerHTML = `⚠️ Your subscription has expired. You can still add students and teachers, but other features are restricted. Please renew to unlock all features.`;
  document.body?.prepend(banner);
}

function hideSubscriptionExpiredBanner() {
  document.getElementById('subscriptionExpiredBanner')?.remove();
}

function showPaymentBanner() {
  const container = document.getElementById('paymentBannerContainer');
  if (!container) return;
  document.getElementById('paymentBanner')?.remove();

  const banner = document.createElement('div');
  banner.id = 'paymentBanner';
  banner.className = 'payment-banner';
  banner.innerHTML = `
    <div class="payment-banner-content">
      <h3>💰 Activate Your Subscription</h3>
      <p>Pay securely online with your ATM card via Paystack, or contact us on WhatsApp for assistance.</p>
    </div>
    <div class="payment-buttons">
      <button id="paystackPaymentBtn" class="paystack-btn">💳 Pay Now</button>
      <a id="whatsappLink" href="https://wa.me/2349044784225?text=Hello%20Acadex%2C%20I%20want%20to%20renew%20my%20subscription" target="_blank" class="whatsapp-btn">
        <svg class="whatsapp-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-5.46-4.45-9.91-9.91-9.91zm0 2c4.4 0 7.91 3.51 7.91 7.91 0 4.4-3.51 7.91-7.91 7.91-1.43 0-2.78-.38-3.97-1.07l-.6-.34-3.11.82.83-3.04-.34-.6c-.7-1.2-1.07-2.55-1.07-3.97 0-4.4 3.51-7.91 7.91-7.91zM8.53 7.5c-.18 0-.48.07-.73.33-.26.26-.95.93-.95 2.28 0 1.35.98 2.66 1.12 2.84.14.18 1.88 2.98 4.56 4.07.64.26 1.14.42 1.53.54.64.2 1.22.17 1.68.1.51-.08 1.57-.64 1.79-1.26.22-.62.22-1.15.15-1.26-.07-.11-.26-.18-.55-.31-.29-.13-1.7-.84-1.96-.94-.26-.1-.45-.15-.64.15-.19.3-.73.94-.9 1.13-.17.19-.34.21-.63.07-.29-.13-1.22-.45-2.32-1.43-.86-.76-1.44-1.7-1.61-1.99-.17-.29-.02-.45.13-.59.13-.13.29-.34.44-.51.14-.17.19-.29.29-.48.1-.19.05-.36-.03-.51-.08-.15-.64-1.54-.88-2.11-.23-.56-.46-.48-.64-.49h-.55z"/>
        </svg>
        09044784225 (WhatsApp)
      </a>
    </div>
  `;
  container.appendChild(banner);

  document.getElementById('paystackPaymentBtn')?.addEventListener('click', () => {
    window.open('https://paystack.shop/pay/fmj267paou', '_blank');
  });
}

function hidePaymentBanner() {
  document.getElementById('paymentBanner')?.remove();
}

function injectSubscriptionUI() {
  if (!document.getElementById('subscriptionBadge')) {
    const headerRight = document.querySelector('.header .header-right');
    if (headerRight) {
      const badge = document.createElement('div');
      badge.id = 'subscriptionBadge';
      badge.style.cssText = 'margin-left:auto;font-weight:bold;padding:4px 12px;border-radius:20px;background:#f1f5f9;';
      headerRight.appendChild(badge);
    }
  }
  if (!document.getElementById('subscriptionFeeContainer')) {
    const contentDiv = document.querySelector('.content');
    if (contentDiv) {
      const feeDiv = document.createElement('div');
      feeDiv.id = 'subscriptionFeeContainer';
      feeDiv.style.margin = '16px 0';
      contentDiv.insertBefore(feeDiv, contentDiv.firstChild);
    }
  }
  if (!document.getElementById('pendingExtraContainer')) {
    const contentDiv = document.querySelector('.content');
    if (contentDiv) {
      const pendingDiv = document.createElement('div');
      pendingDiv.id = 'pendingExtraContainer';
      pendingDiv.style.margin = '16px 0';
      const feeDiv = document.getElementById('subscriptionFeeContainer');
      if (feeDiv?.nextSibling) contentDiv.insertBefore(pendingDiv, feeDiv.nextSibling);
      else contentDiv.appendChild(pendingDiv);
    }
  }
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

export function setupSidebar() {
  const currentPage = window.location.pathname.split('/').pop();
  document.querySelectorAll('.sidebar-nav a').forEach(link => {
    const href = link.getAttribute('href');
    link.classList.toggle('active', href === currentPage);
  });
}

async function updateSubscriptionBadge(schoolId) {
  try {
    const displayStatus = await getSubscriptionDisplayStatus(schoolId);
    const badge = document.getElementById('subscriptionBadge');
    if (badge) {
      if (displayStatus === 'active') {
        badge.innerText = '✅ Active';
        badge.style.color = '#10b981';
        badge.classList.add('active');
        badge.classList.remove('expired');
      } else {
        badge.innerText = '⚠️ Expired';
        badge.style.color = '#ef4444';
        badge.classList.add('expired');
        badge.classList.remove('active');
      }
    }
  } catch (err) {
    console.error('Badge update error:', err);
    toast.warning('Unable to update subscription status. Please refresh the page.');
  }
}

let subscriptionListenerUnsubscribe = null;

async function alignSubscriptionEndDate(schoolId, currentSubData) {
  if (!currentSubData || currentSubData.status !== 'active' || currentSubData.locked === true) {
    return;
  }
  try {
    const termDates  = getTermDates();
    const termEndStr = termDates.end;
    if (!termEndStr) return;

    const termEndDate = new Date(termEndStr + 'T23:59:59.999Z');
    if (isNaN(termEndDate.getTime())) return;

    let storedEnd = null;
    if (currentSubData.endDate) {
      storedEnd = currentSubData.endDate.toDate
        ? currentSubData.endDate.toDate()
        : new Date(currentSubData.endDate);
    }

    if (storedEnd && storedEnd.getTime() === termEndDate.getTime()) return;

    const subRef = doc(db, 'schools', schoolId, 'subscription', 'current');
    await updateDoc(subRef, { endDate: termEndDate, lastUpdated: new Date() });
  } catch (err) {
    console.warn('Failed to align subscription endDate:', err);
    // Silent fail – not critical for user
  }
}

export function initSubscriptionUI(schoolId) {
  if (!schoolId) return;
  if (subscriptionListenerUnsubscribe) subscriptionListenerUnsubscribe();

  const subRef = doc(db, 'schools', schoolId, 'subscription', 'current');
  subscriptionListenerUnsubscribe = onSnapshot(subRef, async (snap) => {
    if (!snap.exists()) return;
    const sub = snap.data();

    await alignSubscriptionEndDate(schoolId, sub);
    await updateFeeDisplay(schoolId, sub);
    await updatePendingExtraDisplay(schoolId, sub);

    const isActive = sub.status === 'active' && sub.locked === false;
    if (isActive) {
      hideSubscriptionExpiredBanner();
      hidePaymentBanner();
    } else {
      if (!document.getElementById('subscriptionExpiredBanner')) showSubscriptionExpiredBanner();
      showPaymentBanner();
    }
    await updateSubscriptionBadge(schoolId);
  }, (err) => {
    console.error('Subscription listener error:', err);
    toast.warning('Subscription status update failed. Please refresh the page.');
  });
}

async function updateFeeDisplay(schoolId, sub) {
  const feeContainer = document.getElementById('subscriptionFeeContainer');
  if (!feeContainer) return;

  const isActive      = sub.status === 'active' && sub.locked === false;
  const plan          = sub.plan || 'Basic';
  const costPerStudent = sub.costPerStudent || 1000;

  if (!isActive) {
    let totalActiveStudents = 0;
    try {
      const snap = await getDocs(
        query(collection(db, 'students'), where('schoolId', '==', schoolId), where('status', '==', 'active'))
      );
      totalActiveStudents = snap.size;
    } catch (err) {
      console.error('Student count error:', err);
      toast.warning('Unable to calculate student count. Please refresh the page.');
    }
    const totalFee = totalActiveStudents * costPerStudent;
    feeContainer.innerHTML = `
      <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:8px;margin:16px 0;">
        <strong>💰 Subscription Fee Due</strong><br>
        Active students: ${totalActiveStudents} × ₦${costPerStudent} = <strong>₦${totalFee.toLocaleString()}</strong><br>
        <small>Your subscription has expired. Please renew to unlock all features.</small>
      </div>`;
  } else {
    // ── FIX 3: Only show "Subscription active" text ──
    feeContainer.innerHTML = `
      <div style="background:#dcfce7;border-left:4px solid #10b981;padding:12px 16px;border-radius:8px;margin:16px 0;">
        <strong>✅ Subscription active</strong>
      </div>`;
  }
}

async function updatePendingExtraDisplay(schoolId, sub = null) {
  const pendingContainer = document.getElementById('pendingExtraContainer');
  if (!pendingContainer) return;

  let lockedCount = 0;
  try {
    const lockedSnap = await getDocs(
      query(collection(db, 'students'), where('schoolId', '==', schoolId), where('locked', '==', true))
    );
    lockedCount = lockedSnap.size;
  } catch (err) {
    console.error('Locked students count error:', err);
    toast.warning('Unable to load pending students list.');
  }

  if (lockedCount === 0) { pendingContainer.innerHTML = ''; return; }

  let costPerStudent = sub?.costPerStudent ?? 1000;
  if (!sub) {
    try {
      const subSnap = await getDoc(doc(db, 'schools', schoolId, 'subscription', 'current'));
      if (subSnap.exists()) costPerStudent = subSnap.data().costPerStudent || 1000;
    } catch (err) {
      console.error('Cost fetch error:', err);
    }
  }

  const totalExtraFee = lockedCount * costPerStudent;
  pendingContainer.innerHTML = `
    <div style="background:#e0f2fe;border-left:4px solid #0284c7;border-radius:12px;padding:16px 20px;margin:16px 0;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;">
      <div>
        <strong style="font-size:1rem;">⏳ Pending Extra Students</strong><br>
        ${lockedCount} student(s) awaiting approval.<br>
        <strong>Payment required:</strong> ${lockedCount} × ₦${costPerStudent} = <strong>₦${totalExtraFee.toLocaleString()}</strong>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        <button id="payNowPendingBtn" class="paystack-btn" style="background:#00b3f0;">💳 Pay Now</button>
        <a href="https://wa.me/2349044784225?text=Hello%20Acadex%2C%20I%20want%20to%20pay%20for%20extra%20students" target="_blank" class="whatsapp-btn" style="background:#25D366;">📱 WhatsApp Support</a>
      </div>
    </div>`;

  document.getElementById('payNowPendingBtn')?.addEventListener('click', () => {
    window.open('https://paystack.shop/pay/fmj267paou', '_blank');
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// ACADEMIC CALENDAR
// ───────────────────────────────────────────────────────────────────────────────
export async function initAcademicCalendar(schoolId) {
  await initCentralCalendar();
  await syncAcademicCalendar();
}

export function getCurrentAcademicSessionAndTerm() {
  return { session: getCurrentSession(), term: getCurrentTerm() };
}

export async function getAcademicContext(schoolId) {
  await initCentralCalendar();
  return { currentSession: getCurrentSession(), currentTerm: getCurrentTerm() };
}

export async function loadAcademicInfo() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;
  try {
    await initCentralCalendar();
    const session   = getCurrentSession();
    const term      = getCurrentTerm();
    const termNames = { 'First Term': 'First Term', 'Second Term': 'Second Term', 'Third Term': 'Third Term' };
    const academicDiv = document.getElementById('academicInfo');
    if (academicDiv) academicDiv.textContent = `${session || 'N/A'} • ${termNames[term] || term || ''}`;
  } catch (err) {
    console.warn('Could not load academic info', err);
    // Silent fail – non-critical
  }
}

export { adminOverrideCalendar, adminResetToAuto };

// ───────────────────────────────────────────────────────────────────────────────
// LOGO UPLOAD & SCHOOL INFO WITH CACHING AND RETRY
// ───────────────────────────────────────────────────────────────────────────────
const CACHE_KEY = 'acadex_school_info';

function getCachedSchoolInfo() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      // Check if cache is less than 24 hours old
      if (data.timestamp && (Date.now() - data.timestamp) < 24 * 60 * 60 * 1000) {
        return data.info;
      }
    }
  } catch (_) {}
  return null;
}

function setCachedSchoolInfo(info) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ info, timestamp: Date.now() }));
  } catch (_) {}
}

async function loadSchoolInfoWithRetry() {
  // Try to load from Firestore with retry logic
  const maxAttempts = 3;
  let attempt = 0;
  let success = false;

  while (attempt < maxAttempts && !success) {
    attempt++;
    try {
      await loadSchoolInfo();
      success = true;
      // Save to cache
      const userData = currentUserData;
      if (userData) {
        const school = await getSchoolById(userData.schoolId);
        if (school) {
          setCachedSchoolInfo(school);
        }
      }
    } catch (err) {
      console.warn(`School info load attempt ${attempt} failed:`, err);
      if (attempt < maxAttempts) {
        // Exponential backoff: 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  // If all attempts failed, try to use cached data
  if (!success) {
    const cached = getCachedSchoolInfo();
    if (cached) {
      // Apply cached data to UI
      const schoolNameEl = document.getElementById('schoolName');
      const schoolAddressEl = document.getElementById('schoolAddress');
      const logoImg = document.getElementById('schoolLogoImg');
      if (schoolNameEl) schoolNameEl.textContent = cached.name || 'Unknown School (cached)';
      if (schoolAddressEl && cached.address) schoolAddressEl.textContent = cached.address;
      if (logoImg && cached.logo) logoImg.src = cached.logo;
      toast.warning('Using cached school info. Some data may be outdated.');
    } else {
      // Show a fallback error message in the UI
      const schoolNameEl = document.getElementById('schoolName');
      if (schoolNameEl) {
        schoolNameEl.textContent = '⚠️ Unable to load school info';
        schoolNameEl.style.color = '#ef4444';
      }
      toast.error('Could not load school details. Please check your internet connection.');
    }
  }
}

async function compressImage(file, maxSizeKB = 500, maxWidth = 500) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width, height = img.height;
        if (width > maxWidth) { height = (height * maxWidth) / width; width = maxWidth; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        let quality = 0.9;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length > maxSizeKB * 1024 && quality > 0.1) {
          quality -= 0.1;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error('Image loading failed'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('File reading failed'));
    reader.readAsDataURL(file);
  });
}

async function uploadSchoolLogo(schoolId, file) {
  try {
    const compressed = await compressImage(file, 500, 500);
    await updateDoc(doc(db, 'schools', schoolId), { logo: compressed });
    toast.success('Logo uploaded successfully');
    // Update cache after successful upload
    const school = await getSchoolById(schoolId);
    if (school) setCachedSchoolInfo(school);
    return compressed;
  } catch (error) {
    console.error('Logo upload error:', error);
    toast.error('Failed to upload logo. Please try with a smaller image (under 500KB).');
    return null;
  }
}

export async function loadSchoolInfo() {
  const userData = currentUserData;
  if (!userData) return;
  try {
    const school = await getSchoolById(userData.schoolId);
    const schoolNameEl    = document.getElementById('schoolName');
    const schoolAddressEl = document.getElementById('schoolAddress');
    if (schoolNameEl)    schoolNameEl.textContent    = school ? school.name : 'Unknown School';
    if (schoolAddressEl && school) schoolAddressEl.textContent = school.address || 'No address provided';

    const logoImg = document.getElementById('schoolLogoImg');
    if (logoImg && school?.logo) {
      logoImg.src = school.logo;
    } else if (logoImg) {
      logoImg.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 24 24" fill="%23e2e8f0"%3E%3Ccircle cx="12" cy="12" r="12"/%3E%3C/svg%3E';
    }

    // Update subscription and academic info
    await loadAcademicInfo();
    if (userData.schoolId) {
      updateSubscriptionBadge(userData.schoolId);
      initSubscriptionUI(userData.schoolId);
    }
  } catch (err) {
    console.error('School info error:', err);
    toast.warning('Unable to load school information. Please refresh the page.');
    throw err; // rethrow for retry logic
  }
}

async function getSchoolById(schoolId) {
  try {
    const snap = await getDoc(doc(db, 'schools', schoolId));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error('School fetch error:', err);
    throw err;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// LOGO UPLOAD – Click on the logo container (works on both desktop & mobile)
// ───────────────────────────────────────────────────────────────────────────────
export function setupLogoUpload() {
  const logoContainer = document.querySelector('.school-logo');
  const fileInput = document.getElementById('logoUploadInput');
  if (!logoContainer || !fileInput) return;

  // Remove old listeners by cloning and replacing the container
  const newContainer = logoContainer.cloneNode(true);
  logoContainer.parentNode.replaceChild(newContainer, logoContainer);

  // Re‑query the fresh elements
  const freshContainer = document.querySelector('.school-logo');
  const freshFileInput = document.getElementById('logoUploadInput');
  if (!freshContainer || !freshFileInput) return;

  // Main click handler – works on desktop & mobile (touch)
  freshContainer.addEventListener('click', (e) => {
    e.preventDefault();
    freshFileInput.click();
  });

  // Camera icon click (desktop only, hidden on mobile but safe to attach)
  const cameraIcon = freshContainer.querySelector('#cameraIcon');
  if (cameraIcon) {
    cameraIcon.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent container’s click from firing twice
      freshFileInput.click();
    });
  }

  // File selection handler
  freshFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file && file.type.startsWith('image/')) {
      const schoolId = await getCurrentSchoolId();
      if (!schoolId) {
        toast.error('School ID not found. Please refresh the page.');
        return;
      }
      const newLogo = await uploadSchoolLogo(schoolId, file);
      if (newLogo) {
        const logoImg = document.getElementById('schoolLogoImg');
        if (logoImg) logoImg.src = newLogo;
      }
    } else if (file) {
      toast.error('Please select a valid image file (JPG, PNG, GIF).');
    }
    freshFileInput.value = ''; // Allow re‑selecting the same file
  });
}

export async function loadDashboardCounts() {
  const schoolId = await getCurrentSchoolId();
  if (!schoolId) return;

  try {
    const snap = await getDocs(query(collection(db, 'teachers'), where('schoolId', '==', schoolId)));
    const el = document.getElementById('totalTeachers');
    if (el) el.textContent = snap.size;
  } catch (err) {
    console.error('Teacher count error:', err);
    toast.warning('Unable to load teacher count. Please refresh the page.');
  }

  try {
    const snap = await getDocs(query(collection(db, 'students'), where('schoolId', '==', schoolId)));
    const el = document.getElementById('totalStudents');
    if (el) el.textContent = snap.size;
  } catch (err) {
    console.error('Student count error:', err);
    toast.warning('Unable to load total student count.');
  }

  try {
    const snap = await getDocs(
      query(collection(db, 'students'), where('schoolId', '==', schoolId), where('status', '==', 'active'))
    );
    const el = document.getElementById('activeStudents');
    if (el) el.textContent = snap.size;
  } catch (err) {
    console.error('Active students error:', err);
    toast.warning('Unable to load active student count.');
    const el = document.getElementById('activeStudents');
    if (el) el.textContent = 'Error';
  }

  try {
    const snap = await getDocs(query(collection(db, 'subjects'), where('schoolId', '==', schoolId)));
    const el = document.getElementById('totalSubjects');
    if (el) el.textContent = snap.size;
  } catch (err) {
    console.error('Subjects count error:', err);
    toast.warning('Unable to load subject count.');
  }
}

// =========================================================================
// 🆕 Centralised Admin Page Boot Function
// =========================================================================

/**
 * Initialises any admin page with shared setup.
 * @param {Function} pageInitFn - Optional page‑specific initialisation function (async)
 * @returns {Promise<Object>} - The result from protectAdminPage
 */
export async function initAdminPage(pageInitFn) {
  // 1. Protect the page (auth, subscription, calendar, school info)
  const result = await protectAdminPage();
  if (!result) return null; // redirect already happened

  // 2. Shared UI setup (idempotent – safe to call even if already done)
  setupSidebar();
  setupLogout();
  setupLogoUpload();
  initMobileMenu();

  // 3. Run page‑specific initialisation
  if (typeof pageInitFn === 'function') {
    await pageInitFn();
  }

  // 4. Set up academic calendar subscription (term/session display)
  setupAcademicCalendarDisplay();

  return result;
}

/**
 * Sets up the academic calendar subscription to update the term/session
 * elements on any admin page.
 */
function setupAcademicCalendarDisplay() {
  subscribeToCalendar((state) => {
    const termEl = document.getElementById('currentTermDisplay');
    const sessionEl = document.getElementById('currentSessionDisplay');
    if (termEl) termEl.textContent = state.currentTerm || '—';
    if (sessionEl) sessionEl.textContent = state.currentSession || '—';
    if (state.manualOverride) {
      termEl?.classList.add('override-badge');
    } else {
      termEl?.classList.remove('override-badge');
    }
  });
}

// =========================================================================
// 🆕 Re‑export calendar functions so they can be imported from admin.js
// =========================================================================
export {
  getAcademicCalendar,
  getCurrentSession,
  getCurrentTerm
} from './academic-calendar.js';