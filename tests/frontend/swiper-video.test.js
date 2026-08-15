// Integration test: swiper.js builds video slides with a play badge.
//
// video-badge.js itself is covered in isolation by video-badge.test.js; what
// matters here is that addSlideByIndex wires the payload through, on both the
// desktop and touch construction paths.
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule("../../photomap/frontend/static/javascript/album-manager.js", () => ({
  albumManager: {
    fetchAvailableAlbums: jest.fn(() => Promise.resolve([])),
    setSwiperManager: jest.fn(),
  },
  checkAlbumIndex: jest.fn(),
}));

jest.unstable_mockModule("../../photomap/frontend/static/javascript/index.js", () => ({
  getIndexMetadata: jest.fn(() => Promise.resolve({ filename_count: 0 })),
  deleteImage: jest.fn(() => Promise.resolve()),
}));

jest.unstable_mockModule("../../photomap/frontend/static/javascript/control-panel.js", () => ({
  initializeControlPanel: jest.fn(),
  toggleFullscreen: jest.fn(),
  showDeleteConfirmModal: jest.fn(() => Promise.resolve(true)),
}));

jest.unstable_mockModule("../../photomap/frontend/static/javascript/bookmarks.js", () => ({
  addBookmarkIconToSlide: jest.fn(),
  toggleCurrentBookmark: jest.fn(),
  updateAllBookmarkIcons: jest.fn(),
  bookmarkManager: {
    loadBookmarks: jest.fn(),
    updateBookmarkButton: jest.fn(),
  },
}));

const mockState = {
  single_swiper: null,
  mode: "chronological",
  currentDelay: 5,
  highWaterMark: 50,
  swiper: null,
};

jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: mockState,
  saveSettingsToLocalStorage: jest.fn(),
}));

jest.unstable_mockModule("../../photomap/frontend/static/javascript/slideshow.js", () => ({
  slideShowRunning: jest.fn(() => false),
  updateSlideshowButtonIcon: jest.fn(),
}));

jest.unstable_mockModule("../../photomap/frontend/static/javascript/umap.js", () => ({
  updateCurrentImageMarker: jest.fn(),
}));

jest.unstable_mockModule("../../photomap/frontend/static/javascript/metadata-drawer.js", () => ({
  updateMetadataOverlay: jest.fn(),
}));

jest.unstable_mockModule("../../photomap/frontend/static/javascript/events.js", () => ({
  toggleGridSwiperView: jest.fn(),
}));

const mockFetchImageByIndex = jest.fn();
jest.unstable_mockModule("../../photomap/frontend/static/javascript/search.js", () => ({
  fetchImageByIndex: mockFetchImageByIndex,
}));

jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
  showToast: jest.fn(),
}));

const mockSlideState = {
  currentGlobalIndex: 0,
  isSearchMode: false,
  totalAlbumImages: 10,
  searchResults: [],
  updateFromExternal: jest.fn(),
  resolveOffset: jest.fn(() => ({ globalIndex: 0, searchIndex: null })),
  getCurrentSlide: jest.fn(() => ({
    globalIndex: 0,
    searchIndex: null,
    totalCount: 10,
    isSearchMode: false,
  })),
  getCurrentIndex: jest.fn(() => 0),
  searchToGlobal: jest.fn(() => null),
};

jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
  slideState: mockSlideState,
  getCurrentSlideIndex: jest.fn(() => [0, 10, null]),
}));

const VIDEO_PAYLOAD = {
  index: 4,
  total: 10,
  filename: "clip.mp4",
  filepath: "/photos/clip.mp4",
  image_url: "video_frame/album/4",
  video_url: "videos/album/clip.mp4",
  metadata_url: "get_metadata/album/4",
  media_type: "video",
  video_info: { duration: 125, fps: 29.97, playable: true },
};

const IMAGE_PAYLOAD = {
  index: 2,
  total: 10,
  filename: "photo.jpg",
  filepath: "/photos/photo.jpg",
  image_url: "images/album/photo.jpg",
  metadata_url: "get_metadata/album/2",
  media_type: "image",
};

