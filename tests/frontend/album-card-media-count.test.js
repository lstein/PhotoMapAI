/**
 * The album card's index-status line spells out the image/video split that
 * /index_metadata returns, so a file count that grew because videos were
 * indexed explains itself (issue #368).
 *
 * album-manager.js pulls in a large sibling graph whose modules touch the DOM
 * at import time, so the direct imports are mocked and the module under test
 * is loaded dynamically — the same pattern as album-manager-rebuild.test.js.
 */
import { beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";

const M = "../../photomap/frontend/static/javascript";

jest.unstable_mockModule(`${M}/filetree.js`, () => ({
  createSimpleDirectoryPicker: jest.fn(),
}));
jest.unstable_mockModule(`${M}/index.js`, () => ({
  getIndexMetadata: jest.fn(),
  removeIndex: jest.fn(),
  updateIndex: jest.fn(),
}));
jest.unstable_mockModule(`${M}/modal-utils.js`, () => ({
  showConfirmModal: jest.fn(),
}));
jest.unstable_mockModule(`${M}/search-ui.js`, () => ({
  exitSearchMode: jest.fn(),
}));
jest.unstable_mockModule(`${M}/settings.js`, () => ({
  closeSettingsModal: jest.fn(),
  loadAvailableAlbums: jest.fn(),
  openSettingsModal: jest.fn(),
}));
jest.unstable_mockModule(`${M}/state.js`, () => ({
  setAlbum: jest.fn(),
  refreshActiveAlbumSearchSettings: jest.fn(() => Promise.resolve()),
  state: {},
}));
jest.unstable_mockModule(`${M}/utils.js`, () => ({
  fetchJson: jest.fn(() => Promise.resolve({})),
  hideSpinner: jest.fn(),
  showSpinner: jest.fn(),
}));

const { getIndexMetadata } = await import(`${M}/index.js`);

let AlbumManager;
let formatIndexCount;

beforeAll(async () => {
  document.body.innerHTML =
    `<div id="albumManagementOverlay"></div>` +
    ["addAlbumBtn", "cancelAddAlbumBtn", "cancelAddAlbumBtn2", "closeAlbumManagementBtn", "showAddAlbumBtn"]
      .map((id) => `<button id="${id}"></button>`)
      .join("");

  ({ AlbumManager, formatIndexCount } = await import(`${M}/album-manager.js`));
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("formatIndexCount", () => {
  test.each([
    [{ filename_count: 120, image_count: 120, video_count: 0 }, "120 images"],
    [{ filename_count: 0, image_count: 0, video_count: 0 }, "0 images"],
    [{ filename_count: 1, image_count: 1, video_count: 0 }, "1 image"],
    [{ filename_count: 124, image_count: 120, video_count: 4 }, "120 images, 4 videos"],
    [{ filename_count: 2, image_count: 1, video_count: 1 }, "1 image, 1 video"],
    [{ filename_count: 4, image_count: 0, video_count: 4 }, "4 videos"],
    [{ filename_count: 1, image_count: 0, video_count: 1 }, "1 video"],
  ])("%j -> %s", (metadata, expected) => {
    expect(formatIndexCount(metadata)).toBe(expected);
  });

  test("a response without the split fields falls back to the total", () => {
    expect(formatIndexCount({ filename_count: 7 })).toBe("7 images");
  });
});

describe("album card index status", () => {
  function makeCard() {
    const card = document.createElement("div");
    card.innerHTML =
      `<div class="index-status"></div>` +
      `<button class="create-index-btn"></button>` +
      `<button class="rebuild-index-btn" style="display: none"></button>`;
    return card;
  }

  const self = () => ({
    setRebuildButtonVisible: AlbumManager.prototype.setRebuildButtonVisible,
    _appendIndexWarningNote: jest.fn(),
  });

  test("shows the image/video split once videos are indexed", async () => {
    const card = makeCard();
    getIndexMetadata.mockResolvedValue({
      last_modified: 1_700_000_000,
      filename_count: 124,
      image_count: 120,
      video_count: 4,
    });

    await AlbumManager.prototype.updateAlbumCardIndexStatus.call(self(), card, { key: "album1" });

    expect(card.querySelector(".index-status").textContent).toMatch(/\(120 images, 4 videos\)$/);
  });

  test("image-only albums keep the single count", async () => {
    const card = makeCard();
    getIndexMetadata.mockResolvedValue({
      last_modified: 1_700_000_000,
      filename_count: 7,
      image_count: 7,
      video_count: 0,
    });

    await AlbumManager.prototype.updateAlbumCardIndexStatus.call(self(), card, { key: "album1" });

    expect(card.querySelector(".index-status").textContent).toMatch(/\(7 images\)$/);
  });
});
