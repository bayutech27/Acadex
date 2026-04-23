// loading.js - Loading utilities with safe DOM access
// Provides global page loader and button-specific loaders

// ---------- Button-specific Loading ----------
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
  else buttonElement.innerHTML = buttonElement.dataset.originalText || 'Submit';
}

// ---------- Global Page Loader Overlay ----------
let pageLoaderElement = null;

export function showPageLoader() {
  // If loader already exists, just show it
  if (pageLoaderElement) {
    pageLoaderElement.style.display = 'flex';
    return;
  }

  // Create loader element if it doesn't exist
  pageLoaderElement = document.createElement('div');
  pageLoaderElement.id = 'globalPageLoader';
  pageLoaderElement.style.cssText = `
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
  pageLoaderElement.innerHTML = '<div class="spinner-border text-light" style="width: 3rem; height: 3rem;" role="status"></div>';
  document.body.appendChild(pageLoaderElement);
}

export function hidePageLoader() {
  if (pageLoaderElement) {
    pageLoaderElement.style.display = 'none';
  }
}