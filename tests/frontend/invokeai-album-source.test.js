/**
 * Tests for the InvokeAI board-album source: the invokeai-album-source.js
 * helpers plus the AlbumManager form paths that build add/update payloads.
 *
 * album-manager.js pulls in a large sibling graph whose modules touch the DOM
 * at import time, so the direct imports are mocked and the modules under test
 * are loaded dynamically — the same pattern as album-manager-progress.test.js.
 */
import { beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";

const M = "../../photomap/frontend/static/javascript";

const fetchJson = jest.fn();

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
  fetchJson,
  hideSpinner: jest.fn(),
  showSpinner: jest.fn(),
}));

let AlbumManager;
let probeInvokeAI;
let fetchInvokeAIBoards;
let renderBoardChecklist;
let collectSelectedBoardIds;

beforeAll(async () => {
  // album-manager.js instantiates `new AlbumManager()` at module load and
  // wires click handlers on these buttons without null-guards.
  document.body.innerHTML =
    `<div id="albumManagementOverlay"></div>` +
    ["addAlbumBtn", "cancelAddAlbumBtn", "cancelAddAlbumBtn2", "closeAlbumManagementBtn", "showAddAlbumBtn"]
      .map((id) => `<button id="${id}"></button>`)
      .join("");

  ({ probeInvokeAI, fetchInvokeAIBoards, renderBoardChecklist, collectSelectedBoardIds } = await import(
    `${M}/invokeai-album-source.js`
  ));
  ({ AlbumManager } = await import(`${M}/album-manager.js`));
});

beforeEach(() => {
  fetchJson.mockReset();
});

describe("invokeai-album-source helpers", () => {
  test("probeInvokeAI posts the explicit URL", async () => {
    fetchJson.mockResolvedValue({ reachable: true, version: "5.1.0" });
    const result = await probeInvokeAI("http://elsewhere:9090");
    expect(fetchJson).toHaveBeenCalledWith("invokeai/probe_status", {
      json: { url: "http://elsewhere:9090" },
    });
    expect(result.reachable).toBe(true);
  });

  test("fetchInvokeAIBoards omits empty credentials and maps albumKey", async () => {
    fetchJson.mockResolvedValue([]);
    await fetchInvokeAIBoards({ url: "http://x:9090", username: "", password: "", albumKey: "my_album" });
    expect(fetchJson).toHaveBeenCalledWith("invokeai/probe_boards", {
      json: { url: "http://x:9090", album_key: "my_album" },
    });

    await fetchInvokeAIBoards({ url: "http://x:9090", username: "alice", password: "pw" });
    expect(fetchJson).toHaveBeenLastCalledWith("invokeai/probe_boards", {
      json: { url: "http://x:9090", username: "alice", password: "pw" },
    });
  });

  test("renderBoardChecklist prepends Uncategorized and preselects ids", () => {
    const container = document.createElement("div");
    renderBoardChecklist(
      container,
      [
        { board_id: "b1", board_name: "Portraits" },
        { board_id: "b2", board_name: "Landscapes" },
      ],
      ["b2", "none"]
    );

    const checkboxes = Array.from(container.querySelectorAll(".board-checkbox"));
    expect(checkboxes.map((c) => c.value)).toEqual(["none", "b1", "b2"]);
    expect(container.textContent).toContain("Uncategorized");
    expect(checkboxes.map((c) => c.checked)).toEqual([true, false, true]);

    expect(collectSelectedBoardIds(container)).toEqual(["none", "b2"]);
  });
});

