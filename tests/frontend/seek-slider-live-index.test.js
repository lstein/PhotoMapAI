// Regression test for the live position badge while dragging the seek slider.
// showCluster/showSearchScore render `index + 1`, so onSliderInput must pass the
// 0-based slider index. It previously passed targetIndex + 1, double-incrementing
// the badge so the live drag read one too high until the thumb was released.
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockScoreDisplay = {
  showCluster: jest.fn(),
  showSearchScore: jest.fn(),
  showIndex: jest.fn(),
  setBookmarkStatus: jest.fn(),
};

jest.unstable_mockModule("../../photomap/frontend/static/javascript/score-display.js", () => ({
  scoreDisplay: mockScoreDisplay,
}));

jest.unstable_mockModule("../../photomap/frontend/static/javascript/back-stack.js", () => ({
  backStack: { markNextAsJump: jest.fn() },
}));

jest.unstable_mockModule("../../photomap/frontend/static/javascript/bookmarks.js", () => ({
  bookmarkManager: { isBookmarked: jest.fn(() => false) },
}));

const mockSlideState = {
  getCurrentIndex: jest.fn(() => 0),
  navigateToIndex: jest.fn(),
  isSearchMode: true,
};

jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
  slideState: mockSlideState,
  getCurrentSlideIndex: jest.fn(() => [0, 5, 0]),
}));

const mockState = { searchResults: [], searchType: "cluster", album: "test" };
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: mockState,
}));

jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
  debounce: (fn) => fn,
}));

describe("seek-slider live drag index", () => {
  let seekSlider;

  beforeEach(async () => {
    jest.clearAllMocks();
    document.body.innerHTML = `
      <div id="sliderWithTicksContainer"></div>
      <input type="range" id="slideSeekSlider" min="1" max="5" />
      <div id="sliderInfoPanel"></div>
    `;
    mockState.searchResults = [];
    mockState.searchType = "cluster";

    ({ seekSlider } = await import("../../photomap/frontend/static/javascript/seek-slider.js"));
    seekSlider.slider = document.getElementById("slideSeekSlider");
    seekSlider.infoPanel = document.getElementById("sliderInfoPanel");
    seekSlider.sliderContainer = document.getElementById("sliderWithTicksContainer");
    seekSlider.scoreDisplayObj = mockScoreDisplay;
    // Avoid scheduling real timers during the test.
    seekSlider.resetFadeOutTimer = jest.fn();
    seekSlider.updateHoverStripProgress = jest.fn();
  });

  it("shows the 0-based index for a cluster result while dragging (no +1 inflation)", async () => {
    // A 5-image cluster; thumb on slot 3 (slider value 3 -> targetIndex 2).
    mockState.searchResults = [
      { index: 100, cluster: 2, color: "#abc" },
      { index: 250, cluster: 2, color: "#abc" },
      { index: 370, cluster: 2, color: "#abc" },
      { index: 420, cluster: 2, color: "#abc" },
      { index: 555, cluster: 2, color: "#abc" },
    ];
    seekSlider.slider.value = 3;

    await seekSlider.onSliderInput({});

    expect(mockScoreDisplay.showCluster).toHaveBeenCalledWith(2, "#abc", 2, 5);
  });

  it("shows the 0-based index for a scored search result while dragging", async () => {
    mockState.searchType = "text";
    mockState.searchResults = [
      { index: 100, score: 0.9 },
      { index: 250, score: 0.8 },
      { index: 370, score: 0.7 },
    ];
    seekSlider.slider.value = 2; // targetIndex 1

    await seekSlider.onSliderInput({});

    expect(mockScoreDisplay.showSearchScore).toHaveBeenCalledWith(0.8, 1, 3);
  });
});

