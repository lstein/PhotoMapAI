/**
 * Tests for slideState remembering the slide last shown in each album, so a
 * reload (or a switch back to the album) returns to it instead of slide 1.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const M = "../../photomap/frontend/static/javascript";

const mockState = { album: "alb", lastSlideIndex: {} };
const persistSettings = jest.fn();
jest.unstable_mockModule(`${M}/state.js`, () => ({ state: mockState, persistSettings }));

const { slideState } = await import(`${M}/slide-state.js`);

function dispatchAlbumChanged(detail) {
  window.dispatchEvent(new CustomEvent("albumChanged", { detail }));
}

beforeEach(() => {
  slideState.album = null;
  slideState.exitSearchMode();
  slideState.currentGlobalIndex = 0;
  slideState.currentSearchIndex = 0;
  slideState.totalAlbumImages = 0;
  mockState.album = "alb";
  mockState.lastSlideIndex = {};
  persistSettings.mockReset();
});

describe("restoring the last position on album switch", () => {
  test("starts at the remembered slide", () => {
    mockState.lastSlideIndex = { alb: 200 };

    dispatchAlbumChanged({ album: "alb", totalImages: 500 });

    expect(slideState.currentGlobalIndex).toBe(200);
  });

  test("clamps a remembered slide past the end of a shrunken album", () => {
    mockState.lastSlideIndex = { alb: 200 };

    dispatchAlbumChanged({ album: "alb", totalImages: 50 });

    expect(slideState.currentGlobalIndex).toBe(49);
  });

  test("starts at 0 for an album with no remembered slide", () => {
    mockState.lastSlideIndex = { other: 10 };

    dispatchAlbumChanged({ album: "alb", totalImages: 500 });

    expect(slideState.currentGlobalIndex).toBe(0);
  });

  test("falls back to state.album when the event names none", () => {
    mockState.lastSlideIndex = { alb: 12 };

    dispatchAlbumChanged({ totalImages: 500 });

    expect(slideState.currentGlobalIndex).toBe(12);
  });
});

describe("remembering the position", () => {
  test("records each slide change under the album slideState is showing", () => {
    dispatchAlbumChanged({ album: "alb", totalImages: 500 });

    slideState.navigateToIndex(42, false);

    expect(mockState.lastSlideIndex).toEqual({ alb: 42 });
    expect(persistSettings).toHaveBeenCalledWith("lastSlideIndex");
  });

  test("does not file a slide under an album whose albumChanged is still pending", () => {
    dispatchAlbumChanged({ album: "alb", totalImages: 500 });
    // setAlbum has switched state.album but not yet dispatched albumChanged;
    // a slideshow tick on the old album lands in between.
    mockState.album = "next";

    slideState.navigateToIndex(7, false);

    expect(mockState.lastSlideIndex).toEqual({ alb: 7 });
  });

  test("does not persist when the slide did not move", () => {
    mockState.lastSlideIndex = { alb: 5 };
    dispatchAlbumChanged({ album: "alb", totalImages: 500 });

    slideState.navigateToIndex(5, false);

    expect(persistSettings).not.toHaveBeenCalled();
  });

  test("a refresh keeps the current position rather than the remembered one", () => {
    mockState.lastSlideIndex = { alb: 5 };
    dispatchAlbumChanged({ album: "alb", totalImages: 500 });
    slideState.currentGlobalIndex = 80;

    dispatchAlbumChanged({ album: "alb", totalImages: 500, changeType: "refresh" });

    expect(slideState.currentGlobalIndex).toBe(80);
  });
});
