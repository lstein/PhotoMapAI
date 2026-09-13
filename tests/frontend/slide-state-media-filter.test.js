// slideState and the media filter's browse list.
//
// search.js dispatches searchType "clear" with a non-empty list when an
// images/videos filter is active. slideState browses that list like search
// results, but keeps the user's place in the album instead of jumping to the
// first entry.

import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const M = "../../photomap/frontend/static/javascript";

jest.unstable_mockModule(`${M}/state.js`, () => ({
  state: { album: "alb", wrapNavigation: false },
}));

const { slideState } = await import(`${M}/slide-state.js`);

function dispatchResults(results, searchType) {
  window.dispatchEvent(new CustomEvent("searchResultsChanged", { detail: { results, searchType } }));
}

const VIDEOS = [{ index: 1 }, { index: 4 }, { index: 7 }];

beforeEach(() => {
  slideState.exitSearchMode();
  slideState.browseList = null;
  slideState.totalAlbumImages = 10;
  slideState.currentGlobalIndex = 0;
  slideState.currentSearchIndex = 0;
});

describe("a non-empty clear", () => {
  test("browses the list", () => {
    dispatchResults(VIDEOS, "clear");
    expect(slideState.isSearchMode).toBe(true);
    expect(slideState.getCurrentSlide().totalCount).toBe(3);
    expect(slideState.resolveOffset(1)).toEqual({ globalIndex: 4, searchIndex: 1 });
  });

  test("stays on the current image when the list keeps it", () => {
    slideState.currentGlobalIndex = 4;
    dispatchResults(VIDEOS, "clear");
    expect(slideState.currentGlobalIndex).toBe(4);
    expect(slideState.currentSearchIndex).toBe(1);
  });

  test("moves to the next kept image when the current one is hidden", () => {
    slideState.currentGlobalIndex = 5;
    dispatchResults(VIDEOS, "clear");
    expect(slideState.currentGlobalIndex).toBe(7);
    expect(slideState.currentSearchIndex).toBe(2);
  });

  test("moves to the last kept image when everything kept precedes the current one", () => {
    slideState.currentGlobalIndex = 9;
    dispatchResults(VIDEOS, "clear");
    expect(slideState.currentGlobalIndex).toBe(7);
    expect(slideState.currentSearchIndex).toBe(2);
  });

  test("starts a real search at its first result regardless", () => {
    slideState.currentGlobalIndex = 5;
    dispatchResults(VIDEOS, "text");
    expect(slideState.currentSearchIndex).toBe(0);
    expect(slideState.currentGlobalIndex).toBe(1);
  });
});

describe("a browse list that starts at album index 0", () => {
  // The grid enumerates positions through indexToGlobal and skips null; the
  // first image of nearly every album is index 0, which is falsy.
  const IMAGES = [{ index: 0 }, { index: 2 }, { index: 3 }];

  test("maps position 0 to global index 0", () => {
    dispatchResults(IMAGES, "clear");
    expect(slideState.indexToGlobal(0)).toBe(0);
    expect(slideState.currentGlobalIndex).toBe(0);
  });

  test("lands on index 0 when a search's first hit is index 0", () => {
    slideState.currentGlobalIndex = 7;
    dispatchResults(
      [
        { index: 0, score: 1 },
        { index: 5, score: 0.5 },
      ],
      "text"
    );
    expect(slideState.currentGlobalIndex).toBe(0);
    expect(slideState.currentSearchIndex).toBe(0);
  });
});

describe("a jump to an image the filter hides", () => {
  test("snaps to the nearest shown image and keeps browsing the list", () => {
    dispatchResults(VIDEOS, "clear");
    slideState.navigateToIndex(5, false); // browser Back to an image
    expect(slideState.isSearchMode).toBe(true);
    expect(slideState.currentGlobalIndex).toBe(7);
    expect(slideState.currentSearchIndex).toBe(2);
  });

  test("still leaves a real search when the target is not a result", () => {
    dispatchResults([...VIDEOS], "text");
    slideState.navigateToIndex(5, false);
    expect(slideState.isSearchMode).toBe(false);
    expect(slideState.currentGlobalIndex).toBe(5);
  });

  test("forgets the browse list on an album switch", () => {
    dispatchResults(VIDEOS, "clear");
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: "other", totalImages: 3 } }));
    expect(slideState.browseList).toBeNull();
  });
});

describe("an empty clear", () => {
  test("returns to the whole album at the current image", () => {
    slideState.currentGlobalIndex = 4;
    dispatchResults(VIDEOS, "clear");
    dispatchResults([], "clear");
    expect(slideState.isSearchMode).toBe(false);
    expect(slideState.currentGlobalIndex).toBe(4);
    expect(slideState.getCurrentSlide().totalCount).toBe(10);
  });
});
