// In the phone layout the metadata drawer's contents are the bottom sheet's
// details stop, so the drawer's open/close entry points (the i, arrow and
// Escape shortcuts, and the swipe up on the photo) move the sheet instead.
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

let mobile = true;
let bottomState = "expanded";
const setSheetState = jest.fn((name, value) => {
  bottomState = value;
});
const closeSheetDetails = jest.fn(() => {
  if (bottomState === "details") {
    bottomState = "expanded";
  }
});

jest.unstable_mockModule("../../photomap/frontend/static/javascript/mobile-sheets.js", () => ({
  isMobileSheetsMode: () => mobile,
  isTopSheetMode: () => mobile,
  setSheetState,
  closeSheetDetails,
  sheetState: () => bottomState,
  sheetVisibleHeight: () => 0,
  SHEET_DETAILS: "details",
  SHEET_EXPANDED: "expanded",
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/score-display.js", () => ({
  scoreDisplay: { setToggleBookmarkCallback: jest.fn(), setBookmarkStatus: jest.fn(), refreshDisplay: jest.fn() },
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/bookmarks.js", () => ({
  bookmarkManager: { isBookmarked: jest.fn(() => false) },
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
  slideState: { getCurrentSlide: jest.fn(() => null) },
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: { showMetadataFields: false },
  setShowMetadataFields: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/search.js", () => ({
  setSearchResults: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
  isColorLight: jest.fn(() => false),
  makeDraggable: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/cluster-utils.js", () => ({
  getClusterColorFromPoints: jest.fn(),
  getClusterInfoForImage: jest.fn(),
  getClusterLabelInfo: jest.fn(),
  getImageLabelInfo: jest.fn(),
  SHOW_CLUSTER_LABELS_IN_BADGES: false,
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/invoke-ref-target.js", () => ({
  applyRefTarget: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/reference-thumbnails.js", () => ({
  enhanceReferenceImageThumbnails: jest.fn(),
  registerReferenceThumbnailClickHandler: jest.fn(),
}));

document.body.innerHTML = `
  <div id="bannerDrawerContainer"><div class="drawer-handle"></div><div id="filenameBanner"></div></div>
  <div id="metadataModal"><textarea id="metadataTextArea"></textarea><button id="closeMetadataModalBtn"></button></div>
`;

const { showMetadataOverlay, hideMetadataOverlay, toggleMetadataOverlay } =
  await import("../../photomap/frontend/static/javascript/metadata-drawer.js");

const drawer = () => document.getElementById("bannerDrawerContainer");

describe("metadata drawer in the phone layout", () => {
  beforeEach(() => {
    mobile = true;
    bottomState = "expanded";
    setSheetState.mockClear();
    closeSheetDetails.mockClear();
    drawer().classList.remove("visible");
  });

  it("opens the sheet's details instead of the drawer", () => {
    showMetadataOverlay();
    expect(setSheetState).toHaveBeenCalledWith("bottom", "details");
    expect(drawer().classList.contains("visible")).toBe(false);
  });

  it("closes them back to the stop they came from", () => {
    bottomState = "details";
    hideMetadataOverlay();
    expect(closeSheetDetails).toHaveBeenCalled();
    expect(bottomState).toBe("expanded");
  });

  it("leaves a collapsed sheet collapsed when asked to close", () => {
    bottomState = "collapsed";
    hideMetadataOverlay();
    expect(bottomState).toBe("collapsed");
    expect(setSheetState).not.toHaveBeenCalled();
  });

  it("toggles on the sheet's stop", () => {
    toggleMetadataOverlay();
    expect(bottomState).toBe("details");
    toggleMetadataOverlay();
    expect(bottomState).toBe("expanded");
  });

  it("still slides the drawer outside the phone layout", () => {
    mobile = false;
    toggleMetadataOverlay();
    expect(drawer().classList.contains("visible")).toBe(true);
    toggleMetadataOverlay();
    expect(drawer().classList.contains("visible")).toBe(false);
    expect(setSheetState).not.toHaveBeenCalled();
    expect(closeSheetDetails).not.toHaveBeenCalled();
  });
});
