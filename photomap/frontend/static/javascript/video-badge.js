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

  const label = formatBadgeLabel(videoInfo);
  badge.innerHTML = `${PLAY_ICON_SVG}<span class="video-badge-label"></span>`;
  badge.querySelector(".video-badge-label").textContent = label;

  // `playable` is a hint from the container extension, used for styling only.
  // Whether a video actually plays depends on the codec inside it (an HEVC
  // .mp4 plays in Safari but not Firefox), so the player always attempts
  // playback and reacts to the element's own error event.
  if (videoInfo?.playable === false) {
    badge.classList.add("video-badge--unplayable");
    badge.title = "This video format may not play in your browser — click for options";
  } else {
    badge.title = filename ? `Play ${filename}` : "Play video";
  }
  badge.setAttribute("aria-label", badge.title);

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
 * Add the badge to a slide, if its payload describes a video.
 *
 * No-ops for images, and is idempotent — grid tiles are upgraded from
 * placeholder to real metadata in place, so this runs more than once per tile.
 */
export function applyVideoOverlay(slideEl, data) {
  if (!slideEl || data?.media_type !== "video") {
    return null;
  }
  if (slideEl.querySelector(":scope > .video-badge")) {
    return slideEl.querySelector(":scope > .video-badge");
  }

  const videoInfo = data.video_info || {};
  const badge = makeVideoBadge(videoInfo, data.filename);

  badge.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
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

  // The badge is absolutely positioned within the slide. On touch devices the
  // poster lives inside `.swiper-zoom-container`; the badge is appended to the
  // slide itself, deliberately *outside* that container, or Swiper's zoom
  // module would scale it along with the image on a pinch.
  slideEl.style.position = "relative";
  slideEl.appendChild(badge);
  slideEl.dataset.mediaType = "video";

  return badge;
}

/** Remove a slide's badge, if it has one. */
export function removeVideoOverlay(slideEl) {
  slideEl?.querySelector(":scope > .video-badge")?.remove();
  if (slideEl) {
    delete slideEl.dataset.mediaType;
  }
}
