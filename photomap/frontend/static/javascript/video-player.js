/**
 * Video player.
 *
 * Opens on the `videoPlayRequested` event dispatched by the play badge, in one
 * of two presentations:
 *
 *   - **In place** (the single-image swiper, and grid tiles unless turned off
 *     with GRID_IN_TILE_KEY): the frame is pinned over the exact rectangle the
 *     poster occupies on screen, with no backdrop, so pressing play swaps the
 *     still for the moving picture without anything changing size. The
 *     surrounding UI stays live: the swiper's own arrows, the arrow keys and a
 *     swipe across the video all dismiss the player and move on.
 *   - **Lightbox**: a centred card over a dimmed backdrop, reusing the shared
 *     `.modal-overlay` machinery. Used when there is no slide to pin to.
 *
 * The modal owns its own `<video>` element and never borrows one from a
 * slide. Swiper destroys slide DOM nodes as the user navigates
 * (`trimBuffer`, `resetAllSlides`), and a
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
let frameEl = null;
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

// Set while playing in place: the poster <img> the frame is pinned over, and
// the swiper that owns it (for navigation, and as the viewport the picture
// has to stay inside).
let anchorImg = null;
let anchorSlide = null;
let anchorSwiper = null;
let followFrame = null;

// How to find the poster again after Swiper rebuilds its slides: the image's
// index, and the swiper's container element, which outlives the instance.
// The grid discards every tile — and its Swiper instance — whenever the
// window changes shape, and entering fullscreen is exactly such a change.
let anchorIndex = null;
let anchorHost = null;
// When the poster went missing. A rebuild takes a debounce plus a fetch, so
// the player waits this long for the tile to come back before giving up.
let anchorLostAt = null;
const ANCHOR_GRACE_MS = 4000;

// The owning swiper's keyboard module, when opening disabled it. Kept apart
// from state.swiper because in the grid the owner is a different instance.
let keyboardSwiper = null;

// localStorage switch for playing grid videos in their tile. Anything but
// "false" means yes; set it to "false" to get the lightbox back in the grid.
export const GRID_IN_TILE_KEY = "photomap.gridVideoInTile";

// Keys that leave the video for the neighbouring slide while playing in
// place. Deliberately taken from the native controls, which would otherwise
// seek with the arrows: the user asked the arrows to navigate.
const NAV_KEYS = { ArrowLeft: -1, ArrowRight: 1, PageUp: -1, PageDown: 1 };

// A horizontal drag this long across the video is a swipe to the next slide.
const SWIPE_MIN_PX = 50;
// Drags starting this close to the bottom are the native control bar's —
// scrubbing — and never navigate.
const CONTROL_BAR_PX = 56;
let swipeStart = null;

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

// Consecutive failed polls tolerated before giving up. The POST is also the
// backend's liveness signal, so treating one dropped request as fatal both
// told the user a five-minute conversion had failed and made the backend drop
// it — for a wifi handoff, a sleep/wake, or a proxy hiccup.
const MAX_POLL_FAILURES = 4;
let pollFailures = 0;

// Starting volume for the first clip of a page load. A <video> starts at full
// volume, which is jarring. Set once at init rather than on every open: the
// element is permanent, so whatever the user picks afterwards carries over to
// the next clip for the rest of the session.
const DEFAULT_VOLUME = 0.5;

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
  if (known) {
    progressBarEl?.setAttribute("aria-valuenow", String(percent));
  } else {
    // ARIA requires the attribute to be absent for an indeterminate
    // progressbar; leaving it at 0 makes a screen reader announce a job that
    // is running fine as stuck at 0%.
    progressBarEl?.removeAttribute("aria-valuenow");
  }
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
    pollFailures += 1;
    if (pollFailures < MAX_POLL_FAILURES) {
      // Keep asking. Backing off linearly stays well inside the backend's
      // abandonment window even at the last attempt.
      pollTimer = setTimeout(() => pollConversion(mySession, endpoint), POLL_INTERVAL_MS * pollFailures);
      return;
    }
    showFallback(`${subject()} could not be prepared for playback.`, current?.url || "");
    return;
  }

  if (mySession !== session) {
    return;
  }
  pollFailures = 0;

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
    focusPlayer();
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

/** The Swiper instance a slide belongs to; Swiper stores it on its container. */
function owningSwiper(el) {
  for (let node = el; node; node = node.parentElement) {
    if (node.swiper) {
      return node.swiper;
    }
  }
  return null;
}

