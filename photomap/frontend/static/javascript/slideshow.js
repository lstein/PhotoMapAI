import { saveSettingsToLocalStorage, state } from "./state.js";
import { slideState } from "./slide-state.js";
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

// Whether Swiper's autoplay timer is currently ticking. This goes false for
// the duration of every buffer rebuild and trim, so it answers "is a slide
// about to advance" — not "did the user start the slideshow". Use
// isSlideshowActive() for the latter.
export function slideShowRunning() {
  return !!state.single_swiper?.swiper?.autoplay?.running;
}

// Whether the user wants the slideshow running — true from Play until Pause,
// a swipe, an arrow key or the end of the list (which pauses explicitly in
// swiper.js's slideNextTransitionStart handler), and unaffected by the
// internal autoplay stop/start of a rebuild. This is what the controls must
// consult: pressing Pause during an album-switch rebuild has to pause, not
// be mistaken for a Play press because autoplay happens to be stopped.
export function isSlideshowActive() {
  return !!state.single_swiper?.isSlideshowActive?.();
}

// In sequential mode there is a genuine end of the list, so a stopped slideshow
// resting on the final slide has nowhere to advance to. resolveOffset(+1)
// reports null only at that end (wrap mode always resolves to a real index, and
// random mode has no end), so it cleanly captures the "last slide" case.
function atSequentialEnd() {
  return state.mode !== "random" && slideState.resolveOffset(+1).globalIndex === null;
}

