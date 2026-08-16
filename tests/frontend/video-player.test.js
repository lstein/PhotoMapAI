// Unit tests for video-player.js
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockPauseSlideshow = jest.fn();
const mockStartSlideshow = jest.fn();
const mockKeyboardDisable = jest.fn();
const mockKeyboardEnable = jest.fn();

const mockState = {
  single_swiper: {
    pauseSlideshow: mockPauseSlideshow,
    startSlideshow: mockStartSlideshow,
  },
  swiper: {
    autoplay: { running: false },
    keyboard: { disable: mockKeyboardDisable, enable: mockKeyboardEnable },
  },
};

jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: mockState,
  saveSettingsToLocalStorage: jest.fn(),
}));

const { _resetVideoPlayerForTests, closeVideoPlayer, initializeVideoPlayer, isVideoPlayerOpen, openVideoPlayer } =
  await import("../../photomap/frontend/static/javascript/video-player.js");

const MP4 = { url: "videos/album/clip.mp4", filename: "clip.mp4", playable: true };

function modal() {
  return document.getElementById("videoPlayerModal");
}
function video() {
  return document.getElementById("videoPlayerElement");
}
function fallback() {
  return document.getElementById("videoPlayerFallback");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.swiper.autoplay.running = false;

  document.body.innerHTML = `
    <div id="videoPlayerModal" class="modal-overlay">
      <div class="modal-content video-player-content">
        <button class="modal-close" id="videoPlayerCloseBtn">&times;</button>
        <div class="video-player-title" id="videoPlayerTitle"></div>
        <video id="videoPlayerElement" class="video-player-element" controls></video>
        <div class="video-player-fallback" id="videoPlayerFallback" hidden>
          <p id="videoPlayerFallbackMessage"></p>
          <a id="videoPlayerDownloadLink" href="#" download>Download the video</a>
        </div>
      </div>
    </div>
  `;

  // jsdom implements neither play() nor load() on HTMLMediaElement.
  window.HTMLMediaElement.prototype.play = jest.fn(() => Promise.resolve());
  window.HTMLMediaElement.prototype.pause = jest.fn();
  window.HTMLMediaElement.prototype.load = jest.fn();

  _resetVideoPlayerForTests();
  initializeVideoPlayer();
});

afterEach(() => {
  _resetVideoPlayerForTests();
  document.body.innerHTML = "";
});

describe("opening", () => {
  it("shows the modal and loads the video", () => {
    openVideoPlayer(MP4);
    expect(modal().classList.contains("visible")).toBe(true);
    expect(video().getAttribute("src")).toBe("videos/album/clip.mp4");
    expect(isVideoPlayerOpen()).toBe(true);
  });

  it("shows the filename", () => {
    openVideoPlayer(MP4);
    expect(document.getElementById("videoPlayerTitle").textContent).toBe("clip.mp4");
  });

  it("pauses the slideshow and disables swiper keyboard nav", () => {
    // Otherwise the slideshow advances behind the modal, and the arrow keys
    // change slides while the user is trying to scrub.
    openVideoPlayer(MP4);
    expect(mockPauseSlideshow).toHaveBeenCalled();
    expect(mockKeyboardDisable).toHaveBeenCalled();
  });

  it("starts playing immediately", () => {
    // The modal is opened from a click on the play badge, so this call still
    // carries that gesture's user activation and may play with sound.
    openVideoPlayer(MP4);
    expect(video().play).toHaveBeenCalled();
  });

  it("does not try to play when there is nothing to play", () => {
    openVideoPlayer({ url: "", filename: "clip.mp4", playable: true });
    expect(video().play).not.toHaveBeenCalled();
  });

  it("does not try to play a container it has already declared unplayable", () => {
    openVideoPlayer({ url: "videos/a/clip.avi", filename: "clip.avi", playable: false });
    expect(video().play).not.toHaveBeenCalled();
  });

  it("survives the browser refusing to autoplay", async () => {
    // A refusal is a policy decision, not a playback failure: the native
    // controls are right there, so it must not raise the error fallback.
    const refusal = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
    window.HTMLMediaElement.prototype.play = jest.fn(() => Promise.reject(refusal));

    openVideoPlayer(MP4);
    await Promise.resolve();
    await Promise.resolve();

    expect(isVideoPlayerOpen()).toBe(true);
    expect(fallback().hidden).toBe(true);
  });

  it("survives a play() aborted by closing the modal straight away", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    window.HTMLMediaElement.prototype.play = jest.fn(() => Promise.reject(abort));

    openVideoPlayer(MP4);
    closeVideoPlayer();
    await Promise.resolve();
    await Promise.resolve();

    expect(isVideoPlayerOpen()).toBe(false);
    expect(fallback().hidden).toBe(true);
  });

  it("tolerates a browser with no play() at all", () => {
    delete window.HTMLMediaElement.prototype.play;
    expect(() => openVideoPlayer(MP4)).not.toThrow();
    expect(isVideoPlayerOpen()).toBe(true);
  });

  it("opens from a videoPlayRequested event", () => {
    // The seam between the badge (PR 4) and the player.
    window.dispatchEvent(new CustomEvent("videoPlayRequested", { detail: MP4 }));
    expect(isVideoPlayerOpen()).toBe(true);
    expect(video().getAttribute("src")).toBe("videos/album/clip.mp4");
  });
});

