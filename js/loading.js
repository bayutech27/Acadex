// loading.js — unified loading utilities with safe DOM access.
//
// Provides three tiers of loading UX:
//
//   1. Button loading       — showLoading(btn) / hideLoading(btn)
//                             Inline spinner inside any <button>. Unchanged API.
//
//   2. Fullscreen loader    — showFullscreenLoader() / hideFullscreenLoader()
//                             iOS-styled opaque frosted backdrop, large arc
//                             spinner, "Loading…" label. Ideal for main
//                             dashboards (admin / teacher / parent home pages).
//                             Matches the student dashboard boot loader.
//
//   3. Overlay loader       — showOverlayLoader() / hideOverlayLoader()
//                             Faint, semi-transparent wash — the page peeking
//                             through stays faintly visible. Ideal for
//                             sub-pages (class, scores, attendance, etc.).
//
// Backwards-compat:
//   showPageLoader()  → aliased to showFullscreenLoader()
//   hidePageLoader()  → aliased to hideFullscreenLoader()
//   Any existing call sites keep working; they just get the nicer loader.
//
// Robustness:
//   • Failsafe timeout — if hide() is never called, the loader swaps to a
//     "network is taking too long / refresh" message after the configured ms.
//   • Reference-counted body-scroll lock — safe to have multiple loaders
//     on the page (or show/hide in odd orders) without the page scrolling
//     getting permanently stuck.
//   • Idempotent show/hide — calling show twice is a no-op on the second
//     call; hide after hide is a no-op.
//   • Force-hide fallback — 420 ms after the fade-out, the element is set to
//     display: none directly, so a broken CSS state can never leave a ghost
//     loader on screen.
//   • Self-contained CSS — the styles are injected on first use, so any page
//     can import this module without extra <link>s.

// ============================================================================
// CSS INJECTION (runs once per page)
// ============================================================================

const LOADER_CSS_ID = 'acadex-loader-styles';

function ensureLoaderStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(LOADER_CSS_ID)) return;

  const style = document.createElement('style');
  style.id = LOADER_CSS_ID;
  style.textContent = `
    /* ── Fullscreen loader (student-dashboard-style) ── */
    .acadex-fs-loader {
      position: fixed;
      inset: 0;
      background: rgba(242, 242, 247, 0.94);
      -webkit-backdrop-filter: blur(14px);
      backdrop-filter: blur(14px);
      z-index: 9998;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1.15rem;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 0.35s ease, visibility 0.35s ease;
    }
    .acadex-fs-loader.active {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }

    /* ── Overlay loader (faint transparent — sub-pages) ── */
    .acadex-ov-loader {
      position: fixed;
      inset: 0;
      background: rgba(255, 255, 255, 0.55);
      -webkit-backdrop-filter: blur(3px);
      backdrop-filter: blur(3px);
      z-index: 9997;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.85rem;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 0.28s ease, visibility 0.28s ease;
    }
    .acadex-ov-loader.active {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }

    /* ── Shared spinner (rotating arc) ── */
    .acadex-spinner svg { display: block; }
    .acadex-spinner-track { stroke: rgba(0, 122, 255, 0.16); }
    .acadex-spinner-ring {
      stroke: #007AFF;
      animation: acadex-spin 0.9s linear infinite;
      transform-origin: center;
    }
    @keyframes acadex-spin { to { transform: rotate(360deg); } }

    /* ── Shared label ── */
    .acadex-loader-label {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text',
                   'SF Pro Display', 'Inter', 'Helvetica Neue', Arial, sans-serif;
      font-size: 0.9rem;
      font-weight: 600;
      color: rgba(60, 60, 67, 0.6);
      letter-spacing: -0.005em;
      text-align: center;
    }
    .acadex-ov-loader .acadex-loader-label { font-size: 0.82rem; }

    /* ── Failsafe block (swapped in on timeout) ── */
    .acadex-loader-failsafe {
      text-align: center;
      padding: 1rem;
    }
    .acadex-loader-failsafe .icon {
      font-size: 2.5rem;
      margin-bottom: 0.75rem;
    }
    .acadex-loader-failsafe p {
      color: rgba(60, 60, 67, 0.6);
      font-size: 0.9rem;
      line-height: 1.6;
      margin: 0;
    }
    .acadex-loader-failsafe strong { color: #000; }
    .acadex-loader-failsafe a {
      color: #007AFF;
      text-decoration: underline;
      font-weight: 600;
    }

    /* ── Sizes ── */
    .acadex-spinner-lg svg { width: 60px; height: 60px; }
    .acadex-spinner-md svg { width: 44px; height: 44px; }
    .acadex-spinner-sm svg { width: 32px; height: 32px; }

    @media (max-width: 768px) {
      .acadex-spinner-lg svg { width: 52px; height: 52px; }
    }
  `;
  document.head.appendChild(style);
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

