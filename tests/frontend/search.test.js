// Unit tests for search.js
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// Note: We use jest.unstable_mockModule because this is the current recommended approach
// for mocking ES modules in Jest. The "unstable" prefix indicates the API may change,
// but it's the only way to mock modules before they're imported in ESM.
// See: https://jestjs.io/docs/ecmascript-modules#module-mocking-in-esm

// We need to mock these modules BEFORE importing search.js
// because search.js imports state.js which imports album-manager.js
// which has DOM side effects on load

// Mock album-manager to prevent DOM errors
jest.unstable_mockModule("../../photomap/frontend/static/javascript/album-manager.js", () => ({
  albumManager: {
    fetchAvailableAlbums: jest.fn(() => Promise.resolve([])),
  },
  checkAlbumIndex: jest.fn(),
}));

// Mock index.js to prevent DOM errors
jest.unstable_mockModule("../../photomap/frontend/static/javascript/index.js", () => ({
  getIndexMetadata: jest.fn(() => Promise.resolve({ filename_count: 0 })),
}));

// Mock utils.js
jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
  showSpinner: jest.fn(),
  hideSpinner: jest.fn(),
  fetchJson: jest.fn(),
  showToast: jest.fn(),
}));

// Now import state with our mock
const { state } = await import("../../photomap/frontend/static/javascript/state.js");

// Grab the mocked utils so we can assert on showToast / fetchJson calls.
const utilsModule = await import("../../photomap/frontend/static/javascript/utils.js");

// Import the functions we want to test
const { setSearchResults, searchTextAndImage } = await import("../../photomap/frontend/static/javascript/search.js");

describe("search.js", () => {
  beforeEach(() => {
    // Reset state before each test
    state.searchResults = [];
    state.searchType = null;
    jest.clearAllMocks();
  });

  describe("setSearchResults", () => {
    it("should set search results and type on state", () => {
      const results = [
        { filename: "photo1.jpg", score: 0.9 },
        { filename: "photo2.jpg", score: 0.8 },
      ];

      // Mock event dispatch
      const dispatchEventSpy = jest.spyOn(window, "dispatchEvent");

      setSearchResults(results, "text");

      expect(state.searchResults).toEqual(results);
      expect(state.searchType).toBe("text");
      expect(dispatchEventSpy).toHaveBeenCalled();

      const event = dispatchEventSpy.mock.calls[0][0];
      expect(event.type).toBe("searchResultsChanged");
      expect(event.detail.results).toEqual(results);
      expect(event.detail.searchType).toBe("text");

      dispatchEventSpy.mockRestore();
    });

    it("should not dispatch event for switchAlbum search type", () => {
      const results = [{ filename: "photo1.jpg", score: 0.9 }];
      const dispatchEventSpy = jest.spyOn(window, "dispatchEvent");

      setSearchResults(results, "switchAlbum");

      expect(state.searchResults).toEqual(results);
      expect(state.searchType).toBe("switchAlbum");
      expect(dispatchEventSpy).not.toHaveBeenCalled();

      dispatchEventSpy.mockRestore();
    });

    it("should handle empty results", () => {
      const dispatchEventSpy = jest.spyOn(window, "dispatchEvent");

      setSearchResults([], "text");

      expect(state.searchResults).toEqual([]);
      expect(dispatchEventSpy).toHaveBeenCalled();

      dispatchEventSpy.mockRestore();
    });

    it("should handle image search type", () => {
      const results = [{ filename: "photo1.jpg", score: 0.95 }];
      const dispatchEventSpy = jest.spyOn(window, "dispatchEvent");

      setSearchResults(results, "image");

      expect(state.searchType).toBe("image");
      expect(dispatchEventSpy).toHaveBeenCalled();

      dispatchEventSpy.mockRestore();
    });
  });

  describe("searchTextAndImage error handling", () => {
    beforeEach(() => {
      state.album = "test-album";
      // Silence the console.error noise the catch logs intentionally.
      jest.spyOn(console, "error").mockImplementation(() => {});
    });

    it("surfaces server errors via showToast and returns []", async () => {
      // Build an HttpError-shaped object — fetchJson's contract from utils.js.
      const httpErr = Object.assign(new Error("HTTP 503"), {
        name: "HttpError",
        status: 503,
        body: {
          detail: "GPU is out of memory. Close other GPU workloads or restart the server to free VRAM.",
        },
      });
      utilsModule.fetchJson.mockRejectedValueOnce(httpErr);

      const result = await searchTextAndImage({ positive_query: "cats" });

      expect(result).toEqual([]);
      expect(utilsModule.showToast).toHaveBeenCalledTimes(1);
      const [message, options] = utilsModule.showToast.mock.calls[0];
      // The detail from FastAPI's response body surfaces in the toast.
      expect(message).toContain("GPU is out of memory");
      expect(options).toMatchObject({ level: "error" });
    });

    it("falls back to err.message when the body has no detail", async () => {
      const httpErr = Object.assign(new Error("Network down"), {
        name: "HttpError",
        status: 0,
        body: undefined,
      });
      utilsModule.fetchJson.mockRejectedValueOnce(httpErr);

      await searchTextAndImage({ positive_query: "cats" });

      expect(utilsModule.showToast).toHaveBeenCalledTimes(1);
      expect(utilsModule.showToast.mock.calls[0][0]).toContain("Network down");
    });

    it("does not show a toast on AbortError (search superseded)", async () => {
      const abortErr = Object.assign(new Error("aborted"), {
        name: "AbortError",
      });
      utilsModule.fetchJson.mockRejectedValueOnce(abortErr);

      const result = await searchTextAndImage({ positive_query: "cats" });

      expect(result).toEqual([]);
      expect(utilsModule.showToast).not.toHaveBeenCalled();
    });
  });
});
