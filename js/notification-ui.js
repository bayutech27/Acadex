// notification-ui.js
/**
 * Render the notification list inside the given container.
 * @param {Array} notifications - sorted array of notification objects.
 * @param {HTMLElement} container - the DOM element to populate.
 */
export function renderNotificationList(notifications, container) {
  if (!container) return;

  if (!notifications || notifications.length === 0) {
    container.innerHTML = `
      <div class="empty-notification">
        <i class="fa-regular fa-bell-slash"></i>
        No notifications yet
      </div>`;
    return;
  }

  container.innerHTML = notifications.map(n => {
    const icon = n.type === 'score' ? '📊' : n.type === 'cbt' ? '📝' : '🔔';
    const unreadClass = n.read ? '' : 'unread';
    return `
      <div class="notification-item ${unreadClass}" data-id="${n.id}" data-read="${n.read}">
        <span class="notif-icon">${icon}</span>
        <div class="notif-body">
          <div class="notif-title">${escapeHtml(n.title)}</div>
          <div class="notif-text">${escapeHtml(n.message)}</div>
          <div class="notif-time">${formatNotificationTime(n.createdAt)}</div>
        </div>
        ${!n.read ? '<span class="unread-dot"></span>' : ''}
      </div>`;
  }).join('');
}

/**
 * Update the notification badge.
 * @param {number} count - unread count
 * @param {HTMLElement} badgeElement - the span for the badge
 */
export function renderNotificationBadge(count, badgeElement) {
  if (!badgeElement) return;
  if (count > 0) {
    badgeElement.textContent = count;
    badgeElement.style.display = 'flex';
  } else {
    badgeElement.textContent = '';
    badgeElement.style.display = 'none';
  }
}

/**
 * Format a Firestore timestamp into a relative time string.
 */
export function formatNotificationTime(timestamp) {
  if (!timestamp) return '';
  let date;
  if (timestamp && typeof timestamp.toDate === 'function') {
    date = timestamp.toDate();
  } else if (timestamp instanceof Date) {
    date = timestamp;
  } else {
    return '';
  }

  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
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