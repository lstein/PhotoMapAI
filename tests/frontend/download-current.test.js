// The control panel's Download button, and the shared single-item download.
//
// The load-bearing case is video: a photo is fetched into a blob so the object
// URL can carry a chosen filename, but a 200 MB clip buffered the same way
// sits entirely in browser memory before the save dialog appears. And a video
// must always be saved as the ORIGINAL file, never a converted copy.
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockFetchJson = jest.fn();
const mockGetCurrentSlideIndex = jest.fn();

jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
  errorDetail: (e) => e?.message ?? String(e),
  fetchJson: mockFetchJson,
  hideSpinner: jest.fn(),
  setCheckmarkOnIcon: jest.fn(),
  showSpinner: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: { album: "my album", swiper: null, single_swiper: null },
  saveSettingsToLocalStorage: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/index.js", () => ({
  deleteImage: jest.fn(),
  getIndexMetadata: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
  getCurrentFilepath: jest.fn(),
  getCurrentSlideIndex: mockGetCurrentSlideIndex,
  slideState: { getCurrentSlide: () => ({ globalIndex: 0 }) },
}));

const { downloadItem } = await import("../../photomap/frontend/static/javascript/download.js");
const { initializeControlPanel } = await import("../../photomap/frontend/static/javascript/control-panel.js");

/** Capture the <a> the download path synthesises, and swallow its click. */
function captureAnchors() {
  const anchors = [];
  const realCreate = document.createElement.bind(document);
  jest.spyOn(document, "createElement").mockImplementation((tag) => {
    const el = realCreate(tag);
    if (tag === "a") {
      el.click = jest.fn();
      anchors.push(el);
    }
    return el;
  });
  return anchors;
}

const VIDEO = {
  media_type: "video",
  filename: "holiday.avi",
  filepath: "/photos/holiday.avi",
  video_url: "videos/my%20album/holiday.avi",
  image_url: "video_frame/my%20album/7",
};

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(["x"])) }));
  global.URL.createObjectURL = jest.fn(() => "blob:fake");
  global.URL.revokeObjectURL = jest.fn();
  global.alert = jest.fn();
});

describe("downloadItem", () => {
  it("saves a video as the original file, never a converted copy", async () => {
    // The conversion exists so the browser can decode the container; it is a
    // lossy re-encode and it is not what is in the user's library.
    mockFetchJson.mockResolvedValue(VIDEO);
    const anchors = captureAnchors();

    await downloadItem(7);

    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("videos/my%20album/holiday.avi");
    expect(anchors[0].download).toBe("holiday.avi");
    expect(anchors[0].getAttribute("href")).not.toContain("transcoded");
  });

  it("streams a video rather than buffering it into memory", async () => {
    mockFetchJson.mockResolvedValue(VIDEO);
    captureAnchors();

    await downloadItem(7);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(global.URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to the real extension when the filename is missing", async () => {
    mockFetchJson.mockResolvedValue({ ...VIDEO, filename: undefined });
    const anchors = captureAnchors();

    await downloadItem(7);

    expect(anchors[0].download).toBe("image_7.avi");
  });

  it("still blob-downloads a photo, so the object URL can carry a name", async () => {
    mockFetchJson.mockResolvedValue({
      media_type: "image",
      filename: "beach.jpg",
      filepath: "/photos/beach.jpg",
      image_url: "images/my%20album/beach.jpg",
    });
    const anchors = captureAnchors();

    await downloadItem(3);

    expect(global.fetch).toHaveBeenCalledWith("images/my%20album/beach.jpg");
    expect(anchors[0].getAttribute("href")).toBe("blob:fake");
    expect(anchors[0].download).toBe("beach.jpg");
    expect(global.URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("raises when the image cannot be fetched", async () => {
    mockFetchJson.mockResolvedValue({ media_type: "image", image_url: "images/x", filename: "x.jpg" });
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404 }));

    await expect(downloadItem(1)).rejects.toThrow(/Failed to fetch/);
  });
});

describe("the shipped control panel markup", () => {
  // The fixture below passing proves nothing about the real page if the id is
  // renamed on one side only — the button would then silently do nothing.
  const TEMPLATE = readFileSync(
    fileURLToPath(new URL("../../photomap/frontend/templates/modules/control-panel.html", import.meta.url)),
    "utf8"
  );

  it("provides #downloadCurrentFileBtn", () => {
    expect(TEMPLATE).toContain('id="downloadCurrentFileBtn"');
  });

  it("keeps the button outside the album_locked guard", () => {
    // A lock protects the album's files from being changed; saving a copy
    // changes nothing, so a locked album must still be downloadable.
    const guarded = TEMPLATE.slice(TEMPLATE.indexOf("{% if not album_locked %}"), TEMPLATE.indexOf("{% endif %}"));
    expect(guarded).toContain('id="deleteCurrentFileBtn"');
    expect(guarded).not.toContain('id="downloadCurrentFileBtn"');
  });
});

describe("the control panel's Download button", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="controlPanel">
        <button id="downloadCurrentFileBtn"></button>
        <button id="deleteCurrentFileBtn"></button>
      </div>
      <div id="searchPanel"></div>
      <div id="fixedScoreDisplay"></div>`;
    initializeControlPanel();
  });

  it("downloads whatever slide is current, in either view", async () => {
    // getCurrentSlideIndex is view-agnostic, which is what lets one button
    // serve both the swiper and the grid.
    mockGetCurrentSlideIndex.mockReturnValue([7]);
    mockFetchJson.mockResolvedValue(VIDEO);
    const anchors = captureAnchors();

    document.getElementById("downloadCurrentFileBtn").click();
    await new Promise((r) => setTimeout(r, 0));

    expect(mockFetchJson).toHaveBeenCalledWith("retrieve_image/my%20album/7");
    expect(anchors[0].getAttribute("href")).toBe("videos/my%20album/holiday.avi");
  });

  it("says so rather than throwing when nothing is selected", async () => {
    mockGetCurrentSlideIndex.mockReturnValue([-1]);

    document.getElementById("downloadCurrentFileBtn").click();
    await new Promise((r) => setTimeout(r, 0));

    expect(global.alert).toHaveBeenCalledWith(expect.stringMatching(/no image selected/i));
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it("reports a failure instead of leaving the spinner up", async () => {
    mockGetCurrentSlideIndex.mockReturnValue([7]);
    mockFetchJson.mockRejectedValue(new Error("server exploded"));

    document.getElementById("downloadCurrentFileBtn").click();
    await new Promise((r) => setTimeout(r, 0));

    expect(global.alert).toHaveBeenCalledWith(expect.stringMatching(/server exploded/));
  });
});
