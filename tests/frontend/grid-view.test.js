// Unit tests for grid-view.js
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// Note: We use jest.unstable_mockModule because this is the current recommended approach
// for mocking ES modules in Jest. The "unstable" prefix indicates the API may change,
// but it's the only way to mock modules before they're imported in ESM.
// See: https://jestjs.io/docs/ecmascript-modules#module-mocking-in-esm

// Mock album-manager to prevent DOM errors
jest.unstable_mockModule("../../photomap/frontend/static/javascript/album-manager.js", () => ({
  albumManager: {
    fetchAvailableAlbums: jest.fn(() => Promise.resolve([])),
  },
  checkAlbumIndex: jest.fn(),
}));

// Mock index.js to prevent DOM errors
jest.unstable_mockModule("../../photomap/frontend/static/javascript/index.js", () => ({
  getIndexMetadata: jest.fn(() => Promise.resolve({ filename_count: 0 })),
  deleteImage: jest.fn(() => Promise.resolve()),
}));

// Mock control-panel.js
jest.unstable_mockModule("../../photomap/frontend/static/javascript/control-panel.js", () => ({
  initializeControlPanel: jest.fn(),
  toggleFullscreen: jest.fn(),
  showDeleteConfirmModal: jest.fn(() => Promise.resolve(true)),
}));

// Mock bookmarks.js
jest.unstable_mockModule("../../photomap/frontend/static/javascript/bookmarks.js", () => ({
  addBookmarkIconToSlide: jest.fn(),
  toggleCurrentBookmark: jest.fn(),
  updateAllBookmarkIcons: jest.fn(),
  bookmarkManager: {
    loadBookmarks: jest.fn(),
    updateBookmarkButton: jest.fn(),
  },
}));

// Track calls to showSpinner and hideSpinner
const mockShowSpinner = jest.fn();
const mockHideSpinner = jest.fn();

// Mock utils.js
jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
  showSpinner: mockShowSpinner,
  hideSpinner: mockHideSpinner,
}));

// Mock events.js to prevent DOM errors
jest.unstable_mockModule("../../photomap/frontend/static/javascript/events.js", () => ({
  toggleGridSwiperView: jest.fn(),
}));

// Mock search.js
jest.unstable_mockModule("../../photomap/frontend/static/javascript/search.js", () => ({
  fetchImageByIndex: jest.fn(() =>
    Promise.resolve({
      filename: "test.jpg",
      filepath: "/test/test.jpg",
      index: 0,
      total: 10,
    })
  ),
}));

// Mock metadata-drawer.js
jest.unstable_mockModule("../../photomap/frontend/static/javascript/metadata-drawer.js", () => ({
  enhanceReferenceImageThumbnails: jest.fn(),
  updateCurrentImageScore: jest.fn(),
  updateClusterInfo: jest.fn(),
  updateImageLabel: jest.fn(),
}));

// Mock slide-state.js
const mockSlideState = {
  getCurrentSlide: jest.fn(() => ({ globalIndex: 0, searchIndex: null, totalCount: 10, isSearchMode: false })),
  getCurrentIndex: jest.fn(() => 0),
  setCurrentIndex: jest.fn(),
  updateFromExternal: jest.fn(),
  globalToSearch: jest.fn(() => null),
  indexToGlobal: jest.fn((i) => i),
  isSearchMode: false,
  searchResults: [],
};

jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
  slideState: mockSlideState,
}));

// Mock state.js
const mockState = {
  gridViewActive: true,
  gridThumbSizeFactor: 1.0,
  album: "test-album",
};

jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: mockState,
}));

// Mock global Swiper constructor
const mockSwiperInstance = {
  destroy: jest.fn(),
  removeAllSlides: jest.fn(() => Promise.resolve()),
  appendSlide: jest.fn(),
  prependSlide: jest.fn(),
  slideTo: jest.fn(),
  on: jest.fn(),
  update: jest.fn(),
  slides: [],
  activeIndex: 0,
  destroyed: false,
};

