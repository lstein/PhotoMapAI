// setSearchResults under an images/videos filter.
//
// search.js is the one place every result list passes through, so the filter
// is applied there: real search results are narrowed, and "clear" carries the
// filter's browse list instead of an empty array. The unfiltered results are
// remembered so widening the filter brings the hidden ones back.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const JS = "../../photomap/frontend/static/javascript";

const mockState = { album: "alb", mediaFilter: "both", searchResults: [], searchType: null };

jest.unstable_mockModule(`${JS}/state.js`, () => ({ state: mockState }));
jest.unstable_mockModule(`${JS}/utils.js`, () => ({
  fetchJson: jest.fn(),
  showSpinner: jest.fn(),
  hideSpinner: jest.fn(),
  showToast: jest.fn(),
}));

const mf = await import(`${JS}/media-filter.js`);
const { setSearchResults, reapplyMediaFilter, searchTextAndImage } = await import(`${JS}/search.js`);
const utils = await import(`${JS}/utils.js`);

// Six entries; 1 and 4 are videos.
const MIXED = { album: "alb", total: 6, videoIndices: [1, 4] };
const HITS = [
  { index: 4, score: 0.9 },
  { index: 0, score: 0.8 },
  { index: 1, score: 0.7 },
];

let events = [];
window.addEventListener("searchResultsChanged", (e) => events.push(e.detail));

function setFilter(value) {
  mockState.mediaFilter = value;
  window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value } }));
}

beforeEach(() => {
  mockState.mediaFilter = "both";
  mockState.searchResults = [];
  mockState.searchType = null;
  mf._setMediaIndicesForTest(MIXED);
  setSearchResults([], "clear");
  events = [];
});

describe("with no filter", () => {
  it("passes results through untouched", () => {
    setSearchResults(HITS, "text");
    expect(mockState.searchResults).toBe(HITS);
    expect(events).toEqual([{ results: HITS, searchType: "text", noResults: false }]);
  });

  it("clears to an empty list", () => {
    setSearchResults([], "clear");
    expect(mockState.searchResults).toEqual([]);
    expect(events[0].results).toEqual([]);
  });
});

describe("with Videos selected", () => {
  beforeEach(() => {
    setFilter("videos");
    events = [];
  });

  it("narrows search results to videos, in their original order", () => {
    setSearchResults(HITS, "text");
    expect(mockState.searchResults).toEqual([
      { index: 4, score: 0.9 },
      { index: 1, score: 0.7 },
    ]);
    expect(mockState.searchType).toBe("text");
    expect(events[0].results).toEqual(mockState.searchResults);
  });

  it("makes clear browse the album's videos", () => {
    setSearchResults([], "clear");
    expect(mockState.searchType).toBe("clear");
    expect(mockState.searchResults).toEqual([{ index: 1 }, { index: 4 }]);
    expect(events).toEqual([{ results: [{ index: 1 }, { index: 4 }], searchType: "clear", noResults: false }]);
  });

  it("stores a switchAlbum clear as given: the browse list in hand is the old album's", () => {
    setSearchResults([], "switchAlbum");
    expect(mockState.searchResults).toEqual([]);
    expect(events).toEqual([]);
  });

  it("ignores whatever a clear is handed and rebuilds the browse list", () => {
    // bookmarks.js saves the current list and hands it back with "clear"
    // when bookmarks are hidden; that must not pin a stale list.
    setSearchResults([{ index: 0 }, { index: 2 }], "clear");
    expect(mockState.searchResults).toEqual([{ index: 1 }, { index: 4 }]);
  });

  it("falls back to the browse list when a search has no hits of the shown type", () => {
    setSearchResults([{ index: 0, score: 0.9 }], "text"); // an image
    expect(mockState.searchType).toBe("clear");
    expect(mockState.searchResults).toEqual([{ index: 1 }, { index: 4 }]);
    expect(events).toEqual([{ results: [{ index: 1 }, { index: 4 }], searchType: "clear", noResults: true }]);
  });

  it("falls back the same way when the server returned nothing", () => {
    setSearchResults([], "text");
    expect(mockState.searchType).toBe("clear");
    expect(mockState.searchResults).toEqual([{ index: 1 }, { index: 4 }]);
    expect(events[0].noResults).toBe(true);
  });

  it("sends the filter with a search request", async () => {
    utils.fetchJson.mockResolvedValueOnce({ results: [] });
    await searchTextAndImage({ positive_query: "cats" });
    const [, options] = utils.fetchJson.mock.calls[0];
    expect(options.json.media_filter).toBe("videos");
  });
});

