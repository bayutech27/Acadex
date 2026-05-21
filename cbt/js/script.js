// cbt/js/script.js - UI Logic for CBT Dashboard (mobile menu, navigation)
// This file handles ONLY UI interactions for CBT pages

import { auth } from '../../js/firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";

document.addEventListener('DOMContentLoaded', () => {
  console.log('📄 CBT script.js loaded');

  // ----- Mobile Menu Toggle -----
  const hamburger = document.getElementById('hamburger');
  const mobileMenu = document.getElementById('mobileMenu');

  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('active');
      mobileMenu.classList.toggle('active');
      document.body.style.overflow = mobileMenu.classList.contains('active') ? 'hidden' : '';
    });

    // Close mobile menu when any nav link is clicked
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
      link.addEventListener('click', () => {
        hamburger.classList.remove('active');
        mobileMenu.classList.remove('active');
        document.body.style.overflow = '';
      });
    });
  }

  // ----- Desktop Navigation Active Highlight -----
  const desktopNavLinks = document.querySelectorAll('.desktop-nav-link');
  desktopNavLinks.forEach(link => {
    link.addEventListener('click', function(e) {
      // Remove active class from all, add to current
      desktopNavLinks.forEach(l => l.classList.remove('active'));
      this.classList.add('active');

      // If mobile menu is open, close it (consistency)
      if (mobileMenu && mobileMenu.classList.contains('active')) {
        hamburger.classList.remove('active');
        mobileMenu.classList.remove('active');
        document.body.style.overflow = '';
      }
    });
  });

  // ----- Optional: Auth check (redirect if not logged in) -----
  // This is optional because session validation is already done in HTML.
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      // User is not signed in – redirect to main index (or login page)
      // Uncomment if you want to enforce login globally:
      // window.location.href = '../../index.html';
    }
  });
});