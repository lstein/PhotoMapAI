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
 *
 * A container the browser cannot decode is not a dead end: the player asks
 * the backend to convert the file (see `video_transcode.py`), shows the
 * conversion's progress over the poster, and plays the result. That poll is
 * also the backend's liveness signal — it drops a job nobody is asking about
 * — so closing the player has to stop the polling, which is what the
 * `session` counter below is for.
 */

import { state } from "./state.js";

let modal = null;
let videoEl = null;
let titleEl = null;
let closeBtn = null;
let fallbackEl = null;
let fallbackMessageEl = null;
let downloadLinkEl = null;
let progressEl = null;
let progressMessageEl = null;
let progressBarEl = null;
let progressFillEl = null;
let progressPercentEl = null;
let initialized = false;

// Whether the slideshow was running when the player opened. Restored rather
// than force-started on close, so opening a video from a paused slideshow
// doesn't silently start it.
let slideshowWasRunning = false;

/**
 * Bumped on every open and every close.
 *
 * Every conversion poll captures the value it started under and abandons
 * itself the moment it no longer matches. Without that, a response in flight
 * when the user closes the player — or navigates to a *different* video —
 * lands afterwards and starts playing the wrong clip into a dismissed modal.
 */
let session = 0;
let pollTimer = null;

// What the currently open request is about, so the async conversion path can
// still name the file and offer the original for download.
let current = null;

// Whether the element is playing a converted copy. Decides what an `error`
// means: the first one sends us to the converter, a second one (from the
// conversion itself) is a real dead end and must not loop.
let usingConversion = false;

// How often to ask the backend how the conversion is going. Comfortably
// inside its abandonment window, which is measured in tens of seconds.
const POLL_INTERVAL_MS = 1000;

export function isVideoPlayerOpen() {
  return Boolean(modal?.classList.contains("visible"));
}

/** The subject of a message, when the filename is not known. */
function subject() {
  return current?.filename || "This video";
}

function showFallback(message, url) {
  if (!fallbackEl) {
    return;
  }
  if (progressEl) {
    progressEl.hidden = true;
  }
  fallbackMessageEl.textContent = message;
  if (downloadLinkEl) {
    downloadLinkEl.href = url || "#";
    downloadLinkEl.hidden = !url;
  }
  fallbackEl.hidden = false;
  // The native control bar would otherwise show through the scrim, offering
  // transport controls for something that is not going to play.
  if (videoEl) {
    videoEl.controls = false;
  }
}

/**
 * Show the conversion panel.
 *
 * @param {string} message what is happening, in words
 * @param {number|null} progress 0..1, or null when the backend cannot say
 *   (a source whose duration ffmpeg could not determine). A sweeping bar is
 *   honest about that; a bar sitting at 0% reads as stuck.
 */
function showProgress(message, progress) {
  if (!progressEl) {
    return;
  }
  if (fallbackEl) {
    fallbackEl.hidden = true;
  }
  const known = typeof progress === "number" && Number.isFinite(progress) && progress > 0;
  const percent = known ? Math.round(progress * 100) : 0;

  progressMessageEl.textContent = message;
  progressBarEl?.classList.toggle("video-player-bar--indeterminate", !known);
  progressBarEl?.setAttribute("aria-valuenow", String(percent));
  if (progressFillEl) {
    // Cleared rather than set to 0% in the indeterminate case: the sweep
    // animation supplies the width, and an inline one would override it.
    progressFillEl.style.width = known ? `${percent}%` : "";
  }
  if (progressPercentEl) {
    progressPercentEl.textContent = known ? `${percent}%` : "";
  }
  progressEl.hidden = false;
  if (videoEl) {
    videoEl.controls = false;
  }
}

function hidePanels() {
  if (fallbackEl) {
    fallbackEl.hidden = true;
  }
  if (progressEl) {
    progressEl.hidden = true;
  }
  if (videoEl) {
    videoEl.controls = true;
  }
}

/**
 * Start playing as soon as the player opens.
 *
 * On the direct path this runs inside the click on the play badge — window
 * events dispatch synchronously, so the gesture's transient user activation
 * is still live — which is what lets playback start *with sound* instead of
 * being refused by the browser's autoplay policy.
 *
 * On the conversion path the activation is long gone by the time the file is
 * ready, so the browser may well decline. That is not a failure and must not
 * raise the error fallback: the clip is loaded, the controls are right there,
 * and the user presses play. The same is true of an AbortError from the load
 * being torn down while still pending (closing the modal quickly).
 */
function startPlayback() {
  const started = videoEl?.play?.();
  started?.catch?.((err) => {
    console.debug("Video autoplay declined:", err?.name || err);
  });
}

/** Point the element at `url` and start it. */
function playFrom(url) {
  hidePanels();
  videoEl.src = url;
  startPlayback();
  focusPlayer();
}

/** Stop playback and release the stream, leaving the modal as it is. */
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

/**
 * Focus the video, so Space reaches playback — or the close button when there
 * is nothing to play.
 *
 * shouldIgnoreKeyEvent() lets Space through to the player precisely so the
 * native controls can pause, but a focused <button> activates on Space, so
 * focusing the close button while a clip is playing hands it the key instead
 * and Space *dismisses the player* mid-clip. Verified in Chromium: close
 * button focused, Space fires the button's click; video focused, Space
 * toggles playback.
 *
 * With no src there is nothing for Space to drive and the native controls are
 * hidden behind a panel, so the close button is the right target.
 */
function focusPlayer() {
  const target = videoEl?.getAttribute("src") ? videoEl : closeBtn;
  target?.focus?.();
}

