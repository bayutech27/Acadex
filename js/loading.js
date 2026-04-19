// loading.js
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

// Global page loading overlay
export function showPageLoader() {
  let loader = document.getElementById('globalLoader');
  if (!loader) {
    loader = document.createElement('div');
    loader.id = 'globalLoader';
    loader.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.5); display: flex; align-items: center;
      justify-content: center; z-index: 9999; backdrop-filter: blur(2px);
    `;
    loader.innerHTML = '<div class="spinner-border text-light" style="width: 3rem; height: 3rem;" role="status"></div>';
    document.body.appendChild(loader);
  }
  loader.style.display = 'flex';
}

export function hidePageLoader() {
  const loader = document.getElementById('globalLoader');
  if (loader) loader.style.display = 'none';
}