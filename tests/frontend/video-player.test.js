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
// A container no browser decodes, with somewhere to send it for conversion.
const AVI = {
  url: "videos/album/clip.avi",
  filename: "clip.avi",
  playable: false,
  transcodeUrl: "prepare_video/album/clip.avi",
};
// The same file from a server that predates conversion support.
const AVI_NO_CONVERSION = { url: "videos/album/clip.avi", filename: "clip.avi", playable: false };

/**
 * Queue up what POST /prepare_video should answer.
 *
 * The last entry repeats, so a single argument is a steady state and several
 * describe a conversion progressing.
 */
function mockConversion(...responses) {
  const queue = [...responses];
  global.fetch = jest.fn(() => {
    const body = queue.length > 1 ? queue.shift() : queue[0];
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
}

/** Let the fetch/json microtasks settle. Works under fake timers. */
async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

const progress = () => document.getElementById("videoPlayerProgress");
const progressMessage = () => document.getElementById("videoPlayerProgressMessage").textContent;
const fallbackMessage = () => document.getElementById("videoPlayerFallbackMessage").textContent;
const downloadLink = () => document.getElementById("videoPlayerDownloadLink");

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
    <div id="videoPlayerModal" class="modal-overlay video-player-overlay">
      <button class="video-player-close" id="videoPlayerCloseBtn">&times;</button>
      <div class="video-player-frame" id="videoPlayerFrame">
        <video id="videoPlayerElement" class="video-player-element" controls tabindex="0"></video>
        <div class="video-player-panel video-player-progress" id="videoPlayerProgress" hidden>
          <p id="videoPlayerProgressMessage"></p>
          <div class="video-player-bar" id="videoPlayerProgressBar" role="progressbar" aria-valuenow="0">
            <div class="video-player-bar-fill" id="videoPlayerProgressFill"></div>
          </div>
          <p id="videoPlayerProgressPercent"></p>
        </div>
        <div class="video-player-panel video-player-fallback" id="videoPlayerFallback" hidden>
          <p id="videoPlayerFallbackMessage"></p>
          <a id="videoPlayerDownloadLink" href="#" download>Download the video</a>
        </div>
      </div>
      <div class="video-player-title" id="videoPlayerTitle"></div>
    </div>
  `;

  // Nothing in this file wants a real conversion; the tests that care about
  // one install their own queue with mockConversion().
  mockConversion({ state: "queued", progress: 0 });

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

  it("focuses the video, so Space reaches playback", () => {
    // shouldIgnoreKeyEvent() lets Space through to the player precisely so the
    // native controls can pause. A focused <button> activates on Space, so
    // focusing the close button instead makes Space dismiss the player
    // mid-clip — verified in Chromium.
    openVideoPlayer(MP4);
    expect(document.activeElement).toBe(video());
  });

  it("focuses the close button when there is nothing to play yet", () => {
    // The video element is never hidden any more — it holds the poster while
    // a conversion runs — but with no src there is nothing for Space to
    // drive, and the native controls are behind a panel. Leaving focus on
    // <body> would mean Tab starts from the top of the page.
    openVideoPlayer(AVI);
    expect(document.activeElement).toBe(document.getElementById("videoPlayerCloseBtn"));
  });

  it("shows the poster, so the frame has an aspect ratio before metadata", () => {
    openVideoPlayer({ ...MP4, poster: "video_frame/album/3" });
    expect(video().getAttribute("poster")).toBe("video_frame/album/3");
  });

  it("drops the previous clip's poster when this one has none", () => {
    openVideoPlayer({ ...MP4, poster: "video_frame/album/3" });
    closeVideoPlayer();
    openVideoPlayer(MP4);
    expect(video().hasAttribute("poster")).toBe(false);
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

  it("does not close on a click on the frame", () => {
    openVideoPlayer(MP4);
    modal()
      .querySelector(".video-player-frame")
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

  it("can stop a video that started playing during the same open", () => {
    // close() early-returns unless the modal is marked visible, so the open
    // path has to mark it visible *before* anything starts streaming.
    // Otherwise a close arriving mid-open is a silent no-op and the clip
    // plays on — audible — behind a modal that was never shown.
    openVideoPlayer(MP4);
    expect(modal().classList.contains("visible")).toBe(true);
    closeVideoPlayer();
    expect(video().pause).toHaveBeenCalled();
    expect(video().hasAttribute("src")).toBe(false);
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
  it("converts instead of showing a dead player", async () => {
    // The static hint says no browser decodes this container, so there is
    // nothing to gain from a black-rectangle-then-error round trip.
    openVideoPlayer(AVI);

    expect(fallback().hidden).toBe(true);
    expect(progress().hidden).toBe(false);
    expect(video().hasAttribute("src")).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith("prepare_video/album/clip.avi", { method: "POST" });
    await flush();
  });

  it("explains and offers the file when the server cannot convert it", () => {
    // A payload with no conversion route — an older server. This is exactly
    // what the player did before conversion existed.
    openVideoPlayer(AVI_NO_CONVERSION);

    expect(fallback().hidden).toBe(false);
    expect(fallbackMessage()).toMatch(/cannot play/i);
    expect(downloadLink().getAttribute("href")).toBe("videos/album/clip.avi");
    expect(downloadLink().hidden).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("converts when the video element itself errors", async () => {
    // The load-bearing half: no static extension list predicts this
    // correctly in either direction (an HEVC .mp4 plays in Safari but not
    // Firefox), so the player always tries and reacts to what happened.
    openVideoPlayer({ ...MP4, transcodeUrl: "prepare_video/album/clip.mp4" });
    expect(fallback().hidden).toBe(true);

    video().dispatchEvent(new Event("error"));

    expect(progress().hidden).toBe(false);
    // The original is released: it is streaming bytes nothing can decode.
    expect(video().hasAttribute("src")).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith("prepare_video/album/clip.mp4", { method: "POST" });
    await flush();
  });

  it("falls back when an errored video has nowhere to be converted", () => {
    openVideoPlayer(MP4);
    video().dispatchEvent(new Event("error"));

    expect(fallback().hidden).toBe(false);
    expect(fallbackMessage()).toMatch(/cannot play/i);
    expect(downloadLink().getAttribute("href")).toBe("videos/album/clip.mp4");
  });

  it("ignores the error fired by teardown clearing the src", () => {
    openVideoPlayer(MP4);
    closeVideoPlayer();
    video().dispatchEvent(new Event("error"));
    expect(fallback().hidden).toBe(true);
    expect(progress().hidden).toBe(true);
  });

  it("recovers the player on the next open", () => {
    openVideoPlayer(AVI_NO_CONVERSION);
    closeVideoPlayer();
    openVideoPlayer(MP4);
    expect(fallback().hidden).toBe(true);
    expect(progress().hidden).toBe(true);
    expect(video().getAttribute("src")).toBe("videos/album/clip.mp4");
  });

  it("explains when there is no URL at all", () => {
    openVideoPlayer({ url: "", filename: "clip.mp4", playable: true });
    expect(fallback().hidden).toBe(false);
    expect(downloadLink().hidden).toBe(true);
  });
});

describe("conversion", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("plays the converted copy once it is ready", async () => {
    mockConversion({ state: "ready", progress: 1, url: "transcoded_video/album/clip.avi" });
    openVideoPlayer(AVI);
    await flush();

    expect(video().getAttribute("src")).toBe("transcoded_video/album/clip.avi");
    expect(progress().hidden).toBe(true);
    expect(video().play).toHaveBeenCalled();
    expect(document.activeElement).toBe(video());
  });

  it("reports progress while the conversion runs", async () => {
    mockConversion({ state: "running", progress: 0.42 });
    openVideoPlayer(AVI);
    await flush();

    expect(progress().hidden).toBe(false);
    expect(progressMessage()).toMatch(/converting/i);
    expect(document.getElementById("videoPlayerProgressPercent").textContent).toBe("42%");
    expect(document.getElementById("videoPlayerProgressFill").style.width).toBe("42%");
    expect(document.getElementById("videoPlayerProgressBar").getAttribute("aria-valuenow")).toBe("42");
  });

  it("says it is waiting while the job sits in the queue", async () => {
    mockConversion({ state: "queued", progress: 0 });
    openVideoPlayer(AVI);
    await flush();

    expect(progressMessage()).toMatch(/waiting/i);
  });

  it("sweeps rather than sitting at 0% when the duration is unknown", async () => {
    // ffmpeg could not determine the duration, so there is no percentage to
    // report. A bar parked at 0% reads as stuck.
    mockConversion({ state: "running", progress: 0 });
    openVideoPlayer(AVI);
    await flush();

    const bar = document.getElementById("videoPlayerProgressBar");
    expect(bar.classList.contains("video-player-bar--indeterminate")).toBe(true);
    expect(document.getElementById("videoPlayerProgressFill").style.width).toBe("");
  });

  it("keeps polling until the conversion finishes", async () => {
    mockConversion(
      { state: "queued", progress: 0 },
      { state: "running", progress: 0.5 },
      { state: "ready", progress: 1, url: "transcoded_video/album/clip.avi" }
    );
    openVideoPlayer(AVI);
    await flush();
    expect(progressMessage()).toMatch(/waiting/i);

    jest.advanceTimersByTime(1000);
    await flush();
    expect(progressMessage()).toMatch(/converting/i);

    jest.advanceTimersByTime(1000);
    await flush();
    expect(video().getAttribute("src")).toBe("transcoded_video/album/clip.avi");
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("stops polling when the player closes", async () => {
    // The backend drops a job nobody is asking about, so this is not merely
    // tidy: it is how closing the player cancels the ffmpeg run.
    mockConversion({ state: "running", progress: 0.1 });
    openVideoPlayer(AVI);
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    closeVideoPlayer();
    jest.advanceTimersByTime(10000);
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not let a late response play into a dismissed player", async () => {
    mockConversion({ state: "ready", progress: 1, url: "transcoded_video/album/clip.avi" });
    openVideoPlayer(AVI);
    closeVideoPlayer();
    await flush();

    expect(isVideoPlayerOpen()).toBe(false);
    expect(video().hasAttribute("src")).toBe(false);
  });

  it("does not let a late response play over a different clip", async () => {
    mockConversion({ state: "ready", progress: 1, url: "transcoded_video/album/clip.avi" });
    openVideoPlayer(AVI);
    openVideoPlayer(MP4);
    await flush();

    expect(video().getAttribute("src")).toBe("videos/album/clip.mp4");
  });

  it("shows the backend's reason when the conversion fails", async () => {
    mockConversion({ state: "failed", progress: 0, detail: "This video could not be converted." });
    openVideoPlayer(AVI);
    await flush();

    expect(fallback().hidden).toBe(false);
    expect(fallbackMessage()).toBe("This video could not be converted.");
    expect(downloadLink().getAttribute("href")).toBe("videos/album/clip.avi");
  });

  it("explains when the server has no ffmpeg", async () => {
    mockConversion({ state: "unavailable", progress: 0, detail: "ffmpeg is not available." });
    openVideoPlayer(AVI);
    await flush();

    expect(fallback().hidden).toBe(false);
    expect(fallbackMessage()).toBe("ffmpeg is not available.");
  });

  it("survives the request itself failing", async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error("offline")));
    openVideoPlayer(AVI);
    await flush();

    expect(fallback().hidden).toBe(false);
    expect(fallbackMessage()).toMatch(/could not be prepared/i);
  });

  it("treats a non-OK response as a failure rather than parsing it", async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    openVideoPlayer(AVI);
    await flush();

    expect(fallback().hidden).toBe(false);
    expect(fallbackMessage()).toMatch(/could not be prepared/i);
  });

  it("does not convert a second time when the converted copy also errors", async () => {
    // The conversion is H.264/AAC in an MP4. If that will not play, nothing
    // the backend can produce will, and re-converting would loop forever.
    mockConversion({ state: "ready", progress: 1, url: "transcoded_video/album/clip.avi" });
    openVideoPlayer(AVI);
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    video().dispatchEvent(new Event("error"));
    await flush();

    expect(fallback().hidden).toBe(false);
    expect(fallbackMessage()).toMatch(/even after conversion/i);
    expect(global.fetch).toHaveBeenCalledTimes(1);
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
