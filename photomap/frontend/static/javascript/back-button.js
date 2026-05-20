// back-button.js
// UI wiring for the Back button in the control panel. Left-click pops one
// step off the back stack; right-click (or long-press) opens a flyout of
// recent positions as thumbnails the user can jump to directly.

import { backStack } from "./back-stack.js";
import { state } from "./state.js";

const FLYOUT_LIMIT = 10;
const DISABLED_CLASS = "back-nav-disabled";
const FLYOUT_ID = "backNavFlyout";

function updateButtonState(btn) {
  // Back is possible only when there is something to back up to — i.e. at
  // least two entries (current + previous).
  if (backStack.size() >= 2) {
    btn.classList.remove(DISABLED_CLASS);
  } else {
    btn.classList.add(DISABLED_CLASS);
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

function buildFlyout(x, y) {
  removeFlyout();

  const entries = backStack.recent(FLYOUT_LIMIT);
  if (entries.length === 0) {
    return;
  }

  const flyout = document.createElement("div");
  flyout.id = FLYOUT_ID;

  for (const entry of entries) {
    const img = document.createElement("img");
    img.className = "back-nav-thumb";
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

  document.body.appendChild(flyout);

  // Position after appending so we can measure the flyout's actual size.
  const rect = flyout.getBoundingClientRect();
  const margin = 6;
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - rect.height - margin);
  }
  flyout.style.left = `${left}px`;
  flyout.style.top = `${top}px`;

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
  setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
  }, 0);
  flyout._cleanup = () => {
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

  // The back stack emits backStackChanged on every mutation. Listening for
  // that (rather than slideChanged) keeps the button in sync even when the
  // swiper suppresses its own slideChange event during an in-place restore.
  window.addEventListener("backStackChanged", () => updateButtonState(btn));
  window.addEventListener("albumChanged", () => removeFlyout());
}
