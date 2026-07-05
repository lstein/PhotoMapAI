/**
 * Tests for slideState's handling of albumChanged with changeType "refresh"
 * (dispatched after an in-place index update, e.g. the semantic map's
 * reindex button): position and search results must survive the refresh,
 * clamped against the new image count.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const M = "../../photomap/frontend/static/javascript";

jest.unstable_mockModule(`${M}/state.js`, () => ({
  state: { album: "alb" },
}));

const { slideState } = await import(`${M}/slide-state.js`);

function dispatchAlbumChanged(detail) {
  window.dispatchEvent(new CustomEvent("albumChanged", { detail }));
}

beforeEach(() => {
  slideState.exitSearchMode();
  slideState.currentGlobalIndex = 0;
  slideState.currentSearchIndex = 0;
  slideState.totalAlbumImages = 0;
});

describe("albumChanged changeType refresh", () => {
  test("keeps the current position and updates the total", () => {
    slideState.totalAlbumImages = 100;
    slideState.currentGlobalIndex = 57;

    dispatchAlbumChanged({ album: "alb", totalImages: 120, changeType: "refresh" });

    expect(slideState.totalAlbumImages).toBe(120);
    expect(slideState.currentGlobalIndex).toBe(57);
    expect(slideState.isSearchMode).toBe(false);
  });

  test("clamps the position when the album shrank below it", () => {
    slideState.totalAlbumImages = 100;
    slideState.currentGlobalIndex = 95;

    dispatchAlbumChanged({ album: "alb", totalImages: 60, changeType: "refresh" });

    expect(slideState.currentGlobalIndex).toBe(59);

    dispatchAlbumChanged({ album: "alb", totalImages: 0, changeType: "refresh" });
    expect(slideState.currentGlobalIndex).toBe(0);
  });

  test("preserves search results and position within them", () => {
    slideState.totalAlbumImages = 100;
    slideState.enterSearchMode(
      [
        { index: 3, score: 0.9 },
        { index: 40, score: 0.8 },
        { index: 77, score: 0.7 },
      ],
      1
    );

    dispatchAlbumChanged({ album: "alb", totalImages: 130, changeType: "refresh" });

    expect(slideState.isSearchMode).toBe(true);
    expect(slideState.searchResults).toHaveLength(3);
    expect(slideState.currentSearchIndex).toBe(1);
    expect(slideState.currentGlobalIndex).toBe(40);
  });

  test("drops search results that point past the new end", () => {
    slideState.totalAlbumImages = 100;
    slideState.enterSearchMode(
      [
        { index: 3, score: 0.9 },
        { index: 40, score: 0.8 },
        { index: 77, score: 0.7 },
      ],
      2
    );

    dispatchAlbumChanged({ album: "alb", totalImages: 50, changeType: "refresh" });

    expect(slideState.isSearchMode).toBe(true);
    expect(slideState.searchResults.map((r) => r.index)).toEqual([3, 40]);
    expect(slideState.currentSearchIndex).toBe(1);
    expect(slideState.currentGlobalIndex).toBe(40);
  });

  test("exits search mode when no result survives the refresh", () => {
    slideState.totalAlbumImages = 100;
    slideState.currentGlobalIndex = 80;
    slideState.enterSearchMode([{ index: 80, score: 0.9 }], 0);

    dispatchAlbumChanged({ album: "alb", totalImages: 20, changeType: "refresh" });

    expect(slideState.isSearchMode).toBe(false);
    expect(slideState.searchResults).toEqual([]);
    expect(slideState.currentGlobalIndex).toBe(19);
  });

  test("a plain albumChanged (album switch) still resets to the beginning", () => {
    slideState.totalAlbumImages = 100;
    slideState.currentGlobalIndex = 57;

    dispatchAlbumChanged({ album: "other", totalImages: 30 });

    expect(slideState.currentGlobalIndex).toBe(0);
    expect(slideState.totalAlbumImages).toBe(30);
  });
});
