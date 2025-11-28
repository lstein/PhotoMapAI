// Unit tests for score-display.js
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ScoreDisplay, scoreDisplay } from '../../photomap/frontend/static/javascript/score-display.js';

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
    });
  });

  describe('show', () => {
    it('should display score with correct format', () => {
      scoreDisplayInstance.show(0.8567);

      expect(scoreDisplayInstance.scoreText.textContent).toBe('score=0.857');
      expect(scoreDisplayInstance.scoreElement.style.display).toBe('block');
      expect(scoreDisplayInstance.isVisible).toBe(true);
    });

    it('should display score with index and total', () => {
      scoreDisplayInstance.show(0.5, 3, 10);

      expect(scoreDisplayInstance.scoreText.textContent).toBe('score=0.500 (3/10)');
    });

    it('should not display when score is undefined', () => {
      scoreDisplayInstance.show(undefined);

      expect(scoreDisplayInstance.isVisible).toBe(false);
    });

    it('should not display when score is null', () => {
      scoreDisplayInstance.show(null);

      expect(scoreDisplayInstance.isVisible).toBe(false);
    });

    it('should add visible class and remove hidden class', () => {
      scoreDisplayInstance.show(0.5);

      expect(scoreDisplayInstance.scoreElement.classList.contains('visible')).toBe(true);
      expect(scoreDisplayInstance.scoreElement.classList.contains('hidden')).toBe(false);
    });

    it('should set default background and text color', () => {
      scoreDisplayInstance.show(0.5);

      expect(scoreDisplayInstance.scoreElement.style.backgroundColor).toBe('rgba(0, 0, 0, 0.85)');
      expect(scoreDisplayInstance.scoreElement.style.color).toBe('rgb(255, 255, 255)');
    });
  });

  describe('showIndex', () => {
    it('should display slide index correctly', () => {
      scoreDisplayInstance.showIndex(5, 20);

      expect(scoreDisplayInstance.scoreText.textContent).toBe('Slide 6 / 20');
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
      scoreDisplayInstance.showIndex(0, 10);

      expect(scoreDisplayInstance.scoreText.textContent).toBe('Slide 1 / 10');
      expect(scoreDisplayInstance.isVisible).toBe(true);
    });
  });

  describe('showCluster', () => {
    it('should display cluster information', () => {
      scoreDisplayInstance.showCluster(3, '#ff0000');

      expect(scoreDisplayInstance.scoreText.textContent).toBe('cluster 3');
      expect(scoreDisplayInstance.isVisible).toBe(true);
    });

    it('should display cluster with index and total', () => {
      scoreDisplayInstance.showCluster(2, '#00ff00', 5, 15);

      expect(scoreDisplayInstance.scoreText.textContent).toBe('cluster 2 (5/15)');
    });

    it('should display unclustered text for unclustered images', () => {
      scoreDisplayInstance.showCluster('unclustered', '#808080');

      expect(scoreDisplayInstance.scoreText.textContent).toBe('unclustered images');
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
  });

  describe('hide', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should add hidden class and remove visible class', () => {
      scoreDisplayInstance.show(0.5);
      scoreDisplayInstance.hide();

      expect(scoreDisplayInstance.scoreElement.classList.contains('hidden')).toBe(true);
      expect(scoreDisplayInstance.scoreElement.classList.contains('visible')).toBe(false);
    });

    it('should set isVisible to false', () => {
      scoreDisplayInstance.show(0.5);
      scoreDisplayInstance.hide();

      expect(scoreDisplayInstance.isVisible).toBe(false);
    });

    it('should hide display after transition timeout', () => {
      scoreDisplayInstance.show(0.5);
      scoreDisplayInstance.hide();

      jest.advanceTimersByTime(300);

      expect(scoreDisplayInstance.scoreElement.style.display).toBe('none');
    });

    it('should not hide display if shown again before timeout', () => {
      scoreDisplayInstance.show(0.5);
      scoreDisplayInstance.hide();

      jest.advanceTimersByTime(100);
      scoreDisplayInstance.show(0.6);

      jest.advanceTimersByTime(200);

      expect(scoreDisplayInstance.scoreElement.style.display).toBe('block');
    });
  });

  describe('update', () => {
    it('should update score text when visible', () => {
      scoreDisplayInstance.show(0.5);
      scoreDisplayInstance.update(0.75);

      expect(scoreDisplayInstance.scoreText.textContent).toBe('score=0.750');
    });

    it('should not update when not visible', () => {
      scoreDisplayInstance.scoreText.textContent = 'original';
      scoreDisplayInstance.update(0.75);

      expect(scoreDisplayInstance.scoreText.textContent).toBe('original');
    });

    it('should not update with undefined score', () => {
      scoreDisplayInstance.show(0.5);
      scoreDisplayInstance.update(undefined);

      expect(scoreDisplayInstance.scoreText.textContent).toBe('score=0.500');
    });

    it('should not update with null score', () => {
      scoreDisplayInstance.show(0.5);
      scoreDisplayInstance.update(null);

      expect(scoreDisplayInstance.scoreText.textContent).toBe('score=0.500');
    });
  });

  describe('global scoreDisplay instance', () => {
    it('should export a global ScoreDisplay instance', () => {
      expect(scoreDisplay).toBeInstanceOf(ScoreDisplay);
    });
  });
});