describe("swiper.js video slides", () => {
  let mockSwiper;
  let manager;

  async function buildManager() {
    const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
    return initializeSingleSwiper();
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    mockSwiper = {
      slides: [],
      activeIndex: 0,
      params: { autoplay: { stopOnLastSlide: true } },
      autoplay: { running: false, stop: jest.fn(), start: jest.fn() },
      allowSlideNext: true,
      allowSlidePrev: true,
      appendSlide: jest.fn((slide) => mockSwiper.slides.push(slide)),
      prependSlide: jest.fn((slide) => mockSwiper.slides.unshift(slide)),
      removeSlide: jest.fn(),
      removeAllSlides: jest.fn(() => {
        mockSwiper.slides = [];
      }),
      slideTo: jest.fn(),
      on: jest.fn(),
    };
    global.Swiper = jest.fn(() => mockSwiper);

    document.body.innerHTML = `
      <div id="singleSwiperContainer">
        <div id="singleSwiper" class="swiper">
          <div class="swiper-wrapper"></div>
        </div>
        <div id="singleSwiperPrevButton" class="swiper-button-prev"></div>
        <div id="singleSwiperNextButton" class="swiper-button-next"></div>
      </div>
    `;

    manager = await buildManager();
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = "";
    delete global.Swiper;
  });

  it("draws a play badge on a video slide", async () => {
    mockFetchImageByIndex.mockResolvedValue(VIDEO_PAYLOAD);

    await manager.addSlideByIndex(4);

    const slide = mockSwiper.slides[0];
    const badge = slide.querySelector(".video-badge");
    expect(badge).not.toBeNull();
    expect(badge.querySelector(".video-badge-label").textContent).toBe("2:05 · 29.97 fps");
  });

  it("keeps the poster as an <img> pointing at the extracted still", async () => {
    // search-ui.js reads slide.querySelector("img").src for "search by this
    // image"; keeping the poster an <img> means it searches by the very frame
    // that was embedded.
    mockFetchImageByIndex.mockResolvedValue(VIDEO_PAYLOAD);

    await manager.addSlideByIndex(4);

    const img = mockSwiper.slides[0].querySelector("img");
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("video_frame/album/4");
  });

  it("records the media type and playable URL on the slide dataset", async () => {
    mockFetchImageByIndex.mockResolvedValue(VIDEO_PAYLOAD);

    await manager.addSlideByIndex(4);

    const slide = mockSwiper.slides[0];
    expect(slide.dataset.mediaType).toBe("video");
    expect(slide.dataset.videoUrl).toBe("videos/album/clip.mp4");
  });

  it("adds no badge to an image slide", async () => {
    mockFetchImageByIndex.mockResolvedValue(IMAGE_PAYLOAD);

    await manager.addSlideByIndex(2);

    const slide = mockSwiper.slides[0];
    expect(slide.querySelector(".video-badge")).toBeNull();
    expect(slide.dataset.mediaType).toBe("image");
    expect(slide.dataset.videoUrl).toBe("");
  });

  it("badges prepended slides too", async () => {
    // Prepend is a separate construction path from append; a badge applied by
    // a later sweep rather than at construction would miss it.
    mockFetchImageByIndex.mockResolvedValue(VIDEO_PAYLOAD);

    await manager.addSlideByIndex(4, null, true);

    expect(mockSwiper.prependSlide).toHaveBeenCalled();
    expect(mockSwiper.slides[0].querySelector(".video-badge")).not.toBeNull();
  });

  it("keeps the badge outside the zoom container on touch devices", async () => {
    // Swiper's zoom module scales the first img inside .swiper-zoom-container;
    // a badge in there would be scaled on pinch.
    mockFetchImageByIndex.mockResolvedValue(VIDEO_PAYLOAD);
    manager.hasTouchCapability = true;

    await manager.addSlideByIndex(4);

    const slide = mockSwiper.slides[0];
    expect(slide.querySelector(".swiper-zoom-container img")).not.toBeNull();
    expect(slide.querySelector(".swiper-zoom-container .video-badge")).toBeNull();
    expect(slide.querySelector(":scope > .video-badge")).not.toBeNull();

    manager.hasTouchCapability = false;
  });

  it("clicking the badge asks for playback rather than changing views", async () => {
    mockFetchImageByIndex.mockResolvedValue(VIDEO_PAYLOAD);
    await manager.addSlideByIndex(4);

    const handler = jest.fn();
    window.addEventListener("videoPlayRequested", handler);

    mockSwiper.slides[0].querySelector(".video-badge").click();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail.url).toBe("videos/album/clip.mp4");
    window.removeEventListener("videoPlayRequested", handler);
  });
});
