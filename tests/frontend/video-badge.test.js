// Unit tests for video-badge.js
//
// video-badge.js deliberately imports nothing, so this needs no module
// mocking — that isolation is why the badge logic is worth having in its own
// module rather than inline in swiper.js.
import { jest, describe, it, expect, afterEach } from "@jest/globals";

import {
  applyVideoOverlay,
  formatBadgeLabel,
  formatDuration,
  formatFps,
  makeVideoBadge,
  removeVideoOverlay,
} from "../../photomap/frontend/static/javascript/video-badge.js";

const VIDEO_DATA = {
  filename: "clip.mp4",
  media_type: "video",
  video_url: "videos/album/clip.mp4",
  video_info: { duration: 7.4, fps: 30, playable: true },
};

const IMAGE_DATA = {
  filename: "photo.jpg",
  media_type: "image",
};

function makeSlide() {
  const slide = document.createElement("div");
  slide.className = "swiper-slide";
  slide.dataset.globalIndex = "3";
  slide.innerHTML = '<img src="poster.jpg" alt="clip.mp4" />';
  document.body.appendChild(slide);
  return slide;
}

afterEach(() => {
  document.body.innerHTML = "";
  jest.clearAllMocks();
});

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [7.4, "0:07"],
    [59, "0:59"],
    [65, "1:05"],
    [125, "2:05"],
    [3725, "1:02:05"],
  ])("formats %p as %p", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it.each([[null], [undefined], [NaN], [-5], ["nonsense"]])("returns an empty string for %p", (value) => {
    expect(formatDuration(value)).toBe("");
  });
});

describe("formatFps", () => {
  it.each([
    [30, "30 fps"],
    [30.0, "30 fps"],
    [29.97, "29.97 fps"],
    [23.976, "23.98 fps"],
  ])("formats %p as %p", (fps, expected) => {
    expect(formatFps(fps)).toBe(expected);
  });

  it.each([[null], [undefined], [NaN], [0], [-1], ["nonsense"]])("returns an empty string for %p", (value) => {
    expect(formatFps(value)).toBe("");
  });
});

describe("formatBadgeLabel", () => {
  it("joins duration and fps", () => {
    expect(formatBadgeLabel({ duration: 7.4, fps: 30 })).toBe("0:07 · 30 fps");
  });

  it("omits either half when it is unknown", () => {
    expect(formatBadgeLabel({ duration: 7.4, fps: null })).toBe("0:07");
    expect(formatBadgeLabel({ duration: null, fps: 30 })).toBe("30 fps");
  });

  it("returns an empty string when nothing is known", () => {
    expect(formatBadgeLabel({})).toBe("");
    expect(formatBadgeLabel(undefined)).toBe("");
  });
});

describe("makeVideoBadge", () => {
  it("renders a play icon and the duration/fps label", () => {
    const badge = makeVideoBadge({ duration: 7.4, fps: 30, playable: true }, "clip.mp4");
    expect(badge.tagName).toBe("BUTTON");
    expect(badge.querySelector("svg")).not.toBeNull();
    expect(badge.querySelector(".video-badge-label").textContent).toBe("0:07 · 30 fps");
  });

  it("is a button of explicit type, so it cannot submit a form", () => {
    expect(makeVideoBadge({}).type).toBe("button");
  });

  it("sets the label as text, not markup", () => {
    // The label is derived from numbers, but going through textContent keeps
    // it that way if the shape of video_info ever changes.
    const badge = makeVideoBadge({ duration: 1, fps: 1 });
    expect(badge.querySelector(".video-badge-label").innerHTML).not.toContain("<");
  });

  it("marks containers browsers cannot play", () => {
    const badge = makeVideoBadge({ duration: 5, fps: 25, playable: false }, "clip.avi");
    expect(badge.classList.contains("video-badge--unplayable")).toBe(true);
    expect(badge.title).toMatch(/may not play/i);
  });

  it("carries an accessible label", () => {
    const badge = makeVideoBadge({ playable: true }, "clip.mp4");
    expect(badge.getAttribute("aria-label")).toBe("Play clip.mp4");
  });
});

