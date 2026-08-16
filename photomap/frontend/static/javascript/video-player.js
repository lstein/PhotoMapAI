/**
 * Modal video player.
 *
 * Opens on the `videoPlayRequested` event dispatched by the play badge, over
 * a dimmed backdrop, reusing the shared `.modal-overlay` machinery.
 *
 * The modal owns its own `<video>` element and never borrows one from a
 * slide. Swiper destroys slide DOM nodes as the user navigates
 * (`trimShuffleBacklog`, `enforceHighWaterMark`, `resetAllSlides`), and a
 * detached `<video>` goes on playing audio.
 */

import { state } from "./state.js";

let modal = null;
let videoEl = null;
let titleEl = null;
let fallbackEl = null;
let fallbackMessageEl = null;
let downloadLinkEl = null;
let initialized = false;

// Whether the slideshow was running when the player opened. Restored rather
// than force-started on close, so opening a video from a paused slideshow
// doesn't silently start it.
let slideshowWasRunning = false;

export function isVideoPlayerOpen() {
  return Boolean(modal?.classList.contains("visible"));
}

function showFallback(message, url) {
  if (!fallbackEl) {
    return;
  }
  fallbackMessageEl.textContent = message;
  if (downloadLinkEl) {
    downloadLinkEl.href = url || "#";
    downloadLinkEl.hidden = !url;
  }
  fallbackEl.hidden = false;
  if (videoEl) {
    videoEl.hidden = true;
  }
}

function hideFallback() {
  if (fallbackEl) {
    fallbackEl.hidden = true;
  }
  if (videoEl) {
    videoEl.hidden = false;
  }
}

/**
 * Start playing as soon as the player opens.
 *
 * This runs inside the click on the play badge — window events dispatch
 * synchronously, so the gesture's transient user activation is still live —
 * which is what lets playback start *with sound* instead of being refused by
 * the browser's autoplay policy.
 *
 * A rejection here is not a playback failure and must not raise the error
 * fallback. It means either the browser declined anyway (NotAllowedError, on
 * a stricter policy or a synthetic open) or the load was torn down while
 * still pending (AbortError, from closing the modal quickly). In both cases
 * the native controls are right there for the user.
 */
function startPlayback() {
  const started = videoEl?.play?.();
  started?.catch?.((err) => {
    console.debug("Video autoplay declined:", err?.name || err);
  });
}

/** Stop playback and release the stream. */
function teardownVideo() {
  if (!videoEl) {
    return;
  }
  videoEl.pause();
  // Clearing the src and calling load() is what actually stops the download
  // and the audio. Merely hiding the overlay leaves both running.
  videoEl.removeAttribute("src");
  videoEl.load();
}

export function openVideoPlayer({ url, filename, playable = true } = {}) {
  if (!modal) {
    return;
  }

  if (titleEl) {
    titleEl.textContent = filename || "";
  }

  hideFallback();

  if (!url) {
    showFallback("This video is unavailable.", "");
  } else if (playable === false) {
    // The static hint says browsers generally can't play this container. Say
    // so up front rather than showing a black rectangle, but still offer the
    // file — see the error handler for the cases the hint gets wrong.
    showFallback(`${filename || "This video"} is in a format your browser probably cannot play.`, url);
  } else {
    videoEl.src = url;
    startPlayback();
  }

  // Snapshot before pausing, and restore rather than force-start on close.
  slideshowWasRunning = Boolean(state.swiper?.autoplay?.running);
  state.single_swiper?.pauseSlideshow?.();
  // Otherwise the arrow keys change slides behind the modal while the user is
  // trying to scrub.
  state.swiper?.keyboard?.disable?.();

  modal.classList.add("visible");
  modal.querySelector(".modal-close")?.focus?.();
}

export function closeVideoPlayer() {
  if (!modal || !isVideoPlayerOpen()) {
    return;
  }

  teardownVideo();
  modal.classList.remove("visible");
  hideFallback();

  state.swiper?.keyboard?.enable?.();
  if (slideshowWasRunning) {
    state.single_swiper?.startSlideshow?.();
  }
  slideshowWasRunning = false;
}

export function initializeVideoPlayer() {
  if (initialized) {
    return;
  }
  modal = document.getElementById("videoPlayerModal");
  if (!modal) {
    return;
  }
  videoEl = document.getElementById("videoPlayerElement");
  titleEl = document.getElementById("videoPlayerTitle");
  fallbackEl = document.getElementById("videoPlayerFallback");
  fallbackMessageEl = document.getElementById("videoPlayerFallbackMessage");
  downloadLinkEl = document.getElementById("videoPlayerDownloadLink");

  document.getElementById("videoPlayerCloseBtn")?.addEventListener("click", closeVideoPlayer);

  // Click the backdrop to dismiss, but not a click inside the panel.
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      closeVideoPlayer();
    }
  });

  // The real playability test. No static extension list can get this right in
  // either direction — an HEVC .mp4 plays in Safari but not Firefox — so the
  // player always tries, and reacts to what actually happened.
  videoEl?.addEventListener("error", () => {
    const url = videoEl.getAttribute("src");
    if (!url) {
      return; // teardown clears src, which fires error; not a real failure
    }
    showFallback(`${titleEl?.textContent || "This video"} could not be played in your browser.`, url);
  });

  // A playing video must not be left behind by navigation: the modal would
  // then describe a different slide than the drawer and the UMAP marker, and
  // on an album change the indices are about to be re-based entirely.
  window.addEventListener("slideChanged", closeVideoPlayer);
  window.addEventListener("albumChanged", closeVideoPlayer);

  window.addEventListener("videoPlayRequested", (e) => {
    openVideoPlayer(e.detail || {});
  });

  initialized = true;
}

/** Test seam: drop cached element references so a fresh DOM can be wired. */
export function _resetVideoPlayerForTests() {
  initialized = false;
  modal = null;
  videoEl = null;
  titleEl = null;
  fallbackEl = null;
  fallbackMessageEl = null;
  downloadLinkEl = null;
  slideshowWasRunning = false;
}
