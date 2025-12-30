// Unit tests for grid-view.js - image deletion scenario
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock album-manager
jest.unstable_mockModule('../../photomap/frontend/static/javascript/album-manager.js', () => ({
  albumManager: {
    fetchAvailableAlbums: jest.fn(() => Promise.resolve([]))
  },
  checkAlbumIndex: jest.fn()
}));

// Mock index.js
jest.unstable_mockModule('../../photomap/frontend/static/javascript/index.js', () => ({
  getIndexMetadata: jest.fn(() => Promise.resolve({ filename_count: 10 })),
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

// Track calls to showSpinner and hideSpinner
const mockShowSpinner = jest.fn();
const mockHideSpinner = jest.fn();

// Mock utils.js
jest.unstable_mockModule('../../photomap/frontend/static/javascript/utils.js', () => ({
  showSpinner: mockShowSpinner,
  hideSpinner: mockHideSpinner
}));

// Mock events.js
jest.unstable_mockModule('../../photomap/frontend/static/javascript/events.js', () => ({
  toggleGridSwiperView: jest.fn()
}));

// Mock search.js with images that will be "deleted"
const mockFetchImageByIndex = jest.fn();
jest.unstable_mockModule('../../photomap/frontend/static/javascript/search.js', () => ({
  fetchImageByIndex: mockFetchImageByIndex
}));

// Mock metadata-drawer.js
jest.unstable_mockModule('../../photomap/frontend/static/javascript/metadata-drawer.js', () => ({
  replaceReferenceImagesWithLinks: jest.fn(() => ''),
  updateCurrentImageScore: jest.fn(),
  updateClusterInfo: jest.fn()
}));

// Mock slide-state.js
const mockSlideState = {
  getCurrentSlide: jest.fn(() => ({ globalIndex: 0, searchIndex: null, totalCount: 10, isSearchMode: false })),
  getCurrentIndex: jest.fn(() => 0),
  setCurrentIndex: jest.fn(),
  updateFromExternal: jest.fn(),
  globalToSearch: jest.fn(() => null),
  indexToGlobal: jest.fn((i) => i < 10 ? i : null),
  isSearchMode: false,
  searchResults: [],
  totalAlbumImages: 10,
  handleAlbumChanged: jest.fn((detail) => {
    mockSlideState.totalAlbumImages = detail.totalImages;
    mockSlideState.getCurrentSlide.mockReturnValue({ 
      globalIndex: 0, 
      searchIndex: null, 
      totalCount: detail.totalImages, 
      isSearchMode: false 
    });
    mockSlideState.getCurrentIndex.mockReturnValue(0);
    mockSlideState.indexToGlobal.mockImplementation((i) => i < detail.totalImages ? i : null);
  })
};

jest.unstable_mockModule('../../photomap/frontend/static/javascript/slide-state.js', () => ({
  slideState: mockSlideState
}));

// Mock state.js
const mockState = {
  gridViewActive: true,
  gridThumbSizeFactor: 1.0,
  album: 'test-album'
};

jest.unstable_mockModule('../../photomap/frontend/static/javascript/state.js', () => ({
  state: mockState
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
  destroyed: false
};

global.Swiper = jest.fn(() => mockSwiperInstance);

// Now import the module we want to test
const { initializeGridSwiper } = await import('../../photomap/frontend/static/javascript/grid-view.js');

describe('grid-view.js - image deletion', () => {
  let gridViewManager;
  let albumChangedListener;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    mockShowSpinner.mockClear();
    mockHideSpinner.mockClear();
    mockSwiperInstance.slides = [];
    mockSwiperInstance.destroyed = false;
    mockSwiperInstance.removeAllSlides.mockClear();
    mockSlideState.totalAlbumImages = 10;
    mockSlideState.indexToGlobal.mockImplementation((i) => i < 10 ? i : null);
    
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
    Object.defineProperty(window, 'innerHeight', { value: 600, writable: true });
    
    // Mock offsetWidth for the grid container
    const gridModeElement = document.querySelector('.swiper.grid-mode');
    Object.defineProperty(gridModeElement, 'offsetWidth', { value: 800, configurable: true });

    // Mock fetchImageByIndex to return valid image data
    mockFetchImageByIndex.mockImplementation((index) => Promise.resolve({
      filename: `image${index}.jpg`,
      filepath: `/path/to/image${index}.jpg`,
      index: index
    }));
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('should remove deleted images from grid view after albumChanged event', async () => {
    // Initialize the grid view manager
    gridViewManager = await initializeGridSwiper();
    
    // Load initial batch of images (10 images total)
    mockSlideState.indexToGlobal.mockImplementation((i) => i < 10 ? i : null);
    await gridViewManager.loadBatch(0, true);
    
    // Verify slides were added
    expect(mockSwiperInstance.appendSlide).toHaveBeenCalled();
    const initialSlideCount = mockSwiperInstance.appendSlide.mock.calls[0][0].length;
    expect(initialSlideCount).toBeGreaterThan(0);
    
    // Clear mocks to track subsequent calls
    mockSwiperInstance.removeAllSlides.mockClear();
    mockSwiperInstance.appendSlide.mockClear();
    mockShowSpinner.mockClear();
    mockHideSpinner.mockClear();
    
    // Simulate deletion of images 5, 6, 7 (3 images)
    const deletedIndices = [5, 6, 7];
    const newTotalImages = 10 - deletedIndices.length;
    
    // This is the CORRECT order: dispatch albumChanged BEFORE any other events
    // so that slideState.totalAlbumImages is updated before grid refreshes
    mockSlideState.handleAlbumChanged({ album: 'test-album', totalImages: newTotalImages });
    mockSlideState.totalAlbumImages = newTotalImages;
    mockSlideState.indexToGlobal.mockImplementation((i) => i < newTotalImages ? i : null);
    
    // Dispatch albumChanged event (simulating what bookmarks.js does)
    window.dispatchEvent(new CustomEvent("albumChanged", {
      detail: { album: 'test-album', totalImages: newTotalImages }
    }));
    
    // Wait for event handler to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify that removeAllSlides was called to clear the grid
    expect(mockSwiperInstance.removeAllSlides).toHaveBeenCalled();
    
    // Verify that spinner was shown and hidden
    expect(mockShowSpinner).toHaveBeenCalled();
    expect(mockHideSpinner).toHaveBeenCalled();
    
    // Verify that new slides were appended with correct total count
    expect(mockSwiperInstance.appendSlide).toHaveBeenCalled();
  });

  it('should update grid when visible after images are deleted', async () => {
    // Initialize the grid view manager
    gridViewManager = await initializeGridSwiper();
    
    // Ensure grid is visible
    const gridContainer = document.getElementById('gridViewContainer');
    gridContainer.style.display = 'block';
    expect(gridViewManager.isVisible()).toBe(true);
    
    // Clear mocks
    mockSwiperInstance.removeAllSlides.mockClear();
    mockShowSpinner.mockClear();
    mockHideSpinner.mockClear();
    
    // Simulate deletion
    const newTotalImages = 7;
    mockSlideState.handleAlbumChanged({ album: 'test-album', totalImages: newTotalImages });
    mockSlideState.indexToGlobal.mockImplementation((i) => i < newTotalImages ? i : null);
    
    // Dispatch albumChanged event
    window.dispatchEvent(new CustomEvent("albumChanged", {
      detail: { album: 'test-album', totalImages: newTotalImages }
    }));
    
    // Wait for async handler
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // resetAllSlides should have been called (removeAllSlides is part of it)
    expect(mockSwiperInstance.removeAllSlides).toHaveBeenCalled();
  });

  it('should not update grid when not visible', async () => {
    // Initialize the grid view manager
    gridViewManager = await initializeGridSwiper();
    
    // Hide the grid
    const gridContainer = document.getElementById('gridViewContainer');
    gridContainer.style.display = 'none';
    expect(gridViewManager.isVisible()).toBe(false);
    
    // Clear mocks
    mockSwiperInstance.removeAllSlides.mockClear();
    mockShowSpinner.mockClear();
    mockHideSpinner.mockClear();
    
    // Simulate deletion
    const newTotalImages = 7;
    mockSlideState.handleAlbumChanged({ album: 'test-album', totalImages: newTotalImages });
    
    // Dispatch albumChanged event
    window.dispatchEvent(new CustomEvent("albumChanged", {
      detail: { album: 'test-album', totalImages: newTotalImages }
    }));
    
    // Wait for async handler
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // resetAllSlides should NOT have been called because grid is not visible
    expect(mockSwiperInstance.removeAllSlides).not.toHaveBeenCalled();
    expect(mockShowSpinner).not.toHaveBeenCalled();
  });
});
