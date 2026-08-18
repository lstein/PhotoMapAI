// downloadSingleImage has to treat a video differently from a photo: a photo
// is fetched into a blob so the object URL can carry a chosen filename, but a
// 200 MB clip buffered the same way sits entirely in browser memory before the
// save dialog appears.
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockFetchJson = jest.fn();

jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
  errorDetail: jest.fn(),
  fetchJson: mockFetchJson,
  hideSpinner: jest.fn(),
  setCheckmarkOnIcon: jest.fn(),
  showSpinner: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/control-panel.js", () => ({
  showDeleteConfirmModal: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/filetree.js", () => ({
  createSimpleDirectoryPicker: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/index.js", () => ({
  deleteImages: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/modal-utils.js", () => ({
  showConfirmModal: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/search.js", () => ({
  setSearchResults: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
  slideState: { getCurrentSlide: () => ({ globalIndex: 0 }) },
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: { album: "album", swiper: null, single_swiper: null },
  saveSettingsToLocalStorage: jest.fn(),
}));

const { bookmarkManager } = await import("../../photomap/frontend/static/javascript/bookmarks.js");

/** Capture the <a> the download path synthesises, and swallow its click. */
function captureAnchor() {
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

beforeEach(() => {
  jest.restoreAllMocks();
  mockFetchJson.mockReset();
  global.fetch = jest.fn();
  global.URL.createObjectURL = jest.fn(() => "blob:mock");
  global.URL.revokeObjectURL = jest.fn();
});

describe("downloading a video", () => {
  const VIDEO = {
    media_type: "video",
    image_url: "video_frame/album/3",
    video_url: "videos/album/clip.mp4",
    filename: "clip.mp4",
    filepath: "/photos/clip.mp4",
  };

  it("links straight at the video instead of buffering it into a blob", async () => {
    mockFetchJson.mockResolvedValue(VIDEO);
    const anchors = captureAnchor();

    await bookmarkManager.downloadSingleImage(3);

    // No fetch of the media itself, and no object URL: that is the whole point.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(global.URL.createObjectURL).not.toHaveBeenCalled();

    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("videos/album/clip.mp4");
    expect(anchors[0].download).toBe("clip.mp4");
    expect(anchors[0].click).toHaveBeenCalled();
  });

  it("downloads the playable file, not the still frame", async () => {
    mockFetchJson.mockResolvedValue(VIDEO);
    const anchors = captureAnchor();

    await bookmarkManager.downloadSingleImage(3);

    expect(anchors[0].getAttribute("href")).not.toBe(VIDEO.image_url);
  });

  it("falls back to the still frame when there is no video URL", async () => {
    mockFetchJson.mockResolvedValue({ ...VIDEO, video_url: "" });
    const anchors = captureAnchor();

    await bookmarkManager.downloadSingleImage(3);

    expect(anchors[0].getAttribute("href")).toBe("video_frame/album/3");
  });

  it("names an unnamed video with its real extension, not .jpg", async () => {
    // The old hardcoded image_${i}.jpg would save a clip under a name no
    // player would open.
    mockFetchJson.mockResolvedValue({ ...VIDEO, filename: "", filepath: "/photos/holiday.webm" });
    const anchors = captureAnchor();

    await bookmarkManager.downloadSingleImage(7);

    expect(anchors[0].download).toBe("image_7.webm");
  });

  it("still names a video when the index carries no path at all", async () => {
    mockFetchJson.mockResolvedValue({ ...VIDEO, filename: "", filepath: undefined });
    const anchors = captureAnchor();

    await bookmarkManager.downloadSingleImage(7);

    expect(anchors[0].download).toBe("image_7.mp4");
  });
});

describe("downloading a still image", () => {
  const IMAGE = {
    media_type: "image",
    image_url: "images/album/shot.jpg",
    filename: "shot.jpg",
    filepath: "/photos/shot.jpg",
  };

  it("keeps the blob path, so the chosen filename is honoured", async () => {
    mockFetchJson.mockResolvedValue(IMAGE);
    global.fetch.mockResolvedValue({ ok: true, blob: async () => new Blob(["x"]) });
    const anchors = captureAnchor();

    await bookmarkManager.downloadSingleImage(1);

    expect(global.fetch).toHaveBeenCalledWith("images/album/shot.jpg");
    expect(global.URL.createObjectURL).toHaveBeenCalled();
    expect(anchors[0].getAttribute("href")).toBe("blob:mock");
    expect(anchors[0].download).toBe("shot.jpg");
  });

  it("still throws when the image cannot be fetched", async () => {
    mockFetchJson.mockResolvedValue(IMAGE);
    global.fetch.mockResolvedValue({ ok: false });

    await expect(bookmarkManager.downloadSingleImage(1)).rejects.toThrow(/Failed to fetch/);
  });
});
