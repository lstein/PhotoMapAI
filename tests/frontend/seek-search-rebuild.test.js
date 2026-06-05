// Regression tests for seekToSlideIndex rebuilding the buffer in search/cluster
// mode. Search results are NOT contiguous in global-album index, so the rebuild
// must resolve each neighbour through searchToGlobal rather than stepping
// globalIndex and searchIndex together. The old code did the latter, which:
//   - loaded album-adjacent images instead of the adjacent cluster images, and
//   - tagged the slides it prepended with bogus search indices (-1, -2),
// so seeking back to cluster image #1 could land on a mistagged slide (the
// position badge showed "3"), and swiping left showed "0" then "-1".
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

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

// A non-contiguous cluster: search index N maps to a scattered global index.
const CLUSTER = [{ index: 100 }, { index: 250 }, { index: 370 }, { index: 420 }, { index: 555 }];

const mockSlideState = {
  currentGlobalIndex: 100,
  currentSearchIndex: 0,
  isSearchMode: true,
  totalAlbumImages: 1000,
  searchResults: CLUSTER,
  updateFromExternal: jest.fn(),
  searchToGlobal: jest.fn((idx) => mockSlideState.searchResults[idx]?.index ?? null),
  getCurrentSlide: jest.fn(() => ({
    globalIndex: mockSlideState.currentGlobalIndex,
    searchIndex: mockSlideState.currentSearchIndex,
    totalCount: mockSlideState.searchResults.length,
    isSearchMode: true,
  })),
  getCurrentIndex: jest.fn(() => mockSlideState.currentSearchIndex),
  resolveOffset: jest.fn(() => ({ globalIndex: null, searchIndex: null })),
};

jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
  slideState: mockSlideState,
  getCurrentSlideIndex: jest.fn(() => [
    mockSlideState.currentGlobalIndex,
    mockSlideState.searchResults.length,
    mockSlideState.currentSearchIndex,
  ]),
}));

describe("seekToSlideIndex rebuild in search/cluster mode", () => {
  let mockSwiper;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockSlideState.searchResults = CLUSTER;
    mockSlideState.isSearchMode = true;
    mockSlideState.totalAlbumImages = 1000;
    mockSlideState.searchToGlobal = jest.fn((idx) => mockSlideState.searchResults[idx]?.index ?? null);

    mockSwiper = {
      slides: [],
      activeIndex: 0,
      autoplay: { running: false, stop: jest.fn(), start: jest.fn() },
      allowSlideNext: true,
      allowSlidePrev: true,
      appendSlide: jest.fn((slide) => mockSwiper.slides.push(slide)),
      prependSlide: jest.fn((slide) => mockSwiper.slides.unshift(slide)),
      removeAllSlides: jest.fn(() => {
        mockSwiper.slides = [];
      }),
      slideTo: jest.fn((idx) => {
        mockSwiper.activeIndex = idx;
      }),
      on: jest.fn(),
    };
    global.Swiper = jest.fn(() => mockSwiper);

    // fetchImageByIndex echoes the requested global index back as data.index,
    // so the slide's dataset.globalIndex reflects the real image fetched.
    mockFetchImageByIndex.mockImplementation((index) =>
      Promise.resolve({
        index,
        filename: `image${index}.jpg`,
        image_url: `/images/${index}.jpg`,
        filepath: `/path/to/image${index}.jpg`,
        total: 1000,
      })
    );

    document.body.innerHTML = `
      <div id="singleSwiperContainer">
        <div id="singleSwiper" class="swiper"><div class="swiper-wrapper"></div></div>
      </div>
    `;
  });

  it("loads the adjacent cluster images and never tags slides with out-of-range search indices", async () => {
    const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
    const manager = await initializeSingleSwiper();

    // The buffer holds the tail of the cluster (we ran the slideshow to the end);
    // cluster image #1 (global 100) is NOT loaded, forcing the rebuild path.
    mockSwiper.slides = [makeSlide(420, 3), makeSlide(555, 4)];

    // Seek back to cluster image #1 (search index 0, global 100).
    await manager.seekToSlideIndex({
      detail: { globalIndex: 100, searchIndex: 0, isSearchMode: true, totalCount: CLUSTER.length },
    });

    // Every slide must carry a valid search index and a global index that
    // actually corresponds to that search position in the cluster.
    for (const slide of mockSwiper.slides) {
      const searchIndex = parseInt(slide.dataset.searchIndex, 10);
      const globalIndex = parseInt(slide.dataset.globalIndex, 10);
      expect(searchIndex).toBeGreaterThanOrEqual(0);
      expect(searchIndex).toBeLessThan(CLUSTER.length);
      expect(globalIndex).toBe(CLUSTER[searchIndex].index);
    }
  });

  it("lands on cluster image #1 with the correct position badge after seeking", async () => {
    const { initializeSingleSwiper } = await import("../../photomap/frontend/static/javascript/swiper.js");
    const manager = await initializeSingleSwiper();

    mockSwiper.slides = [makeSlide(420, 3), makeSlide(555, 4)];

    await manager.seekToSlideIndex({
      detail: { globalIndex: 100, searchIndex: 0, isSearchMode: true, totalCount: CLUSTER.length },
    });

    const landed = mockSwiper.slides[mockSwiper.activeIndex];
    expect(parseInt(landed.dataset.globalIndex, 10)).toBe(100);
    // searchIndex 0 -> badge shows "1/5", not "3".
    expect(parseInt(landed.dataset.searchIndex, 10)).toBe(0);
  });
});

function makeSlide(globalIndex, searchIndex) {
  const slide = document.createElement("div");
  slide.className = "swiper-slide";
  slide.dataset.globalIndex = globalIndex;
  slide.dataset.searchIndex = searchIndex;
  slide.innerHTML = `<img src="/images/${globalIndex}.jpg" alt="image${globalIndex}" />`;
  return slide;
}
