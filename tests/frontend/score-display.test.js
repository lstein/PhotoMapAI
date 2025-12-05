// Unit tests for score-display.js
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ScoreDisplay } from '../../photomap/frontend/static/javascript/score-display.js';

// Mock the utils module
jest.mock('../../photomap/frontend/static/javascript/utils.js', () => ({
  isColorLight: jest.fn((color) => {
    // Simple mock implementation
    const hex = color.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 180;
  })
}));

describe('score-display.js', () => {
  let scoreDisplayInstance;

  beforeEach(() => {
    // Setup DOM elements required by ScoreDisplay
    document.body.innerHTML = `
      <div id="fixedScoreDisplay" style="display:none">
        <span id="scoreText"></span>
      </div>
    `;
    scoreDisplayInstance = new ScoreDisplay();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with correct elements', () => {
      expect(scoreDisplayInstance.scoreElement).toBe(document.getElementById('fixedScoreDisplay'));
      expect(scoreDisplayInstance.scoreText).toBe(document.getElementById('scoreText'));
      expect(scoreDisplayInstance.isVisible).toBe(false);
      expect(scoreDisplayInstance.opacity).toBe(0.85);
      expect(scoreDisplayInstance.currentGlobalIndex).toBe(null);
      expect(scoreDisplayInstance.isBookmarked).toBe(false);
    });
  });

  describe('setBookmarkStatus', () => {
    it('should set the global index and bookmark status', () => {
      scoreDisplayInstance.setBookmarkStatus(5, true);

      expect(scoreDisplayInstance.currentGlobalIndex).toBe(5);
      expect(scoreDisplayInstance.isBookmarked).toBe(true);
    });

    it('should update bookmark status to false', () => {
      scoreDisplayInstance.setBookmarkStatus(10, false);

      expect(scoreDisplayInstance.currentGlobalIndex).toBe(10);
      expect(scoreDisplayInstance.isBookmarked).toBe(false);
    });
  });

  describe('getStarHtml', () => {
    it('should return filled star when bookmarked', () => {
      scoreDisplayInstance.setBookmarkStatus(1, true);
      
      const starHtml = scoreDisplayInstance.getStarHtml();
      expect(starHtml).toContain('fill="#ffc107"');
    });

    it('should return empty star when not bookmarked', () => {
      scoreDisplayInstance.setBookmarkStatus(1, false);
      
      const starHtml = scoreDisplayInstance.getStarHtml();
      expect(starHtml).toContain('fill="none"');
    });
  });

  describe('showSearchScore', () => {
    it('should display score with correct format including star', () => {
      scoreDisplayInstance.setBookmarkStatus(1, false);
      scoreDisplayInstance.showSearchScore(0.8567);

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('score=0.857');
      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('score-star');
      expect(scoreDisplayInstance.scoreElement.style.display).toBe('block');
      expect(scoreDisplayInstance.isVisible).toBe(true);
    });

    it('should display score with index and total in new format', () => {
      scoreDisplayInstance.setBookmarkStatus(1, false);
      scoreDisplayInstance.showSearchScore(0.5, 3, 10);

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('3/10 (score=0.500)');
    });

    it('should not display when score is undefined', () => {
      scoreDisplayInstance.showSearchScore(undefined);

      expect(scoreDisplayInstance.isVisible).toBe(false);
    });

    it('should not display when score is null', () => {
      scoreDisplayInstance.showSearchScore(null);

      expect(scoreDisplayInstance.isVisible).toBe(false);
    });

    it('should add visible class and remove hidden class', () => {
      scoreDisplayInstance.showSearchScore(0.5);

      expect(scoreDisplayInstance.scoreElement.classList.contains('visible')).toBe(true);
      expect(scoreDisplayInstance.scoreElement.classList.contains('hidden')).toBe(false);
    });

    it('should set default background and text color', () => {
      scoreDisplayInstance.showSearchScore(0.5);

      expect(scoreDisplayInstance.scoreElement.style.backgroundColor).toBe('rgba(0, 0, 0, 0.85)');
      expect(scoreDisplayInstance.scoreElement.style.color).toBe('rgb(255, 255, 255)');
    });

    it('should show filled star when bookmarked', () => {
      scoreDisplayInstance.setBookmarkStatus(1, true);
      scoreDisplayInstance.showSearchScore(0.5, 3, 10);

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('fill="#ffc107"');
    });
  });

  describe('showIndex', () => {
    it('should display slide index correctly with star', () => {
      scoreDisplayInstance.setBookmarkStatus(5, false);
      scoreDisplayInstance.showIndex(5, 20);

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('6/20');
      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('score-star');
      expect(scoreDisplayInstance.isVisible).toBe(true);
    });

    it('should not display when index is null', () => {
      scoreDisplayInstance.showIndex(null, 20);

      expect(scoreDisplayInstance.isVisible).toBe(false);
    });

    it('should not display when total is null', () => {
      scoreDisplayInstance.showIndex(5, null);

      expect(scoreDisplayInstance.isVisible).toBe(false);
    });

    it('should display for zero index', () => {
      scoreDisplayInstance.setBookmarkStatus(0, false);
      scoreDisplayInstance.showIndex(0, 10);

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('1/10');
      expect(scoreDisplayInstance.isVisible).toBe(true);
    });

    it('should show filled star when bookmarked', () => {
      scoreDisplayInstance.setBookmarkStatus(5, true);
      scoreDisplayInstance.showIndex(5, 20);

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('fill="#ffc107"');
    });
  });

  describe('showCluster', () => {
    it('should display cluster information with star', () => {
      scoreDisplayInstance.setBookmarkStatus(1, false);
      scoreDisplayInstance.showCluster(3, '#ff0000');

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('cluster=3');
      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('score-star');
      expect(scoreDisplayInstance.isVisible).toBe(true);
    });

    it('should display cluster with index and total in new format', () => {
      scoreDisplayInstance.setBookmarkStatus(1, false);
      scoreDisplayInstance.showCluster(2, '#00ff00', 5, 15);

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('5/15 (cluster=2)');
    });

    it('should display unclustered text for unclustered images', () => {
      scoreDisplayInstance.setBookmarkStatus(1, false);
      scoreDisplayInstance.showCluster('unclustered', '#808080');

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('unclustered images');
    });

    it('should set background color from cluster color', () => {
      scoreDisplayInstance.showCluster(1, '#ff5500');

      expect(scoreDisplayInstance.scoreElement.style.backgroundColor).toBe('rgb(255, 85, 0)');
    });

    it('should use dark text for light backgrounds', () => {
      scoreDisplayInstance.showCluster(1, '#ffffff');

      expect(scoreDisplayInstance.scoreElement.style.color).toBe('rgb(0, 0, 0)');
    });

    it('should use light text for dark backgrounds', () => {
      scoreDisplayInstance.showCluster(1, '#000000');

      expect(scoreDisplayInstance.scoreElement.style.color).toBe('rgb(255, 255, 255)');
    });

    it('should not display when cluster is undefined', () => {
      scoreDisplayInstance.showCluster(undefined, '#ff0000');

      expect(scoreDisplayInstance.isVisible).toBe(false);
    });

    it('should not display when cluster is null', () => {
      scoreDisplayInstance.showCluster(null, '#ff0000');

      expect(scoreDisplayInstance.isVisible).toBe(false);
    });

    it('should show filled star when bookmarked', () => {
      scoreDisplayInstance.setBookmarkStatus(1, true);
      scoreDisplayInstance.showCluster(3, '#ff0000', 5, 15);

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('fill="#ffc107"');
    });
  });

  describe('hide', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should add hidden class and remove visible class', () => {
      scoreDisplayInstance.showSearchScore(0.5);
      scoreDisplayInstance.hide();

      expect(scoreDisplayInstance.scoreElement.classList.contains('hidden')).toBe(true);
      expect(scoreDisplayInstance.scoreElement.classList.contains('visible')).toBe(false);
    });

    it('should set isVisible to false', () => {
      scoreDisplayInstance.showSearchScore(0.5);
      scoreDisplayInstance.hide();

      expect(scoreDisplayInstance.isVisible).toBe(false);
    });

    it('should hide display after transition timeout', () => {
      scoreDisplayInstance.showSearchScore(0.5);
      scoreDisplayInstance.hide();

      jest.advanceTimersByTime(300);

      expect(scoreDisplayInstance.scoreElement.style.display).toBe('none');
    });

    it('should not hide display if shown again before timeout', () => {
      scoreDisplayInstance.showSearchScore(0.5);
      scoreDisplayInstance.hide();

      jest.advanceTimersByTime(100);
      scoreDisplayInstance.showSearchScore(0.6);

      jest.advanceTimersByTime(200);

      expect(scoreDisplayInstance.scoreElement.style.display).toBe('block');
    });
  });

  describe('update', () => {
    it('should update score text when visible', () => {
      scoreDisplayInstance.setBookmarkStatus(1, false);
      scoreDisplayInstance.showSearchScore(0.5);
      scoreDisplayInstance.update(0.75);

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('score=0.750');
    });

    it('should not update when not visible', () => {
      scoreDisplayInstance.scoreText.textContent = 'original';
      scoreDisplayInstance.update(0.75);

      expect(scoreDisplayInstance.scoreText.textContent).toBe('original');
    });

    it('should not update with undefined score', () => {
      scoreDisplayInstance.setBookmarkStatus(1, false);
      scoreDisplayInstance.showSearchScore(0.5);
      scoreDisplayInstance.update(undefined);

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('score=0.500');
    });

    it('should not update with null score', () => {
      scoreDisplayInstance.setBookmarkStatus(1, false);
      scoreDisplayInstance.showSearchScore(0.5);
      scoreDisplayInstance.update(null);

      expect(scoreDisplayInstance.scoreText.innerHTML).toContain('score=0.500');
    });
  });

  describe('ScoreDisplay class export', () => {
    it('should be exportable as a class', () => {
      const instance = new ScoreDisplay();
      expect(instance).toBeInstanceOf(ScoreDisplay);
    });
  });
});
