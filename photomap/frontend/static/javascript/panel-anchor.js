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

// How long after a text field blurs the correction stays held. On iPad the
// blur arrives while the software keyboard is still fully on screen — hiding
// the search panel blurs its input first, the keyboard collapses after — so
// the first resyncs after blur sample a viewport still shrunk by the
// keyboard. Recomputing then would briefly treat the keyboard as browser
// chrome and bounce everything sized by the correction. The keyboard's hide
// animation is well under this; the timer resyncs with the truth at the end.
const KEYBOARD_COLLAPSE_MS = 700;

let anchored = [];
let settleTimer = null;
let keyboardSettling = false;
let keyboardCollapseTimer = null;

/** Can focusing this element summon the software keyboard? */
function isTextEntry(element) {
  if (!element) {
    return false;
  }
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

/** Is the software keyboard likely to be the reason the viewport shrank? */
function isTextEntryFocused() {
  return isTextEntry(document.activeElement);
}

/** Keep the correction held across the keyboard's hide animation. */
function noteTextEntryBlur(element) {
  if (!isTextEntry(element)) {
    return;
  }
  keyboardSettling = true;
  clearTimeout(keyboardCollapseTimer);
  keyboardCollapseTimer = setTimeout(() => {
    keyboardSettling = false;
    syncPanelAnchor();
  }, KEYBOARD_COLLAPSE_MS);
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

/**
 * Is what visibleViewportBottom() reports right now trustworthy?
 *
 * The software keyboard shrinks the visible viewport exactly as a stranded
 * layout viewport does, and nothing in the geometry tells the two apart — see
 * syncPanelAnchor(), which holds its correction rather than guess. Re-seating
 * a panel on a bad sample is self-correcting; anything that acts on the
 * measurement irreversibly (collapsing a section and persisting that, say)
 * wants to know first, and to do nothing until this is true again.
 *
 * @returns {boolean} false while a text field is focused and until the
 *   keyboard has finished collapsing after it blurs
 */
export function visibleViewportSettled() {
  return !isTextEntryFocused() && !keyboardSettling;
}

/** Re-seat the registered panels against the current viewport. */
export function syncPanelAnchor() {
  // The software keyboard shrinks the visual viewport exactly as a stranded
  // layout viewport does, and on iPad it is by far the more common of the two:
  // opening the text search dialog would otherwise fling both panels several
  // hundred pixels up into the middle of the photo, on top of the dialog they
  // belong under. There is nothing in the geometry to tell the two apart, so
  // from focus until the keyboard has finished collapsing after blur, the
  // correction is left exactly as it is — recomputing on the blur edge would
  // sample the still-raised keyboard, and recomputing the published height
  // from a fresh clientHeight against a held overshoot mixes two moments.
  //
  // Pinch-zoom holds for the same reason: zoomed in, the visual viewport is a
  // window onto the page and WebKit already treats fixed elements specially.
  // Recomputing per-frame would drag the panels under the user's fingers, and
  // clearing would grow the photo 40px mid-gesture on a stranded viewport —
  // the overshoot has not gone away just because the user zoomed.
  const zoomed = window.visualViewport && window.visualViewport.scale > 1.01;
  if (isTextEntryFocused() || keyboardSettling || zoomed) {
    return;
  }

  const overshoot = liveOvershoot();

  anchored.forEach((panel) => {
    if (panel) {
      panel.style.transform = overshoot ? `translateY(${-overshoot}px)` : "";
    }
  });

  // The swiper container and slide images are sized with 100dvh, which
  // resolves against the same stranded layout viewport the panels are anchored
  // to — so after a stranded fullscreen exit the bottom of the photo hangs off
  // the screen too. Publish the visible height for those rules to consume
  // (they fall back to 100dvh when it is unset).
  const root = document.documentElement;
  if (overshoot) {
    root.style.setProperty("--visible-viewport-height", `${root.clientHeight - overshoot}px`);
  } else {
    root.style.removeProperty("--visible-viewport-height");
  }
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
  keyboardSettling = false;
  clearTimeout(keyboardCollapseTimer);

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
  // to be recomputed once it goes away again — but only after the keyboard's
  // hide animation, which starts after the blur, has finished.
  window.addEventListener("focusin", scheduleSettleResync);
  window.addEventListener("focusout", (event) => {
    noteTextEntryBlur(event.target);
    scheduleSettleResync();
  });

  syncPanelAnchor();
}
