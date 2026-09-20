/**
 * Rebuild Index: the confirmation gate, the remove-then-update sequence, and
 * when the button is offered at all.
 *
 * Rebuild exists because Update Index cannot do this job. An update is a set
 * difference on paths — it adds files that appeared and drops files that
 * vanished, and never re-reads a file already in the index — so anything
 * derived at index time stays as first recorded until the index is discarded.
 * That is why the destructive path is a separate, confirmed, red button
 * rather than a flag on the existing one, and why these tests care about the
 * *order* of removal and re-index rather than only that both happened.
 *
 * album-manager.js pulls in a large sibling graph whose modules touch the DOM
 * at import time, so the direct imports are mocked and the module under test
 * is loaded dynamically — the same pattern as album-manager-progress.test.js.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";

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
const { showConfirmModal } = await import(`${M}/modal-utils.js`);

let AlbumManager;

beforeAll(async () => {
  document.body.innerHTML =
    `<div id="albumManagementOverlay"></div>` +
    ["addAlbumBtn", "cancelAddAlbumBtn", "cancelAddAlbumBtn2", "closeAlbumManagementBtn", "showAddAlbumBtn"]
      .map((id) => `<button id="${id}"></button>`)
      .join("");

  ({ AlbumManager } = await import(`${M}/album-manager.js`));
});

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.clearAllMocks();
});

/** A card carrying the nodes these methods touch. */
function makeCard() {
  const card = document.createElement("div");
  card.innerHTML =
    `<div class="index-status"></div>` +
    `<button class="create-index-btn"></button>` +
    `<button class="cancel-index-btn"></button>` +
    `<button class="rebuild-index-btn" style="display: none"></button>` +
    `<div class="progress-container"></div>`;
  return card;
}

const rebuildBtn = (card) => card.querySelector(".rebuild-index-btn");

describe("the confirmation gate", () => {
  test("asks before destroying anything, with the agreed wording", async () => {
    const card = makeCard();
    const self = { startIndexing: jest.fn() };
    showConfirmModal.mockResolvedValue(false);

    await AlbumManager.prototype.rebuildIndex.call(self, "album1", card);

    expect(showConfirmModal).toHaveBeenCalledWith(
      "This will delete your previous index and rebuild it from scratch. Proceed?",
      "Yes",
      "Cancel"
    );
  });

  test("cancelling touches nothing", async () => {
    const card = makeCard();
    const self = { startIndexing: jest.fn() };
    showConfirmModal.mockResolvedValue(false);

    await AlbumManager.prototype.rebuildIndex.call(self, "album1", card);

    expect(self.startIndexing).not.toHaveBeenCalled();
  });

  test("confirming re-indexes with the remove-first flag set", async () => {
    const card = makeCard();
    const self = { startIndexing: jest.fn(), _liveCardFor: (_key, fallback) => fallback };
    showConfirmModal.mockResolvedValue(true);

    await AlbumManager.prototype.rebuildIndex.call(self, "album1", card);

    expect(self.startIndexing).toHaveBeenCalledWith("album1", card, true);
  });

  test("uses the album's live card, not the one captured before the prompt", async () => {
    // The confirmation is an await of unbounded length, and loadAlbums()
    // rebuilds the card list wholesale, so the element captured when the
    // button was clicked can be detached by the time the user answers.
    // Progress painted onto a detached node leaves the visible card frozen.
    const stale = makeCard();
    const live = makeCard();
    const self = {
      startIndexing: jest.fn(),
      _liveCardFor: jest.fn(() => live),
    };
    showConfirmModal.mockResolvedValue(true);

    await AlbumManager.prototype.rebuildIndex.call(self, "album1", stale);

    expect(self._liveCardFor).toHaveBeenCalledWith("album1", stale);
    expect(self.startIndexing).toHaveBeenCalledWith("album1", live, true);
  });
});

