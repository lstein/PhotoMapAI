// Unit tests for slideshow.js
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
  getIndexMetadata: jest.fn(() => Promise.resolve({ filename_count: 0 }))
}));

// Create mocked state
const mockState = {
  single_swiper: null,
  mode: 'chronological'
};

// Mock state module before importing slideshow
jest.unstable_mockModule('../../photomap/frontend/static/javascript/state.js', () => ({
  state: mockState,
  saveSettingsToLocalStorage: jest.fn()
}));

// Mock umap module
jest.unstable_mockModule('../../photomap/frontend/static/javascript/umap.js', () => ({
  isUmapFullscreen: jest.fn(() => false),
  toggleUmapWindow: jest.fn()
}));

// Now import the module we want to test
const {
  slideShowRunning,
  updateSlideshowButtonIcon,
  showPlayPauseIndicator,
  removeExistingIndicator
} = await import('../../photomap/frontend/static/javascript/slideshow.js');

const { state } = await import('../../photomap/frontend/static/javascript/state.js');

describe('slideshow.js', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('slideShowRunning', () => {
    it('should return false when single_swiper is null', () => {
      state.single_swiper = null;
      expect(slideShowRunning()).toBe(false);
    });

    it('should return false when swiper is null', () => {
      state.single_swiper = { swiper: null };
      expect(slideShowRunning()).toBe(false);
    });

    it('should return false when autoplay is null', () => {
      state.single_swiper = { swiper: { autoplay: null } };
      expect(slideShowRunning()).toBe(false);
    });

    it('should return false when autoplay is not running', () => {
      state.single_swiper = { swiper: { autoplay: { running: false } } };
      expect(slideShowRunning()).toBe(false);
    });

    it('should return true when autoplay is running', () => {
      state.single_swiper = { swiper: { autoplay: { running: true } } };
      expect(slideShowRunning()).toBe(true);
    });
  });

  describe('updateSlideshowButtonIcon', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="slideshowIcon"></div>
        <button id="startStopSlideshowBtn" title=""></button>
      `;
    });

    it('should show pause icon when slideshow is running', () => {
      state.single_swiper = { swiper: { autoplay: { running: true } } };
      state.mode = 'chronological';

      updateSlideshowButtonIcon();

      const container = document.getElementById('slideshowIcon');
      expect(container.innerHTML).toContain('pauseIcon');
    });

    it('should show play icon when slideshow is stopped in chronological mode', () => {
      state.single_swiper = { swiper: { autoplay: { running: false } } };
      state.mode = 'chronological';

      updateSlideshowButtonIcon();

      const container = document.getElementById('slideshowIcon');
      expect(container.innerHTML).toContain('playIcon');
    });

    it('should show shuffle icon when slideshow is stopped in random mode', () => {
      state.single_swiper = { swiper: { autoplay: { running: false } } };
      state.mode = 'random';

      updateSlideshowButtonIcon();

      const container = document.getElementById('slideshowIcon');
      expect(container.innerHTML).toContain('shuffleIcon');
    });

    it('should update button title when running in chronological mode', () => {
      state.single_swiper = { swiper: { autoplay: { running: true } } };
      state.mode = 'chronological';

      updateSlideshowButtonIcon();

      const btn = document.getElementById('startStopSlideshowBtn');
      expect(btn.title).toBe('Pause Slideshow (sequential mode)');
    });

    it('should update button title when running in random mode', () => {
      state.single_swiper = { swiper: { autoplay: { running: true } } };
      state.mode = 'random';

      updateSlideshowButtonIcon();

      const btn = document.getElementById('startStopSlideshowBtn');
      expect(btn.title).toBe('Pause Slideshow (shuffle mode)');
    });

    it('should update button title when stopped', () => {
      state.single_swiper = { swiper: { autoplay: { running: false } } };
      state.mode = 'chronological';

      updateSlideshowButtonIcon();

      const btn = document.getElementById('startStopSlideshowBtn');
      expect(btn.title).toBe('Start Slideshow (sequential mode)');
    });

    it('should do nothing if slideshowIcon element does not exist', () => {
      document.body.innerHTML = '';
      expect(() => updateSlideshowButtonIcon()).not.toThrow();
    });

    it('should handle null mode', () => {
      state.single_swiper = { swiper: { autoplay: { running: false } } };
      state.mode = null;

      updateSlideshowButtonIcon();

      const container = document.getElementById('slideshowIcon');
      expect(container.innerHTML).toContain('playIcon');
    });
  });

  describe('showPlayPauseIndicator', () => {
    it('should create indicator element when showing play', () => {
      state.mode = 'chronological';

      showPlayPauseIndicator(true);

      const indicator = document.getElementById('fullscreen-indicator');
      expect(indicator).toBeInTheDocument();
      expect(indicator.innerHTML).toBe('▶');
    });

    it('should show shuffle icon in random mode when playing', () => {
      state.mode = 'random';

      showPlayPauseIndicator(true);

      const indicator = document.getElementById('fullscreen-indicator');
      expect(indicator.innerHTML).toBe('🔀');
    });

    it('should show pause icon when pausing', () => {
      state.mode = 'chronological';

      showPlayPauseIndicator(false);

      const indicator = document.getElementById('fullscreen-indicator');
      expect(indicator.innerHTML).toBe('⏸');
    });

    it('should have fullscreen-playback-indicator class', () => {
      showPlayPauseIndicator(true);

      const indicator = document.getElementById('fullscreen-indicator');
      expect(indicator.classList.contains('fullscreen-playback-indicator')).toBe(true);
    });

    it('should add show class after animation frame', () => {
      showPlayPauseIndicator(true);

      // The indicator should exist and get show class added via requestAnimationFrame
      // We need to check immediately after creation, before the removal timer fires
      const indicator = document.getElementById('fullscreen-indicator');
      expect(indicator).toBeInTheDocument();
      
      // Run just enough time for requestAnimationFrame but not the full removal
      jest.advanceTimersByTime(100);
      
      // Check if show class was added (requestAnimationFrame would have run by now)
      expect(indicator.classList.contains('show')).toBe(true);
    });

    it('should remove indicator after timeout', () => {
      showPlayPauseIndicator(true);

      // Run through all timers (requestAnimationFrame + 800ms timeout + 300ms removal)
      jest.advanceTimersByTime(1200);

      const indicator = document.getElementById('fullscreen-indicator');
      expect(indicator).not.toBeInTheDocument();
    });

    it('should remove existing indicator before creating new one', () => {
      // Create first indicator
      showPlayPauseIndicator(true);

      // Create second indicator
      showPlayPauseIndicator(false);

      const indicators = document.querySelectorAll('#fullscreen-indicator');
      expect(indicators.length).toBe(1);
      expect(indicators[0].innerHTML).toBe('⏸');
    });
  });

  describe('removeExistingIndicator', () => {
    it('should remove indicator element if it exists', () => {
      document.body.innerHTML = '<div id="fullscreen-indicator"></div>';

      removeExistingIndicator();

      expect(document.getElementById('fullscreen-indicator')).not.toBeInTheDocument();
    });

    it('should clear timer if one exists', () => {
      showPlayPauseIndicator(true);
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

      removeExistingIndicator();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('should do nothing if no indicator exists', () => {
      document.body.innerHTML = '';
      expect(() => removeExistingIndicator()).not.toThrow();
    });
  });
});