function gridPlaysInTile() {
  try {
    return localStorage.getItem(GRID_IN_TILE_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * The on-screen rectangle of the picture inside a poster <img>.
 *
 * The slide images are `object-fit: contain` boxes the size of the slide, so
 * the element's own box includes the letterbox bars. Pinning the frame to
 * that box would make the video jump to a different size on play — the very
 * thing this mode exists to avoid.
 */
export function pictureRect(img) {
  const box = img.getBoundingClientRect();
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh || !box.width || !box.height) {
    return box;
  }
  const scale = Math.min(box.width / nw, box.height / nh);
  const width = nw * scale;
  const height = nh * scale;
  const left = box.left + (box.width - width) / 2;
  const top = box.top + (box.height - height) / 2;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/** The element the browser is showing fullscreen, if it is part of the player. */
function playerFullscreenElement() {
  const el = document.fullscreenElement || document.webkitFullscreenElement || null;
  if (el && modal?.contains(el)) {
    return el;
  }
  // iOS Safari fullscreens a <video> natively, without the Fullscreen API.
  return videoEl?.webkitDisplayingFullscreen ? videoEl : null;
}

/**
 * Leave fullscreen before the player goes away.
 *
 * Hiding a fullscreen element does not end fullscreen: the document keeps an
 * invisible top-layer element over the whole page, and every click lands on
 * it — the page looks normal and responds to nothing.
 */
function exitPlayerFullscreen() {
  const el = playerFullscreenElement();
  if (!el) {
    return;
  }
  if (el === videoEl && videoEl.webkitDisplayingFullscreen && !document.fullscreenElement) {
    videoEl.webkitExitFullscreen?.();
    return;
  }
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  const result = exit?.call(document);
  result?.catch?.(() => {});
}

/** Find the poster again after its slide was rebuilt; null if it is not back. */
function relocateAnchor() {
  if (anchorIndex === null || !anchorHost?.isConnected) {
    return null;
  }
  const slide = anchorHost.querySelector(`.swiper-slide[data-global-index="${anchorIndex}"]`);
  return slide?.querySelector("img") || null;
}

/** Pin to a (possibly rebuilt) slide's poster and adopt its swiper. */
function adoptAnchor(img) {
  anchorImg = img;
  anchorSlide?.classList.remove("video-playing-slide");
  anchorSlide = img.closest(".swiper-slide");
  anchorSlide?.classList.add("video-playing-slide");
  const swiper = owningSwiper(img);
  if (swiper && swiper !== anchorSwiper) {
    anchorSwiper = swiper;
    // A recreated grid instance comes back with its arrows enabled.
    if (swiper !== state.swiper) {
      keyboardSwiper = swiper;
      swiper.keyboard?.disable?.();
    }
  }
}

/**
 * Keep the frame over the poster, or close if the poster has gone.
 *
 * Called every animation frame while playing in place, which covers every way
 * the picture can move without an event this module would otherwise need to
 * hear about: window resize, fullscreen, the drawer, a partial drag of the
 * slide (the video follows it), and a grid page sliding away.
 */
function followAnchor() {
  followFrame = null;
  if (!anchorImg || !isVideoPlayerOpen()) {
    return;
  }
  // While fullscreen the page underneath is laid out for the new window size
  // and may be rebuilding; none of that concerns the player until it returns.
  if (playerFullscreenElement()) {
    followFrame = window.requestAnimationFrame(followAnchor);
    return;
  }
  if (!anchorImg.isConnected) {
    const found = relocateAnchor();
    if (found) {
      adoptAnchor(found);
    } else {
      anchorLostAt ??= performance.now();
      if (performance.now() - anchorLostAt > ANCHOR_GRACE_MS) {
        closeVideoPlayer();
        return;
      }
      // Nothing to sit over meanwhile. Hidden rather than closed, so the clip
      // carries on where it was when its tile reappears.
      frameEl.style.visibility = "hidden";
      followFrame = window.requestAnimationFrame(followAnchor);
      return;
    }
  }
  anchorLostAt = null;
  const rect = pictureRect(anchorImg);
  const view = anchorSwiper?.el?.getBoundingClientRect?.();
  const visible =
    rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    (!view || (rect.right > view.left && rect.left < view.right && rect.bottom > view.top && rect.top < view.bottom));
  if (!visible) {
    // The view was switched or the page slid away. Leaving the video floating
    // over whatever is there now would be worse than stopping it.
    closeVideoPlayer();
    return;
  }
  const style = frameEl.style;
  style.visibility = "";
  style.left = `${rect.left}px`;
  style.top = `${rect.top}px`;
  style.width = `${rect.width}px`;
  style.height = `${rect.height}px`;
  followFrame = window.requestAnimationFrame(followAnchor);
}

/** Switch between the in-place and lightbox presentations. */
function setAnchor(img) {
  if (!frameEl || !closeBtn) {
    img = null;
  }
  anchorImg = img;
  anchorLostAt = null;
  anchorIndex = img?.closest?.(".swiper-slide")?.dataset.globalIndex ?? null;
  anchorHost = anchorSwiper?.el || null;
  window.cancelAnimationFrame(followFrame);
  followFrame = null;
  modal.classList.toggle("video-player-overlay--anchored", Boolean(img));
  // Fades the bottom panels and hides the slide's star; see video-player.css.
  document.body.classList.toggle("video-playing-in-place", Boolean(img));
  anchorSlide?.classList.remove("video-playing-slide");
  anchorSlide = img?.closest?.(".swiper-slide") || null;
  anchorSlide?.classList.add("video-playing-slide");
  if (img) {
    // Inside the frame, so it rides along in its corner.
    frameEl.appendChild(closeBtn);
    frameEl.style.borderRadius = getComputedStyle(img).borderRadius;
    followAnchor();
  } else if (frameEl && closeBtn) {
    modal.insertBefore(closeBtn, modal.firstChild);
    frameEl.removeAttribute("style");
  }
}

/** Leave the video for the neighbouring slide. */
function navigateFromPlayer(direction) {
  // Looked up now rather than remembered: the grid may have replaced its
  // instance since the player opened.
  const swiper = (anchorImg && owningSwiper(anchorImg)) || anchorSwiper;
  closeVideoPlayer();
  if (direction > 0) {
    swiper?.slideNext?.();
  } else {
    swiper?.slidePrev?.();
  }
}

function onNavKey(e) {
  const direction = NAV_KEYS[e.key];
  if (!direction || !anchorImg || !isVideoPlayerOpen() || e.altKey || e.ctrlKey || e.metaKey) {
    return;
  }
  // Fullscreen, the video is all there is: the arrows seek, as they should.
  if (playerFullscreenElement()) {
    return;
  }
  // The search box and the other panels stay usable while a video plays in
  // place, and their caret keys are their own.
  const tag = e.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  navigateFromPlayer(direction);
}

function onFramePointerDown(e) {
  if (!anchorImg || e.isPrimary === false || playerFullscreenElement()) {
    swipeStart = null;
    return;
  }
  const bottom = frameEl.getBoundingClientRect().bottom;
  swipeStart = e.clientY > bottom - CONTROL_BAR_PX ? null : { x: e.clientX, y: e.clientY };
}

function onFramePointerUp(e) {
  const start = swipeStart;
  swipeStart = null;
  if (!start || !anchorImg) {
    return;
  }
  const dx = e.clientX - start.x;
  const dy = e.clientY - start.y;
  if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) {
    navigateFromPlayer(dx < 0 ? 1 : -1);
  }
}

export function openVideoPlayer({ url, filename, playable = true, poster = "", transcodeUrl = "", slide = null } = {}) {
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
  pollFailures = 0;

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

  // Play in place over the slide's poster when there is one to pin to.
  anchorSwiper = slide ? owningSwiper(slide) : null;
  const inGrid = Boolean(slide?.closest?.("#gridViewContainer"));
  const img = slide?.isConnected && (!inGrid || gridPlaysInTile()) ? slide.querySelector("img") : null;
  setAnchor(img || null);

  if (!url) {
    // The only open path with nothing to play. Without the teardown the
    // previous clip keeps streaming — audibly — behind the panel, and with
    // the controls hidden there is no way to stop it.
    teardownVideo();
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
  // Logical state rather than autoplay.running, which is false for the
  // duration of a buffer rebuild even when the slideshow is running.
  slideshowWasRunning = Boolean(state.single_swiper?.isSlideshowActive?.());
  state.single_swiper?.pauseSlideshow?.();
  // Otherwise the arrow keys change slides behind the modal while the user is
  // trying to scrub.
  state.swiper?.keyboard?.disable?.();
  // The grid has its own instance, whose arrows would page behind the player.
  keyboardSwiper = anchorSwiper && anchorSwiper !== state.swiper ? anchorSwiper : null;
  keyboardSwiper?.keyboard?.disable?.();
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

  exitPlayerFullscreen();
  teardownVideo();
  videoEl?.removeAttribute("poster");
  modal.classList.remove("visible");
  setAnchor(null);
  anchorSwiper = null;
  anchorHost = null;
  anchorIndex = null;
  swipeStart = null;
  hidePanels();
  current = null;
  usingConversion = false;

  state.swiper?.keyboard?.enable?.();
  keyboardSwiper?.keyboard?.enable?.();
  keyboardSwiper = null;
  if (slideshowWasRunning) {
    state.single_swiper?.resumeSlideshow?.();
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
  frameEl = document.getElementById("videoPlayerFrame");
  closeBtn = document.getElementById("videoPlayerCloseBtn");
  fallbackEl = document.getElementById("videoPlayerFallback");
  fallbackMessageEl = document.getElementById("videoPlayerFallbackMessage");
  downloadLinkEl = document.getElementById("videoPlayerDownloadLink");
  progressEl = document.getElementById("videoPlayerProgress");
  progressMessageEl = document.getElementById("videoPlayerProgressMessage");
  progressBarEl = document.getElementById("videoPlayerProgressBar");
  progressFillEl = document.getElementById("videoPlayerProgressFill");
  progressPercentEl = document.getElementById("videoPlayerProgressPercent");

  if (videoEl) {
    videoEl.volume = DEFAULT_VOLUME;
  }

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

    // Which failure it was decides whether converting could possibly help.
    // Without this, a transient network drop on a perfectly decodable clip
    // tore it down and started a full re-encode on the server.
    const code = videoEl.error?.code;
    if (code === 1 /* MEDIA_ERR_ABORTED */) {
      return; // the load was cancelled, not rejected
    }
    if (code === 2 /* MEDIA_ERR_NETWORK */) {
      showFallback(`${subject()} could not be loaded. Check that PhotoMapAI is still running.`, current?.url || url);
      return;
    }
    // MEDIA_ERR_DECODE and MEDIA_ERR_SRC_NOT_SUPPORTED are exactly what a
    // container or codec the browser cannot handle looks like. An absent code
    // stays permissive, which is what the player did before.
    beginConversion(session);
  });

  // A playing video must not be left behind by navigation: the modal would
  // then describe a different slide than the drawer and the UMAP marker, and
  // on an album change the indices are about to be re-based entirely.
  //
  // Except while fullscreen: the user cannot navigate from there, so a
  // slideChanged then is a rebuild of the page underneath, not a move away.
  window.addEventListener("slideChanged", () => {
    if (!playerFullscreenElement()) {
      closeVideoPlayer();
    }
  });
  window.addEventListener("albumChanged", closeVideoPlayer);

  // Capture phase, so the arrows reach this before the native controls seek
  // with them or the global shortcuts see them.
  window.addEventListener("keydown", onNavKey, true);
  frameEl?.addEventListener("pointerdown", onFramePointerDown);
  frameEl?.addEventListener("pointerup", onFramePointerUp);
  frameEl?.addEventListener("pointercancel", () => {
    swipeStart = null;
  });

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
  frameEl = null;
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
  window.cancelAnimationFrame(followFrame);
  followFrame = null;
  anchorImg = null;
  anchorSlide = null;
  anchorSwiper = null;
  anchorHost = null;
  anchorIndex = null;
  anchorLostAt = null;
  keyboardSwiper = null;
  swipeStart = null;
  // Advanced, never reset to a fixed value: session numbers are only a valid
  // staleness guard while they are monotonic. Restarting at 0 lets a poll
  // chain left pending by a previous test capture a number the next test
  // reissues, so its check passes and it plays into the wrong player.
  session += 1;
  current = null;
  usingConversion = false;
  pollFailures = 0;
}
