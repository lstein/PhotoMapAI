// back-button.js
// UI wiring for the Back button in the control panel. Left-click pops one
// step off the back stack; right-click (or long-press) opens a flyout of
// recent positions as thumbnails the user can jump to directly.

import { backStack } from "./back-stack.js";
import { visibleViewportBottom } from "./panel-anchor.js";
import { state } from "./state.js";

const FLYOUT_ROWS = 3;
const FLYOUT_COLS = 4;
const FLYOUT_LIMIT = FLYOUT_ROWS * FLYOUT_COLS;
const DISABLED_CLASS = "back-nav-disabled";
const FLYOUT_ID = "backNavFlyout";
const MENU_BTN_ID = "backNavMenuBtn";

function updateButtonState(btn) {
  // Back is possible only when there is something to back up to — i.e. at
  // least two entries (current + previous).
  const enabled = backStack.size() >= 2;
  btn.classList.toggle(DISABLED_CLASS, !enabled);
  // The chevron opens a flyout built from the same stack, so it is dead
  // whenever Back is. Kept in step here rather than in CSS because the flyout
  // is emptied by albumChanged too, not only by navigation.
  const menuBtn = document.getElementById(MENU_BTN_ID);
  if (menuBtn) {
    menuBtn.disabled = !enabled;
  }
}

function removeFlyout() {
  const existing = document.getElementById(FLYOUT_ID);
  if (existing) {
    if (existing._cleanup) {
      existing._cleanup();
    }
    existing.remove();
  }
}

function thumbnailUrl(globalIndex) {
  if (!state.album) {
    return "";
  }
  return `thumbnails/${encodeURIComponent(state.album)}/${globalIndex}?size=128`;
}

function populateFlyout(flyout) {
  flyout.replaceChildren();
  const entries = backStack.recent(FLYOUT_LIMIT);
  // Anchor the fill to the bottom-right with the OLDEST entry in the corner;
  // newer entries walk upward in the rightmost column, then jump one column
  // left at the next column's bottom. backStack.recent() is newest-first, so
  // iterate from the tail to place the oldest first. When fewer than
  // FLYOUT_LIMIT entries exist, the unfilled slots land at the top-left.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[entries.length - 1 - i];
    const img = document.createElement("img");
    img.className = "back-nav-thumb";
    img.style.gridColumn = String(FLYOUT_COLS - Math.floor(i / FLYOUT_ROWS));
    img.style.gridRow = String(FLYOUT_ROWS - (i % FLYOUT_ROWS));
    img.src = thumbnailUrl(entry.globalIndex);
    img.alt = `slide ${entry.globalIndex}`;
    img.title = `Back to ${entry.kind === "step" ? "earlier slide" : entry.kind} #${entry.globalIndex}`;
    img.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeFlyout();
      backStack.popToEntry(entry.id);
    });
    flyout.appendChild(img);
  }
}

function clampFlyoutPosition(flyout) {
  const rect = flyout.getBoundingClientRect();
  const margin = 6;
  // Not window.innerHeight: on iPadOS the bottom of the layout viewport can be
  // off the screen (see panel-anchor.js), and clamping to it puts the bottom
  // row of thumbnails somewhere the user cannot see.
  const bottom = visibleViewportBottom();
  let left = flyout._anchorX;
  let top = flyout._anchorY;
  if (left + rect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (top + rect.height > bottom - margin) {
    top = Math.max(margin, bottom - rect.height - margin);
  }
  flyout.style.left = `${left}px`;
  flyout.style.top = `${top}px`;
}

// Rebuilds the open flyout (if any) from the current back stack. Called on
// every backStackChanged so keyboard / scrollwheel / swiper navigation while
// the flyout is open reflects the latest position list in real time.
function refreshFlyout() {
  const flyout = document.getElementById(FLYOUT_ID);
  if (!flyout) {
    return;
  }
  if (backStack.recent(FLYOUT_LIMIT).length === 0) {
    removeFlyout();
    return;
  }
  populateFlyout(flyout);
  clampFlyoutPosition(flyout);
}

function buildFlyout(x, y) {
  removeFlyout();

  const entries = backStack.recent(FLYOUT_LIMIT);
  if (entries.length === 0) {
    return;
  }

  const flyout = document.createElement("div");
  flyout.id = FLYOUT_ID;
  flyout._anchorX = x;
  flyout._anchorY = y;
  populateFlyout(flyout);

  document.body.appendChild(flyout);
  // Position after appending so we can measure the flyout's actual size.
  clampFlyoutPosition(flyout);

  const onDocClick = (ev) => {
    if (!flyout.contains(ev.target)) {
      removeFlyout();
    }
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      removeFlyout();
    }
  };
  // Defer so the same click that opened the flyout doesn't immediately close it.
  const attachTimer = setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
  }, 0);
  // Cancelling the timer is the load-bearing part: removeFlyout() can run
  // before it fires (the chevron toggles the flyout shut on a second click),
  // and removing listeners that have not been added yet would not stop the
  // pending timeout from attaching them to a flyout that no longer exists.
  flyout._cleanup = () => {
    clearTimeout(attachTimer);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  };
}

export function showBackFlyout(x, y) {
  buildFlyout(x, y);
}

export function initializeBackButton() {
  const btn = document.getElementById("backNavBtn");
  if (!btn) {
    return;
  }

  updateButtonState(btn);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.classList.contains(DISABLED_CLASS)) {
      return;
    }
    backStack.popOne();
  });

  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (backStack.size() < 2) {
      return;
    }
    buildFlyout(e.clientX + 6, e.clientY + 6);
  });

  // The chevron is the discoverable way in; right-click and long-press on the
  // Back button itself still work and are unchanged.
  const menuBtn = document.getElementById(MENU_BTN_ID);
  if (menuBtn) {
    const toggleFlyout = (e) => {
      // contextmenu is routed here too: a long-press on the chevron would
      // otherwise raise the browser's own menu instead of ours.
      e.preventDefault();
      e.stopPropagation();
      if (document.getElementById(FLYOUT_ID)) {
        removeFlyout();
        return;
      }
      if (backStack.size() < 2) {
        return;
      }
      // Anchor to the chevron, not the pointer, so a keyboard or touch
      // activation (which carries no useful coordinates) lands in the same
      // place as a mouse click. clampFlyoutPosition() lifts it into view.
      const rect = menuBtn.getBoundingClientRect();
      buildFlyout(rect.left, rect.top);
    };
    menuBtn.addEventListener("click", toggleFlyout);
    menuBtn.addEventListener("contextmenu", toggleFlyout);
  }

  // The back stack emits backStackChanged on every mutation. Listening for
  // that (rather than slideChanged) keeps the button in sync even when the
  // swiper suppresses its own slideChange event during an in-place restore.
  // Same event drives live refresh of the open flyout so keyboard / scroll
  // navigation updates the thumbnail strip without the user reopening it.
  window.addEventListener("backStackChanged", () => {
    updateButtonState(btn);
    refreshFlyout();
  });
  window.addEventListener("albumChanged", () => removeFlyout());
}