/**
 * Ask the backend for a playable copy, and follow it until it is ready.
 *
 * @param {number} mySession the session this belongs to; anything else means
 *   the player has moved on and this must stop silently.
 */
async function pollConversion(mySession, endpoint) {
  let status;
  try {
    // POST because the first call starts work — but it is idempotent, and
    // repeating it is both how progress is read and how the backend knows
    // somebody is still waiting.
    const response = await fetch(endpoint, { method: "POST" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    status = await response.json();
  } catch (err) {
    if (mySession !== session) {
      return;
    }
    console.debug("Video conversion request failed:", err);
    showFallback(`${subject()} could not be prepared for playback.`, current?.url || "");
    return;
  }

  if (mySession !== session) {
    return;
  }

  if (status.state === "ready" && status.url) {
    usingConversion = true;
    playFrom(status.url);
    return;
  }

  if (status.state === "queued" || status.state === "running") {
    showProgress(
      status.state === "queued" ? "Waiting to convert this video…" : "Converting this video for playback…",
      status.progress
    );
    pollTimer = setTimeout(() => pollConversion(mySession, endpoint), POLL_INTERVAL_MS);
    return;
  }

  // "failed", "unavailable", and the should-not-happen "ready" with no URL.
  // The original file is still offered: it may well play in another
  // application even though no browser will touch it.
  showFallback(status.detail || `${subject()} could not be converted for playback.`, current?.url || "");
}

/** Hand this video to the backend converter. */
function beginConversion(mySession) {
  const endpoint = current?.transcodeUrl;
  if (!endpoint) {
    // An older server, or a payload with no conversion route. Behave the way
    // the player did before conversion existed.
    showFallback(`${subject()} is in a format your browser cannot play.`, current?.url || "");
    return;
  }

  // Release the original first. It is still streaming bytes that nothing can
  // decode, and on a large file over a slow mount that competes for
  // bandwidth with the conversion's own reads.
  teardownVideo();
  showProgress("Preparing this video for playback…", null);
  focusPlayer();
  pollConversion(mySession, endpoint);
}

export function openVideoPlayer({ url, filename, playable = true, poster = "", transcodeUrl = "" } = {}) {
  if (!modal) {
    return;
  }

  // Supersede anything the previous open left in flight before touching any
  // shared state below.
  const mySession = ++session;
  clearTimeout(pollTimer);
  pollTimer = null;
  current = { url, filename, transcodeUrl };
  usingConversion = false;

  if (titleEl) {
    titleEl.textContent = filename || "";
  }

  // The extracted still, which the frame sizes itself from and which stays
  // visible behind the conversion panel. Removed rather than left stale when
  // there is none, or the previous clip's frame shows behind this one.
  if (videoEl) {
    if (poster) {
      videoEl.setAttribute("poster", poster);
    } else {
      videoEl.removeAttribute("poster");
    }
  }

  hidePanels();

  // Mark the modal open before anything can start streaming. closeVideoPlayer
  // early-returns when the modal is not visible, so a close arriving between
  // "src is set" and "modal is visible" would be a silent no-op and leave the
  // video playing — audible — behind a modal the user never saw.
  modal.classList.add("visible");

  if (!url) {
    showFallback("This video is unavailable.", "");
    focusPlayer();
  } else if (playable === false) {
    // The container is one browsers generally cannot decode. Skip the
    // black-rectangle-then-error round trip and convert straight away.
    beginConversion(mySession);
  } else {
    playFrom(url);
  }

  // Snapshot before pausing, and restore rather than force-start on close.
  slideshowWasRunning = Boolean(state.swiper?.autoplay?.running);
  state.single_swiper?.pauseSlideshow?.();
  // Otherwise the arrow keys change slides behind the modal while the user is
  // trying to scrub.
  state.swiper?.keyboard?.disable?.();
}

export function closeVideoPlayer() {
  if (!modal || !isVideoPlayerOpen()) {
    return;
  }

  // Strands any conversion poll in flight, and tells the backend — which
  // treats the absence of polls as abandonment — that this job can be dropped.
  session++;
  clearTimeout(pollTimer);
  pollTimer = null;

  teardownVideo();
  videoEl?.removeAttribute("poster");
  modal.classList.remove("visible");
  hidePanels();
  current = null;
  usingConversion = false;

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
  closeBtn = document.getElementById("videoPlayerCloseBtn");
  fallbackEl = document.getElementById("videoPlayerFallback");
  fallbackMessageEl = document.getElementById("videoPlayerFallbackMessage");
  downloadLinkEl = document.getElementById("videoPlayerDownloadLink");
  progressEl = document.getElementById("videoPlayerProgress");
  progressMessageEl = document.getElementById("videoPlayerProgressMessage");
  progressBarEl = document.getElementById("videoPlayerProgressBar");
  progressFillEl = document.getElementById("videoPlayerProgressFill");
  progressPercentEl = document.getElementById("videoPlayerProgressPercent");

  closeBtn?.addEventListener("click", closeVideoPlayer);

  // Click the backdrop to dismiss, but not a click on the frame.
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
    if (usingConversion) {
      // The converted copy is H.264/AAC in an MP4. If *that* will not play,
      // nothing the backend can produce will, and re-converting would loop.
      showFallback(`${subject()} could not be played even after conversion.`, current?.url || url);
      return;
    }
    beginConversion(session);
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
  closeBtn = null;
  fallbackEl = null;
  fallbackMessageEl = null;
  downloadLinkEl = null;
  progressEl = null;
  progressMessageEl = null;
  progressBarEl = null;
  progressFillEl = null;
  progressPercentEl = null;
  slideshowWasRunning = false;
  clearTimeout(pollTimer);
  pollTimer = null;
  session = 0;
  current = null;
  usingConversion = false;
}
