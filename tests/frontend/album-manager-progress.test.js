/**
 * Tests for AlbumManager.updateProgressStatus, focused on the model-download
 * phase added so first-install encoder downloads are surfaced on the album card,
 * and for handleIndexingCompletion's in-place refresh events.
 *
 * album-manager.js pulls in a large sibling graph (index.js -> umap.js, etc.)
 * whose modules touch the DOM at import time, so we mock the direct imports and
 * dynamically load the module under test — the same pattern used by
 * seek-search-rebuild.test.js.
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
  state: {},
}));
jest.unstable_mockModule(`${M}/utils.js`, () => ({
  fetchJson: jest.fn(() => Promise.resolve({})),
  hideSpinner: jest.fn(),
  showSpinner: jest.fn(),
}));

const { getIndexMetadata } = await import(`${M}/index.js`);
const { state } = await import(`${M}/state.js`);

let AlbumManager;

beforeAll(async () => {
  // album-manager.js instantiates `new AlbumManager()` at module load, and its
  // constructor wires click handlers on these buttons without null-guards, so
  // they must exist before import or the module eval throws.
  document.body.innerHTML =
    `<div id="albumManagementOverlay"></div>` +
    ["addAlbumBtn", "cancelAddAlbumBtn", "cancelAddAlbumBtn2", "closeAlbumManagementBtn", "showAddAlbumBtn"]
      .map((id) => `<button id="${id}"></button>`)
      .join("");

  ({ AlbumManager } = await import(`${M}/album-manager.js`));
});

function makeElements() {
  const status = document.createElement("span");
  status.className = "index-status";
  const estimatedTime = document.createElement("div");
  estimatedTime.className = "estimated-time";
  return { status, estimatedTime };
}

// updateProgressStatus only reads AlbumManager.STATUS_CLASSES (static) and the
// DOM nodes it's handed, so we can exercise it without a constructed instance.
function callUpdate(status, progress, estimatedTime) {
  AlbumManager.prototype.updateProgressStatus.call({}, status, progress, estimatedTime);
}

describe("AlbumManager downloading phase", () => {
  test("renders a downloading status with the encoder-model message", () => {
    const { status, estimatedTime } = makeElements();
    estimatedTime.textContent = "Estimated time remaining: 30s";

    callUpdate(
      status,
      {
        status: "downloading",
        current_step: "Downloading encoder model…",
        images_processed: 1024,
        total_images: 4096,
      },
      estimatedTime
    );

    expect(status.textContent).toBe("Downloading encoder model…");
    expect(status.className).toBe(AlbumManager.STATUS_CLASSES.DOWNLOADING);
    // ETA stays visible for the download (handled in updateProgress, not cleared here).
    expect(estimatedTime.textContent).toBe("Estimated time remaining: 30s");
  });

  test("falls back to a default label when current_step is missing", () => {
    const { status, estimatedTime } = makeElements();

    callUpdate(status, { status: "downloading", current_step: "" }, estimatedTime);

    expect(status.textContent).toBe("Downloading encoder model…");
  });

  test("does not render byte counts like the default indexing branch", () => {
    const { status, estimatedTime } = makeElements();

    callUpdate(
      status,
      { status: "downloading", current_step: "Downloading encoder model…", images_processed: 1024, total_images: 4096 },
      estimatedTime
    );

    // The default (indexing) branch would show "(1024/4096)"; downloading must not.
    expect(status.textContent).not.toContain("(1024/4096)");
  });
});

describe("AlbumManager completed status", () => {
  test("shows a plain success message when there is no warning", () => {
    const { status, estimatedTime } = makeElements();

    callUpdate(status, { status: "completed" }, estimatedTime);

    expect(status.textContent).toBe("Indexing completed successfully");
    expect(status.className).toBe(AlbumManager.STATUS_CLASSES.COMPLETED);
    expect(status.style.color).toBe("green");
  });

  test("surfaces a non-fatal warning_message alongside completion", () => {
    const { status, estimatedTime } = makeElements();

    callUpdate(
      status,
      {
        status: "completed",
        warning_message: "2 of 242 image(s) listed by InvokeAI were not found on disk and were skipped.",
      },
      estimatedTime
    );

    expect(status.textContent).toContain("Indexing completed");
    expect(status.textContent).toContain("not found on disk");
    expect(status.className).toBe(AlbumManager.STATUS_CLASSES.COMPLETED);
    // Completion-with-a-caveat is coloured differently from a clean success.
    expect(status.style.color).not.toBe("green");
  });
});

describe("AlbumManager persistent index warning note", () => {
  test("appends a note element when a warning is stored for the album", () => {
    const manager = { indexWarnings: new Map([["alb", "2 images skipped"]]) };
    const status = document.createElement("span");

    AlbumManager.prototype._appendIndexWarningNote.call(manager, status, "alb");

    const note = status.querySelector(".index-status-warning");
    expect(note).not.toBeNull();
    expect(note.textContent).toBe("2 images skipped");
  });

  test("does nothing when no warning is stored", () => {
    const manager = { indexWarnings: new Map() };
    const status = document.createElement("span");

    AlbumManager.prototype._appendIndexWarningNote.call(manager, status, "alb");

    expect(status.querySelector(".index-status-warning")).toBeNull();
  });
});

describe("AlbumManager handleIndexingCompletion refresh events", () => {
  // Minimal instance: no card element, not in setup mode.
  function makeManager() {
    return {
      showIndexingCompletedUI: jest.fn(),
      isSetupMode: false,
      autoIndexingAlbums: new Set(["alb"]),
    };
  }

  let albumChangedEvents;
  let indexUpdatedEvents;
  const onAlbumChanged = (e) => albumChangedEvents.push(e.detail);
  const onIndexUpdated = (e) => indexUpdatedEvents.push(e.detail);

  beforeEach(() => {
    albumChangedEvents = [];
    indexUpdatedEvents = [];
    getIndexMetadata.mockReset();
    getIndexMetadata.mockResolvedValue({ filename_count: 7 });
    window.addEventListener("albumChanged", onAlbumChanged);
    window.addEventListener("albumIndexUpdated", onIndexUpdated);
  });

  afterEach(() => {
    window.removeEventListener("albumChanged", onAlbumChanged);
    window.removeEventListener("albumIndexUpdated", onIndexUpdated);
  });

  test("current album: fires albumIndexUpdated plus an in-place albumChanged refresh", async () => {
    state.album = "alb";

    await AlbumManager.prototype.handleIndexingCompletion.call(makeManager(), "alb", null);

    expect(indexUpdatedEvents).toEqual([{ albumKey: "alb" }]);
    expect(albumChangedEvents).toEqual([{ album: "alb", totalImages: 7, changeType: "refresh" }]);
  });

  test("other album: no refresh events for the one being browsed", async () => {
    state.album = "alb";

    await AlbumManager.prototype.handleIndexingCompletion.call(makeManager(), "other", null);

    expect(indexUpdatedEvents).toEqual([]);
    expect(albumChangedEvents).toEqual([]);
  });
});
