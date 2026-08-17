/**
 * Play/duration/fps overlay drawn on top of a video's still frame.
 *
 * The badge is the click target for playback in both the swiper and the grid.
 * It dispatches a `videoPlayRequested` window event rather than opening a
 * player itself, so this module stays free of any dependency on the player.
 *
 * The poster underneath stays a real `<img>`. That is load-bearing rather
 * than cosmetic: `search-ui.js` ("search by this image") reads
 * `slide.querySelector("img")?.src`, `curation.js` skips slides that have no
 * `img`, and `grid-view.js` updates alt text the same way. Keeping an `<img>`
 * means all three keep working — and "search by this image" then searches by
 * the exact frame that was embedded, which is what you want.
 */

/** Clock time for a duration in seconds: 7.4 -> "0:07", 3725 -> "1:02:05". */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) {
    return "";
  }
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) {
    return "";
  }
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** "30 fps" for whole rates, "29.97 fps" otherwise. */
export function formatFps(fps) {
  if (fps === null || fps === undefined) {
    return "";
  }
  const value = Number(fps);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  return Math.abs(value - Math.round(value)) < 0.01 ? `${Math.round(value)} fps` : `${value.toFixed(2)} fps`;
}

/** The label under the play icon: "0:07 · 30 fps", or either half alone. */
export function formatBadgeLabel(videoInfo) {
  const parts = [formatDuration(videoInfo?.duration), formatFps(videoInfo?.fps)].filter((part) => part !== "");
  return parts.join(" · ");
}

const PLAY_ICON_SVG = `
  <svg class="video-badge-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="11" />
    <path d="M9.5 7.5v9l7-4.5z" />
    <line class="video-badge-slash" x1="4.5" y1="19.5" x2="19.5" y2="4.5" />
  </svg>
`;

/**
 * Build the badge element for a video.
 *
 * @param {object} videoInfo - duration / fps / playable, as probed at index time.
 * @param {string} filename - used for the accessible label only.
 */
export function makeVideoBadge(videoInfo, filename = "") {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "video-badge";
  // Matches setupAccessibility(), which takes every button out of the tab
  // order. That pass runs once at init over buttons that exist then, so a
  // badge created later would otherwise be the only tabbable button in the
  // app — and tabbing to it inside a slide triggers Swiper's focus handling
  // (it slides to the focused element), while a focused button also loses
  // Space to the global slideshow shortcut, which preventDefaults it.
  //
  // Note this does not hide the badge from assistive technology: screen
  // readers navigate by virtual cursor, not tab order, which is why the
  // accessible name above still matters.
  badge.tabIndex = -1;

  const label = formatBadgeLabel(videoInfo);
  badge.innerHTML = `${PLAY_ICON_SVG}<span class="video-badge-label"></span>`;
  badge.querySelector(".video-badge-label").textContent = label;

  // `playable` is a hint from the container extension, used for styling only.
  // Whether a video actually plays depends on the codec inside it (an HEVC
  // .mp4 plays in Safari but not Firefox), so the player always attempts
  // playback and reacts to the element's own error event.
  const unplayable = videoInfo?.playable === false;
  const subject = filename || "video";
  if (unplayable) {
    badge.classList.add("video-badge--unplayable");
    badge.title = `${subject} — this format may not play in your browser; click for options`;
  } else {
    badge.title = `Play ${subject}`;
  }

  // The accessible name is built explicitly rather than left to aria-label,
  // which would *replace* the element's contents in the name computation —
  // the icon is aria-hidden, so the duration and frame rate (the entire
  // reason the badge carries text) reached no screen reader at all. Every
  // unplayable tile in a grid also announced identically, with no filename to
  // tell them apart.
  const spoken = [badge.title, label].filter(Boolean).join(", ");
  badge.setAttribute("aria-label", spoken);

  return badge;
}

/**
 * Stop a badge interaction from reaching the slide underneath.
 *
 * Three separate collisions make this necessary, not one:
 *   - `attachDoubleTapHandler` on swiper slides flips to grid view, so a
 *     double-click on the badge would open the player and switch views.
 *   - grid tiles carry inline `onclick`/`ondblclick` attributes.
 *   - `touch.js` toggles the slideshow on *any* tap while in fullscreen.
 */
