// Test file for seek-slider.js - updateHoverStripProgress logic
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import '@testing-library/jest-dom';

describe('seek-slider.js', () => {
  describe('updateHoverStripProgress logic', () => {
    let hoverStrip;
    let mockSlideState;
    let backgroundSetter;

    // This is the updateHoverStripProgress method extracted for unit testing
    const updateHoverStripProgress = (hoverStrip, getCurrentIndex, searchResults, getCurrentSlideIndex) => {
      if (!hoverStrip) return;
      
      const currentIndex = getCurrentIndex();
      let max = 1;
      
      if (searchResults?.length > 0) {
        max = searchResults.length;
      } else {
        const [, totalSlides] = getCurrentSlideIndex();
        max = totalSlides || 1;
      }
      
      // Calculate percentage using same formula as slider thumb positioning
      // Slider uses 1-indexed values with min=1, so value = currentIndex + 1
      const value = currentIndex + 1;
      const percent = max > 1 ? ((value - 1) / (max - 1)) * 100 : 0;
      
      // Apply gradient: yellow up to current position, white after
      hoverStrip.style.background = `linear-gradient(to right, #ffc107 ${percent}%, #ffffff ${percent}%)`;
    };

    beforeEach(() => {
      // Create DOM elements
      document.body.innerHTML = `
        <div id="sliderHoverStrip" class="slider-hover-strip"></div>
      `;
      hoverStrip = document.getElementById('sliderHoverStrip');
      
      // Mock the style.background setter since jsdom doesn't support linear-gradient
      backgroundSetter = jest.fn();
      Object.defineProperty(hoverStrip.style, 'background', {
        set: backgroundSetter,
        get: () => '',
        configurable: true
      });
      
      // Mock slideState
      mockSlideState = {
        getCurrentIndex: jest.fn().mockReturnValue(0)
      };
    });

    afterEach(() => {
      document.body.innerHTML = '';
      jest.clearAllMocks();
    });

    it('should set gradient with 0% yellow when at first slide', () => {
      mockSlideState.getCurrentIndex.mockReturnValue(0);
      const getCurrentSlideIndex = () => [0, 100, null];

      updateHoverStripProgress(
        hoverStrip,
        mockSlideState.getCurrentIndex,
        null,
        getCurrentSlideIndex
      );

      // At position 0 of 100 (value=1, min=1, max=100), percent = 0%
      expect(backgroundSetter).toHaveBeenCalledWith('linear-gradient(to right, #ffc107 0%, #ffffff 0%)');
    });

    it('should set gradient with 100% yellow when at last slide', () => {
      mockSlideState.getCurrentIndex.mockReturnValue(99);
      const getCurrentSlideIndex = () => [99, 100, null];

      updateHoverStripProgress(
        hoverStrip,
        mockSlideState.getCurrentIndex,
        null,
        getCurrentSlideIndex
      );

      // At position 99 of 100 (value=100, min=1, max=100), percent = 100%
      expect(backgroundSetter).toHaveBeenCalledWith('linear-gradient(to right, #ffc107 100%, #ffffff 100%)');
    });

    it('should set gradient at approximately 50% when at middle slide', () => {
      mockSlideState.getCurrentIndex.mockReturnValue(49);
      const getCurrentSlideIndex = () => [49, 100, null];

      updateHoverStripProgress(
        hoverStrip,
        mockSlideState.getCurrentIndex,
        null,
        getCurrentSlideIndex
      );

      // At position 49 of 100 (value=50, min=1, max=100), percent = (50-1)/(100-1) * 100 ≈ 49.49%
      const expectedPercent = ((50 - 1) / (100 - 1)) * 100;
      expect(backgroundSetter).toHaveBeenCalledWith(
        expect.stringContaining(`linear-gradient(to right, #ffc107 ${expectedPercent}%`)
      );
    });

    it('should handle search results mode', () => {
      mockSlideState.getCurrentIndex.mockReturnValue(4);
      const searchResults = [
        { index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }, { index: 4 },
        { index: 5 }, { index: 6 }, { index: 7 }, { index: 8 }, { index: 9 }
      ];
      const getCurrentSlideIndex = () => [4, 100, 4];

      updateHoverStripProgress(
        hoverStrip,
        mockSlideState.getCurrentIndex,
        searchResults,
        getCurrentSlideIndex
      );

      // At position 4 of 10 (value=5, min=1, max=10), percent = (5-1)/(10-1) * 100 ≈ 44.44%
      const expectedPercent = ((5 - 1) / (10 - 1)) * 100;
      expect(backgroundSetter).toHaveBeenCalledWith(
        expect.stringContaining(`linear-gradient(to right, #ffc107 ${expectedPercent}%`)
      );
    });

    it('should not throw when hoverStrip is null', () => {
      const getCurrentSlideIndex = () => [0, 100, null];
      
      expect(() => updateHoverStripProgress(
        null,
        mockSlideState.getCurrentIndex,
        null,
        getCurrentSlideIndex
      )).not.toThrow();
    });

    it('should handle single slide (max equals min)', () => {
      mockSlideState.getCurrentIndex.mockReturnValue(0);
      const getCurrentSlideIndex = () => [0, 1, null];

      updateHoverStripProgress(
        hoverStrip,
        mockSlideState.getCurrentIndex,
        null,
        getCurrentSlideIndex
      );

      // Single slide case: percent should be 0 (not NaN or error)
      expect(backgroundSetter).toHaveBeenCalledWith('linear-gradient(to right, #ffc107 0%, #ffffff 0%)');
    });

    it('should use white and yellow colors for the gradient', () => {
      mockSlideState.getCurrentIndex.mockReturnValue(50);
      const getCurrentSlideIndex = () => [50, 100, null];

      updateHoverStripProgress(
        hoverStrip,
        mockSlideState.getCurrentIndex,
        null,
        getCurrentSlideIndex
      );

      const calledWith = backgroundSetter.mock.calls[0][0];
      expect(calledWith).toContain('#ffc107');  // Yellow
      expect(calledWith).toContain('#ffffff');  // White
    });
  });
});
