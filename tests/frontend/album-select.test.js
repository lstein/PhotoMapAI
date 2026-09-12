/**
 * Tests for album-select.js: the album pulldowns in the semantic-map titlebar
 * and the album badge. Both are populated from one list, a change on either
 * switches the album, and they follow albumChanged / albumListChanged.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const M = "../../photomap/frontend/static/javascript";

const ALBUMS = [
  { key: "a", name: "Album A" },
  { key: "b", name: "Album B" },
];

jest.unstable_mockModule(`${M}/album-manager.js`, () => ({
  albumManager: { fetchAvailableAlbums: jest.fn() },
}));
jest.unstable_mockModule(`${M}/settings.js`, () => ({
  switchAlbum: jest.fn(),
}));
jest.unstable_mockModule(`${M}/state.js`, () => ({
  state: { album: "a" },
}));

const { albumManager } = await import(`${M}/album-manager.js`);
const { switchAlbum } = await import(`${M}/settings.js`);
const { state } = await import(`${M}/state.js`);
const { initAlbumSelects, populateAlbumSelects } = await import(`${M}/album-select.js`);

function buildDom({ locked = false } = {}) {
  document.body.innerHTML = `
    <div id="umapTitlebar">
      <select id="semanticMapAlbumSelect" class="album-select"></select>
    </div>
    <div id="fixedScoreDisplay">
      <div class="album-badge-row">
        ${
          locked
            ? '<span id="albumBadgeName" class="album-select-static"></span>'
            : '<select id="albumBadgeSelect" class="album-select"></select>'
        }
      </div>
      <span id="scoreText"></span>
    </div>`;
}

const options = (id) => Array.from(document.getElementById(id).options).map((o) => [o.value, o.textContent]);

beforeEach(() => {
  buildDom();
  jest.clearAllMocks();
  albumManager.fetchAvailableAlbums.mockResolvedValue(ALBUMS);
  state.album = "a";
  // Run the deferred scoreDisplayContentChanged dispatch synchronously.
  window.requestAnimationFrame = (cb) => cb();
});

describe("populateAlbumSelects", () => {
  test("fills every select from the fetched list and selects the current album", async () => {
    await populateAlbumSelects();
    expect(albumManager.fetchAvailableAlbums).toHaveBeenCalledTimes(1);
    for (const id of ["semanticMapAlbumSelect", "albumBadgeSelect"]) {
      expect(options(id)).toEqual([
        ["a", "Album A"],
        ["b", "Album B"],
      ]);
      expect(document.getElementById(id).value).toBe("a");
    }
  });

  test("uses a supplied list without fetching", async () => {
    await populateAlbumSelects([{ key: "z", name: "Zed" }]);
    expect(albumManager.fetchAvailableAlbums).not.toHaveBeenCalled();
    expect(options("albumBadgeSelect")).toEqual([["z", "Zed"]]);
  });

  test("shows a disabled placeholder when there are no albums", async () => {
    await populateAlbumSelects([]);
    const [only] = document.getElementById("albumBadgeSelect").options;
    expect(only.disabled).toBe(true);
    expect(only.value).toBe("");
  });

  test("tells the seek slider the badge content changed", async () => {
    const seen = jest.fn();
    window.addEventListener("scoreDisplayContentChanged", seen);
    try {
      await populateAlbumSelects(ALBUMS);
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("scoreDisplayContentChanged", seen);
    }
  });

  test("locked single album: the badge shows the album name as text", async () => {
    buildDom({ locked: true });
    await populateAlbumSelects(ALBUMS);
    expect(document.getElementById("albumBadgeName").textContent).toBe("Album A");
    // The titlebar select is still populated.
    expect(document.getElementById("semanticMapAlbumSelect").value).toBe("a");
  });
});

describe("initAlbumSelects", () => {
  test("a change on the badge select switches the album", async () => {
    await populateAlbumSelects(ALBUMS);
    initAlbumSelects();
    const badge = document.getElementById("albumBadgeSelect");
    badge.value = "b";
    badge.dispatchEvent(new Event("change"));
    expect(switchAlbum).toHaveBeenCalledWith("b");
  });

  test("re-selecting the current album is a no-op", async () => {
    await populateAlbumSelects(ALBUMS);
    initAlbumSelects();
    const titlebar = document.getElementById("semanticMapAlbumSelect");
    titlebar.value = "a";
    titlebar.dispatchEvent(new Event("change"));
    expect(switchAlbum).not.toHaveBeenCalled();
  });

  test("pointer-down on the select does not reach the container, but a click still reaches document", async () => {
    initAlbumSelects();
    const titlebarDown = jest.fn();
    document.getElementById("umapTitlebar").addEventListener("mousedown", titlebarDown);
    const docClicks = jest.fn();
    document.addEventListener("click", docClicks);
    try {
      const select = document.getElementById("albumBadgeSelect");
      document.getElementById("semanticMapAlbumSelect").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      select.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(titlebarDown).not.toHaveBeenCalled();
      // Menus close on a document click; the select must not swallow it.
      expect(docClicks).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("click", docClicks);
    }
  });

  test("the select gives up focus after a change so keyboard shortcuts work again", async () => {
    await populateAlbumSelects(ALBUMS);
    initAlbumSelects();
    const badge = document.getElementById("albumBadgeSelect");
    badge.focus();
    expect(document.activeElement).toBe(badge);
    badge.value = "b";
    badge.dispatchEvent(new Event("change"));
    expect(document.activeElement).not.toBe(badge);
  });

  test("a current album that is not in the list falls back to the first option instead of a blank select", async () => {
    state.album = "gone";
    await populateAlbumSelects([]);
    expect(document.getElementById("albumBadgeSelect").selectedIndex).toBe(0);
    await populateAlbumSelects(ALBUMS);
    expect(document.getElementById("albumBadgeSelect").selectedIndex).toBe(0);
    expect(document.getElementById("albumBadgeSelect").value).toBe("a");
  });

  test("albumChanged re-selects the new album on every select without refetching", async () => {
    await populateAlbumSelects(ALBUMS);
    initAlbumSelects();
    albumManager.fetchAvailableAlbums.mockClear();
    state.album = "b";
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: "b", totalImages: 1 } }));
    expect(document.getElementById("albumBadgeSelect").value).toBe("b");
    expect(document.getElementById("semanticMapAlbumSelect").value).toBe("b");
    expect(albumManager.fetchAvailableAlbums).not.toHaveBeenCalled();
  });

  test("albumListChanged rebuilds the options from the event's list", async () => {
    await populateAlbumSelects(ALBUMS);
    initAlbumSelects();
    albumManager.fetchAvailableAlbums.mockClear();
    const renamed = [
      { key: "a", name: "Album A (renamed)" },
      { key: "b", name: "Album B" },
      { key: "c", name: "Album C" },
    ];
    window.dispatchEvent(new CustomEvent("albumListChanged", { detail: { albums: renamed } }));
    await Promise.resolve();
    expect(options("albumBadgeSelect")).toEqual([
      ["a", "Album A (renamed)"],
      ["b", "Album B"],
      ["c", "Album C"],
    ]);
    expect(document.getElementById("albumBadgeSelect").value).toBe("a");
    expect(albumManager.fetchAvailableAlbums).not.toHaveBeenCalled();
  });
});
