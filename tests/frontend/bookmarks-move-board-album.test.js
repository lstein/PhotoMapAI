// An InvokeAI-board album's directories are derived from the InvokeAI root, so
// the "the destination is not in this album — add it?" offer cannot be honored
// for one: the backend refuses the change, and before it did, the partial
// update silently demoted the album to a directory album (issue #371).
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockFetchJson = jest.fn();
const mockShowConfirmModal = jest.fn();

jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
  errorDetail: jest.fn(),
  fetchJson: mockFetchJson,
  hideSpinner: jest.fn(),
  setCheckmarkOnIcon: jest.fn(),
  showSpinner: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/control-panel.js", () => ({
  showDeleteConfirmModal: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/filetree.js", () => ({
  createSimpleDirectoryPicker: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/index.js", () => ({
  deleteImages: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/modal-utils.js", () => ({
  showConfirmModal: mockShowConfirmModal,
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/search.js", () => ({
  setSearchResults: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
  slideState: { getCurrentSlide: () => ({ globalIndex: 0 }), totalAlbumImages: 0 },
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: { album: "board", swiper: null, single_swiper: null },
  saveSettingsToLocalStorage: jest.fn(),
}));

const { bookmarkManager } = await import("../../photomap/frontend/static/javascript/bookmarks.js");

/** Route fetchJson by URL: album config, then the move itself. */
function routeFetch(albumConfig, moveResult) {
  mockFetchJson.mockImplementation((url) => {
    if (url.startsWith("album/")) {
      return Promise.resolve(albumConfig);
    }
    if (url.startsWith("move_images/")) {
      return moveResult();
    }
    return Promise.resolve({});
  });
}

const BOARD_ALBUM = {
  key: "board",
  name: "Board",
  source_type: "invokeai_board",
  image_paths: ["/srv/invokeai/outputs/images"],
  index: "/data/board/embeddings.npz",
};

const DIRECTORY_ALBUM = {
  key: "dir",
  name: "Dir",
  source_type: "directory",
  image_paths: ["/photos"],
  index: "/photos/photomap_index/embeddings.npz",
};

beforeEach(() => {
  mockFetchJson.mockReset();
  mockShowConfirmModal.mockReset();
  global.alert = jest.fn();
});

describe("performMove on an InvokeAI-board album", () => {
  it("does not offer to add the destination folder to the album", async () => {
    routeFetch(BOARD_ALBUM, () => Promise.reject(new Error("Moving images is not supported")));

    await bookmarkManager.performMove([0], "/somewhere/else");

    expect(mockShowConfirmModal).not.toHaveBeenCalled();
    const updateCalls = mockFetchJson.mock.calls.filter(([url]) => url === "update_album/");
    expect(updateCalls).toHaveLength(0);
  });

  it("still offers for a directory album", async () => {
    routeFetch(DIRECTORY_ALBUM, () => Promise.resolve({ moved_count: 1, same_folder_count: 0, error_count: 0 }));
    mockShowConfirmModal.mockResolvedValue(false);

    await bookmarkManager.performMove([0], "/somewhere/else");

    expect(mockShowConfirmModal).toHaveBeenCalled();
  });
});

describe("addFolderToAlbum", () => {
  it("sends only the fields it is changing, so the rest survive the patch", async () => {
    mockFetchJson.mockResolvedValue({});

    await bookmarkManager.addFolderToAlbum("/extra", DIRECTORY_ALBUM);

    const [url, options] = mockFetchJson.mock.calls[0];
    expect(url).toBe("update_album/");
    expect(options.json).toEqual({
      key: "dir",
      name: "Dir",
      image_paths: ["/photos", "/extra"],
    });
  });
});
