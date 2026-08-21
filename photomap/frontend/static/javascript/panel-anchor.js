// panel-anchor.js
//
// Keeps the bottom-anchored panels inside the *visible* viewport.
//
// #controlPanel and #searchPanel are `position: fixed; bottom: 10px`, which
// resolves against the layout viewport. On iPadOS that is not always the part
// of the page you can see: leaving fullscreen shrinks the visible area as the
// browser chrome returns, and WebKit can keep the taller, fullscreen-sized
// layout viewport afterwards. The panels are then laid out ten pixels above a
// bottom edge that is off the tablet — the user watches them slide past the
// bottom of the screen on the way out of fullscreen and never sees them again,
// because nothing in the page ever re-lays them out. Rotating does not help and
// only a reload clears it.
//
// window.visualViewport reports the region that is actually on screen, so the
// distance between its bottom and the layout viewport's bottom is exactly how
// far the panels overshoot. Translating them back up by that much puts them
// where the CSS intended. When the two agree — every desktop browser, and iPad
// when it behaves — the offset is zero and this does nothing at all.

// The visible area shrinks by less than this for reasons that are not a
// stranded layout viewport: sub-pixel rounding, and the first fraction of a
// pinch before the scale guard below takes over. Browser chrome is far taller
// than this, so nothing real is filtered out.
const MIN_OVERSHOOT_PX = 24;

// A resample after the viewport has had time to settle. The iPadOS fullscreen
// exit is animated, so a sample taken mid-transition can be wrong, and the
// event that would correct it may already have fired.
const SETTLE_DELAY_MS = 300;

let anchored = [];
let appliedOvershoot = 0;
let settleTimer = null;

/** Is the software keyboard likely to be the reason the viewport shrank? */
function isTextEntryFocused() {
  const active = document.activeElement;
  if (!active) {
    return false;
  }
  return active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
}

/**
 * How far the layout viewport's bottom edge currently sits below the visible
 * one, as measured right now.
 */
function liveOvershoot() {
  const viewport = window.visualViewport;
  if (!viewport) {
    return 0;
  }
  // Zoomed in, the visual viewport is a window onto the page and WebKit
  // already treats fixed elements specially; correcting on top of that would
  // drag the panels around under the user's fingers.
  if (viewport.scale > 1.01) {
    return 0;
  }
  const overshoot = document.documentElement.clientHeight - (viewport.offsetTop + viewport.height);
  return Number.isFinite(overshoot) && overshoot >= MIN_OVERSHOOT_PX ? Math.round(overshoot) : 0;
}

/**
 * The lowest client-coordinate y that is actually on screen.
 *
 * Anything positioning itself against the bottom of the window — a flyout
 * clamped so it does not overflow, say — has the same problem the panels do
 * and wants this instead of window.innerHeight.
 *
 * @returns {number} y coordinate of the visible bottom edge
 */
export function visibleViewportBottom() {
  return document.documentElement.clientHeight - liveOvershoot();
}

/** Re-seat the registered panels against the current viewport. */
export function syncPanelAnchor() {
  // The software keyboard shrinks the visual viewport exactly as a stranded
  // layout viewport does, and on iPad it is by far the more common of the two:
  // opening the text search dialog would otherwise fling both panels several
  // hundred pixels up into the middle of the photo, on top of the dialog they
  // belong under. There is nothing in the geometry to tell the two apart, so
  // while a text field holds focus the last correction is held instead of
  // recomputed.
  const overshoot = isTextEntryFocused() ? appliedOvershoot : liveOvershoot();
  appliedOvershoot = overshoot;

  anchored.forEach((panel) => {
    if (panel) {
      panel.style.transform = overshoot ? `translateY(${-overshoot}px)` : "";
    }
  });
}

/** Resync once more after the viewport has settled, coalescing repeat calls. */
function scheduleSettleResync() {
  syncPanelAnchor();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(syncPanelAnchor, SETTLE_DELAY_MS);
}

/**
 * Register the panels and start following the viewport.
 *
 * @param {Array<HTMLElement|null>} panels elements to keep on screen
 */
export function initializePanelAnchor(panels) {
  anchored = panels.filter(Boolean);
  appliedOvershoot = 0;

  window.addEventListener("resize", scheduleSettleResync);
  window.addEventListener("orientationchange", scheduleSettleResync);
  if (window.visualViewport) {
    // The visible area shrinking is the signal that fires most reliably on the
    // platform this exists for: the layout viewport does not change on a
    // stranded exit, so window.resize may never come.
    window.visualViewport.addEventListener("resize", scheduleSettleResync);
    window.visualViewport.addEventListener("scroll", scheduleSettleResync);
  }
  // Focus changes bracket the software keyboard, and the held correction has
  // to be recomputed once it goes away again.
  window.addEventListener("focusin", scheduleSettleResync);
  window.addEventListener("focusout", scheduleSettleResync);

  syncPanelAnchor();
}