// public: update the icon displayed on the start/stop button according to state
export function updateSlideshowButtonIcon() {
  const container = document.getElementById("slideshowIcon");
  const btn = document.getElementById("startStopSlideshowBtn");
  if (!container) {
    return;
  }

  // Logical state, not autoplay.running: a rebuild stops autoplay for its
  // duration, and the icon must not flip to Play (or the button start acting
  // as Play) while the slideshow is merely rebuilding its buffer.
  const isRunning = isSlideshowActive();
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

  // Gray out and disable Play when stopped on the final slide in sequential
  // mode — there is nothing left to play. Never disable the Pause button.
  if (btn) {
    const disabled = !isRunning && atSequentialEnd();
    btn.classList.toggle("slideshow-disabled", disabled);
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

  // Ignore clicks while parked on the last sequential slide (button is grayed
  // out): there is nothing to start.
  if (!isSlideshowActive() && atSequentialEnd()) {
    return;
  }

  if (isSlideshowActive()) {
    // pause
    const wasShuffling = state.mode === "random";
    try {
      state.single_swiper.pauseSlideshow();
      // A shuffle run fills the swiper buffer with slides in random order. Once
      // stopped, the forward/back buttons just walk that buffer, so the user
      // would see the shuffled neighborhood instead of the current image's real
      // sequential neighbors. Rebuild the buffer in album order around the
      // current slide so manual navigation behaves sequentially again.
      // (Sequential runs already leave an in-order buffer, so only shuffle needs
      // this.)
      if (wasShuffling) {
        await state.single_swiper.resetAllSlides();
      }
    } catch (err) {
      console.warn("pauseSlideshow failed:", err);
    }
    showPlayPauseIndicator(false);
    updateSlideshowButtonIcon();
    return;
  }

  // Listeners prepare the view (leave grid view, rebuild the buffer around
  // the current slide, close the semantic map). The rebuild runs
  // asynchronously; resumeSlideshow() below records that the slideshow is
  // wanted and the rebuild starts autoplay when it finishes — or leaves it
  // stopped if the user pauses again before then.
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

// Switch the slideshow mode ("chronological" or "random"). Shared by the mode
// menu on the Play button and the radios in the settings modal, so both behave
// identically: the mode is written and persisted at once, a running slideshow
// is paused, and a shuffled buffer is rebuilt in album order.
export async function setSlideshowMode(modeVal) {
  const wasShuffling = state.mode === "random";
  const wasRunning = isSlideshowActive();
  // Write and persist the new mode synchronously so the last click always
  // wins: the rebuild below awaits several image fetches, and a second pick
  // made during that window must not be overwritten when this one resumes.
  // Everything after this line is driven by the locally captured outgoing
  // mode, never by re-reading state.mode.
  state.mode = modeVal;
  saveSettingsToLocalStorage();
  // Lets the other mode control (menu icon vs settings radios) mirror the
  // change without either importing the other's DOM.
  window.dispatchEvent(new CustomEvent("slideshowModeChanged", { detail: { mode: modeVal } }));
  if (wasRunning) {
    state.single_swiper.pauseSlideshow();
    showPlayPauseIndicator(false);
  }
  // A shuffle run leaves the swiper buffer in random order, so prev/next
  // would walk the leftover shuffle instead of the current image's real
  // neighbors. Rebuild in album order when a shuffle run was just stopped
  // here, and also when leaving shuffle with the slideshow already stopped:
  // an arrow key, a swipe or a scrollbar drag halts autoplay without ever
  // running the pause path, so a shuffled buffer may still be on screen.
  if (wasShuffling && (wasRunning || modeVal !== "random")) {
    try {
      await state.single_swiper?.resetAllSlides();
    } catch (err) {
      console.warn("resetAllSlides failed:", err);
    }
  }
  updateSlideshowButtonIcon();
}

// right-click menu to choose chronological vs random. `anchorAbove` is the
// rect of a control the menu must not cover (see the positioning block below).
function createModeMenu(x, y, anchorAbove = null) {
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
      removeModeMenu();
      await setSlideshowMode(modeVal);
    };
    return b;
  };

  menu.appendChild(makeButton(PLAY_SVG, "Sequential", "chronological"));
  menu.appendChild(makeButton(SHUFFLE_SVG, "Shuffled", "random"));

  document.body.appendChild(menu);

  // Position after appending so we can measure the menu height
  const menuHeight = menu.offsetHeight;
  const windowHeight = window.innerHeight;

  let finalY = y;
  if (anchorAbove) {
    // Opened from a control rather than a pointer, so the menu has to sit
    // fully clear above that control. The control panel is pinned to the
    // bottom of the window, so the plain overflow flip below would always
    // land the menu *on top of* the chevron — and the click meant to toggle
    // the menu shut would hit a mode button instead, silently changing (and
    // persisting) the slideshow mode.
    finalY = Math.max(6, anchorAbove.top - menuHeight - 6);
  } else if (y + menuHeight > windowHeight) {
    // If menu would go off bottom of screen, position it above the click
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
  // Defer so the same click that opened the menu doesn't immediately close it.
  const attachTimer = setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
  }, 0);
  // Cancelling the timer is the load-bearing part: removeModeMenu() can run
  // before it fires (the chevron toggles the menu shut on a second click), and
  // removing listeners that have not been added yet would not stop the pending
  // timeout from attaching them to a menu that no longer exists.
  menu._cleanup = () => {
    clearTimeout(attachTimer);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  };
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

  // The chevron beside the button is the discoverable way in; right-click and
  // long-press on the button itself still work and are unchanged. It stays
  // live even while the Play button is greyed out at the end of a sequential
  // run — switching to Shuffled is the way out of that state.
  const menuBtn = document.getElementById("slideshowModeMenuBtn");
  if (menuBtn) {
    const toggleModeMenu = (e) => {
      // contextmenu is routed here too: a long-press on the chevron would
      // otherwise raise the browser's own menu instead of ours.
      e.preventDefault();
      // Deliberately NOT stopPropagation: every other popup in the app closes
      // from a listener on document, so swallowing this click here would
      // strand the bookmarks menu or the back flyout open behind this one.
      if (document.getElementById("slideshowModeMenu")) {
        removeModeMenu();
        return;
      }
      // Anchor to the chevron, not the pointer, so a keyboard or touch
      // activation (which carries no useful coordinates) lands in the same
      // place as a mouse click, and so the menu can be kept clear of it.
      const rect = menuBtn.getBoundingClientRect();
      createModeMenu(rect.left, rect.top, rect);
    };
    menuBtn.addEventListener("click", toggleModeMenu);
    menuBtn.addEventListener("contextmenu", toggleModeMenu);
  }

  // ensure icon reflects current state on init
  updateSlideshowButtonIcon();

  // Listen for seekToSlideIndex event
  window.addEventListener("seekToSlideIndex", () => {
    state.single_swiper.pauseSlideshow();
    updateSlideshowButtonIcon();
  });
}