describe("changing the filter", () => {
  it("narrows an active search when the filter tightens", () => {
    setSearchResults(HITS, "text");
    events = [];

    setFilter("images");

    expect(mockState.searchType).toBe("text");
    expect(mockState.searchResults).toEqual([{ index: 0, score: 0.8 }]);
    expect(events).toHaveLength(1);
  });

  it("restores the hidden results when the filter widens again", () => {
    setSearchResults(HITS, "text");
    setFilter("images");
    events = [];

    setFilter("both");

    expect(mockState.searchType).toBe("text");
    expect(mockState.searchResults).toEqual(HITS);
    expect(events).toHaveLength(1);
  });

  it("restores a search the filter had narrowed to nothing", () => {
    setSearchResults([{ index: 0, score: 0.9 }], "text");
    setFilter("videos"); // no video hits: browsing videos, flagged noResults
    expect(mockState.searchType).toBe("clear");
    events = [];

    setFilter("both");

    expect(mockState.searchType).toBe("text");
    expect(mockState.searchResults).toEqual([{ index: 0, score: 0.9 }]);
    expect(events[0].noResults).toBe(false);
  });

  it("does not restart an active search after an in-place reindex", () => {
    setFilter("images");
    setSearchResults(HITS, "text");
    events = [];

    window.dispatchEvent(new CustomEvent("mediaFilterChanged", { detail: { filter: "images", reason: "refresh" } }));

    expect(events).toEqual([]);
  });

  it("does rebuild the browse list after an in-place reindex", () => {
    setFilter("images");
    setSearchResults([], "clear");
    mf._setMediaIndicesForTest({ album: "alb", total: 7, videoIndices: [1, 4] });
    events = [];

    window.dispatchEvent(new CustomEvent("mediaFilterChanged", { detail: { filter: "images", reason: "refresh" } }));

    expect(events).toHaveLength(1);
    expect(mockState.searchResults).toEqual([{ index: 0 }, { index: 2 }, { index: 3 }, { index: 5 }, { index: 6 }]);
  });

  it("swaps the browse list for an empty clear when widened while browsing", () => {
    setFilter("videos");
    setSearchResults([], "clear");
    events = [];

    setFilter("both");

    expect(mockState.searchType).toBe("clear");
    expect(mockState.searchResults).toEqual([]);
    expect(events).toEqual([{ results: [], searchType: "clear", noResults: false }]);
  });

  it("does not resurrect entries deleted while the filter was narrow", () => {
    setSearchResults(HITS, "text");
    setFilter("images"); // showing only index 0
    // Delete index 0 (an image): the videos shift down to 0 and 3.
    window.dispatchEvent(
      new CustomEvent("albumChanged", {
        detail: { album: "alb", totalImages: 5, changeType: "deletion", deletedIndices: [0] },
      })
    );

    setFilter("both");

    expect(mockState.searchResults).toEqual([
      { index: 3, score: 0.9 },
      { index: 0, score: 0.7 },
    ]);
  });

  it("drops a browse list on a switch to an album where the filter does not apply", () => {
    setFilter("images");
    setSearchResults([], "clear");
    expect(mockState.searchResults).not.toEqual([]);

    // The new album never announces (no videos), so nothing else would
    // replace the old album's list.
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: "photos", totalImages: 50 } }));

    expect(mockState.searchResults).toEqual([]);
  });

  it("leaves an active search's results alone on an album switch", () => {
    // Pre-existing contract: the album switch path clears the search itself
    // via exitSearchMode("switchAlbum") beforehand; other albumChanged
    // producers do not, and this module must not start second-guessing them.
    setSearchResults(HITS, "text");
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: "photos", totalImages: 50 } }));
    expect(mockState.searchResults).toBe(HITS);
  });

  it("forgets the old results on a switch to another album", () => {
    setSearchResults(HITS, "text");
    setFilter("images");
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: "other", totalImages: 6 } }));
    mf._setMediaIndicesForTest({ album: "other", total: 6, videoIndices: [1, 4] });
    mockState.searchType = "switchAlbum";
    events = [];

    reapplyMediaFilter();

    // Nothing to restore: the result is the new album's browse list.
    expect(mockState.searchType).toBe("clear");
    expect(mockState.searchResults).toEqual([{ index: 0 }, { index: 2 }, { index: 3 }, { index: 5 }]);
  });
});