describe("closing", () => {
  it("hides the modal", () => {
    openVideoPlayer(MP4);
    closeVideoPlayer();
    expect(modal().classList.contains("visible")).toBe(false);
    expect(isVideoPlayerOpen()).toBe(false);
  });

  it("stops playback and releases the stream", () => {
    // Merely hiding the overlay leaves the browser streaming and, worse,
    // leaves the audio playing.
    openVideoPlayer(MP4);
    closeVideoPlayer();
    expect(video().pause).toHaveBeenCalled();
    expect(video().hasAttribute("src")).toBe(false);
    expect(video().load).toHaveBeenCalled();
  });

  it("closes on the close button", () => {
    openVideoPlayer(MP4);
    document.getElementById("videoPlayerCloseBtn").click();
    expect(isVideoPlayerOpen()).toBe(false);
  });

  it("closes on a backdrop click", () => {
    openVideoPlayer(MP4);
    modal().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isVideoPlayerOpen()).toBe(false);
  });

  it("does not close on a click inside the panel", () => {
    openVideoPlayer(MP4);
    modal()
      .querySelector(".modal-content")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isVideoPlayerOpen()).toBe(true);
  });

  it("re-enables swiper keyboard nav", () => {
    openVideoPlayer(MP4);
    closeVideoPlayer();
    expect(mockKeyboardEnable).toHaveBeenCalled();
  });

  it("is a no-op when already closed", () => {
    closeVideoPlayer();
    expect(video().pause).not.toHaveBeenCalled();
  });
});

describe("slideshow state", () => {
  it("restores a running slideshow", () => {
    mockState.swiper.autoplay.running = true;
    openVideoPlayer(MP4);
    closeVideoPlayer();
    expect(mockStartSlideshow).toHaveBeenCalled();
  });

  it("does not start a slideshow that was paused", () => {
    // Restore, never force-start: opening a video from a paused slideshow
    // must not silently start it.
    mockState.swiper.autoplay.running = false;
    openVideoPlayer(MP4);
    closeVideoPlayer();
    expect(mockStartSlideshow).not.toHaveBeenCalled();
  });
});

describe("navigation closes the player", () => {
  it.each(["slideChanged", "albumChanged"])("closes on %s", (eventName) => {
    // Otherwise the modal describes clip A while the drawer and the UMAP
    // marker describe clip B — and on an album change the indices are about
    // to be re-based entirely.
    openVideoPlayer(MP4);
    window.dispatchEvent(new CustomEvent(eventName, { detail: {} }));
    expect(isVideoPlayerOpen()).toBe(false);
    expect(video().pause).toHaveBeenCalled();
  });
});

describe("formats the browser cannot play", () => {
  it("explains instead of showing a dead player", () => {
    openVideoPlayer({ url: "videos/album/clip.avi", filename: "clip.avi", playable: false });

    expect(fallback().hidden).toBe(false);
    expect(video().hidden).toBe(true);
    expect(video().hasAttribute("src")).toBe(false);
    expect(document.getElementById("videoPlayerFallbackMessage").textContent).toMatch(/cannot play/i);
  });

  it("offers the file for download", () => {
    openVideoPlayer({ url: "videos/album/clip.avi", filename: "clip.avi", playable: false });
    const link = document.getElementById("videoPlayerDownloadLink");
    expect(link.getAttribute("href")).toBe("videos/album/clip.avi");
    expect(link.hidden).toBe(false);
  });

  it("falls back when the video element itself errors", () => {
    // The load-bearing half: no static extension list predicts this
    // correctly in either direction (an HEVC .mp4 plays in Safari but not
    // Firefox), so the player always tries and reacts to what happened.
    openVideoPlayer(MP4);
    expect(fallback().hidden).toBe(true);

    video().dispatchEvent(new Event("error"));

    expect(fallback().hidden).toBe(false);
    expect(document.getElementById("videoPlayerFallbackMessage").textContent).toMatch(/could not be played/i);
    expect(document.getElementById("videoPlayerDownloadLink").getAttribute("href")).toBe("videos/album/clip.mp4");
  });

  it("ignores the error fired by teardown clearing the src", () => {
    openVideoPlayer(MP4);
    closeVideoPlayer();
    video().dispatchEvent(new Event("error"));
    expect(fallback().hidden).toBe(true);
  });

  it("recovers the player on the next open", () => {
    openVideoPlayer({ url: "videos/album/clip.avi", filename: "clip.avi", playable: false });
    closeVideoPlayer();
    openVideoPlayer(MP4);
    expect(fallback().hidden).toBe(true);
    expect(video().hidden).toBe(false);
    expect(video().getAttribute("src")).toBe("videos/album/clip.mp4");
  });

  it("explains when there is no URL at all", () => {
    openVideoPlayer({ url: "", filename: "clip.mp4", playable: true });
    expect(fallback().hidden).toBe(false);
    expect(document.getElementById("videoPlayerDownloadLink").hidden).toBe(true);
  });
});

describe("without the modal markup", () => {
  it("initializes and opens without throwing", () => {
    // main.html always includes the modal, but the module must not explode if
    // it is imported into a page that does not.
    document.body.innerHTML = "";
    _resetVideoPlayerForTests();
    initializeVideoPlayer();
    openVideoPlayer(MP4);
    closeVideoPlayer();
    expect(isVideoPlayerOpen()).toBe(false);
  });
});
