// Unit tests for shuffle mode in swiper.js - specifically testing the random slide selection logic
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock album-manager to prevent DOM errors (it has side effects on import)
jest.unstable_mockModule('../../photomap/frontend/static/javascript/album-manager.js', () => ({
  albumManager: {
    fetchAvailableAlbums: jest.fn(() => Promise.resolve([]))
  },
  checkAlbumIndex: jest.fn()
}));

// Mock index.js to prevent DOM errors
jest.unstable_mockModule('../../photomap/frontend/static/javascript/index.js', () => ({
  getIndexMetadata: jest.fn(() => Promise.resolve({ filename_count: 0 })),
  deleteImage: jest.fn(() => Promise.resolve())
}));

// Mock control-panel.js
jest.unstable_mockModule('../../photomap/frontend/static/javascript/control-panel.js', () => ({
  initializeControlPanel: jest.fn(),
  toggleFullscreen: jest.fn(),
  showDeleteConfirmModal: jest.fn(() => Promise.resolve(true))
}));

// Mock bookmarks.js
jest.unstable_mockModule('../../photomap/frontend/static/javascript/bookmarks.js', () => ({
  addBookmarkIconToSlide: jest.fn(),
  toggleCurrentBookmark: jest.fn(),
  updateAllBookmarkIcons: jest.fn(),
  bookmarkManager: {
    loadBookmarks: jest.fn(),
    updateBookmarkButton: jest.fn()
  }
}));

// Create mocked state
const mockState = {
  single_swiper: null,
  mode: 'random',
  currentDelay: 5,
  highWaterMark: 50,
  swiper: null
};

// Mock state module
jest.unstable_mockModule('../../photomap/frontend/static/javascript/state.js', () => ({
  state: mockState,
  saveSettingsToLocalStorage: jest.fn()
}));

// Mock slideshow module
const mockSlideShowRunning = jest.fn(() => true);
jest.unstable_mockModule('../../photomap/frontend/static/javascript/slideshow.js', () => ({
  slideShowRunning: mockSlideShowRunning,
  updateSlideshowButtonIcon: jest.fn()
}));

// Mock umap module
jest.unstable_mockModule('../../photomap/frontend/static/javascript/umap.js', () => ({
  updateCurrentImageMarker: jest.fn()
}));

// Mock metadata-drawer module
jest.unstable_mockModule('../../photomap/frontend/static/javascript/metadata-drawer.js', () => ({
  updateMetadataOverlay: jest.fn()
}));

// Mock events module
jest.unstable_mockModule('../../photomap/frontend/static/javascript/events.js', () => ({
  toggleGridSwiperView: jest.fn()
}));

// Mock search module
const mockFetchImageByIndex = jest.fn();
jest.unstable_mockModule('../../photomap/frontend/static/javascript/search.js', () => ({
  fetchImageByIndex: mockFetchImageByIndex
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
    searchIndex: null
  })),
  getCurrentSlide: jest.fn(() => ({
    globalIndex: mockSlideState.currentGlobalIndex,
    searchIndex: null,
    totalCount: mockSlideState.totalAlbumImages,
    isSearchMode: false
  })),
  searchToGlobal: jest.fn((idx) => mockSlideState.searchResults[idx]?.index ?? null)
};

jest.unstable_mockModule('../../photomap/frontend/static/javascript/slide-state.js', () => ({
  slideState: mockSlideState,
  getCurrentSlideIndex: jest.fn(() => [mockSlideState.currentGlobalIndex, mockSlideState.totalAlbumImages, null])
}));