describe("when the button is offered", () => {
  function statusSelf(card) {
    return {
      setRebuildButtonVisible: AlbumManager.prototype.setRebuildButtonVisible,
      _appendIndexWarningNote: jest.fn(),
      _card: card,
    };
  }

  test("hidden when the album has no index — there is nothing to rebuild", async () => {
    const card = makeCard();
    rebuildBtn(card).style.display = "inline-block";
    getIndexMetadata.mockResolvedValue(null);

    await AlbumManager.prototype.updateAlbumCardIndexStatus.call(statusSelf(card), card, {
      key: "album1",
    });

    expect(rebuildBtn(card).style.display).toBe("none");
  });

  test("shown once an index exists", async () => {
    const card = makeCard();
    getIndexMetadata.mockResolvedValue({ last_modified: 1_700_000_000, filename_count: 7 });

    await AlbumManager.prototype.updateAlbumCardIndexStatus.call(statusSelf(card), card, {
      key: "album1",
    });

    expect(rebuildBtn(card).style.display).toBe("inline-block");
  });

  test("hidden when the index metadata lookup fails", async () => {
    const card = makeCard();
    rebuildBtn(card).style.display = "inline-block";
    getIndexMetadata.mockRejectedValue(new Error("boom"));

    await AlbumManager.prototype.updateAlbumCardIndexStatus.call(statusSelf(card), card, {
      key: "album1",
    });

    expect(rebuildBtn(card).style.display).toBe("none");
  });

  test("hidden while an index is being built", () => {
    const card = makeCard();
    rebuildBtn(card).style.display = "inline-block";
    const self = {
      setRebuildButtonVisible: AlbumManager.prototype.setRebuildButtonVisible,
      updateProgress: jest.fn(),
    };

    AlbumManager.prototype.showProgressUIWithoutScroll.call(self, card, null);

    // A second rebuild mid-run would delete the index the running job is
    // about to write.
    expect(rebuildBtn(card).style.display).toBe("none");
  });

  test("offered again once indexing completes", () => {
    const card = makeCard();
    const self = { setRebuildButtonVisible: AlbumManager.prototype.setRebuildButtonVisible };

    AlbumManager.prototype.showIndexingCompletedUI.call(self, card);

    expect(rebuildBtn(card).style.display).toBe("inline-block");
  });

  test("tolerates a card rendered before the button existed", () => {
    const card = makeCard();
    rebuildBtn(card).remove();

    expect(() => AlbumManager.prototype.setRebuildButtonVisible.call({}, card, true)).not.toThrow();
  });
});

describe("the remove-then-update sequence", () => {
  function indexingSelf() {
    return {
      progressPollers: new Map(),
      showProgressUIWithoutScroll: jest.fn(),
      startProgressPolling: jest.fn(),
      handleIndexingCompletion: jest.fn(),
      getAlbum: jest.fn(() => Promise.resolve({ index: "/tmp/embeddings.npz" })),
    };
  }

  test("the old index is removed before the new one is built", async () => {
    const { removeIndex, updateIndex } = await import(`${M}/index.js`);
    const calls = [];
    removeIndex.mockImplementation(() => {
      calls.push("remove");
      return Promise.resolve({ success: true });
    });
    updateIndex.mockImplementation(() => {
      calls.push("update");
      return Promise.resolve({ status: "scanning" });
    });

    await AlbumManager.prototype.startIndexing.call(indexingSelf(), "album1", makeCard(), true);

    // Order is the whole point: updating first would index against the very
    // records the rebuild exists to discard.
    expect(calls).toEqual(["remove", "update"]);
  });

  test("a plain update never removes the index", async () => {
    const { removeIndex, updateIndex } = await import(`${M}/index.js`);
    updateIndex.mockResolvedValue({ status: "scanning" });

    await AlbumManager.prototype.startIndexing.call(indexingSelf(), "album1", makeCard(), false);

    expect(removeIndex).not.toHaveBeenCalled();
    expect(updateIndex).toHaveBeenCalledWith("album1");
  });

  test("a failed removal does not go on to re-index", async () => {
    const { removeIndex, updateIndex } = await import(`${M}/index.js`);
    removeIndex.mockResolvedValue({ success: false });
    updateIndex.mockResolvedValue({ status: "scanning" });
    jest.spyOn(window, "alert").mockImplementation(() => {});

    await AlbumManager.prototype.startIndexing.call(indexingSelf(), "album1", makeCard(), true);

    // Otherwise the card would sit in "indexing" over an index that is still
    // the old one.
    expect(updateIndex).not.toHaveBeenCalled();
    window.alert.mockRestore();
  });
});

describe("the confirmation dialog stacks above the album manager", () => {
  // jsdom does no layout and no cascade, so the bug this guards against is
  // invisible to every other test here: the dialog was painted but sat
  // *behind* the Album Management overlay, leaving its buttons unclickable
  // and the flow dead. Asserting the declared z-indexes is crude, but it is
  // the part that actually broke, and it is checkable without a browser.
  const CSS = "../../photomap/frontend/static/css";

  async function zIndexOf(file, selector) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(new URL(`${CSS}/${file}`, import.meta.url));
    const text = await readFile(path, "utf8");
    const block = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(text);
    expect(block).not.toBeNull();
    const z = /z-index:\s*(\d+)/.exec(block[1]);
    expect(z).not.toBeNull();
    return Number(z[1]);
  }

  test("#confirmModal outranks .modal-overlay", async () => {
    const confirmZ = await zIndexOf("delete-modal.css", "#confirmModal\\.modal");
    const overlayZ = await zIndexOf("modal-base.css", "\\.modal-overlay");

    expect(confirmZ).toBeGreaterThan(overlayZ);
  });
});