// Build the add-album form DOM the AlbumManager methods read from.
function buildAddAlbumDom({ sourceType, boardIds = [] } = {}) {
  document.body.innerHTML = `
    <input id="newAlbumKey" value="my_album" />
    <input id="newAlbumName" value="My Album" />
    <input id="newAlbumDescription" value="desc" />
    <label><input type="radio" name="newAlbumSourceType" value="directory" ${
      sourceType === "directory" ? "checked" : ""
    } /></label>
    <label><input type="radio" name="newAlbumSourceType" value="invokeai_board" ${
      sourceType === "invokeai_board" ? "checked" : ""
    } /></label>
    <div id="newAlbumDirectorySection">
      <div id="newAlbumPathsContainer">
        <input class="album-path-input" value="/photos/vacation" />
      </div>
    </div>
    <div id="newAlbumInvokeAISection">
      <input id="newAlbumInvokeUrl" value="http://localhost:9090" />
      <div id="newAlbumInvokeRootRow"><input class="invoke-root-input" value="/srv/invokeai" /></div>
      <input id="newAlbumInvokeUsername" value="alice" />
      <input id="newAlbumInvokePassword" value="secret" />
      <div id="newAlbumInvokeBoards">
        ${boardIds
          .map((id) => `<label><input type="checkbox" class="board-checkbox" value="${id}" checked /></label>`)
          .join("")}
      </div>
    </div>
    <select id="newAlbumEncoder"><option value="openai-clip:ViT-B/32" selected>clip</option></select>
  `;

  const elements = {};
  [
    "newAlbumKey",
    "newAlbumName",
    "newAlbumDescription",
    "newAlbumPathsContainer",
    "newAlbumEncoder",
    "newAlbumDirectorySection",
    "newAlbumInvokeAISection",
    "newAlbumInvokeUrl",
    "newAlbumInvokeRootRow",
    "newAlbumInvokeUsername",
    "newAlbumInvokePassword",
    "newAlbumInvokeBoards",
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
  return elements;
}

function makeManagerStub(elements) {
  return {
    elements,
    getNewAlbumFormData: AlbumManager.prototype.getNewAlbumFormData,
    getNewAlbumSourceType: AlbumManager.prototype.getNewAlbumSourceType,
    collectNewAlbumPathFields: AlbumManager.prototype.collectNewAlbumPathFields,
    toggleNewAlbumSourceSections: AlbumManager.prototype.toggleNewAlbumSourceSections,
    fetchAvailableAlbums: jest.fn().mockResolvedValue([]),
    handleSuccessfulAlbumAdd: jest.fn(),
  };
}

describe("AlbumManager add-album payloads", () => {
  test("board-source albums omit index/image_paths and carry InvokeAI fields", async () => {
    const elements = buildAddAlbumDom({ sourceType: "invokeai_board", boardIds: ["b1", "none"] });
    const manager = makeManagerStub(elements);
    fetchJson.mockResolvedValue({ success: true });

    await AlbumManager.prototype.addAlbum.call(manager);

    expect(fetchJson).toHaveBeenCalledTimes(1);
    const [route, options] = fetchJson.mock.calls[0];
    expect(route).toBe("add_album/");
    const payload = options.json;
    expect(payload).not.toHaveProperty("index");
    expect(payload).not.toHaveProperty("image_paths");
    expect(payload.source_type).toBe("invokeai_board");
    expect(payload.invokeai_url).toBe("http://localhost:9090");
    expect(payload.invokeai_root).toBe("/srv/invokeai");
    expect(payload.invokeai_username).toBe("alice");
    expect(payload.invokeai_password).toBe("secret");
    expect(payload.invokeai_board_ids).toEqual(["b1", "none"]);
    expect(manager.handleSuccessfulAlbumAdd).toHaveBeenCalledWith("my_album");
  });

  test("directory albums keep the original payload shape (regression)", async () => {
    const elements = buildAddAlbumDom({ sourceType: "directory" });
    const manager = makeManagerStub(elements);
    fetchJson.mockResolvedValue({ success: true });

    await AlbumManager.prototype.addAlbum.call(manager);

    const payload = fetchJson.mock.calls[0][1].json;
    expect(payload.image_paths).toEqual(["/photos/vacation"]);
    expect(payload.index).toBe("/photos/vacation/photomap_index/embeddings.npz");
    expect(payload).not.toHaveProperty("source_type");
    expect(payload).not.toHaveProperty("invokeai_url");
  });

  test("board source without a selected board blocks submission", async () => {
    const elements = buildAddAlbumDom({ sourceType: "invokeai_board", boardIds: [] });
    const manager = makeManagerStub(elements);
    window.alert = jest.fn();

    await AlbumManager.prototype.addAlbum.call(manager);

    expect(fetchJson).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalled();
  });
});

describe("AlbumManager settings-credential surfacing", () => {
  function makeInvokeSectionStub() {
    document.body.innerHTML = `
      <div id="newAlbumSourceGroup" hidden>
        <label><input type="radio" name="newAlbumSourceType" value="directory" /></label>
        <label><input type="radio" name="newAlbumSourceType" value="invokeai_board" checked /></label>
      </div>
      <div id="newAlbumDirectorySection"></div>
      <div id="newAlbumInvokeAISection"></div>
      <input id="newAlbumInvokeUrl" />
      <input id="newAlbumInvokeUsername" />
      <input id="newAlbumInvokePassword" />
      <div id="newAlbumInvokeAuth" hidden></div>
      <div id="newAlbumInvokeBoards" hidden></div>
      <div id="newAlbumInvokeRootRow"></div>
      <small id="newAlbumInvokeStatusHint"></small>
    `;
    const elements = {};
    [
      "newAlbumSourceGroup",
      "newAlbumDirectorySection",
      "newAlbumInvokeAISection",
      "newAlbumInvokeUrl",
      "newAlbumInvokeUsername",
      "newAlbumInvokePassword",
      "newAlbumInvokeAuth",
      "newAlbumInvokeBoards",
      "newAlbumInvokeRootRow",
      "newAlbumInvokeStatusHint",
    ].forEach((id) => {
      elements[id] = document.getElementById(id);
    });
    return {
      elements,
      _setInvokeHint: AlbumManager.prototype._setInvokeHint,
      _createInvokeRootRow: AlbumManager.prototype._createInvokeRootRow,
      _applySettingsCredentialDefaults: AlbumManager.prototype._applySettingsCredentialDefaults,
      _setNewAlbumInvokeAvailable: AlbumManager.prototype._setNewAlbumInvokeAvailable,
      getNewAlbumSourceType: AlbumManager.prototype.getNewAlbumSourceType,
      toggleNewAlbumSourceSections: AlbumManager.prototype.toggleNewAlbumSourceSections,
      initializeNewAlbumInvokeSection: AlbumManager.prototype.initializeNewAlbumInvokeSection,
    };
  }

  test("prefills URL and username from settings and flags the saved password", async () => {
    const manager = makeInvokeSectionStub();
    fetchJson.mockResolvedValue({
      url: "http://localhost:9090",
      username: "alice",
      has_password: true,
      board_id: "",
    });

    await manager.initializeNewAlbumInvokeSection();

    expect(manager.elements.newAlbumInvokeUrl.value).toBe("http://localhost:9090");
    expect(manager.elements.newAlbumInvokeUsername.value).toBe("alice");
    expect(manager.elements.newAlbumInvokePassword.placeholder).toContain("saved in Settings");
  });

  test("repointing the URL at a different backend clears the auto-filled username", async () => {
    const manager = makeInvokeSectionStub();
    fetchJson.mockResolvedValue({
      url: "http://localhost:9090",
      username: "alice",
      has_password: true,
      board_id: "",
    });
    await manager.initializeNewAlbumInvokeSection();

    manager.elements.newAlbumInvokeUrl.value = "http://other-host:9090";
    manager._applySettingsCredentialDefaults();
    expect(manager.elements.newAlbumInvokeUsername.value).toBe("");
    expect(manager.elements.newAlbumInvokePassword.placeholder).not.toContain("saved in Settings");

    // Returning to the settings URL restores the surfaced credentials.
    manager.elements.newAlbumInvokeUrl.value = "http://localhost:9090/";
    manager._applySettingsCredentialDefaults();
    expect(manager.elements.newAlbumInvokeUsername.value).toBe("alice");
    expect(manager.elements.newAlbumInvokePassword.placeholder).toContain("saved in Settings");
  });

  test("a hand-typed username is never overwritten or cleared", async () => {
    const manager = makeInvokeSectionStub();
    fetchJson.mockResolvedValue({
      url: "http://localhost:9090",
      username: "alice",
      has_password: true,
      board_id: "",
    });
    await manager.initializeNewAlbumInvokeSection();

    // Simulate the user replacing the username (the input listener drops
    // the autofilled marker on real keystrokes).
    manager.elements.newAlbumInvokeUsername.value = "bob";
    delete manager.elements.newAlbumInvokeUsername.dataset.autofilled;

    manager.elements.newAlbumInvokeUrl.value = "http://other-host:9090";
    manager._applySettingsCredentialDefaults();
    expect(manager.elements.newAlbumInvokeUsername.value).toBe("bob");

    manager.elements.newAlbumInvokeUrl.value = "http://localhost:9090";
    manager._applySettingsCredentialDefaults();
    expect(manager.elements.newAlbumInvokeUsername.value).toBe("bob");
  });

  test("reveals the album-source chooser when a backend is configured", async () => {
    const manager = makeInvokeSectionStub();
    fetchJson.mockResolvedValue({ url: "http://localhost:9090", username: "", has_password: false, board_id: "" });

    await manager.initializeNewAlbumInvokeSection();

    expect(manager.elements.newAlbumSourceGroup.hidden).toBe(false);
  });

  test("hides the chooser and forces the directory source with no backend", async () => {
    const manager = makeInvokeSectionStub();
    fetchJson.mockResolvedValue({ url: "", username: "", has_password: false, board_id: "" });

    await manager.initializeNewAlbumInvokeSection();

    expect(manager.elements.newAlbumSourceGroup.hidden).toBe(true);
    expect(document.querySelector('input[name="newAlbumSourceType"][value="directory"]').checked).toBe(true);
  });
});

describe("AlbumManager indexing-progress robustness", () => {
  test("progress poller follows the live card after a rebuild detaches the original", async () => {
    // loadAlbums() rebuilds all cards mid-indexing (album add/edit flows);
    // the poller must update the album's *current* card, not the detached
    // one captured at kickoff — that zombie binding froze the UI at
    // "Indexing in progress..." while the backend completed.
    jest.useFakeTimers();
    try {
      document.body.innerHTML = `<div class="album-card" data-album-key="k" id="liveCard"></div>`;
      const detachedCard = document.createElement("div");
      const manager = {
        progressPollers: new Map(),
        indexWarnings: new Map(),
        _liveCardFor: AlbumManager.prototype._liveCardFor,
        updateProgress: jest.fn(),
        handleIndexingCompletion: jest.fn(),
        hideProgressUI: jest.fn(),
      };
      fetchJson.mockResolvedValue({
        status: "indexing",
        current_step: "Processing x.png",
        progress_percentage: 50,
        images_processed: 1,
        total_images: 2,
      });

      AlbumManager.prototype.startProgressPolling.call(manager, "k", detachedCard);
      await jest.advanceTimersByTimeAsync(1100);

      expect(manager.updateProgress).toHaveBeenCalledWith(document.getElementById("liveCard"), expect.anything());
      clearInterval(manager.progressPollers.get("k"));
    } finally {
      jest.useRealTimers();
    }
  });

  test("freshly added albums are marked auto-indexing before the card rebuild", async () => {
    // The rebuild's 404 metadata probe fires albumIndexError; the guard set
    // must already contain the new album or a second kickoff races the
    // first (duplicate POST → 409 alert, poller bound to a detached card).
    const autoIndexing = new Set();
    const setDuringRebuild = [];
    const manager = {
      autoIndexingAlbums: autoIndexing,
      isSetupMode: false,
      hideAddAlbumForm: jest.fn(),
      loadAlbums: jest.fn(async () => {
        setDuringRebuild.push(autoIndexing.has("k"));
      }),
      startAutoIndexing: jest.fn(),
    };

    await AlbumManager.prototype.handleSuccessfulAlbumAdd.call(manager, "k");

    expect(setDuringRebuild).toEqual([true]);
    expect(manager.startAutoIndexing).toHaveBeenCalledWith("k");
  });
});

describe("AlbumManager add-form entrance animation", () => {
  test("slide-down clamp is dropped when the entrance animation ends", () => {
    // The slideDown keyframes fill forwards with a 600px max-height clamp
    // sized for the directory form; the constructor must remove the class
    // on animationend or the taller InvokeAI board form overflows and the
    // Add Album button becomes unreachable.
    document.body.innerHTML =
      `<div id="albumManagementOverlay"></div>` +
      `<div id="addAlbumSection" class="add-album-section slide-down"></div>` +
      ["addAlbumBtn", "cancelAddAlbumBtn", "cancelAddAlbumBtn2", "closeAlbumManagementBtn", "showAddAlbumBtn"]
        .map((id) => `<button id="${id}"></button>`)
        .join("");
    new AlbumManager();

    const section = document.getElementById("addAlbumSection");
    section.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "slideDown" }));
    expect(section.classList.contains("slide-down")).toBe(false);

    // The exit animation's class must survive its own animationend.
    section.classList.add("slide-up");
    section.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "slideUp" }));
    expect(section.classList.contains("slide-up")).toBe(true);
  });
});