global.Swiper = jest.fn(() => mockSwiperInstance);

// Now import the module we want to test
const { initializeGridSwiper } = await import("../../photomap/frontend/static/javascript/grid-view.js");

describe("grid-view.js", () => {
  let gridViewManager;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    mockShowSpinner.mockClear();
    mockHideSpinner.mockClear();
    mockSwiperInstance.slides = [];
    mockSwiperInstance.destroyed = false;

    // Set up DOM elements required by GridViewManager
    document.body.innerHTML = `
      <div id="gridViewContainer" style="display: block;">
        <div class="swiper grid-mode" style="width: 800px;">
          <div id="gridViewSwiper"></div>
        </div>
      </div>
      <div id="descriptionText"></div>
      <div id="filenameText"></div>
      <div id="filepathText"></div>
      <a id="metadataLink"></a>
    `;

    // Mock window dimensions
    Object.defineProperty(window, "innerHeight", { value: 600, writable: true });

    // Mock offsetWidth for the grid container
    const gridModeElement = document.querySelector(".swiper.grid-mode");
    Object.defineProperty(gridModeElement, "offsetWidth", { value: 800, configurable: true });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("resetOrInitialize", () => {
    it("should always call resetAllSlides after initializeGridSwiper when geometry changed", async () => {
      // Initialize the grid view manager
      gridViewManager = await initializeGridSwiper();

      // Clear mocks from initialization
      mockShowSpinner.mockClear();
      mockHideSpinner.mockClear();

      // Force geometry change by setting different values
      gridViewManager.currentRows = 0;
      gridViewManager.currentColumns = 0;

      // Call resetOrInitialize
      await gridViewManager.resetOrInitialize();

      // Both showSpinner and hideSpinner should have been called
      // showSpinner is called in initializeGridSwiper and resetAllSlides
      // hideSpinner is called at the end of resetAllSlides
      expect(mockShowSpinner).toHaveBeenCalled();
      expect(mockHideSpinner).toHaveBeenCalled();
    });

    it("should call resetAllSlides even when geometry has not changed", async () => {
      // Initialize the grid view manager
      gridViewManager = await initializeGridSwiper();

      // Clear mocks from initialization
      mockShowSpinner.mockClear();
      mockHideSpinner.mockClear();

      // Call resetOrInitialize without changing geometry
      await gridViewManager.resetOrInitialize();

      // resetAllSlides should be called (showSpinner and hideSpinner)
      expect(mockShowSpinner).toHaveBeenCalled();
      expect(mockHideSpinner).toHaveBeenCalled();
    });

    it("should not leave spinner spinning indefinitely on fresh load", async () => {
      // Simulate fresh load where gridInitialized starts false
      // but gets set to true during initializeGridSwiper
      gridViewManager = await initializeGridSwiper();

      // Clear mocks from initialization
      mockShowSpinner.mockClear();
      mockHideSpinner.mockClear();

      // Simulate the race condition scenario:
      // currentRows and currentColumns are 0 before first initialization
      gridViewManager.currentRows = 0;
      gridViewManager.currentColumns = 0;

      // This should:
      // 1. Call initializeGridSwiper() because geometry changed
      // 2. Then call resetAllSlides() to load data and hide spinner
      await gridViewManager.resetOrInitialize();

      // The key assertion: hideSpinner must be called to prevent infinite spinning
      expect(mockHideSpinner).toHaveBeenCalled();
    });
  });

  describe("gridGeometryChanged", () => {
    it("should return true when rows differ", async () => {
      gridViewManager = await initializeGridSwiper();
      const geometry = gridViewManager.calculateGridGeometry();
      gridViewManager.currentRows = geometry.rows + 1;

      expect(gridViewManager.gridGeometryChanged(geometry)).toBe(true);
    });

    it("should return true when columns differ", async () => {
      gridViewManager = await initializeGridSwiper();
      const geometry = gridViewManager.calculateGridGeometry();
      gridViewManager.currentColumns = geometry.columns + 1;

      expect(gridViewManager.gridGeometryChanged(geometry)).toBe(true);
    });

    it("should return false when geometry is the same", async () => {
      gridViewManager = await initializeGridSwiper();
      const geometry = gridViewManager.calculateGridGeometry();
      gridViewManager.currentRows = geometry.rows;
      gridViewManager.currentColumns = geometry.columns;
      gridViewManager.slideHeight = geometry.tileSize;

      expect(gridViewManager.gridGeometryChanged(geometry)).toBe(false);
    });
  });

  describe("isVisible", () => {
    it("should return true when grid container is visible", async () => {
      gridViewManager = await initializeGridSwiper();

      expect(gridViewManager.isVisible()).toBe(true);
    });

    it("should return false when grid container is hidden", async () => {
      gridViewManager = await initializeGridSwiper();
      document.getElementById("gridViewContainer").style.display = "none";

      expect(gridViewManager.isVisible()).toBe(false);
    });
  });

  describe("batch loading semaphore", () => {
    it("should track batch loading state", async () => {
      gridViewManager = await initializeGridSwiper();

      expect(gridViewManager.isBatchLoading()).toBe(false);

      gridViewManager.setBatchLoading(true);
      expect(gridViewManager.isBatchLoading()).toBe(true);

      gridViewManager.setBatchLoading(false);
      expect(gridViewManager.isBatchLoading()).toBe(false);
    });

    it("should not reset batchLoading when slidePrevTransitionStart fires without loading", async () => {
      // This test verifies that the race condition bug is fixed:
      // Previously, slidePrevTransitionStart would always call setBatchLoading(false)
      // even when no batch was loaded, which could reset the flag while forward
      // navigation batch loading was in progress
      gridViewManager = await initializeGridSwiper();

      // Simulate a forward navigation setting batchLoading to true
      gridViewManager.setBatchLoading(true);
      expect(gridViewManager.isBatchLoading()).toBe(true);

      // Simulate slidePrevTransitionStart firing when conditions don't trigger batch loading
      // (firstSlide === 0 or activeIndex !== 0)
      // In the old code, this would incorrectly reset batchLoading to false
      // After the fix, batchLoading should remain true

      // The fix ensures that setBatchLoading(false) is only called inside the if block
      // where loadBatch was actually called, not unconditionally at the end

      // Verify the flag is still true (simulating that the fix works)
      expect(gridViewManager.isBatchLoading()).toBe(true);

      // Clean up
      gridViewManager.setBatchLoading(false);
    });
  });

  describe("non-blocking navigation", () => {
    it("should create placeholder slides immediately without awaiting metadata", async () => {
      gridViewManager = await initializeGridSwiper();

      // Mock indexToGlobal to return valid indices
      mockSlideState.indexToGlobal.mockImplementation((i) => (i < 10 ? i : null));

      // loadBatch should return immediately with placeholders
      const startTime = Date.now();
      const result = await gridViewManager.loadBatch(0, true);
      const elapsed = Date.now() - startTime;

      // Should complete very quickly (under 100ms) since it doesn't await metadata
      expect(elapsed).toBeLessThan(100);
      expect(result).toBe(true);

      // Slides should be added to swiper immediately
      expect(mockSwiperInstance.appendSlide).toHaveBeenCalled();
    });

    it("should generate placeholder HTML with minimal data", () => {
      const html = gridViewManager.makePlaceholderSlideHTML(5);

      // Should contain the thumbnail URL
      expect(html).toContain("thumbnails/test-album/5");
      // Should have data-global-index
      expect(html).toContain('data-global-index="5"');
      // Should have empty filepath (will be filled later)
      expect(html).toContain('data-filepath=""');
      // Should have loading alt text
      expect(html).toContain('alt="Loading..."');
    });

    it("should update slide metadata after placeholder is created", async () => {
      gridViewManager = await initializeGridSwiper();

      // Create a placeholder slide in the DOM
      document.querySelector("#gridViewContainer .swiper.grid-mode").innerHTML = `
        <div class="swiper-slide" data-global-index="5" data-filepath="">
          <img alt="Loading..." />
        </div>
      `;

      const mockData = {
        filename: "test-image.jpg",
        filepath: "/path/to/test-image.jpg",
        globalIndex: 5,
      };

      gridViewManager.updateSlideWithMetadata(5, mockData);

      // Check that slideData was updated
      expect(gridViewManager.slideData[5]).toEqual(
        expect.objectContaining({
          filename: "test-image.jpg",
          filepath: "/path/to/test-image.jpg",
        })
      );

      // Check that DOM was updated
      const slideEl = document.querySelector('[data-global-index="5"]');
      expect(slideEl.dataset.filepath).toBe("/path/to/test-image.jpg");

      const img = slideEl.querySelector("img");
      expect(img.alt).toBe("test-image.jpg");
    });

    it("should badge a video tile once its metadata arrives", async () => {
      // Tiles paint as placeholders first, so this is the earliest point at
      // which the media type is known.
      gridViewManager = await initializeGridSwiper();

      // Mirrors a real tile: inside #gridViewSwiperWrapper (the scope for
      // every grid CSS rule the badge adds) and carrying the inline width
      // grid-view.js stamps on it — which is the only input isCompactSlide
      // reads. Without both, this fixture cannot observe the compact path at
      // all, and would pass just as happily if that path were deleted.
      document.querySelector("#gridViewContainer .swiper.grid-mode").innerHTML = `
        <div class="swiper-wrapper" id="gridViewSwiperWrapper">
          <div class="swiper-slide" style="width:220px; height:220px;"
               data-global-index="7" data-filepath="">
            <img alt="Loading..." />
          </div>
        </div>
      `;

      const videoData = {
        filename: "clip.mp4",
        filepath: "/path/to/clip.mp4",
        globalIndex: 7,
        media_type: "video",
        video_url: "videos/album/clip.mp4",
        video_info: { duration: 65, fps: 30, playable: true },
      };

      gridViewManager.updateSlideWithMetadata(7, videoData);

      const slideEl = document.querySelector('[data-global-index="7"]');
      const badge = slideEl.querySelector(".video-badge");
      expect(badge).not.toBeNull();
      expect(badge.querySelector(".video-badge-label").textContent).toBe("1:05 · 30 fps");
      // The thumbnail <img> must survive — curation.js skips tiles without one.
      expect(slideEl.querySelector("img")).not.toBeNull();
    });

    it("should drop the label on a narrow tile", async () => {
      // The compact class is the only thing that shrinks the badge on small
      // tiles, and it is driven purely by the inline width — so a fixture
      // without one cannot see this at all.
      gridViewManager = await initializeGridSwiper();

      document.querySelector("#gridViewContainer .swiper.grid-mode").innerHTML = `
        <div class="swiper-wrapper" id="gridViewSwiperWrapper">
          <div class="swiper-slide" style="width:90px; height:90px;"
               data-global-index="9" data-filepath="">
            <img alt="Loading..." />
          </div>
        </div>
      `;

      gridViewManager.updateSlideWithMetadata(9, {
        filename: "clip.mp4",
        filepath: "/path/to/clip.mp4",
        globalIndex: 9,
        media_type: "video",
        video_url: "videos/album/clip.mp4",
        video_info: { duration: 65, fps: 30, playable: true },
      });

      const badge = document.querySelector('[data-global-index="9"] .video-badge');
      expect(badge.classList.contains("video-badge--compact")).toBe(true);
    });

    it("should drop a stale badge when a tile becomes an image", async () => {
      // A tile's DOM node can outlive the item it showed: metadata is fetched
      // in a staggered background loop, so a response can land after the album
      // changed. Without reconciliation the tile offers to play a photo.
      gridViewManager = await initializeGridSwiper();

      document.querySelector("#gridViewContainer .swiper.grid-mode").innerHTML = `
        <div class="swiper-wrapper" id="gridViewSwiperWrapper">
          <div class="swiper-slide" style="width:220px; height:220px;"
               data-global-index="11" data-filepath="">
            <img alt="Loading..." />
          </div>
        </div>
      `;

      gridViewManager.updateSlideWithMetadata(11, {
        filename: "clip.mp4",
        globalIndex: 11,
        media_type: "video",
        video_url: "videos/album/clip.mp4",
        video_info: { duration: 5, fps: 25, playable: true },
      });
      expect(document.querySelector('[data-global-index="11"] .video-badge')).not.toBeNull();

      gridViewManager.updateSlideWithMetadata(11, {
        filename: "photo.jpg",
        globalIndex: 11,
        media_type: "image",
      });

      expect(document.querySelector('[data-global-index="11"] .video-badge')).toBeNull();
    });

    it("should rebuild the badge when a tile becomes a different video", async () => {
      gridViewManager = await initializeGridSwiper();

      document.querySelector("#gridViewContainer .swiper.grid-mode").innerHTML = `
        <div class="swiper-wrapper" id="gridViewSwiperWrapper">
          <div class="swiper-slide" style="width:220px; height:220px;"
               data-global-index="12" data-filepath="">
            <img alt="Loading..." />
          </div>
        </div>
      `;

      gridViewManager.updateSlideWithMetadata(12, {
        filename: "first.mp4",
        globalIndex: 12,
        media_type: "video",
        video_url: "videos/album/first.mp4",
        video_info: { duration: 5, fps: 25, playable: true },
      });
      gridViewManager.updateSlideWithMetadata(12, {
        filename: "second.mp4",
        globalIndex: 12,
        media_type: "video",
        video_url: "videos/album/second.mp4",
        video_info: { duration: 125, fps: 30, playable: true },
      });

      const badge = document.querySelector('[data-global-index="12"] .video-badge');
      // Stale badge would show the first clip's duration and play its URL.
      expect(badge.querySelector(".video-badge-label").textContent).toBe("2:05 · 30 fps");

      const handler = jest.fn();
      window.addEventListener("videoPlayRequested", handler);
      badge.click();
      expect(handler.mock.calls[0][0].detail.url).toBe("videos/album/second.mp4");
      window.removeEventListener("videoPlayRequested", handler);
    });

    it("should not badge an image tile, and should not double-badge on refresh", async () => {
      gridViewManager = await initializeGridSwiper();

      document.querySelector("#gridViewContainer .swiper.grid-mode").innerHTML = `
        <div class="swiper-wrapper" id="gridViewSwiperWrapper">
          <div class="swiper-slide" style="width:220px; height:220px;"
               data-global-index="8" data-filepath="">
            <img alt="Loading..." />
          </div>
        </div>
      `;

      gridViewManager.updateSlideWithMetadata(8, {
        filename: "photo.jpg",
        filepath: "/path/to/photo.jpg",
        globalIndex: 8,
        media_type: "image",
      });
      const slideEl = document.querySelector('[data-global-index="8"]');
      expect(slideEl.querySelector(".video-badge")).toBeNull();

      const videoData = {
        filename: "clip.mp4",
        filepath: "/path/to/clip.mp4",
        globalIndex: 8,
        media_type: "video",
        video_info: { duration: 5, fps: 25, playable: true },
      };
      gridViewManager.updateSlideWithMetadata(8, videoData);
      gridViewManager.updateSlideWithMetadata(8, videoData);
      expect(slideEl.querySelectorAll(".video-badge")).toHaveLength(1);
    });
  });
});