function spinnerSVG(sizeClass) {
  return `
    <div class="acadex-spinner ${sizeClass}">
      <svg viewBox="0 0 40 40">
        <circle class="acadex-spinner-track" cx="20" cy="20" r="16"
                fill="none" stroke-width="3"/>
        <circle class="acadex-spinner-ring" cx="20" cy="20" r="16"
                fill="none" stroke-width="3" stroke-linecap="round"
                pathLength="100" stroke-dasharray="25 100"/>
      </svg>
    </div>
  `;
}

function escapeHtmlLocal(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

// Reference-counted body-scroll lock — safe with multiple loaders.
let bodyScrollLockCount = 0;
let originalBodyOverflow = '';

function lockBodyScroll() {
  if (typeof document === 'undefined') return;
  if (bodyScrollLockCount === 0) {
    originalBodyOverflow = document.body.style.overflow || '';
    document.body.style.overflow = 'hidden';
  }
  bodyScrollLockCount++;
}

function unlockBodyScroll() {
  if (typeof document === 'undefined') return;
  if (bodyScrollLockCount > 0) bodyScrollLockCount--;
  if (bodyScrollLockCount === 0) {
    document.body.style.overflow = originalBodyOverflow;
  }
}

// ============================================================================
// LOADER CONTROLLER FACTORY
// ============================================================================

function createLoaderController({
  elementId,
  className,
  sizeClass,
  defaultLabel,
  defaultFailsafeMs,
}) {
  let el = null;
  let failsafeTimer = null;
  let showTimestamp = 0;
  let isActive = false;
  let scrollLocked = false;

  function ensureElement() {
    if (typeof document === 'undefined') return null;
    if (el && document.body.contains(el)) return el;
    ensureLoaderStyles();
    el = document.createElement('div');
    el.id = elementId;
    el.className = className;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = `
      ${spinnerSVG(sizeClass)}
      <div class="acadex-loader-label">${escapeHtmlLocal(defaultLabel)}</div>
    `;
    document.body.appendChild(el);
    return el;
  }

  function show(options = {}) {
    const element = ensureElement();
    if (!element) return;

    const label = options.label;
    if (label) {
      const labelEl = element.querySelector('.acadex-loader-label');
      if (labelEl) labelEl.textContent = label;
    }

    // Idempotent — no re-lock, no double failsafe
    if (!isActive) {
      isActive = true;
      lockBodyScroll();
      scrollLocked = true;
    }

    if (failsafeTimer) {
      clearTimeout(failsafeTimer);
      failsafeTimer = null;
    }

    element.style.display = '';
    element.classList.remove('active');
    void element.offsetHeight;      // force reflow so the transition triggers
    element.classList.add('active');
    showTimestamp = Date.now();

    const failsafeMs = typeof options.failsafeMs === 'number'
      ? options.failsafeMs
      : defaultFailsafeMs;

    if (failsafeMs > 0) {
      failsafeTimer = setTimeout(() => {
        failsafeTimer = null;
        if (element.classList.contains('active')) {
          element.innerHTML = `
            <div class="acadex-loader-failsafe">
              <div class="icon">📶</div>
              <p>
                <strong>Network is taking too long.</strong><br>
                Please check your connection and try again.<br>
                <a href="javascript:location.reload()">Tap to refresh</a>
              </p>
            </div>
          `;
        }
      }, failsafeMs);
    }
  }

  function hide(options = {}) {
    if (!isActive || !el) return;

    const minDisplayMs = typeof options.minDisplayMs === 'number'
      ? options.minDisplayMs
      : 0;
    const elapsed = Date.now() - showTimestamp;
    const wait = Math.max(0, minDisplayMs - elapsed);

    const doHide = () => {
      if (failsafeTimer) {
        clearTimeout(failsafeTimer);
        failsafeTimer = null;
      }
      el.classList.remove('active');
      isActive = false;

      if (scrollLocked) {
        scrollLocked = false;
        unlockBodyScroll();
      }

      // Force-hide fallback (belt and braces)
      setTimeout(() => {
        if (el && !el.classList.contains('active')) {
          el.style.display = 'none';
        }
      }, 420);
    };

    if (wait > 0) {
      setTimeout(doHide, wait);
    } else {
      doHide();
    }
  }

  function isVisible() {
    return !!(el && isActive);
  }

  return { show, hide, isVisible };
}

// ============================================================================
// CONTROLLER INSTANCES
// ============================================================================

const fullscreenController = createLoaderController({
  elementId: 'acadexFullscreenLoaderGlobal',
  className: 'acadex-fs-loader',
  sizeClass: 'acadex-spinner-lg',
  defaultLabel: 'Loading…',
  defaultFailsafeMs: 120000, // 2 minutes
});

const overlayController = createLoaderController({
  elementId: 'acadexOverlayLoaderGlobal',
  className: 'acadex-ov-loader',
  sizeClass: 'acadex-spinner-md',
  defaultLabel: 'Loading…',
  defaultFailsafeMs: 90000, // 90 seconds
});

// ============================================================================
// PUBLIC API — BUTTON LOADING (unchanged)
// ============================================================================

export function showLoading(buttonElement, originalText = null) {
  if (!buttonElement) return;
  if (originalText === null) originalText = buttonElement.innerText;
  buttonElement.disabled = true;
  buttonElement.dataset.originalText = originalText;
  buttonElement.innerHTML =
    '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Loading...';
}

export function hideLoading(buttonElement) {
  if (!buttonElement) return;
  buttonElement.disabled = false;
  const original = buttonElement.dataset.originalText;
  if (original) buttonElement.innerText = original;
  else buttonElement.innerHTML = buttonElement.dataset.originalText || 'Submit';
}

// ============================================================================
// PUBLIC API — FULLSCREEN LOADER (dashboards)
// ============================================================================
//
// Usage:
//   import { showFullscreenLoader, hideFullscreenLoader } from '../js/loading.js';
//   showFullscreenLoader({ label: 'Preparing your dashboard…' });
//   // … await init …
//   hideFullscreenLoader({ minDisplayMs: 600 });
//
// Options for show:
//   { label?: string, failsafeMs?: number }
// Options for hide:
//   { minDisplayMs?: number }

export function showFullscreenLoader(options = {}) {
  fullscreenController.show(options);
}

export function hideFullscreenLoader(options = {}) {
  fullscreenController.hide(options);
}

export function isFullscreenLoaderVisible() {
  return fullscreenController.isVisible();
}

// ============================================================================
// PUBLIC API — OVERLAY LOADER (sub-pages)
// ============================================================================
//
// Usage:
//   import { showOverlayLoader, hideOverlayLoader } from '../js/loading.js';
//   showOverlayLoader({ label: 'Loading class…' });
//   // … await init …
//   hideOverlayLoader();
//
// Options for show:
//   { label?: string, failsafeMs?: number }
// Options for hide:
//   { minDisplayMs?: number }

export function showOverlayLoader(options = {}) {
  overlayController.show(options);
}

export function hideOverlayLoader(options = {}) {
  overlayController.hide(options);
}

export function isOverlayLoaderVisible() {
  return overlayController.isVisible();
}

// ============================================================================
// BACKWARDS-COMPAT ALIASES
// ============================================================================
// Existing code that calls showPageLoader() / hidePageLoader() keeps working;
// it's silently upgraded to the new fullscreen loader.

export function showPageLoader(options = {}) {
  return showFullscreenLoader(options);
}

export function hidePageLoader(options = {}) {
  return hideFullscreenLoader(options);
}

// ============================================================================
// CONVENIENCE WRAPPERS — auto show/hide around a promise or function
// ============================================================================
//
// Usage:
//   await withFullscreenLoader(() => initAdminDashboard(), {
//     label: 'Preparing your dashboard…',
//     minDisplayMs: 600,
//   });
//
// The loader is guaranteed to hide in the finally block, even if the
// wrapped function throws.

export async function withFullscreenLoader(fnOrPromise, options = {}) {
  showFullscreenLoader({
    label: options.label,
    failsafeMs: options.failsafeMs,
  });
  try {
    const result = typeof fnOrPromise === 'function'
      ? await fnOrPromise()
      : await fnOrPromise;
    return result;
  } finally {
    hideFullscreenLoader({ minDisplayMs: options.minDisplayMs });
  }
}

export async function withOverlayLoader(fnOrPromise, options = {}) {
  showOverlayLoader({
    label: options.label,
    failsafeMs: options.failsafeMs,
  });
  try {
    const result = typeof fnOrPromise === 'function'
      ? await fnOrPromise()
      : await fnOrPromise;
    return result;
  } finally {
    hideOverlayLoader({ minDisplayMs: options.minDisplayMs });
  }
}