describe("AlbumManager source-section toggle", () => {
  test("radio selection shows the matching section", () => {
    const elements = buildAddAlbumDom({ sourceType: "directory" });
    const manager = makeManagerStub(elements);

    AlbumManager.prototype.toggleNewAlbumSourceSections.call(manager);
    expect(elements.newAlbumDirectorySection.hidden).toBe(false);
    expect(elements.newAlbumInvokeAISection.hidden).toBe(true);

    document.querySelector('input[name="newAlbumSourceType"][value="invokeai_board"]').checked = true;
    AlbumManager.prototype.toggleNewAlbumSourceSections.call(manager);
    expect(elements.newAlbumDirectorySection.hidden).toBe(true);
    expect(elements.newAlbumInvokeAISection.hidden).toBe(false);
  });
});

describe("AlbumManager edit-save payloads for board albums", () => {
  function buildEditDom({ loaded = true, boardIds = ["b1"] } = {}) {
    document.body.innerHTML = `
      <div class="album-card">
        <div class="edit-form">
          <input class="edit-album-name" value="Renamed" />
          <input class="edit-album-description" value="d" />
          <input class="edit-album-min-image-dimension" value="256" />
          <select class="edit-album-encoder"><option value="openai-clip:ViT-B/32" selected>clip</option></select>
          <input class="edit-album-invoke-url" value="http://localhost:9090" />
          <div class="edit-album-invoke-root-row"><input class="invoke-root-input" value="/srv/invokeai" /></div>
          <input class="edit-album-invoke-username" value="alice" />
          <input class="edit-album-invoke-password" value="" />
          <div class="edit-album-invoke-boards" ${loaded ? 'data-loaded="true"' : ""}>
            ${boardIds
              .map((id) => `<label><input type="checkbox" class="board-checkbox" value="${id}" checked /></label>`)
              .join("")}
          </div>
        </div>
      </div>
    `;
    return document.querySelector(".album-card");
  }

  const album = {
    key: "board_album",
    source_type: "invokeai_board",
    invokeai_url: "http://localhost:9090",
    invokeai_root: "/srv/invokeai",
    invokeai_board_ids: ["b1", "b2"],
    has_invokeai_password: true,
  };

  function makeEditStub() {
    return {
      refreshAlbumsAndDropdown: jest.fn().mockResolvedValue(undefined),
      send_update_index_event: jest.fn(),
      collectPathFields: AlbumManager.prototype.collectPathFields,
    };
  }

  test("blank password is omitted and index/image_paths are not sent", async () => {
    const card = buildEditDom();
    const manager = makeEditStub();
    fetchJson.mockResolvedValue({ success: true });

    await AlbumManager.prototype.saveAlbumChanges.call(manager, card, album);

    const payload = fetchJson.mock.calls[0][1].json;
    expect(payload).not.toHaveProperty("invokeai_password");
    expect(payload).not.toHaveProperty("index");
    expect(payload).not.toHaveProperty("image_paths");
    expect(payload.invokeai_board_ids).toEqual(["b1"]);
    // Board selection changed (b2 dropped) → re-index event fires.
    expect(manager.send_update_index_event).toHaveBeenCalledWith("board_album");
  });

  test("unloaded board checklist falls back to the saved selection", async () => {
    const card = buildEditDom({ loaded: false, boardIds: [] });
    const manager = makeEditStub();
    fetchJson.mockResolvedValue({ success: true });

    await AlbumManager.prototype.saveAlbumChanges.call(manager, card, album);

    const payload = fetchJson.mock.calls[0][1].json;
    expect(payload.invokeai_board_ids).toEqual(["b1", "b2"]);
    expect(manager.send_update_index_event).not.toHaveBeenCalled();
  });
});

