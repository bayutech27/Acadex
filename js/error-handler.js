// error-handler.js - Centralized error handling, notifications, loaders, and toast system

// ---------- Toast / Notification System ----------
let notificationTimeout = null;

// Inject toast styles (once)
function injectToastStyles() {
  if (document.getElementById('acadex-toast-styles')) return;
  const style = document.createElement('style');
  style.id = 'acadex-toast-styles';
  style.textContent = `
    .acadex-toast-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
    }
    .acadex-toast {
      pointer-events: auto;
      min-width: 250px;
      max-width: 350px;
      padding: 12px 16px;
      border-radius: 8px;
      background: white;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 14px;
      animation: slideInRight 0.3s ease;
      border-left: 4px solid;
      font-family: 'Segoe UI', sans-serif;
    }
    .acadex-toast-success {
      border-left-color: #10b981;
      background-color: #ecfdf5;
      color: #065f46;
    }
    .acadex-toast-success i {
      color: #10b981;
    }
    .acadex-toast-error {
      border-left-color: #ef4444;
      background-color: #fef2f2;
      color: #991b1b;
    }
    .acadex-toast-error i {
      color: #ef4444;
    }
    .acadex-toast-warning {
      border-left-color: #f59e0b;
      background-color: #fffbeb;
      color: #92400e;
    }
    .acadex-toast-warning i {
      color: #f59e0b;
    }
    .acadex-toast-info {
      border-left-color: #3b82f6;
      background-color: #eff6ff;
      color: #1e3a8a;
    }
    .acadex-toast-info i {
      color: #3b82f6;
    }
    .acadex-toast-content {
      flex: 1;
    }
    @keyframes slideInRight {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
    @keyframes fadeOut {
      from {
        opacity: 1;
        transform: translateX(0);
      }
      to {
        opacity: 0;
        transform: translateX(100%);
      }
    }
    @media (max-width: 480px) {
      .acadex-toast {
        max-width: 280px;
        font-size: 12px;
        padding: 10px 12px;
      }
    }
  `;
  document.head.appendChild(style);
}

// Get or create toast container
function getToastContainer() {
  let container = document.querySelector('.acadex-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'acadex-toast-container';
    document.body.appendChild(container);
  }
  return container;
}

// Escape HTML to prevent injection
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Internal function to create a toast
function createToast(message, type, duration = 4000) {
  injectToastStyles();
  const container = getToastContainer();
  
  const toast = document.createElement('div');
  toast.className = `acadex-toast acadex-toast-${type}`;
  
  const iconMap = {
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info'
  };
  
  toast.innerHTML = `
    <i class="fa-solid ${iconMap[type]}"></i>
    <div class="acadex-toast-content">${escapeHtml(message)}</div>
  `;
  
  container.appendChild(toast);
  
  // Auto-remove after duration
  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.5s ease forwards';
    setTimeout(() => toast.remove(), 500);
  }, duration);
  
  return toast;
}

// Public notification functions
export function showNotification(message, type = "info") {
  // Remove any old style notification if present (backward compatibility)
  const oldNotification = document.querySelector(".global-notification");
  if (oldNotification) oldNotification.remove();
  if (notificationTimeout) clearTimeout(notificationTimeout);
  
  // Create toast based on type
  switch (type) {
    case "success":
      createToast(message, "success");
      break;
    case "error":
      createToast(message, "error");
      break;
    case "warning":
      createToast(message, "warning");
      break;
    default:
      createToast(message, "info");
  }
}

export function handleError(error, userMessage = "Something went wrong. Please try again.") {
  console.error(error);
  
  let message = userMessage;
  
  // Provide more specific messages for common Firebase errors
  if (error.code === 'permission-denied') {
    message = 'You do not have permission to perform this action.';
  } else if (error.code === 'unavailable' || error.message?.includes('offline')) {
    message = 'Network error. Your changes will be saved when you reconnect.';
  } else if (error.code === 'not-found') {
    message = 'The requested data was not found.';
  } else if (error.message) {
    message = error.message;
  }
  
  createToast(message, "error");
}