function swallowSlideGestures(badge) {
  for (const type of ["mousedown", "dblclick", "touchstart", "touchend"]) {
    badge.addEventListener(
      type,
      (e) => {
        e.stopPropagation();
      },
      { passive: type.startsWith("touch") }
    );
  }
}

/**
 * Reconcile a slide's badge with its payload.
 *
 * Not merely idempotent — *reconciling*. Grid tiles are painted as
 * placeholders and upgraded in place, and a tile's DOM node can outlive the
 * item it was showing: the batch loader fetches metadata in a staggered
 * background loop, so a response can land after the album changed or the tile
 * was reassigned. Three cases have to be handled, and an early "already has a
 * badge, leave it" guard got two of them wrong:
 *
 *   - now an image, previously a video  -> the stale badge must go, or the
 *     tile offers to play a photo
 *   - now a *different* video           -> the badge must be rebuilt, or it
 *     shows the previous clip's duration and plays the previous clip's URL
 *   - same video                        -> rebuild is still cheap and keeps
 *     the compact class correct if the tile was resized
 */
export function applyVideoOverlay(slideEl, data) {
  if (!slideEl) {
    return null;
  }
  if (data?.media_type !== "video") {
    // Covers the image case *and* a missing payload: either way this slide
    // must not keep a badge it was given earlier.
    //
    // Only the badge is removed, not the slide's declared media type —
    // swiper.js assigns that from the payload just before calling here, so
    // clearing it would undo an assignment this function never made.
    slideEl.querySelector(":scope > .video-badge")?.remove();
    if (data?.media_type) {
      slideEl.dataset.mediaType = data.media_type;
    }
    return null;
  }

  const videoInfo = data.video_info || {};
  const identity = `${data.video_url || ""}|${data.filename || ""}`;
  const existing = slideEl.querySelector(":scope > .video-badge");
  if (existing && existing.dataset.videoIdentity === identity) {
    // Same clip. Only the size hint can have changed.
    existing.classList.toggle("video-badge--compact", isCompactSlide(slideEl));
    return existing;
  }
  existing?.remove();

  const badge = makeVideoBadge(videoInfo, data.filename);
  badge.dataset.videoIdentity = identity;

  badge.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // A clicked button keeps focus, and the global Space shortcut
    // preventDefaults its way past the button's own activation — so a focused
    // badge would silently toggle the slideshow instead. The radio controls
    // in events.js blur for the same reason.
    e.currentTarget.blur();
    window.dispatchEvent(
      new CustomEvent("videoPlayRequested", {
        detail: {
          url: data.video_url || "",
          filename: data.filename || "",
          playable: videoInfo.playable !== false,
          globalIndex: Number(slideEl.dataset.globalIndex ?? -1),
        },
      })
    );
  });
  swallowSlideGestures(badge);

  if (isCompactSlide(slideEl)) {
    badge.classList.add("video-badge--compact");
  }

  // The badge is centred within the slide. On touch devices the poster lives
  // inside `.swiper-zoom-container`; the badge is appended to the slide
  // itself, deliberately *outside* that container, or Swiper's zoom module
  // would scale it along with the image on a pinch.
  slideEl.style.position = "relative";
  slideEl.appendChild(badge);
  slideEl.dataset.mediaType = "video";

  return badge;
}

// Tile width below which the duration/fps label has no room beside the play
// button and is dropped, leaving a smaller icon on its own.
const COMPACT_SLIDE_WIDTH = 140;

/**
 * True for a grid tile too small to carry the label.
 *
 * Reads the *inline* width that grid-view.js stamps on each tile rather than
 * offsetWidth: the badge is applied before layout has necessarily run, and
 * tile size varies continuously (200 * gridThumbSizeFactor, clamped 75-300),
 * so no fixed CSS selector could match it. Swiper slides carry no inline
 * width and are therefore never compact.
 */
function isCompactSlide(slideEl) {
  const inlineWidth = parseInt(slideEl.style?.width, 10);
  return Number.isFinite(inlineWidth) && inlineWidth < COMPACT_SLIDE_WIDTH;
}

/** Remove a slide's badge, if it has one. */
export function removeVideoOverlay(slideEl) {
  slideEl?.querySelector(":scope > .video-badge")?.remove();
  if (slideEl) {
    delete slideEl.dataset.mediaType;
  }
}
