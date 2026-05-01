// menu.js - shared hamburger menu setup
export function initMobileMenu() {
  const hamburger = document.querySelector('.hamburger-menu');
  const mobileSidebar = document.getElementById('mobileSidebar');
  const overlay = document.getElementById('overlay');
  const closeBtn = document.querySelector('.close-sidebar');

  if (!hamburger || !mobileSidebar || !overlay) return;

  function openMenu() {
    mobileSidebar.classList.add('open');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeMenu() {
    mobileSidebar.classList.remove('open');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  hamburger.addEventListener('click', openMenu);
  if (closeBtn) closeBtn.addEventListener('click', closeMenu);
  overlay.addEventListener('click', closeMenu);
}