describe("AlbumManager board-album edit form population", () => {
  function buildBoardEditForm() {
    document.body.innerHTML = `
      <div class="edit-form">
        <input class="edit-album-invoke-url" />
        <input class="edit-album-invoke-username" />
        <input class="edit-album-invoke-password" />
        <small class="edit-album-invoke-status-hint"></small>
        <div class="edit-album-invoke-root-row"></div>
        <button class="edit-album-invoke-connect-btn"></button>
        <div class="edit-album-invoke-boards" hidden></div>
      </div>
    `;
    const form = document.querySelector(".edit-form");
    // jsdom doesn't implement scrollIntoView, which connectAndLoadBoards calls.
    form.querySelector(".edit-album-invoke-boards").scrollIntoView = () => {};
    return form;
  }

  function makeStub() {
    return {
      connectAndLoadBoards: AlbumManager.prototype.connectAndLoadBoards,
      populateBoardAlbumEditForm: AlbumManager.prototype.populateBoardAlbumEditForm,
      _createInvokeRootRow: AlbumManager.prototype._createInvokeRootRow,
      _setInvokeHint: AlbumManager.prototype._setInvokeHint,
    };
  }

  const album = {
    key: "board_album",
    source_type: "invokeai_board",
    invokeai_url: "http://localhost:9090",
    invokeai_root: "/srv/invokeai",
    // "all boards" selection — including Uncategorized ("none").
    invokeai_board_ids: ["none", "b1", "b2"],
    has_invokeai_password: true,
  };

  // Flush the async connectAndLoadBoards() chain populateBoardAlbumEditForm
  // kicks off but doesn't await.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("checks every saved board on reopen, even when Uncategorized is among them", async () => {
    // Regression: the placeholder render only paints the (checked)
    // Uncategorized box, so the auto-load must use the album's saved ids —
    // not scrape the DOM, which would collapse the selection to just ["none"].
    const editForm = buildBoardEditForm();
    const manager = makeStub();
    fetchJson.mockResolvedValueOnce({ reachable: true }).mockResolvedValueOnce([
      { board_id: "b1", board_name: "Board One" },
      { board_id: "b2", board_name: "Board Two" },
    ]);

    manager.populateBoardAlbumEditForm(editForm, album);
    await flush();

    const boardsContainer = editForm.querySelector(".edit-album-invoke-boards");
    expect(collectSelectedBoardIds(boardsContainer)).toEqual(["none", "b1", "b2"]);
  });

  test("manual reconnect keeps the user's in-progress selection", async () => {
    const editForm = buildBoardEditForm();
    const manager = makeStub();
    fetchJson.mockResolvedValueOnce({ reachable: true }).mockResolvedValueOnce([
      { board_id: "b1", board_name: "Board One" },
      { board_id: "b2", board_name: "Board Two" },
    ]);

    manager.populateBoardAlbumEditForm(editForm, album);
    await flush();

    const boardsContainer = editForm.querySelector(".edit-album-invoke-boards");
    // User unchecks b2, then clicks "Connect & Load Boards" again.
    boardsContainer.querySelector('.board-checkbox[value="b2"]').checked = false;
    fetchJson.mockResolvedValueOnce({ reachable: true }).mockResolvedValueOnce([
      { board_id: "b1", board_name: "Board One" },
      { board_id: "b2", board_name: "Board Two" },
    ]);
    editForm.querySelector(".edit-album-invoke-connect-btn").click();
    await flush();

    expect(collectSelectedBoardIds(boardsContainer)).toEqual(["none", "b1"]);
  });
});
