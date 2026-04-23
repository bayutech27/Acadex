// error-handler.js - Centralized error handling, notifications, and loaders

// ---------- Notification System ----------
let notificationTimeout = null;

export function showNotification(message, type = "info") {
  // Remove existing notification if any
  const existing = document.querySelector(".global-notification");
  if (existing) existing.remove();
  if (notificationTimeout) clearTimeout(notificationTimeout);

  const notification = document.createElement("div");
  notification.className = `global-notification ${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 10000;
    padding: 12px 20px;
    border-radius: 8px;
    font-weight: 500;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    max-width: 350px;
    background: white;
    border-left: 4px solid;
    font-family: 'Segoe UI', sans-serif;
  `;

  // Set colors based on type
  switch (type) {
    case "success":
      notification.style.borderLeftColor = "#10b981";
      notification.style.backgroundColor = "#ecfdf5";
      notification.style.color = "#065f46";
      break;
    case "error":
      notification.style.borderLeftColor = "#ef4444";
      notification.style.backgroundColor = "#fef2f2";
      notification.style.color = "#991b1b";
      break;
    case "warning":
      notification.style.borderLeftColor = "#f59e0b";
      notification.style.backgroundColor = "#fffbeb";
      notification.style.color = "#92400e";
      break;
    default:
      notification.style.borderLeftColor = "#3b82f6";
      notification.style.backgroundColor = "#eff6ff";
      notification.style.color = "#1e3a8a";
  }

  document.body.appendChild(notification);

  // Auto-hide after 4 seconds
  notificationTimeout = setTimeout(() => {
    if (notification && notification.remove) notification.remove();
  }, 4000);
}

export function handleError(error, userMessage = "Something went wrong. Please try again.") {
  console.error(error);
  showNotification(userMessage, "error");
}

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