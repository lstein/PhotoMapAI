/**
 * Tests for slideState's handling of albumChanged with changeType "deletion"
 * (dispatched by the trash-can button in control-panel.js and the bookmark
 * multi-delete in bookmarks.js): an active search must survive the deletion —
 * the deleted entries drop out of the results, the survivors' global indices
 * are renumbered, and the position stays put instead of resetting to slide 1.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const M = "../../photomap/frontend/static/javascript";

jest.unstable_mockModule(`${M}/state.js`, () => ({
  state: { album: "alb" },
}));

const { slideState } = await import(`${M}/slide-state.js`);

function dispatchDeletion(deletedIndices, totalImages) {
  window.dispatchEvent(
    new CustomEvent("albumChanged", {
      detail: { album: "alb", totalImages, changeType: "deletion", deletedIndices },
    })
  );
}

beforeEach(() => {
  slideState.exitSearchMode();
  slideState.currentGlobalIndex = 0;
  slideState.currentSearchIndex = 0;
  slideState.totalAlbumImages = 0;
});

describe("albumChanged changeType deletion — album mode", () => {
  test("keeps the position when the deleted image was after it", () => {
    slideState.totalAlbumImages = 100;
    slideState.currentGlobalIndex = 10;

    dispatchDeletion([50], 99);

    expect(slideState.currentGlobalIndex).toBe(10);
    expect(slideState.totalAlbumImages).toBe(99);
    expect(slideState.isSearchMode).toBe(false);
  });

  test("shifts the position back past deleted predecessors and clamps at the end", () => {
    slideState.totalAlbumImages = 100;
    slideState.currentGlobalIndex = 50;

    dispatchDeletion([3, 7], 98);
    expect(slideState.currentGlobalIndex).toBe(48);

    slideState.currentGlobalIndex = 97;
    dispatchDeletion([97], 97);
    expect(slideState.currentGlobalIndex).toBe(96);
  });

  test("goes to 0 when the album empties out", () => {
    slideState.totalAlbumImages = 1;
    slideState.currentGlobalIndex = 0;

    dispatchDeletion([0], 0);

    expect(slideState.currentGlobalIndex).toBe(0);
    expect(slideState.totalAlbumImages).toBe(0);
  });
});

describe("albumChanged changeType deletion — search mode", () => {
  test("stays in search mode when the current result is deleted (the regression)", () => {
    slideState.totalAlbumImages = 100;
    const results = [
      { index: 3, score: 0.9 },
      { index: 40, score: 0.8 },
      { index: 77, score: 0.7 },
    ];
    slideState.enterSearchMode(results, 1);

    // Delete the current result (global index 40).
    dispatchDeletion([40], 99);

    expect(slideState.isSearchMode).toBe(true);
    // Survivors renumbered: 77 shifts down to 76; 3 is untouched.
    expect(slideState.searchResults.map((r) => r.index)).toEqual([3, 76]);
    // Same search position, so the next result fills the slot.
    expect(slideState.currentSearchIndex).toBe(1);
    expect(slideState.currentGlobalIndex).toBe(76);
    // Must mutate the caller's array in place — state.searchResults
    // (search.js) holds the same object and would otherwise go stale.
    expect(slideState.searchResults).toBe(results);
    expect(results.map((r) => r.index)).toEqual([3, 76]);
  });

  test("clamps to the last result when the final result is deleted", () => {
    slideState.totalAlbumImages = 100;
    slideState.enterSearchMode(
      [
        { index: 3, score: 0.9 },
        { index: 77, score: 0.7 },
      ],
      1
    );

    dispatchDeletion([77], 99);

    expect(slideState.isSearchMode).toBe(true);
    expect(slideState.currentSearchIndex).toBe(0);
    expect(slideState.currentGlobalIndex).toBe(3);
  });

  test("keeps pointing at the same result when an earlier result is deleted", () => {
    slideState.totalAlbumImages = 100;
    slideState.enterSearchMode(
      [
        { index: 3, score: 0.9 },
        { index: 40, score: 0.8 },
        { index: 77, score: 0.7 },
      ],
      2
    );

    dispatchDeletion([3], 99);

    expect(slideState.currentSearchIndex).toBe(1);
    expect(slideState.currentGlobalIndex).toBe(76);
  });

  test("multi-delete (bookmarks) removes several results and renumbers the rest", () => {
    slideState.totalAlbumImages = 100;
    slideState.enterSearchMode(
      [
        { index: 3, score: 0.9 },
        { index: 40, score: 0.8 },
        { index: 60, score: 0.75 },
        { index: 77, score: 0.7 },
      ],
      2
    );

    // Bookmarks deletes globals 3 and 77 — one before the current result,
    // one after; global 10 was never in the search results.
    dispatchDeletion([3, 10, 77], 97);

    expect(slideState.isSearchMode).toBe(true);
    expect(slideState.searchResults.map((r) => r.index)).toEqual([38, 58]);
    expect(slideState.currentSearchIndex).toBe(1);
    expect(slideState.currentGlobalIndex).toBe(58);
  });

  test("exits search mode only when every result is deleted", () => {
    slideState.totalAlbumImages = 100;
    slideState.currentGlobalIndex = 40;
    slideState.enterSearchMode(
      [
        { index: 3, score: 0.9 },
        { index: 40, score: 0.8 },
      ],
      1
    );

    dispatchDeletion([3, 40], 98);

    expect(slideState.isSearchMode).toBe(false);
    expect(slideState.searchResults).toEqual([]);
    // Falls back to album mode at the renumbered global position.
    expect(slideState.currentGlobalIndex).toBe(39);
    expect(slideState.totalAlbumImages).toBe(98);
  });
});
