/* =========================================================
   AC A D E X — VISIONOS CARD PHYSICS ENGINE
   Works with:
   .stat-card
   .mobile-nav-card
   .sidebar-nav a
   .payment-banner
   ========================================================= */

const cards = document.querySelectorAll(`
  .stat-card,
  .mobile-nav-card,
  .sidebar-nav a,
  .payment-banner
`);

/* ---------------------------------------------------------
   1. SOFT 3D TILT ENGINE (MOUSE + TOUCH)
--------------------------------------------------------- */
cards.forEach((card) => {
  let rect = null;

  const updateRect = () => (rect = card.getBoundingClientRect());

  window.addEventListener("resize", updateRect);
  updateRect();

  let raf;

  const onMove = (x, y) => {
    cancelAnimationFrame(raf);

    raf = requestAnimationFrame(() => {
      if (!rect) return;

      const px = (x - rect.left) / rect.width;
      const py = (y - rect.top) / rect.height;

      const rotateX = (py - 0.5) * -10; // tilt up/down
      const rotateY = (px - 0.5) * 10;  // tilt left/right

      card.style.transform = `
        perspective(1200px)
        rotateX(${rotateX}deg)
        rotateY(${rotateY}deg)
        translateZ(8px)
      `;

      /* dynamic light hotspot */
      card.style.setProperty("--x", `${px * 100}%`);
      card.style.setProperty("--y", `${py * 100}%`);
    });
  };

  /* mouse */
  card.addEventListener("mousemove", (e) => {
    onMove(e.clientX, e.clientY);
  });

  card.addEventListener("mouseleave", () => {
    card.style.transform = `
      perspective(1200px)
      rotateX(0deg)
      rotateY(0deg)
      translateZ(0px)
    `;
  });

  /* touch (mobile) */
  card.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (t) onMove(t.clientX, t.clientY);
  }, { passive: true });

  card.addEventListener("touchend", () => {
    card.style.transform = `
      perspective(1200px)
      rotateX(0deg)
      rotateY(0deg)
      translateZ(0px)
    `;
  });
});


/* ---------------------------------------------------------
   2. SCROLL DEPTH SYSTEM (Apple-like floating layers)
--------------------------------------------------------- */
const scrollCards = document.querySelectorAll(".stat-card, .mobile-nav-card");

window.addEventListener("scroll", () => {
  const scrollY = window.scrollY;

  scrollCards.forEach((card, i) => {
    const offset = (scrollY * 0.02) * (i % 3 === 0 ? 1 : -1);

    card.style.transform += `
      translateY(${offset}px)
    `;
  });
});


/* ---------------------------------------------------------
   3. SOFT INERTIA RESET LOOP (physics smoothing)
--------------------------------------------------------- */
function resetIdleCards() {
  cards.forEach((card) => {
    const style = card.style.transform || "";

    if (style.includes("rotateX") || style.includes("rotateY")) return;

    card.style.transform = `
      perspective(1200px)
      rotateX(0deg)
      rotateY(0deg)
      translateZ(0px)
    `;
  });
}

setInterval(resetIdleCards, 2500);


/* ---------------------------------------------------------
   4. PRESS DEPTH (real “push-in” feel)
--------------------------------------------------------- */
cards.forEach((card) => {
  card.addEventListener("mousedown", () => {
    card.style.transform += " scale(0.98) translateZ(-2px)";
  });

  card.addEventListener("mouseup", () => {
    card.style.transform = card.style.transform.replace(
      "scale(0.98) translateZ(-2px)",
      ""
    );
  });

  card.addEventListener("touchstart", () => {
    card.style.transform += " scale(0.98)";
  });

  card.addEventListener("touchend", () => {
    card.style.transform = card.style.transform.replace(" scale(0.98)", "");
  });
});