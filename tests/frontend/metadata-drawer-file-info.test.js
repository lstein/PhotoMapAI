/**
 * @jest-environment jsdom
 */
//
// The drawer's titlebar (issue #432): file name, full path underneath, and the
// "{ }" raw-metadata button. Both views fill it through setDrawerFileInfo, and
// it replaced two older mechanisms that this also pins down as gone: a "Path"
// row spliced into InvokeAI details tables only (as unescaped HTML), and a
// "View Metadata (JSON)" link cloned into the bottom of every details table.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const JS = "../../photomap/frontend/static/javascript";

// The real markup, for the same reason umap-harness.js uses it: metadata-drawer
// wires listeners onto these elements at *module scope*, and a hand-copied
// fixture is the usual way a test stops matching what the app ships. Neither
// template contains Jinja tags, so both can be used verbatim.
const TEMPLATES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "photomap",
  "frontend",
  "templates",
  "modules"
);
const DRAWER_MARKUP =
  readFileSync(path.join(TEMPLATES, "metadata-modal.html"), "utf8") +
  readFileSync(path.join(TEMPLATES, "metadata-drawer.html"), "utf8");

function drawerDom() {
  document.body.innerHTML = DRAWER_MARKUP;
}

// Must be in place before the import below: metadata-drawer.js resolves the
// metadata modal's elements and binds to them as it is evaluated.
drawerDom();

const mockFetchJson = jest.fn();

jest.unstable_mockModule(`${JS}/utils.js`, () => ({
  fetchJson: mockFetchJson,
  showToast: jest.fn(() => ({ dismiss: jest.fn() })),
  isColorLight: jest.fn(() => false),
  makeDraggable: jest.fn(),
}));

const mockState = {
  album: "demo",
  gridViewActive: false,
  single_swiper: null,
  grid_swiper: null,
  searchType: null,
  searchResults: [],
};

jest.unstable_mockModule(`${JS}/state.js`, () => ({
  state: mockState,
  setShowMetadataFields: jest.fn(),
  setInvokeRefTarget: jest.fn(),
}));

const mockSlideState = { searchResults: [], getCurrentSlide: jest.fn(() => ({ globalIndex: 7 })) };

jest.unstable_mockModule(`${JS}/slide-state.js`, () => ({
  slideState: mockSlideState,
  getCurrentSlideIndex: jest.fn(() => 7),
}));

jest.unstable_mockModule(`${JS}/search.js`, () => ({ setSearchResults: jest.fn() }));

jest.unstable_mockModule(`${JS}/bookmarks.js`, () => ({
  bookmarkManager: { isBookmarked: jest.fn(() => false), toggleBookmark: jest.fn() },
}));

const mockScoreDisplay = {
  setToggleBookmarkCallback: jest.fn(),
  setBookmarkStatus: jest.fn(),
  refreshDisplay: jest.fn(),
  showIndex: jest.fn(),
  showSearchScore: jest.fn(),
  showCluster: jest.fn(),
  rerenderClusterLabel: jest.fn(),
};

jest.unstable_mockModule(`${JS}/score-display.js`, () => ({ scoreDisplay: mockScoreDisplay }));

jest.unstable_mockModule(`${JS}/reference-thumbnails.js`, () => ({
  enhanceReferenceImageThumbnails: jest.fn(),
  registerReferenceThumbnailClickHandler: jest.fn(),
}));

const drawer = await import(`${JS}/metadata-drawer.js`);

function slideWith(dataset) {
  const slide = document.createElement("div");
  Object.assign(slide.dataset, { globalIndex: "7", ...dataset });
  return slide;
}

const INVOKE_TABLE = "<table class='invoke-metadata'><tr><th>Seed</th><td>42</td></tr></table>";
const EXIF_TABLE =
  "<div class='exif-metadata'><div><table class='exif-table'><tr><th>Camera</th><td>Nikon</td></tr></table></div></div>";

describe("drawer titlebar file info", () => {
  beforeEach(() => {
    drawerDom();
    mockFetchJson.mockReset();
  });

  it("shows the file name with the full path beneath it", () => {
    drawer.updateMetadataOverlay(
      slideWith({
        filename: "a.jpg",
        filepath: "/photos/2024/a.jpg",
        metadata_url: "get_metadata/demo/7",
        description: EXIF_TABLE,
      })
    );
    expect(document.getElementById("filenameText").textContent).toBe("a.jpg");
    const pathEl = document.getElementById("filepathText");
    expect(pathEl.textContent).toBe("/photos/2024/a.jpg");
    expect(pathEl.title).toBe("/photos/2024/a.jpg");
    expect(document.getElementById("metadataLink").getAttribute("href")).toBe("get_metadata/demo/7");
  });

  it("treats the path as text, not markup", () => {
    drawer.setDrawerFileInfo({ filename: "x.png", filepath: "/tmp/<img src=x onerror=alert(1)>.png" });
    const pathEl = document.getElementById("filepathText");
    expect(pathEl.querySelector("img")).toBeNull();
    expect(pathEl.textContent).toBe("/tmp/<img src=x onerror=alert(1)>.png");
  });

  it("no longer splices a Path row or a metadata link into the details table", () => {
    for (const description of [INVOKE_TABLE, EXIF_TABLE]) {
      drawer.updateMetadataOverlay(
        slideWith({ filename: "a.png", filepath: "/p/a.png", metadata_url: "m", description })
      );
      const details = document.getElementById("descriptionText");
      expect(details.querySelectorAll("tr")).toHaveLength(1);
      expect(details.textContent).not.toContain("/p/a.png");
      expect(details.querySelector(".metadata-link")).toBeNull();
    }
    // Exactly one metadata link in the drawer: the titlebar button.
    expect(document.querySelectorAll("#bannerDrawerContainer .metadata-link")).toHaveLength(1);
  });

  it("clears the path line when the next item has none", () => {
    drawer.setDrawerFileInfo({ filename: "a.png", filepath: "/p/a.png", metadata_url: "m" });
    drawer.setDrawerFileInfo({});
    expect(document.getElementById("filepathText").textContent).toBe("");
    expect(document.getElementById("filenameText").textContent).toBe("");
    expect(document.getElementById("metadataLink").getAttribute("href")).toBe("#");
  });
});
