// Unit tests for search.js
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Note: We use jest.unstable_mockModule because this is the current recommended approach
// for mocking ES modules in Jest. The "unstable" prefix indicates the API may change,
// but it's the only way to mock modules before they're imported in ESM.
// See: https://jestjs.io/docs/ecmascript-modules#module-mocking-in-esm

// We need to mock these modules BEFORE importing search.js
// because search.js imports state.js which imports album-manager.js
// which has DOM side effects on load

// Mock album-manager to prevent DOM errors
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

// Mock utils.js
jest.unstable_mockModule('../../photomap/frontend/static/javascript/utils.js', () => ({
  showSpinner: jest.fn(),
  hideSpinner: jest.fn()
}));

// Now import state with our mock
const { state } = await import('../../photomap/frontend/static/javascript/state.js');

// Import the functions we want to test
const { calculate_search_score_cutoff, setSearchResults } = await import('../../photomap/frontend/static/javascript/search.js');

describe('search.js', () => {
  beforeEach(() => {
    // Reset state before each test
    state.searchResults = [];
    state.searchType = null;
    jest.clearAllMocks();
  });

  describe('calculate_search_score_cutoff', () => {
    const IMAGE_SCORE_CUTOFF = 0.75;
    const TEXT_SCORE_CUTOFF = 0.2;

    it('should return image cutoff when only image is provided', () => {
      const result = calculate_search_score_cutoff(
        { name: 'test.jpg' }, // imageFile
        1.0, // imgWeight
        '', // positiveQuery
        0.5, // posWeight
        '', // negativeQuery
        0.5  // negWeight
      );
      expect(result).toBe(IMAGE_SCORE_CUTOFF);
    });

    it('should return text cutoff when only positive query is provided', () => {
      const result = calculate_search_score_cutoff(
        null, // imageFile
        0.5, // imgWeight
        'cats', // positiveQuery
        1.0, // posWeight
        '', // negativeQuery
        0.5  // negWeight
      );
      expect(result).toBe(TEXT_SCORE_CUTOFF);
    });

    it('should return text cutoff when only negative query is provided', () => {
      const result = calculate_search_score_cutoff(
        null, // imageFile
        0.5, // imgWeight
        '', // positiveQuery
        0.5, // posWeight
        'dogs', // negativeQuery
        1.0  // negWeight
      );
      expect(result).toBe(TEXT_SCORE_CUTOFF);
    });

    it('should calculate weighted average when image and positive query are provided', () => {
      const result = calculate_search_score_cutoff(
        { name: 'test.jpg' }, // imageFile
        0.5, // imgWeight
        'cats', // positiveQuery
        0.5, // posWeight
        '', // negativeQuery
        0.5  // negWeight
      );
      // (0.5 * 0.75 + 0.5 * 0.2) / (0.5 + 0.5) = 0.475
      expect(result).toBeCloseTo(0.475, 5);
    });

    it('should calculate weighted average when all inputs are provided', () => {
      const result = calculate_search_score_cutoff(
        { name: 'test.jpg' }, // imageFile
        0.6, // imgWeight
        'cats', // positiveQuery
        0.3, // posWeight
        'dogs', // negativeQuery
        0.1  // negWeight
      );
      // (0.6 * 0.75 + 0.3 * 0.2 + 0.1 * 0.2) / (0.6 + 0.3 + 0.1) = (0.45 + 0.06 + 0.02) / 1.0 = 0.53
      expect(result).toBeCloseTo(0.53, 5);
    });

    it('should handle equal weights', () => {
      const result = calculate_search_score_cutoff(
        { name: 'test.jpg' }, // imageFile
        1.0, // imgWeight
        'cats', // positiveQuery
        1.0, // posWeight
        '', // negativeQuery
        0.5  // negWeight
      );
      // (1.0 * 0.75 + 1.0 * 0.2) / (1.0 + 1.0) = 0.475
      expect(result).toBeCloseTo(0.475, 5);
    });
  });

  describe('setSearchResults', () => {
    it('should set search results and type on state', () => {
      const results = [
        { filename: 'photo1.jpg', score: 0.9 },
        { filename: 'photo2.jpg', score: 0.8 }
      ];

      // Mock event dispatch
      const dispatchEventSpy = jest.spyOn(window, 'dispatchEvent');

      setSearchResults(results, 'text');

      expect(state.searchResults).toEqual(results);
      expect(state.searchType).toBe('text');
      expect(dispatchEventSpy).toHaveBeenCalled();

      const event = dispatchEventSpy.mock.calls[0][0];
      expect(event.type).toBe('searchResultsChanged');
      expect(event.detail.results).toEqual(results);
      expect(event.detail.searchType).toBe('text');

      dispatchEventSpy.mockRestore();
    });

    it('should not dispatch event for switchAlbum search type', () => {
      const results = [{ filename: 'photo1.jpg', score: 0.9 }];
      const dispatchEventSpy = jest.spyOn(window, 'dispatchEvent');

      setSearchResults(results, 'switchAlbum');

      expect(state.searchResults).toEqual(results);
      expect(state.searchType).toBe('switchAlbum');
      expect(dispatchEventSpy).not.toHaveBeenCalled();

      dispatchEventSpy.mockRestore();
    });

    it('should handle empty results', () => {
      const dispatchEventSpy = jest.spyOn(window, 'dispatchEvent');

      setSearchResults([], 'text');

      expect(state.searchResults).toEqual([]);
      expect(dispatchEventSpy).toHaveBeenCalled();

      dispatchEventSpy.mockRestore();
    });

    it('should handle image search type', () => {
      const results = [{ filename: 'photo1.jpg', score: 0.95 }];
      const dispatchEventSpy = jest.spyOn(window, 'dispatchEvent');

      setSearchResults(results, 'image');

      expect(state.searchType).toBe('image');
      expect(dispatchEventSpy).toHaveBeenCalled();

      dispatchEventSpy.mockRestore();
    });
  });
});