// Toast API for direct use (optional)
export const toast = {
  success: (msg, duration) => createToast(msg, "success", duration),
  error: (msg, duration) => createToast(msg, "error", duration),
  warning: (msg, duration) => createToast(msg, "warning", duration),
  info: (msg, duration) => createToast(msg, "info", duration)
};

// ---------- Loader System ----------
let loaderCounter = 0;
let globalLoaderElement = null;

export function showLoader() {
  loaderCounter++;
  if (loaderCounter === 1) {
    if (!globalLoaderElement) {
      globalLoaderElement = document.createElement("div");
      globalLoaderElement.id = "globalLoader";
      globalLoaderElement.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        backdrop-filter: blur(2px);
      `;
      globalLoaderElement.innerHTML = '<div class="spinner-border text-light" style="width: 3rem; height: 3rem;" role="status"></div>';
      document.body.appendChild(globalLoaderElement);
    }
    globalLoaderElement.style.display = "flex";
  }
}

export function hideLoader() {
  loaderCounter = Math.max(0, loaderCounter - 1);
  if (loaderCounter === 0 && globalLoaderElement) {
    globalLoaderElement.style.display = "none";
  }
}

// For button-specific loading (legacy support)
export function showLoading(buttonElement, originalText = null) {
  if (!buttonElement) return;
  if (originalText === null) originalText = buttonElement.innerText;
  buttonElement.disabled = true;
  buttonElement.dataset.originalText = originalText;
  buttonElement.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Loading...';
}

export function hideLoading(buttonElement) {
  if (!buttonElement) return;
  buttonElement.disabled = false;
  const original = buttonElement.dataset.originalText;
  if (original) buttonElement.innerText = original;
  else if (buttonElement.dataset.originalText) buttonElement.innerHTML = buttonElement.dataset.originalText;
  else buttonElement.innerHTML = "Submit";
}

// ---------- Confirm Dialog (non-blocking alternative to confirm()) ----------
let activeConfirm = null;

export function showConfirm(message, onConfirm, onCancel = null) {
  // Remove existing confirm dialog if any
  if (activeConfirm) activeConfirm.remove();
  
  const overlay = document.createElement('div');
  overlay.className = 'acadex-confirm-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10001;
  `;
  
  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: white;
    border-radius: 12px;
    padding: 24px;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1);
    text-align: center;
  `;
  dialog.innerHTML = `
    <p style="margin-bottom: 24px; font-size: 16px;">${escapeHtml(message)}</p>
    <div style="display: flex; gap: 12px; justify-content: center;">
      <button class="confirm-yes" style="padding: 8px 20px; background: #ef4444; color: white; border: none; border-radius: 8px; cursor: pointer;">Yes, Delete</button>
      <button class="confirm-no" style="padding: 8px 20px; background: #e2e8f0; color: #1e293b; border: none; border-radius: 8px; cursor: pointer;">Cancel</button>
    </div>
  `;
  
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  activeConfirm = overlay;
  
  const yesBtn = dialog.querySelector('.confirm-yes');
  const noBtn = dialog.querySelector('.confirm-no');
  
  const cleanup = () => {
    if (activeConfirm) activeConfirm.remove();
    activeConfirm = null;
  };
  
  yesBtn.addEventListener('click', () => {
    cleanup();
    if (onConfirm) onConfirm();
  });
  
  noBtn.addEventListener('click', () => {
    cleanup();
    if (onCancel) onCancel();
  });
  
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      cleanup();
      if (onCancel) onCancel();
    }
  });
}

// For backward compatibility with existing confirm() calls
// Note: This is asynchronous – you need to use async/await or callbacks
// To replace: if (confirm('Delete?')) → showConfirm('Delete?', () => { ... })
// This is optional – you can keep using native confirm() if you prefer blocking dialogs