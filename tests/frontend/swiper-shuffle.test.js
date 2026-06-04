// Unit tests for shuffle mode in swiper.js - specifically testing the random slide selection logic
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

// Mock album-manager to prevent DOM errors (it has side effects on import)
jest.unstable_mockModule("../../photomap/frontend/static/javascript/album-manager.js", () => ({
  albumManager: {
    fetchAvailableAlbums: jest.fn(() => Promise.resolve([])),
    setSwiperManager: jest.fn(),
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

// Create mocked state
const mockState = {
  single_swiper: null,
  mode: "random",
  currentDelay: 5,
  highWaterMark: 50,
  swiper: null,
};

// Mock state module
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: mockState,
  saveSettingsToLocalStorage: jest.fn(),
}));

// Mock slideshow module
const mockSlideShowRunning = jest.fn(() => true);
jest.unstable_mockModule("../../photomap/frontend/static/javascript/slideshow.js", () => ({
  slideShowRunning: mockSlideShowRunning,
  updateSlideshowButtonIcon: jest.fn(),
}));

// Mock umap module
jest.unstable_mockModule("../../photomap/frontend/static/javascript/umap.js", () => ({
  updateCurrentImageMarker: jest.fn(),
}));

// Mock metadata-drawer module
jest.unstable_mockModule("../../photomap/frontend/static/javascript/metadata-drawer.js", () => ({
  updateMetadataOverlay: jest.fn(),
}));

// Mock events module
jest.unstable_mockModule("../../photomap/frontend/static/javascript/events.js", () => ({
  toggleGridSwiperView: jest.fn(),
}));

// Mock search module
const mockFetchImageByIndex = jest.fn();
jest.unstable_mockModule("../../photomap/frontend/static/javascript/search.js", () => ({
  fetchImageByIndex: mockFetchImageByIndex,
}));

// Mock slide-state module
const mockSlideState = {
  currentGlobalIndex: 0,
  currentSearchIndex: 0,
  isSearchMode: false,
  totalAlbumImages: 10,
  searchResults: [],
  updateFromExternal: jest.fn(),
  resolveOffset: jest.fn((offset) => ({
    globalIndex: mockSlideState.currentGlobalIndex + offset,
    searchIndex: null,
  })),
  getCurrentSlide: jest.fn(() => ({
    globalIndex: mockSlideState.currentGlobalIndex,
    searchIndex: null,
    totalCount: mockSlideState.totalAlbumImages,
    isSearchMode: false,
  })),
  getCurrentIndex: jest.fn(() =>
    mockSlideState.isSearchMode ? mockSlideState.currentSearchIndex : mockSlideState.currentGlobalIndex
  ),
  searchToGlobal: jest.fn((idx) => mockSlideState.searchResults[idx]?.index ?? null),
};

jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
  slideState: mockSlideState,
  getCurrentSlideIndex: jest.fn(() => [mockSlideState.currentGlobalIndex, mockSlideState.totalAlbumImages, null]),
}));

