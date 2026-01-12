import { saveSettingsToLocalStorage, state } from "./state.js";
import { isUmapFullscreen, toggleUmapWindow } from "./umap.js";

// SVG icons used for the button/menu
const PLAY_SVG = `<svg id="playIcon" width="32" height="32" viewBox="0 0 24 24" fill="#fff"><polygon points="5,3 19,12 5,21"/></svg>`;
const PAUSE_SVG = `<svg id="pauseIcon" width="32" height="32" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
const SHUFFLE_SVG = `<svg id="shuffleIcon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 7h3c2 0 3 1 4 3s2 5 4 6c2 1 3 1 4 1"/>
  <path d="M18 13l3 3-3 3"/>
  <path d="M4 17h3c2 0 3-1 4-3s2-5 4-6c2-1 3-1 4-1"/>
  <path d="M18 11l3-3-3-3"/>
</svg>`;

export function slideShowRunning() {
  return !!state.single_swiper?.swiper?.autoplay?.running;
}

// public: update the icon displayed on the start/stop button according to state
export function updateSlideshowButtonIcon() {
  const container = document.getElementById("slideshowIcon");
  const btn = document.getElementById("startStopSlideshowBtn");
  if (!container) {
    return;
  }

  const isRunning = slideShowRunning();
  const mode = state.mode || "chronological";
  const modeLabel = mode === "random" ? "shuffle mode" : "sequential mode";

  if (isRunning) {
    container.innerHTML = PAUSE_SVG;
    if (btn) {
      btn.title = `Pause Slideshow (${modeLabel})`;
    }
  } else {
    if (mode === "random") {
      container.innerHTML = SHUFFLE_SVG;
    } else {
      container.innerHTML = PLAY_SVG;
    }
    if (btn) {
      btn.title = `Start Slideshow (${modeLabel})`;
    }
  }
}

// small fullscreen/play indicator (moved from events.js)
let indicatorTimer = null;
export function showPlayPauseIndicator(isPlaying) {
  removeExistingIndicator();
  const indicator = createIndicator(isPlaying);
  showIndicatorWithAnimation(indicator);
}

export function removeExistingIndicator() {
  const existing = document.getElementById("fullscreen-indicator");
  if (existing) {
    existing.remove();
  }
  if (indicatorTimer) {
    clearTimeout(indicatorTimer);
    indicatorTimer = null;
  }
}

function createIndicator(isPlaying) {
  const indicator = document.createElement("div");
  const play_icon = state.mode === "random" ? "🔀" : "▶";
  indicator.id = "fullscreen-indicator";
  indicator.className = "fullscreen-playback-indicator";
  indicator.innerHTML = isPlaying ? play_icon : "⏸";
  document.body.appendChild(indicator);
  return indicator;
}

function showIndicatorWithAnimation(indicator) {
  requestAnimationFrame(() => indicator.classList.add("show"));
  indicatorTimer = setTimeout(() => {
    indicator.classList.remove("show");
    setTimeout(() => {
      if (indicator.parentNode) {
        indicator.parentNode.removeChild(indicator);
      }
    }, 300);
  }, 800);
}

// toggle function used by the button click
export async function toggleSlideshowWithIndicator(e) {
  if (e && e.preventDefault) {
    e.preventDefault();
    e.stopPropagation();
  }

  if (slideShowRunning()) {
    // pause
    try {
      state.single_swiper.pauseSlideshow();
    } catch (err) {
      console.warn("pauseSlideshow failed:", err);
    }
    showPlayPauseIndicator(false);
    updateSlideshowButtonIcon();
    return;
  }

  window.dispatchEvent(new Event("slideshowStartRequested"));

  // Ensure UMAP closed if necessary
  if (isUmapFullscreen()) {
    toggleUmapWindow(false);
  }

  try {
    state.single_swiper.resumeSlideshow();
    showPlayPauseIndicator(true);
  } catch (err) {
    console.warn("resumeSlideshow failed:", err);
  }
  updateSlideshowButtonIcon();
}

// right-click menu to choose chronological vs random
function createModeMenu(x, y) {
  removeModeMenu();

  const menu = document.createElement("div");
  menu.id = "slideshowModeMenu";
  menu.style.position = "fixed";
  menu.style.background = "rgba(30,30,30,0.95)";
  menu.style.border = "1px solid #444";
  menu.style.padding = "6px";
  menu.style.borderRadius = "6px";
  menu.style.zIndex = 10000;
  menu.style.display = "flex";
  menu.style.flexDirection = "column";
  menu.style.gap = "6px";

  const makeButton = (html, label, modeVal) => {
    const b = document.createElement("button");
    b.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;">${html}<span style="color:#fff">${label}</span></span>`;
    b.style.display = "flex";
    b.style.alignItems = "center";
    b.style.gap = "8px";
    b.style.background = "transparent";
    b.style.border = "none";
    b.style.cursor = "pointer";
    b.onclick = async (ev) => {
      ev.stopPropagation();
      state.mode = modeVal;
      removeModeMenu();
      saveSettingsToLocalStorage();
      if (slideShowRunning()) {
        await toggleSlideshowWithIndicator();
      }
      updateSlideshowButtonIcon();
    };
    return b;
  };

  menu.appendChild(makeButton(PLAY_SVG, "Sequential", "chronological"));
  menu.appendChild(makeButton(SHUFFLE_SVG, "Shuffled", "random"));

  document.body.appendChild(menu);

  // Position after appending so we can measure the menu height
  const menuHeight = menu.offsetHeight;
  const windowHeight = window.innerHeight;

  // If menu would go off bottom of screen, position it above the click
  let finalY = y;
  if (y + menuHeight > windowHeight) {
    finalY = windowHeight - menuHeight - 6; // 6px padding from bottom
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${finalY}px`;

  // close when clicking elsewhere or Esc
  const onDocClick = (ev) => {
    if (!menu.contains(ev.target)) {
      removeModeMenu();
    }
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      removeModeMenu();
    }
  };
  setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    menu._cleanup = () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, 0);
}

function removeModeMenu() {
  const existing = document.getElementById("slideshowModeMenu");
  if (existing) {
    if (existing._cleanup) {
      existing._cleanup();
    }
    existing.remove();
  }
}

// Export for use by touch.js
export function showSlideshowModeMenu(x, y) {
  createModeMenu(x, y);
}

// initialize click and contextmenu for the start/stop button
export function initializeSlideshowControls() {
  const btn = document.getElementById("startStopSlideshowBtn");
  if (!btn) {
    return;
  }

  // left-click toggles
  btn.addEventListener("click", toggleSlideshowWithIndicator);

  // right-click opens mode menu
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    createModeMenu(e.clientX + 6, e.clientY + 6);
  });

  // ensure icon reflects current state on init
  updateSlideshowButtonIcon();

  // Listen for seekToSlideIndex event
  window.addEventListener("seekToSlideIndex", () => {
    state.single_swiper.pauseSlideshow();
    updateSlideshowButtonIcon();
  });
}
