// toast.js - Non-blocking notification system
// Usage: toast.success('Operation completed');
//        toast.error('Something went wrong');
//        toast.warning('Please check your input');
//        toast.info('New update available');

// CSS styles (injected once)
const styles = `
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
  }
  .acadex-toast.fade-out {
    animation: fadeOut 0.5s ease forwards;
  }
  .acadex-toast-success {
    border-left-color: #10b981;
  }
  .acadex-toast-success i {
    color: #10b981;
  }
  .acadex-toast-error {
    border-left-color: #ef4444;
  }
  .acadex-toast-error i {
    color: #ef4444;
  }
  .acadex-toast-warning {
    border-left-color: #f59e0b;
  }
  .acadex-toast-warning i {
    color: #f59e0b;
  }
  .acadex-toast-info {
    border-left-color: #3b82f6;
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

// Ensure container exists
function getContainer() {
  let container = document.querySelector('.acadex-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'acadex-toast-container';
    document.body.appendChild(container);
  }
  return container;
}

// Inject styles if not already present
function injectStyles() {
  if (document.getElementById('acadex-toast-styles')) return;
  const styleEl = document.createElement('style');
  styleEl.id = 'acadex-toast-styles';
  styleEl.textContent = styles;
  document.head.appendChild(styleEl);
}

// Create and show toast
function showToast(message, type = 'info', duration = 4000) {
  injectStyles();
  const container = getContainer();
  
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
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 500);
  }, duration);
  
  return toast;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Public API
export const toast = {
  success: (msg, duration) => showToast(msg, 'success', duration),
  error: (msg, duration) => showToast(msg, 'error', duration),
  warning: (msg, duration) => showToast(msg, 'warning', duration),
  info: (msg, duration) => showToast(msg, 'info', duration)
};

// For backward compatibility with existing showNotification calls
export function showNotification(message, type = 'success') {
  if (type === 'error' || type === 'danger') {
    toast.error(message);
  } else if (type === 'warning') {
    toast.warning(message);
  } else {
    toast.success(message);
  }
}

export default { toast, showNotification };