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

// Comfortably longer than swiper.js's TRIM_DELAY_MS, so a deferred trim has
// definitely run by the time we assert on it.
const TRIM_SETTLE_MS = 700;

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
      params: { autoplay: { stopOnLastSlide: true } },
      autoplay: {
        running: true,
        stop: jest.fn(() => {
          mockSwiper.autoplay.running = false;
        }),
        start: jest.fn(() => {
          mockSwiper.autoplay.running = true;
        }),
      },
      allowSlideNext: true,
      allowSlidePrev: true,
      appendSlide: jest.fn((slide) => mockSwiper.slides.push(slide)),
      prependSlide: jest.fn((slide) => mockSwiper.slides.unshift(slide)),
      // Mirrors Swiper 11's removeSlide (swiper-bundle `pe`): it takes an index
      // or an array of them, resolves every index against the *pre-removal*
      // slide list, shifts activeIndex down by one for each removed slide that
      // sat before it, and finishes with slideTo(newActiveIndex) — whose
      // beforeTransitionStart stops autoplay under disableOnInteraction.
      //
      // Honouring the indexes matters: a mock that always shifts the front
      // cannot tell a front trim from a back trim, and would pass either way.
      // Tracking activeIndex matters too — the trim's "never remove the active
      // slide" budget is computed from it.
      removeSlide: jest.fn((indexes) => {
        const list = Array.isArray(indexes) ? indexes : [indexes];
        const doomed = new Set(list);
        let active = mockSwiper.activeIndex;
        list.forEach((i) => {
          if (i < mockSwiper.activeIndex) {
            active -= 1;
          }
        });
        mockSwiper.slides = mockSwiper.slides.filter((_, i) => !doomed.has(i));
        mockSwiper.activeIndex = Math.max(active, 0);
        mockSwiper.autoplay.running = false;
      }),
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

  describe("resetAllSlides coalescing", () => {
    it("re-runs a coalesced rebuild with the latest caller's random_nextslide", async () => {
      // Play in shuffle mode starts a rebuild with random neighbors; if the
      // user switches to sequential while it is in flight, the queued re-pass
      // must use *that* caller's flag (false), not the in-flight one (true) —
      // otherwise the "rebuild in album order" request silently yields a
      // shuffled buffer.
      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      const manager = await initializeSingleSwiper();
      manager._resetInFlight = null;
      manager._resetPending = false;
      manager._doResetAllSlides = jest.fn(() => Promise.resolve());

      const first = manager.resetAllSlides(true);
      const second = manager.resetAllSlides(false);
      await Promise.all([first, second]);

      expect(manager._doResetAllSlides.mock.calls.map(([flag]) => flag)).toEqual([true, false]);
    });
  });

  describe("logical run state across rebuilds", () => {
    // Make the mock Swiper emit autoplayStop synchronously from stop(), as the
    // real one does, so the manager's autoplayStop handler is exercised.
    let handlers;
    async function freshManager() {
      handlers = {};
      mockSwiper.on = jest.fn((event, cb) => {
        handlers[event] = cb;
      });
      mockSwiper.autoplay.stop = jest.fn(() => {
        mockSwiper.autoplay.running = false;
        handlers.autoplayStop?.();
      });
      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      const manager = await initializeSingleSwiper();
      // The SwiperManager singleton persists across tests: start clean, and
      // drop any _doResetAllSlides mock an earlier test installed as an own
      // property so tests that want the real rebuild get it.
      delete manager._doResetAllSlides;
      manager._resetInFlight = null;
      manager._resetPending = false;
      manager.slideshowActive = false;
      return manager;
    }

    it("defers a resume requested during a rebuild until the rebuild finishes", async () => {
      // Play dispatches slideshowStartRequested (which starts a rebuild) and
      // then calls resumeSlideshow(). Autoplay must not start against the
      // half-built buffer; it starts once the rebuild completes.
      jest.useFakeTimers();
      const manager = await freshManager();
      let release;
      manager._doResetAllSlides = jest.fn(() => new Promise((resolve) => (release = resolve)));
      mockSwiper.autoplay.running = false;

      const rebuild = manager.resetAllSlides(true);
      manager.resumeSlideshow();
      jest.advanceTimersByTime(100);
      expect(mockSwiper.autoplay.start).not.toHaveBeenCalled();

      release();
      await rebuild;
      jest.advanceTimersByTime(50);
      expect(mockSwiper.autoplay.start).toHaveBeenCalledTimes(1);
      expect(manager.isSlideshowActive()).toBe(true);
    });

    it("leaves autoplay stopped when the user pauses during a rebuild", async () => {
      // Regression: the rebuild used to capture "was running" at entry and
      // resume unconditionally at exit, restarting a slideshow the user had
      // paused (or switched to sequential) while the rebuild was fetching.
      jest.useFakeTimers();
      const manager = await freshManager();
      let release;
      manager._doResetAllSlides = jest.fn(() => new Promise((resolve) => (release = resolve)));
      manager.slideshowActive = true;
      mockSwiper.autoplay.running = false; // stopped internally by the rebuild

      const rebuild = manager.resetAllSlides();
      manager.pauseSlideshow();
      release();
      await rebuild;
      jest.advanceTimersByTime(100);

      expect(mockSwiper.autoplay.start).not.toHaveBeenCalled();
      expect(manager.isSlideshowActive()).toBe(false);
    });

    it("restarts autoplay after a rebuild when the slideshow is still wanted", async () => {
      jest.useFakeTimers();
      const manager = await freshManager();
      manager._doResetAllSlides = jest.fn(() => Promise.resolve());
      manager.slideshowActive = true;

      await manager.resetAllSlides();
      jest.advanceTimersByTime(50);

      expect(mockSwiper.autoplay.start).toHaveBeenCalledTimes(1);
    });

    it("does not let a stale start timer undo a pause made within the restart delay", async () => {
      jest.useFakeTimers();
      const manager = await freshManager();
      manager.resumeSlideshow();
      manager.pauseSlideshow();
      jest.advanceTimersByTime(100);

      expect(mockSwiper.autoplay.start).not.toHaveBeenCalled();
      expect(manager.isSlideshowActive()).toBe(false);
    });

    it("does not fire the restart timer into a rebuild that began after it was armed", async () => {
      // Regression: Play from grid view arms the 50 ms timer, then the
      // grid-to-single transition starts a rebuild. If the timer started
      // autoplay mid-rebuild, the rebuild's slideTo would stop it outside the
      // internal bracket, read as a user pause, and the slideshow would end
      // up stopped with the Play icon showing.
      jest.useFakeTimers();
      const manager = await freshManager();
      let release;
      manager._doResetAllSlides = jest.fn(() => new Promise((resolve) => (release = resolve)));

      manager.resumeSlideshow(); // arms the timer, no rebuild in flight
      const rebuild = manager.resetAllSlides();
      jest.advanceTimersByTime(50);
      expect(mockSwiper.autoplay.start).not.toHaveBeenCalled();

      release();
      await rebuild;
      jest.advanceTimersByTime(50);
      expect(mockSwiper.autoplay.start).toHaveBeenCalledTimes(1);
      expect(manager.isSlideshowActive()).toBe(true);
    });

    it("keeps the run state when the rebuild's own slideTo stops a running autoplay", async () => {
      // Belt and braces for the same hole: if autoplay is somehow running when
      // the rebuild navigates to the current slide, Swiper stops it (it treats
      // the programmatic move as interaction). That stop is ours.
      const manager = await freshManager();
      manager.slideshowActive = true;
      mockSwiper.slideTo = jest.fn(() => {
        if (mockSwiper.autoplay.running) {
          mockSwiper.autoplay.stop();
        }
      });
      // Simulate a timer having started autoplay after the rebuild's internal stop.
      mockFetchImageByIndex.mockImplementation((index) => {
        mockSwiper.autoplay.running = true;
        return Promise.resolve({ index, filename: `image${index}.jpg`, image_url: `/images/${index}.jpg`, total: 10 });
      });
      mockSlideState.currentGlobalIndex = 3;

      await manager.resetAllSlides();

      expect(mockSwiper.slideTo).toHaveBeenCalled();
      expect(manager.isSlideshowActive()).toBe(true);
    });

    it("clears the run state on a Swiper-initiated stop but not on an internal one", async () => {
      const manager = await freshManager();
      manager.slideshowActive = true;
      mockSwiper.autoplay.running = true;

      // Our own bookkeeping stop (rebuild/trim): user intent unchanged.
      manager._stopAutoplayInternal();
      expect(mockSwiper.autoplay.stop).toHaveBeenCalledTimes(1);
      expect(manager.isSlideshowActive()).toBe(true);

      // Swiper stopping itself (swipe with disableOnInteraction, stopOnLastSlide).
      mockSwiper.autoplay.running = true;
      mockSwiper.autoplay.stop();
      expect(manager.isSlideshowActive()).toBe(false);
    });

    it("a real rebuild stops autoplay internally, keeps the run state, and restarts afterwards", async () => {
      // End to end through _doResetAllSlides with the DOM fixture: the stop it
      // performs must not read as a user pause.
      const manager = await freshManager();
      manager.slideshowActive = true;
      mockSwiper.autoplay.running = true;
      mockSlideState.currentGlobalIndex = 3;

      await manager.resetAllSlides();
      expect(manager.isSlideshowActive()).toBe(true);
      expect(mockSwiper.autoplay.stop).toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(mockSwiper.autoplay.start).toHaveBeenCalled();
    });

    it("trimming the shuffle backlog does not clear the run state", async () => {
      const manager = await freshManager();
      manager.slideshowActive = true;
      mockSwiper.autoplay.running = true;
      // removeSlide's implicit slideTo stops autoplay in real Swiper; the mock
      // mirrors that and now also emits autoplayStop like the real one.
      mockSwiper.removeSlide = jest.fn(() => {
        mockSwiper.slides.shift();
        mockSwiper.autoplay.stop();
      });
      const savedHighWaterMark = mockState.highWaterMark;
      mockState.highWaterMark = 3;
      mockSwiper.slides = [createMockSlide(1), createMockSlide(2), createMockSlide(3), createMockSlide(4)];
      // Where a forward advance leaves it: active slide plus its look-ahead at
      // the tail. trimBuffer budgets from activeIndex, so a buffer parked at 0
      // would (correctly) refuse to trim anything.
      mockSwiper.activeIndex = mockSwiper.slides.length - 2;

      manager.trimBuffer("front");

      expect(mockSwiper.slides.length).toBe(3);
      expect(manager.isSlideshowActive()).toBe(true);
      expect(mockSwiper.autoplay.start).toHaveBeenCalled();
      mockState.highWaterMark = savedHighWaterMark;
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

    // Regression: shuffle mode froze after ~highWaterMark slides because the
    // linear-mode stopOnLastSlide backstop is a global autoplay option and so
    // also fired in shuffle, where there is no end of list. resumeSlideshow
    // must flip it off for random mode and back on for sequential mode.
    it("disables stopOnLastSlide when resuming in shuffle mode", async () => {
      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      const manager = await initializeSingleSwiper();

      mockState.mode = "random";
      mockSwiper.params.autoplay.stopOnLastSlide = true;

      manager.resumeSlideshow();

      expect(mockSwiper.params.autoplay.stopOnLastSlide).toBe(false);
    });

    it("enables stopOnLastSlide when resuming in sequential mode", async () => {
      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      const manager = await initializeSingleSwiper();

      mockState.mode = "chronological";
      mockSwiper.params.autoplay.stopOnLastSlide = false;

      manager.resumeSlideshow();

      expect(mockSwiper.params.autoplay.stopOnLastSlide).toBe(true);
    });

    // Regression (the real cause of the "freezes after ~18 shuffled slides"
    // report): swiper.removeSlide() stops autoplay as a side effect (its internal
    // slideTo fires beforeTransitionStart, which with disableOnInteraction halts
    // autoplay). trimBuffer must restart autoplay or the slideshow dies the
    // first time the buffer is trimmed past the high-water mark.
    it("restarts autoplay after trimming the shuffle backlog", async () => {
      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      const manager = await initializeSingleSwiper();

      // Buffer well over the high-water mark, autoplay running, parked where a
      // forward advance leaves it: active slide plus one look-ahead at the tail.
      const over = mockState.highWaterMark + 3;
      mockSwiper.slides = Array.from({ length: over }, (_, i) => createMockSlide(i));
      mockSwiper.activeIndex = over - 2;
      mockSwiper.autoplay.running = true;

      manager.trimBuffer("front");

      // Buffer trimmed down to the cap and autoplay left running.
      expect(mockSwiper.slides.length).toBe(mockState.highWaterMark);
      expect(mockSwiper.removeSlide).toHaveBeenCalled();
      expect(mockSwiper.autoplay.start).toHaveBeenCalled();
      expect(mockSwiper.autoplay.running).toBe(true);
    });

    it("does not restart autoplay when trimming while the slideshow is paused", async () => {
      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      const manager = await initializeSingleSwiper();

      const over = mockState.highWaterMark + 3;
      mockSwiper.slides = Array.from({ length: over }, (_, i) => createMockSlide(i));
      mockSwiper.activeIndex = over - 2;
      mockSwiper.autoplay.running = false; // paused before the trim

      manager.trimBuffer("front");

      expect(mockSwiper.slides.length).toBe(mockState.highWaterMark);
      expect(mockSwiper.autoplay.start).not.toHaveBeenCalled();
      expect(mockSwiper.autoplay.running).toBe(false);
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
  // Regression: the slide buffer grew without bound on manual navigation.
  // Only the shuffle-slideshow append path trimmed it, and `enforceHighWaterMark`
  // was reachable only from the album-deletion path — so a user swiping through
  // an album accumulated one full-resolution <img> per swipe until something
  // rebuilt the buffer. On a tablet that showed up as swipe animations turning
  // jerky after roughly `highWaterMark` swipes, cured by toggling to grid view
  // and back (which rebuilds to three slides).
  describe("slide buffer bounding", () => {
    let handlers;
    let savedHighWaterMark;
    let savedResolveOffset;

    beforeEach(() => {
      savedHighWaterMark = mockState.highWaterMark;
      savedResolveOffset = mockSlideState.resolveOffset;
    });

    afterEach(() => {
      mockState.highWaterMark = savedHighWaterMark;
      mockSlideState.resolveOffset = savedResolveOffset;
    });

    async function managerWithHandlers() {
      handlers = {};
      mockSwiper.on = jest.fn((event, cb) => {
        handlers[event] = cb;
      });
      const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
      const manager = await initializeSingleSwiper();
      manager._resetInFlight = null;
      manager._resetPending = false;
      manager.isAppending = false;
      manager.isPrepending = false;
      clearTimeout(manager._trimTimer);
      manager._trimTimer = null;
      return manager;
    }

    // Advance forward the way a swipe does: land on the last slide, let the
    // handler append the next one.
    async function advance(manager) {
      mockSwiper.activeIndex = mockSwiper.slides.length - 1;
      await handlers.slideNextTransitionStart.call(manager);
      await Promise.resolve();
    }

    it("stops growing after many manual swipes in linear mode", async () => {
      // The reported bug, end to end: no slideshow, sequential mode, nothing
      // but forward swipes. Before the fix this ended at 3 + 40 slides.
      mockState.mode = "chronological";
      mockSlideShowRunning.mockReturnValue(false);
      mockState.highWaterMark = 10;
      mockSlideState.resolveOffset = jest.fn((offset) => ({
        globalIndex: mockSlideState.currentGlobalIndex + offset,
        searchIndex: null,
      }));

      const manager = await managerWithHandlers();
      mockSwiper.slides = [createMockSlide(0), createMockSlide(1), createMockSlide(2)];

      for (let i = 0; i < 40; i++) {
        await advance(manager);
      }
      // Let the pending trim fire.
      await new Promise((resolve) => setTimeout(resolve, TRIM_SETTLE_MS));

      expect(mockSwiper.slides.length).toBeLessThanOrEqual(mockState.highWaterMark);
      expect(mockSwiper.removeSlide).toHaveBeenCalled();
    });

    it("keeps the slide the user is looking at, and its look-ahead", async () => {
      // A trim that drops the active slide would jump the view — worse than the
      // jerkiness it is there to prevent.
      mockState.highWaterMark = 10;
      const manager = await managerWithHandlers();
      mockSwiper.slides = Array.from({ length: 30 }, (_, i) => createMockSlide(i));
      mockSwiper.activeIndex = 28; // active, with one look-ahead at 29
      const activeSlide = mockSwiper.slides[28];
      const lookAhead = mockSwiper.slides[29];

      manager.trimBuffer("front");

      expect(mockSwiper.slides.length).toBe(10);
      expect(mockSwiper.slides).toContain(activeSlide);
      expect(mockSwiper.slides).toContain(lookAhead);
      // activeIndex tracked the removal rather than pointing at a stranger.
      expect(mockSwiper.slides[mockSwiper.activeIndex]).toBe(activeSlide);
    });

    it("drops from the tail when the user is backing up", async () => {
      // Backing up prepends at the head, so the stale slides are at the tail.
      // Trimming the front here would delete the slides just fetched.
      mockState.highWaterMark = 10;
      const manager = await managerWithHandlers();
      mockSwiper.slides = Array.from({ length: 30 }, (_, i) => createMockSlide(i));
      mockSwiper.activeIndex = 1; // where slidePrevTransitionEnd's slideTo(1, 0) leaves it
      const activeSlide = mockSwiper.slides[1];
      const head = mockSwiper.slides[0];

      manager.trimBuffer("back");

      expect(mockSwiper.slides.length).toBe(10);
      expect(mockSwiper.slides[0]).toBe(head);
      expect(mockSwiper.slides[1]).toBe(activeSlide);
      expect(mockSwiper.activeIndex).toBe(1);
    });

    it("trims nothing when the buffer is at or under the cap", async () => {
      mockState.highWaterMark = 10;
      const manager = await managerWithHandlers();
      mockSwiper.slides = Array.from({ length: 10 }, (_, i) => createMockSlide(i));
      mockSwiper.activeIndex = 8;

      manager.trimBuffer("front");

      expect(mockSwiper.slides.length).toBe(10);
      expect(mockSwiper.removeSlide).not.toHaveBeenCalled();
    });

    it("stands aside while a swipe is still animating", async () => {
      // removeSlide() calls slideTo() internally; doing that mid-transition
      // would produce the very stutter the trimming exists to prevent.
      mockState.highWaterMark = 10;
      const manager = await managerWithHandlers();
      mockSwiper.slides = Array.from({ length: 30 }, (_, i) => createMockSlide(i));
      mockSwiper.activeIndex = 28;
      mockSwiper.animating = true;

      manager._scheduleTrim("front");
      await new Promise((resolve) => setTimeout(resolve, TRIM_SETTLE_MS));
      expect(mockSwiper.removeSlide).not.toHaveBeenCalled();
      expect(mockSwiper.slides.length).toBe(30);

      // Once the transition ends, the re-armed trim goes through.
      mockSwiper.animating = false;
      await new Promise((resolve) => setTimeout(resolve, TRIM_SETTLE_MS));
      expect(mockSwiper.slides.length).toBe(10);
    });

    it("does not push the deadline back when advances keep arriving", async () => {
      // A scheduler that re-armed on every advance would never fire under
      // continuous swiping — exactly when the trim is needed most.
      const manager = await managerWithHandlers();
      manager._scheduleTrim("front");
      const firstTimer = manager._trimTimer;

      manager._scheduleTrim("front");
      manager._scheduleTrim("front");

      expect(manager._trimTimer).toBe(firstTimer);
      clearTimeout(manager._trimTimer);
    });

    it("follows the latest direction of travel when one is already queued", async () => {
      const manager = await managerWithHandlers();
      manager._scheduleTrim("front");
      manager._scheduleTrim("back");

      expect(manager._trimEnd).toBe("back");
      clearTimeout(manager._trimTimer);
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