describe("album badge click routing", () => {
  let seekSlider;

  beforeEach(async () => {
    jest.clearAllMocks();
    document.body.innerHTML = `
      <div id="fixedScoreDisplay">
        <div class="album-badge-row">
          <button id="albumReindexBtn"></button>
          <select id="albumBadgeSelect" class="album-select"></select>
        </div>
        <span id="scoreText"><svg class="score-star"></svg> 1/5</span>
      </div>`;
    ({ seekSlider } = await import("../../photomap/frontend/static/javascript/seek-slider.js"));
    seekSlider.scoreDisplayElement = document.getElementById("fixedScoreDisplay");
    seekSlider.toggleSlider = jest.fn();
    seekSlider.addEventListeners();
  });

  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  it("clicking the position text toggles the slider", () => {
    click(document.getElementById("scoreText"));
    expect(seekSlider.toggleSlider).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the album row does not toggle the slider", () => {
    click(document.getElementById("albumReindexBtn"));
    click(document.getElementById("albumBadgeSelect"));
    expect(seekSlider.toggleSlider).not.toHaveBeenCalled();
  });

  it("clicking the bookmark star does not toggle the slider", () => {
    click(document.querySelector(".score-star"));
    expect(seekSlider.toggleSlider).not.toHaveBeenCalled();
  });
});

describe("slider row placement beside the album badge", () => {
  let seekSlider;

  const rect = (left, right) => ({ left, right, top: 0, bottom: 0, width: right - left, height: 0 });

  beforeEach(async () => {
    jest.clearAllMocks();
    document.body.innerHTML = `
      <div id="fixedScoreDisplay"></div>
      <div id="sliderHoverStrip"></div>
      <div id="scoreSliderRow">
        <div id="sliderWithTicksContainer">
          <span id="contextLabel"></span>
          <div id="sliderTicks"></div>
        </div>
      </div>`;
    ({ seekSlider } = await import("../../photomap/frontend/static/javascript/seek-slider.js"));
    seekSlider.scoreDisplayElement = document.getElementById("fixedScoreDisplay");
    seekSlider.scoreSliderRow = document.getElementById("scoreSliderRow");
    seekSlider.hoverStrip = document.getElementById("sliderHoverStrip");
    seekSlider.contextLabel = document.getElementById("contextLabel");
    seekSlider.ticksContainer = document.getElementById("sliderTicks");
    seekSlider.scoreDisplayElement.getBoundingClientRect = () => rect(12, 294);
  });

  it("starts 8px right of the badge when nothing hangs left of the slider", () => {
    seekSlider.updateSliderPosition();
    expect(seekSlider.scoreSliderRow.style.left).toBe("302px");
    expect(seekSlider.hoverStrip.style.left).toBe("302px");
  });

  it("shifts right by however far the context label reaches into the badge", () => {
    seekSlider.contextLabel.textContent = "Date";
    seekSlider.contextLabel.getBoundingClientRect = () => rect(216, 270);
    seekSlider.updateSliderPosition();
    // 302 - 216 = 86px of overhang; the strip keeps the plain base position.
    expect(seekSlider.scoreSliderRow.style.left).toBe("388px");
    expect(seekSlider.hoverStrip.style.left).toBe("302px");
  });

  it("also clears the first tick label, and ignores an empty label", () => {
    seekSlider.contextLabel.textContent = "";
    seekSlider.contextLabel.getBoundingClientRect = () => rect(100, 150);
    seekSlider.ticksContainer.innerHTML = `<div class="slider-tick"><div class="slider-tick-label">08/2004</div></div>`;
    seekSlider.ticksContainer.querySelector(".slider-tick-label").getBoundingClientRect = () => rect(276, 328);
    seekSlider.updateSliderPosition();
    expect(seekSlider.scoreSliderRow.style.left).toBe("328px");
  });

  it("ignores a label hidden by CSS", () => {
    seekSlider.contextLabel.textContent = "Date";
    seekSlider.contextLabel.style.display = "none";
    seekSlider.contextLabel.getBoundingClientRect = () => rect(216, 270);
    seekSlider.updateSliderPosition();
    expect(seekSlider.scoreSliderRow.style.left).toBe("302px");
  });
});