describe('swiper.js shuffle mode', () => {
  let SwiperManager;
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
    mockState.mode = 'random';
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
      removeAllSlides: jest.fn(() => { mockSwiper.slides = []; }),
      slideTo: jest.fn(),
      on: jest.fn()
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
        total: 10
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
    document.body.innerHTML = '';
    delete global.Swiper;
  });

  describe('random slide selection', () => {
    it('should try multiple random indices until finding a unique one', async () => {
      // This test verifies that when random slides are selected, the algorithm
      // tries multiple times if the first random selection is already in the swiper
      
      // Create mock slides that already exist in swiper (indices 0, 1, 2)
      const existingSlides = [
        createMockSlide(0),
        createMockSlide(1),
        createMockSlide(2)
      ];
      mockSwiper.slides = existingSlides;
      
      // Track which indices are requested via Math.random
      // The algorithm uses Math.floor(Math.random() * totalPool) where totalPool = 10
      // We return values that map to existing indices first, then a non-existing one
      let callCount = 0;
      const originalRandom = Math.random;
      Math.random = jest.fn(() => {
        callCount++;
        // Return 0.05 (maps to 0), 0.15 (maps to 1), 0.25 (maps to 2), then 0.55 (maps to 5)
        // These values ensure: floor(0.05*10)=0, floor(0.15*10)=1, floor(0.25*10)=2, floor(0.55*10)=5
        if (callCount <= 3) return (callCount - 1) * 0.1 + 0.05;
        return 0.55;
      });
      
      try {
        // Import the module (needs to be done after mocks are set up)
        const { initializeSingleSwiper } = await import('../../photomap/frontend/static/javascript/swiper.js');
        
        const manager = await initializeSingleSwiper();
        
        // Simulate adding a slide in random mode
        await manager.addSlideByIndex(0, null, false, true);
        
        // Should have called Math.random multiple times to find a unique index
        expect(Math.random).toHaveBeenCalled();
        expect(callCount).toBeGreaterThan(1);
        
        // The slide that was added should NOT be one of the existing indices (0, 1, 2)
        // Check that fetchImageByIndex was called with a non-existing index
        const lastCallArg = mockFetchImageByIndex.mock.calls[mockFetchImageByIndex.mock.calls.length - 1]?.[0];
        expect([3, 4, 5, 6, 7, 8, 9]).toContain(lastCallArg);
        
      } finally {
        Math.random = originalRandom;
      }
    });

    it('should not get stuck in infinite loop when all slides exist', async () => {
      // With only 3 total images and all 3 already loaded, 
      // the algorithm should give up after max attempts
      mockSlideState.totalAlbumImages = 3;
      
      const existingSlides = [
        createMockSlide(0),
        createMockSlide(1),
        createMockSlide(2)
      ];
      mockSwiper.slides = existingSlides;
      
      const { initializeSingleSwiper } = await import('../../photomap/frontend/static/javascript/swiper.js');
      
      const manager = await initializeSingleSwiper();
      
      // This should not hang - it should return early after max attempts
      const startTime = Date.now();
      await manager.addSlideByIndex(0, null, false, true);
      const elapsed = Date.now() - startTime;
      
      // Should complete quickly (within 1 second), not hang
      expect(elapsed).toBeLessThan(1000);
      
      // Since all slides already exist, no new slide should be added
      // (fetchImageByIndex might be called but appendSlide won't add a duplicate)
      expect(mockSwiper.slides.length).toBe(3);
    });

    it('should handle search mode with small result sets', async () => {
      // Test that shuffle mode works correctly with small search results
      mockSlideState.isSearchMode = true;
      mockSlideState.searchResults = [
        { index: 5, score: 0.9 },
        { index: 12, score: 0.8 },
        { index: 7, score: 0.7 }
      ];
      mockSlideState.searchToGlobal = jest.fn((idx) => mockSlideState.searchResults[idx]?.index ?? null);
      
      // Pre-load one slide
      mockSwiper.slides = [createMockSlide(5)];
      
      const { initializeSingleSwiper } = await import('../../photomap/frontend/static/javascript/swiper.js');
      
      const manager = await initializeSingleSwiper();
      
      // Add a random slide - should pick one that doesn't exist (12 or 7)
      await manager.addSlideByIndex(5, 0, false, true);
      
      // Should have called searchToGlobal during random selection
      expect(mockSlideState.searchToGlobal).toHaveBeenCalled();
    });
  });
});

// Helper function to create mock slide elements
function createMockSlide(globalIndex) {
  const slide = document.createElement('div');
  slide.className = 'swiper-slide';
  slide.dataset.globalIndex = globalIndex;
  slide.dataset.filename = `image${globalIndex}.jpg`;
  slide.innerHTML = `<img src="/images/${globalIndex}.jpg" alt="image${globalIndex}" />`;
  return slide;
}