describe("applyVideoOverlay", () => {
  it("adds a badge to a video slide", () => {
    const slide = makeSlide();
    applyVideoOverlay(slide, VIDEO_DATA);
    expect(slide.querySelectorAll(".video-badge")).toHaveLength(1);
    expect(slide.dataset.mediaType).toBe("video");
  });

  it("leaves the poster <img> in place", () => {
    // Load-bearing: search-ui.js reads slide.querySelector("img").src for
    // "search by this image", and curation.js skips slides without one.
    const slide = makeSlide();
    applyVideoOverlay(slide, VIDEO_DATA);
    expect(slide.querySelector("img")).not.toBeNull();
    expect(slide.querySelector("img").src).toContain("poster.jpg");
  });

  it("makes the slide a positioning context for the badge", () => {
    const slide = makeSlide();
    applyVideoOverlay(slide, VIDEO_DATA);
    expect(slide.style.position).toBe("relative");
  });

  it("does nothing for an image", () => {
    const slide = makeSlide();
    expect(applyVideoOverlay(slide, IMAGE_DATA)).toBeNull();
    expect(slide.querySelector(".video-badge")).toBeNull();
  });

  it("does nothing for a missing slide or payload", () => {
    expect(applyVideoOverlay(null, VIDEO_DATA)).toBeNull();
    expect(applyVideoOverlay(makeSlide(), undefined)).toBeNull();
  });

  it("is idempotent", () => {
    // Grid tiles are painted as placeholders and upgraded in place, so this
    // runs more than once per tile.
    const slide = makeSlide();
    applyVideoOverlay(slide, VIDEO_DATA);
    applyVideoOverlay(slide, VIDEO_DATA);
    expect(slide.querySelectorAll(".video-badge")).toHaveLength(1);
  });

  it("does not add the compact modifier to a full-size slide", () => {
    // Swiper slides carry no inline width, so they are never compact.
    const slide = makeSlide();
    applyVideoOverlay(slide, VIDEO_DATA);
    expect(slide.querySelector(".video-badge").classList.contains("video-badge--compact")).toBe(false);
  });

  it("drops the label on grid tiles too small to carry it", () => {
    // Read from the inline width grid-view.js stamps on each tile: the badge
    // is applied before layout has necessarily run, and tile size varies
    // continuously, so no fixed CSS selector could match it.
    const slide = makeSlide();
    slide.style.width = "100px";
    slide.style.height = "100px";
    applyVideoOverlay(slide, VIDEO_DATA);
    expect(slide.querySelector(".video-badge").classList.contains("video-badge--compact")).toBe(true);
  });

  it("keeps the label on a roomy grid tile", () => {
    const slide = makeSlide();
    slide.style.width = "240px";
    slide.style.height = "240px";
    applyVideoOverlay(slide, VIDEO_DATA);
    expect(slide.querySelector(".video-badge").classList.contains("video-badge--compact")).toBe(false);
  });

  it("appends the badge outside any zoom container", () => {
    // On touch devices the poster sits in .swiper-zoom-container; a badge
    // inside it would be scaled along with the image on a pinch.
    const slide = document.createElement("div");
    slide.innerHTML = '<div class="swiper-zoom-container"><img src="p.jpg" /></div>';
    document.body.appendChild(slide);

    applyVideoOverlay(slide, VIDEO_DATA);

    expect(slide.querySelector(".swiper-zoom-container .video-badge")).toBeNull();
    expect(slide.querySelector(":scope > .video-badge")).not.toBeNull();
  });
});

describe("badge click", () => {
  it("dispatches videoPlayRequested with the payload details", () => {
    const slide = makeSlide();
    applyVideoOverlay(slide, VIDEO_DATA);
    const handler = jest.fn();
    window.addEventListener("videoPlayRequested", handler);

    slide.querySelector(".video-badge").click();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail).toEqual({
      url: "videos/album/clip.mp4",
      filename: "clip.mp4",
      playable: true,
      globalIndex: 3,
    });
    window.removeEventListener("videoPlayRequested", handler);
  });

  it("reports an unplayable container so the player can explain", () => {
    const slide = makeSlide();
    applyVideoOverlay(slide, {
      ...VIDEO_DATA,
      video_info: { duration: 5, fps: 25, playable: false },
    });
    const handler = jest.fn();
    window.addEventListener("videoPlayRequested", handler);

    slide.querySelector(".video-badge").click();

    expect(handler.mock.calls[0][0].detail.playable).toBe(false);
    window.removeEventListener("videoPlayRequested", handler);
  });

  it("does not bubble to the slide underneath", () => {
    // Otherwise the grid's inline onclick re-selects the tile and, in
    // fullscreen, touch.js toggles the slideshow.
    const slide = makeSlide();
    const slideClick = jest.fn();
    slide.addEventListener("click", slideClick);
    applyVideoOverlay(slide, VIDEO_DATA);

    slide.querySelector(".video-badge").click();

    expect(slideClick).not.toHaveBeenCalled();
  });

  it("does not bubble a double-click to the slide", () => {
    // attachDoubleTapHandler would otherwise flip to grid view behind the
    // freshly-opened player.
    const slide = makeSlide();
    const dblHandler = jest.fn();
    slide.addEventListener("dblclick", dblHandler);
    applyVideoOverlay(slide, VIDEO_DATA);

    slide.querySelector(".video-badge").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    expect(dblHandler).not.toHaveBeenCalled();
  });

  it.each(["touchstart", "touchend"])("does not bubble %s to the slide", (type) => {
    const slide = makeSlide();
    const handler = jest.fn();
    slide.addEventListener(type, handler);
    applyVideoOverlay(slide, VIDEO_DATA);

    slide.querySelector(".video-badge").dispatchEvent(new Event(type, { bubbles: true }));

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("removeVideoOverlay", () => {
  it("removes the badge and the marker", () => {
    const slide = makeSlide();
    applyVideoOverlay(slide, VIDEO_DATA);
    removeVideoOverlay(slide);
    expect(slide.querySelector(".video-badge")).toBeNull();
    expect(slide.dataset.mediaType).toBeUndefined();
  });

  it("tolerates a slide with no badge", () => {
    removeVideoOverlay(makeSlide());
    removeVideoOverlay(null);
  });
});
