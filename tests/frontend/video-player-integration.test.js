// Integration tests for the seams the video player reaches into: the control
// panel's fullscreen handling, and the modal template it queries by id.
//
// video-player.test.js exercises the module against a hand-written fixture,
// which is exactly why these live separately: every bug found in review was in
// the wiring between modules, not inside video-player.js.
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockState = {
  single_swiper: { pauseSlideshow: jest.fn(), startSlideshow: jest.fn() },
  swiper: { autoplay: { running: false }, keyboard: { disable: jest.fn(), enable: jest.fn() } },
};

jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: mockState,
  saveSettingsToLocalStorage: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/index.js", () => ({
  deleteImage: jest.fn(),
  getIndexMetadata: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
  getCurrentFilepath: jest.fn(),
  getCurrentSlideIndex: jest.fn(),
  slideState: { getCurrentSlide: () => ({ globalIndex: 0 }) },
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
  errorDetail: jest.fn(),
  hideSpinner: jest.fn(),
  showSpinner: jest.fn(),
  setCheckmarkOnIcon: jest.fn(),
}));

const { initializeControlPanel } = await import("../../photomap/frontend/static/javascript/control-panel.js");
const { _resetVideoPlayerForTests, closeVideoPlayer, initializeVideoPlayer, openVideoPlayer } =
  await import("../../photomap/frontend/static/javascript/video-player.js");

const TEMPLATE_PATH = fileURLToPath(
  new URL("../../photomap/frontend/templates/modules/video-player-modal.html", import.meta.url)
);
const TEMPLATE_HTML = readFileSync(TEMPLATE_PATH, "utf8");

const MP4 = { url: "videos/a/clip.mp4", filename: "clip.mp4", playable: true };

/** Set document.fullscreenElement and fire the event the browser would. */
function setFullscreen(el) {
  Object.defineProperty(document, "fullscreenElement", { value: el, configurable: true });
  document.dispatchEvent(new Event("fullscreenchange"));
}

const panel = () => document.getElementById("controlPanel");
const isPanelHidden = () => panel().classList.contains("hidden-fullscreen");

beforeEach(() => {
  jest.clearAllMocks();
  // The real modal markup, not a copy of it — see the parity test below.
  document.body.innerHTML = `
    <div id="controlPanel"></div>
    <div id="searchPanel"></div>
    <div id="fixedScoreDisplay"></div>
    ${TEMPLATE_HTML}`;

  // jsdom implements none of these on HTMLMediaElement.
  window.HTMLMediaElement.prototype.play = jest.fn(() => Promise.resolve());
  window.HTMLMediaElement.prototype.pause = jest.fn();
  window.HTMLMediaElement.prototype.load = jest.fn();

  _resetVideoPlayerForTests();
  initializeVideoPlayer();
  initializeControlPanel();
  setFullscreen(null);
});

describe("the modal template and the module agree", () => {
  // video-player.test.js builds its own fixture. That fixture passing proves
  // nothing about the shipped page if an id is renamed on one side only, and
  // the player would then silently do nothing at all.
  it.each([
    "videoPlayerModal",
    "videoPlayerElement",
    "videoPlayerTitle",
    "videoPlayerFallback",
    "videoPlayerFallbackMessage",
    "videoPlayerDownloadLink",
    "videoPlayerCloseBtn",
  ])("the template provides #%s", (id) => {
    expect(document.getElementById(id)).not.toBeNull();
  });

  it("wires up against the real template", () => {
    openVideoPlayer(MP4);
    expect(document.getElementById("videoPlayerModal").classList.contains("visible")).toBe(true);
    expect(document.getElementById("videoPlayerElement").getAttribute("src")).toBe(MP4.url);
  });

  it("keeps playsinline, so iOS does not hijack playback into its own view", () => {
    expect(document.getElementById("videoPlayerElement").hasAttribute("playsinline")).toBe(true);
  });

  it("focuses the real template's video, so Space reaches playback", () => {
    // The fixture in video-player.test.js could drift into being focusable
    // when the shipped markup is not; this asserts it against the template.
    openVideoPlayer(MP4);
    expect(document.activeElement).toBe(document.getElementById("videoPlayerElement"));
  });
});

describe("fullscreen panel visibility", () => {
  it("restores the panels when the app leaves fullscreen while the player is open", () => {
    // Pressing Escape in fullscreen exits fullscreen; browsers consume that
    // keydown rather than delivering it, so the modal is still open when
    // fullscreenchange fires. Suppressing the handler here left the control
    // panel at opacity:0 + visibility:hidden !important with no way back.
    setFullscreen(document.documentElement);
    expect(isPanelHidden()).toBe(true);

    openVideoPlayer(MP4);
    setFullscreen(null);
    closeVideoPlayer();

    expect(isPanelHidden()).toBe(false);
  });

  it("leaves the panels hidden when the app is still fullscreen after the player closes", () => {
    setFullscreen(document.documentElement);
    openVideoPlayer(MP4);
    closeVideoPlayer();
    expect(isPanelHidden()).toBe(true);
  });

  it("survives the video's own fullscreen button being used and dismissed", () => {
    // Entering and leaving video fullscreen is a matched pair, so the class
    // ends where it started. While the modal is up its backdrop covers the
    // panels at z-index 99999, so no intermediate state is ever visible.
    openVideoPlayer(MP4);
    setFullscreen(document.getElementById("videoPlayerElement"));
    setFullscreen(null);
    closeVideoPlayer();
    expect(isPanelHidden()).toBe(false);
  });
});