describe("swiper.js shuffle mode", () => {
  let mockSwiper;

  beforeEach(async () => {
    // Reset all mocks
    jest.clearAllMocks();

    // Reset slide state
    mockSlideState.currentGlobalIndex = 0;
    mockSlideState.currentSearchIndex = 0;
    mockSlideState.isSearchMode = false;
    mockSlideState.totalAlbumImages = 10;
    mockSlideState.searchResults = [];

    // Reset state
    mockState.mode = "random";
    mockSlideShowRunning.mockReturnValue(true);

    // Create mock Swiper with slides
    mockSwiper = {
      slides: [],
      activeIndex: 0,
      autoplay: { running: true, stop: jest.fn(), start: jest.fn() },
      allowSlideNext: true,
      allowSlidePrev: true,
      appendSlide: jest.fn((slide) => mockSwiper.slides.push(slide)),
      prependSlide: jest.fn((slide) => mockSwiper.slides.unshift(slide)),
      removeAllSlides: jest.fn(() => {
        mockSwiper.slides = [];
      }),
      slideTo: jest.fn(),
      on: jest.fn(),
    };

    // Mock global Swiper constructor
    global.Swiper = jest.fn(() => mockSwiper);

    // Mock fetch for image data
    mockFetchImageByIndex.mockImplementation((index) =>
      Promise.resolve({
        index: index,
        filename: `image${index}.jpg`,
        image_url: `/images/${index}.jpg`,
        filepath: `/path/to/image${index}.jpg`,
        total: 10,
      })
    );

    // Setup minimal DOM
    document.body.innerHTML = `
      <div id="singleSwiperContainer">
        <div id="singleSwiper" class="swiper">
          <div class="swiper-wrapper"></div>
        </div>
        <div id="singleSwiperPrevButton" class="swiper-button-prev"></div>
        <div id="singleSwiperNextButton" class="swiper-button-next"></div>
      </div>
    `;
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = "";
    delete global.Swiper;
  });

  describe("random slide selection", () => {
    it("deals every image once per cycle, then reshuffles for a fresh order", async () => {
      // The shuffle bag is a deck: across one cycle of `pool` deals every image
      // index appears exactly once; the next cycle is a fresh permutation.
      mockSlideState.totalAlbumImages = 5;

      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      const manager = await initializeSingleSwiper();
      // Force a clean bag (the SwiperManager singleton persists across tests).
      manager.shuffleBag = [];
      manager.shuffleBagPool = 0;
      manager.lastShuffleIterIndex = null;

      const cycle1 = [];
      for (let i = 0; i < 5; i++) {
        cycle1.push(manager.selectRandomSlideIndex().globalIndex);
      }
      const cycle2 = [];
      for (let i = 0; i < 5; i++) {
        cycle2.push(manager.selectRandomSlideIndex().globalIndex);
      }

      // Each cycle is a permutation of every album index — nothing missed, nothing repeated.
      expect([...cycle1].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
      expect([...cycle2].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
      // No immediate repeat across the cycle boundary.
      expect(cycle2[0]).not.toBe(cycle1[cycle1.length - 1]);
    });

    it("appends a fresh slide even when every image is already loaded (no stall)", async () => {
      // Regression: a small album whose every image is already in the buffer must
      // still advance — the bag re-deals images rather than refusing to append.
      mockSlideState.totalAlbumImages = 3;

      const existingSlides = [createMockSlide(0), createMockSlide(1), createMockSlide(2)];
      mockSwiper.slides = existingSlides;

      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      const manager = await initializeSingleSwiper();
      manager.shuffleBag = [];
      manager.shuffleBagPool = 0;
      manager.lastShuffleIterIndex = null;

      await manager.addSlideByIndex(0, null, false, true);

      // A slide was appended despite all three images already being present.
      expect(mockSwiper.slides.length).toBe(4);
    });

    it("should handle search mode with small result sets", async () => {
      // Test that shuffle mode works correctly with small search results
      mockSlideState.isSearchMode = true;
      mockSlideState.searchResults = [
        { index: 5, score: 0.9 },
        { index: 12, score: 0.8 },
        { index: 7, score: 0.7 },
      ];
      mockSlideState.searchToGlobal = jest.fn((idx) => mockSlideState.searchResults[idx]?.index ?? null);

      // Pre-load one slide
      mockSwiper.slides = [createMockSlide(5)];

      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");

      const manager = await initializeSingleSwiper();

      // Add a random slide - should pick one that doesn't exist (12 or 7)
      await manager.addSlideByIndex(5, 0, false, true);

      // Should have called searchToGlobal during random selection
      expect(mockSlideState.searchToGlobal).toHaveBeenCalled();
    });
  });

  describe("autoplay end-of-list behavior", () => {
    // Regression tests for the linear-slideshow bug where reaching the last
    // slide jumped back ~10 slides instead of stopping. Swiper's autoplay,
    // on reaching the end with loop off, calls slideTo(0) — the first slide in
    // the windowed buffer, not the album start. The primary defense is that our
    // slideNextTransitionStart handler stops autoplay the moment resolveOffset
    // reports no next slide; stopOnLastSlide is a config-level backstop.
    it("configures Swiper autoplay with stopOnLastSlide enabled and loop disabled", async () => {
      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      await initializeSingleSwiper();

      // new Swiper(selector, config) — grab the config it was constructed with.
      const swiperConfig = global.Swiper.mock.calls[0][1];
      expect(swiperConfig.loop).toBe(false);
      expect(swiperConfig.autoplay.stopOnLastSlide).toBe(true);
    });

    it("stops autoplay and appends nothing at the genuine last image (wrap off)", async () => {
      // resolveOffset(+1) returning null is how slide-state signals "no next
      // slide" at the end with wrap off. The handler must then leave the buffer
      // untouched AND stop autoplay so Swiper's next tick can't slideTo(0).
      mockState.mode = "chronological"; // linear, not shuffle
      mockSlideState.resolveOffset = jest.fn(() => ({ globalIndex: null, searchIndex: null }));

      // Capture the slideNextTransitionStart handler registered on the swiper.
      const handlers = {};
      mockSwiper.on = jest.fn((event, cb) => {
        handlers[event] = cb;
      });

      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      const manager = await initializeSingleSwiper();

      // Sit on the last loaded slide with autoplay running.
      mockSwiper.slides = [createMockSlide(8), createMockSlide(9)];
      mockSwiper.activeIndex = mockSwiper.slides.length - 1;
      mockSwiper.autoplay.running = true;
      const slidesBefore = mockSwiper.slides.length;

      await handlers.slideNextTransitionStart.call(manager);

      // No slide appended past the end, forward navigation re-enabled, and
      // autoplay halted so the slideshow rests on the final slide.
      expect(mockSwiper.slides.length).toBe(slidesBefore);
      expect(mockSwiper.allowSlideNext).toBe(true);
      expect(mockSwiper.autoplay.stop).toHaveBeenCalled();
    });

    it("keeps autoplay running and appends the wrapped slide at the end (wrap on)", async () => {
      // With wrap on, resolveOffset(+1) returns a real index (the first image),
      // so the handler appends it ahead and must NOT stop autoplay.
      mockState.mode = "chronological"; // linear, not shuffle
      mockSlideState.resolveOffset = jest.fn(() => ({ globalIndex: 0, searchIndex: null }));

      const handlers = {};
      mockSwiper.on = jest.fn((event, cb) => {
        handlers[event] = cb;
      });

      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      const manager = await initializeSingleSwiper();

      mockSwiper.slides = [createMockSlide(8), createMockSlide(9)];
      mockSwiper.activeIndex = mockSwiper.slides.length - 1;
      mockSwiper.autoplay.running = true;

      handlers.slideNextTransitionStart.call(manager);
      // The append is async (fetchImageByIndex); let its promise chain settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Wrapped slide appended ahead; autoplay left running to advance into it.
      expect(mockSwiper.slides.length).toBe(3);
      expect(mockSwiper.autoplay.stop).not.toHaveBeenCalled();
    });

    it("keeps shuffling and never stops at the last index in random mode", async () => {
      // In shuffle mode there is no end of list. resolveOffset(+1) returns null
      // whenever the current random slide is the last album index, but that must
      // NOT stop the slideshow — the handler should append another random slide.
      mockState.mode = "random";
      mockSlideShowRunning.mockReturnValue(true);
      mockSlideState.resolveOffset = jest.fn(() => ({ globalIndex: null, searchIndex: null }));

      const handlers = {};
      mockSwiper.on = jest.fn((event, cb) => {
        handlers[event] = cb;
      });

      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      const manager = await initializeSingleSwiper();

      // Parked on the last loaded slide, which is the last album index (9).
      mockSwiper.slides = [createMockSlide(8), createMockSlide(9)];
      mockSwiper.activeIndex = mockSwiper.slides.length - 1;
      mockSwiper.autoplay.running = true;
      const slidesBefore = mockSwiper.slides.length;

      handlers.slideNextTransitionStart.call(manager);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A random slide was appended and autoplay kept running — no premature stop.
      expect(mockSwiper.slides.length).toBe(slidesBefore + 1);
      expect(mockSwiper.autoplay.stop).not.toHaveBeenCalled();
    });
  });
});

// Helper function to create mock slide elements
function createMockSlide(globalIndex) {
  const slide = document.createElement("div");
  slide.className = "swiper-slide";
  slide.dataset.globalIndex = globalIndex;
  slide.dataset.filename = `image${globalIndex}.jpg`;
  slide.innerHTML = `<img src="/images/${globalIndex}.jpg" alt="image${globalIndex}" />`;
  return slide;
}
