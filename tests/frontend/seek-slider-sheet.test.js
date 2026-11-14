// The seek slider in the phone layout's top sheet: open for exactly as long as
// the sheet is, whatever the hover, fade-out and badge-tap paths would do.
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule("../../photomap/frontend/static/javascript/score-display.js", () => ({
  scoreDisplay: { showIndex: jest.fn(), setBookmarkStatus: jest.fn() },
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/back-stack.js", () => ({
  backStack: { markNextAsJump: jest.fn() },
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/bookmarks.js", () => ({
  bookmarkManager: { isBookmarked: jest.fn(() => false) },
}));
const mockSlideState = { getCurrentIndex: jest.fn(() => 2), navigateToIndex: jest.fn(), isSearchMode: false };
jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
  slideState: mockSlideState,
  getCurrentSlideIndex: jest.fn(() => [2, 5, 0]),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: { searchResults: [], searchType: "clear", album: "test" },
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
  debounce: (fn) => fn,
}));
let mobile = true;
jest.unstable_mockModule("../../photomap/frontend/static/javascript/mobile-sheets.js", () => ({
  isMobileSheetsMode: () => mobile,
}));

const { seekSlider } = await import("../../photomap/frontend/static/javascript/seek-slider.js");

function sheetChanged(expanded, isMobile = true) {
  window.dispatchEvent(new CustomEvent("mobileSheetChanged", { detail: { sheet: "top", expanded, mobile: isMobile } }));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("seek slider pinned by the top sheet", () => {
  beforeEach(async () => {
    mobile = true;
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ last_modified: 0 }) }));
    document.body.innerHTML = `
      <div id="topSheetContainer">
        <div id="fixedScoreDisplay"><span id="scoreText"></span></div>
        <div id="sliderHoverStrip"></div>
        <div id="scoreSliderRow" style="left: 200px">
          <div id="sliderHoverZone"></div>
          <div id="sliderWithTicksContainer">
            <input type="range" id="slideSeekSlider" min="1" max="1" value="1" />
            <div id="sliderInfoPanel"></div>
            <span id="contextLabel"></span>
            <div id="sliderTicks"></div>
          </div>
        </div>
      </div>
    `;
    seekSlider.sheetPinned = false;
    seekSlider.sliderVisible = false;
    seekSlider.initialize();
    await flush();
  });

  afterEach(() => {
    seekSlider.unpinForSheet();
    seekSlider.clearFadeOutTimer();
  });

  it("drops the inline left edge that squeezes it beside the badge", () => {
    expect(document.getElementById("scoreSliderRow").style.left).toBe("");
  });

  it("opens with the sheet, with its range, position and ticks", async () => {
    sheetChanged(true);
    await flush();
    await flush();
    expect(seekSlider.sheetPinned).toBe(true);
    expect(seekSlider.sliderVisible).toBe(true);
    expect(document.getElementById("sliderWithTicksContainer").classList.contains("visible")).toBe(true);
    expect(document.getElementById("sliderHoverStrip").classList.contains("hidden")).toBe(true);
    const slider = document.getElementById("slideSeekSlider");
    expect(slider.max).toBe("5");
    expect(slider.value).toBe("3");
    expect(document.querySelectorAll(".slider-tick").length).toBe(seekSlider.TICK_COUNT);
  });

  it("stays open through the paths that would otherwise close it", async () => {
    sheetChanged(true);
    await flush();
    seekSlider.hideSlider();
    seekSlider.scheduleHide();
    seekSlider.resetFadeOutTimer();
    await seekSlider.toggleSlider();
    document.getElementById("fixedScoreDisplay").click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seekSlider.sliderVisible).toBe(true);
    expect(seekSlider.fadeOutTimeoutId).toBeNull();
    expect(document.getElementById("sliderWithTicksContainer").classList.contains("visible")).toBe(true);
  });

  it("closes with the sheet", async () => {
    sheetChanged(true);
    await flush();
    sheetChanged(false);
    expect(seekSlider.sheetPinned).toBe(false);
    expect(seekSlider.sliderVisible).toBe(false);
    expect(document.getElementById("sliderHoverStrip").classList.contains("hidden")).toBe(false);
  });

  it("closes when the phone layout ends, and measures from the badge again", async () => {
    sheetChanged(true);
    await flush();
    mobile = false;
    sheetChanged(false, false);
    expect(seekSlider.sheetPinned).toBe(false);
    expect(seekSlider.sliderVisible).toBe(false);
    // jsdom lays nothing out, so only that it is set again, not to what.
    expect(document.getElementById("scoreSliderRow").style.left).not.toBe("");
  });

  it("re-reads the range at once when the search changes under an open sheet", async () => {
    sheetChanged(true);
    await flush();
    const slider = document.getElementById("slideSeekSlider");
    slider.max = "1";
    window.dispatchEvent(new CustomEvent("searchResultsChanged"));
    await flush();
    expect(slider.max).toBe("5");
  });
});
