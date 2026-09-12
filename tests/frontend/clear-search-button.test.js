// The Clear button is always present in the Search panel and toggles its
// disabled state instead of being shown/hidden, so the panel's width does not
// change when a search starts or ends.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const JS = "../../photomap/frontend/static/javascript";

// search-ui.js pulls in most of the app at import time; none of it matters for
// updateSearchCheckmarks beyond setCheckmarkOnIcon, so stub the rest out.
jest.unstable_mockModule(`${JS}/search.js`, () => ({
  searchImage: jest.fn(),
  searchTextAndImage: jest.fn(),
  setSearchResults: jest.fn(),
}));
jest.unstable_mockModule(`${JS}/slide-state.js`, () => ({ slideState: {} }));
jest.unstable_mockModule(`${JS}/state.js`, () => ({
  persistCurrentAlbumSearchSettings: jest.fn(),
  setMaxSearchResults: jest.fn(),
  setMinSearchScore: jest.fn(),
  setUseQueryOptimization: jest.fn(),
  state: {},
}));
jest.unstable_mockModule(`${JS}/utils.js`, () => ({
  hideSpinner: jest.fn(),
  setCheckmarkOnIcon: jest.fn(),
  showSpinner: jest.fn(),
}));
jest.unstable_mockModule(`${JS}/weight-slider.js`, () => ({
  WeightSlider: class {},
}));
jest.unstable_mockModule(`${JS}/umap.js`, () => ({ hideCurrentImageMarker: jest.fn() }));
jest.unstable_mockModule(`${JS}/curation.js`, () => ({ clearCurationData: jest.fn() }));

const { updateSearchCheckmarks } = await import(`${JS}/search-ui.js`);

const clearBtn = () => document.getElementById("clearSearchBtn");

describe("the Clear button's enabled state", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="searchPanel">
        <button id="showUmapBtn"></button>
        <span id="imageSearchIcon"></span>
        <span id="textSearchIcon"></span>
        <button id="bookmarkMenuBtn"></button>
        <div class="search-icon-container clear-search-container">
          <button id="clearSearchBtn" title="Clear Search" disabled></button>
          <div class="button-label">Clear</div>
        </div>
      </div>`;
  });

  it.each(["cluster", "image", "text", "text_and_image", "bookmarks", "curation"])(
    "enables Clear while a %s search is active",
    (searchType) => {
      updateSearchCheckmarks(searchType);
      expect(clearBtn().disabled).toBe(false);
    }
  );

  it("disables Clear when no search is active", () => {
    updateSearchCheckmarks("text");
    updateSearchCheckmarks(null);
    expect(clearBtn().disabled).toBe(true);
  });

  it("disables Clear when the search was explicitly cleared", () => {
    // exitSearchMode() passes "clear", which is not a key in the icon map.
    updateSearchCheckmarks("text");
    updateSearchCheckmarks("clear");
    expect(clearBtn().disabled).toBe(true);
  });

  it("never hides the button, in either state", () => {
    updateSearchCheckmarks("text");
    expect(clearBtn().style.display).toBe("");
    updateSearchCheckmarks(null);
    expect(clearBtn().style.display).toBe("");
  });
});

describe("the shipped Clear button markup", () => {
  const TEMPLATE = readFileSync(
    fileURLToPath(new URL("../../photomap/frontend/templates/modules/search-panel.html", import.meta.url)),
    "utf8"
  );

  it("renders the button disabled rather than hidden", () => {
    const button = TEMPLATE.slice(TEMPLATE.indexOf('id="clearSearchBtn"'));
    expect(button.slice(0, button.indexOf(">"))).toContain("disabled");
    expect(TEMPLATE).not.toContain('id="clearSearchBtn" title="Clear Search" style="display: none"');
  });
});
