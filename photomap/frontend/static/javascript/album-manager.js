// album-management.js
import { createSimpleDirectoryPicker } from "./filetree.js"; // Add this import
import { getIndexMetadata, removeIndex, updateIndex } from "./index.js";
import {
  collectSelectedBoardIds,
  fetchInvokeAIBoards,
  probeInvokeAI,
  renderBoardChecklist,
} from "./invokeai-album-source.js";
import { exitSearchMode } from "./search-ui.js";
import { closeSettingsModal, loadAvailableAlbums, openSettingsModal } from "./settings.js";
import { setAlbum, state } from "./state.js";
import { fetchJson, hideSpinner, showSpinner } from "./utils.js";

// Encoder backends offered in the album manager dropdown. Values must match
// the spec format consumed by photomap.backend.encoders.build_encoder.
// The pre-selected default for new albums is fetched from the server
// (getServerDefaultEncoderSpec) since it's platform-aware; ENCODER_OPTIONS[0]
// is only the client-side fallback when that request fails.
export const ENCODER_OPTIONS = [
  {
    value: "open-clip:ViT-L-14/dfn2b_s39b",
    label: "OpenCLIP ViT-L-14 / DFN-2B (recommended, best general purpose)",
  },
  {
    value: "siglip:google/siglip2-large-patch16-256",
    label: "SigLIP 2 Large (best for clean subjects, less forgiving)",
  },
  {
    value: "openai-clip:ViT-B/32",
    label: "OpenAI CLIP ViT-B/32 (legacy, fastest, weakest)",
  },
];
const DEFAULT_ENCODER_SPEC = ENCODER_OPTIONS[0].value;

// The default encoder for *new* albums is resolved by the server: it's
// platform-aware (CPU-only Linux/Windows hosts get a lighter encoder than
// CUDA/macOS hosts), so we can't hardcode ENCODER_OPTIONS[0] here. Fetch it
// once, cache the promise, and fall back to the recommended option if the
// request fails.
let serverDefaultEncoderPromise = null;
function getServerDefaultEncoderSpec() {
  if (!serverDefaultEncoderPromise) {
    serverDefaultEncoderPromise = fetchJson("default_encoder/")
      .then((data) => data?.encoder_spec || DEFAULT_ENCODER_SPEC)
      .catch(() => DEFAULT_ENCODER_SPEC);
  }
  return serverDefaultEncoderPromise;
}

function populateEncoderSelect(selectEl, currentValue) {
  if (!selectEl) {
    return;
  }
  const value = currentValue || DEFAULT_ENCODER_SPEC;
  selectEl.innerHTML = "";
  for (const opt of ENCODER_OPTIONS) {
    const optionEl = document.createElement("option");
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    if (opt.value === value) {
      optionEl.selected = true;
    }
    selectEl.appendChild(optionEl);
  }
  // If the album's stored spec isn't in our list (e.g. set via config.yaml),
  // append it as an extra option so the dropdown still reflects reality.
  if (!ENCODER_OPTIONS.some((o) => o.value === value)) {
    const extra = document.createElement("option");
    extra.value = value;
    extra.textContent = `${value} (custom)`;
    extra.selected = true;
    selectEl.appendChild(extra);
  }
}

export class AlbumManager {
  // Constants
  static POLL_INTERVAL = 1000;
  static PROGRESS_HIDE_DELAY = 3000;
  static AUTO_INDEXING_DELAY = 500;
  static SETUP_EXIT_DELAY = 10000;
  static FORM_ANIMATION_DELAY = 300;
  static SCROLL_DELAY = 100;

  static STATUS_CLASSES = {
    SCANNING: "index-status scanning",
    DOWNLOADING: "index-status downloading",
    INDEXING: "index-status indexing",
    UMAPPING: "index-status mapping",
    COMPLETED: "index-status completed",
    ERROR: "index-status error",
    DEFAULT: "index-status",
  };

  constructor() {
    this.overlay = document.getElementById("albumManagementOverlay");
    this.albumsList = document.getElementById("albumsList");
    this.template = document.getElementById("albumCardTemplate");
    this.addAlbumSection = document.getElementById("addAlbumSection");

    // Cache frequently used elements
    this.elements = {
      newAlbumKey: document.getElementById("newAlbumKey"),
      newAlbumName: document.getElementById("newAlbumName"),
      newAlbumDescription: document.getElementById("newAlbumDescription"),
      newAlbumPathsContainer: document.getElementById("newAlbumPathsContainer"), // Changed this line
      newAlbumEncoder: document.getElementById("newAlbumEncoder"),
      albumSelect: document.getElementById("albumSelect"),
      slideshowTitle: document.getElementById("slideshow_title"),
      albumManagementContent: document.querySelector("#albumManagementContent"),
      // InvokeAI board-album source controls (add form)
      newAlbumSourceGroup: document.getElementById("newAlbumSourceGroup"),
      newAlbumDirectorySection: document.getElementById("newAlbumDirectorySection"),
      newAlbumInvokeAISection: document.getElementById("newAlbumInvokeAISection"),
      newAlbumInvokeUrl: document.getElementById("newAlbumInvokeUrl"),
      newAlbumInvokeRootRow: document.getElementById("newAlbumInvokeRootRow"),
      newAlbumInvokeAuth: document.getElementById("newAlbumInvokeAuth"),
      newAlbumInvokeUsername: document.getElementById("newAlbumInvokeUsername"),
      newAlbumInvokePassword: document.getElementById("newAlbumInvokePassword"),
      newAlbumInvokeConnectBtn: document.getElementById("newAlbumInvokeConnectBtn"),
      newAlbumInvokeStatusHint: document.getElementById("newAlbumInvokeStatusHint"),
      newAlbumInvokeBoards: document.getElementById("newAlbumInvokeBoards"),
    };

    this.progressPollers = new Map();
    this.isSetupMode = false;
    this.autoIndexingAlbums = new Set();

    this.initializeEventListeners();
  }

  initializeEventListeners() {
    // Main management button
    const manageAlbumsBtn = document.getElementById("manageAlbumsBtn");
    if (manageAlbumsBtn) {
      manageAlbumsBtn.addEventListener("click", () => {
        closeSettingsModal();
        showSpinner();
        this.show();
      });
    }

    // Back to settings button
    const backToSettingsBtn = document.getElementById("backToSettingsBtn");
    if (backToSettingsBtn) {
      backToSettingsBtn.addEventListener("click", () => {
        this.hide();
        openSettingsModal();
      });
    }

    // Close button
    document.getElementById("closeAlbumManagementBtn").addEventListener("click", () => {
      this.hide();
    });

    // Show add album form button
    document.getElementById("showAddAlbumBtn").addEventListener("click", () => {
      this.showAddAlbumForm();
    });

    // Cancel add album buttons (both X and Cancel button)
    document.getElementById("cancelAddAlbumBtn").addEventListener("click", () => {
      this.hideAddAlbumForm();
    });

    document.getElementById("cancelAddAlbumBtn2").addEventListener("click", () => {
      this.hideAddAlbumForm();
    });

    // Add album button
    document.getElementById("addAlbumBtn").addEventListener("click", () => {
      this.addAlbum();
    });

    // The slide-down entrance animation fills forwards with a 600px
    // max-height clamp sized for the directory form. The InvokeAI board
    // form is taller, so drop the class once the animation finishes to
    // return the section to its natural height.
    if (this.addAlbumSection) {
      this.addAlbumSection.addEventListener("animationend", (event) => {
        if (event.animationName === "slideDown") {
          this.addAlbumSection.classList.remove("slide-down");
        }
      });
    }

    this.setupNewAlbumSourceControls();

    // Click outside to close
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });

    // Edge cases
    // - no albums configured
    window.addEventListener("noAlbumsFound", () => {
      this.enterSetupMode();
    });

    // no image files in selected album
    window.addEventListener("albumIndexingNoImages", async (e) => {
      const { albumKey } = e.detail;
      await albumManager.show();
      setTimeout(async () => {
        const cardElement = document.querySelector(`.album-card[data-album-key="${albumKey}"]`);
        if (cardElement) {
          // Fetch the album object
          const album = await albumManager.getAlbum(albumKey);
          albumManager.editAlbum(cardElement, album);

          // Show a user-friendly error message in the card
          let errorDiv = cardElement.querySelector(".album-error-message");
          if (!errorDiv) {
            errorDiv = document.createElement("div");
            errorDiv.className = "album-error-message";
            cardElement.appendChild(errorDiv);
          }
          errorDiv.textContent =
            "No image files were found in the provided paths. Please check your album paths and try again.";
          errorDiv.style.color = "#b00020";
          errorDiv.style.marginTop = "0.5em";
          errorDiv.style.fontWeight = "bold";

          cardElement.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 500);
    });

    // Handle missing/corrupted index errors and start indexing automatically
    window.addEventListener("albumIndexError", async (e) => {
      const { albumKey, errorType } = e.detail;

      // Prevent duplicate auto-indexing for the same album
      if (this.autoIndexingAlbums.has(albumKey)) {
        console.log(`Auto-indexing already triggered for album: ${albumKey}`);
        return;
      }
      this.autoIndexingAlbums.add(albumKey);

      await albumManager.show();
      setTimeout(async () => {
        const cardElement = document.querySelector(`.album-card[data-album-key="${albumKey}"]`);
        if (cardElement) {
          // Show a user-friendly error message in the card
          let errorDiv = cardElement.querySelector(".album-error-message");
          if (!errorDiv) {
            errorDiv = document.createElement("div");
            errorDiv.className = "album-error-message";
            cardElement.appendChild(errorDiv);
          }
          if (errorType === "missing") {
            errorDiv.textContent = "This album's index is missing. Indexing will start automatically.";
          } else if (errorType === "corrupted") {
            errorDiv.textContent = "This album's index is corrupted. Indexing will start automatically.";
          } else if (errorType === "outOfDate") {
            errorDiv.textContent = "This album's index is out of date. Re-indexing will start automatically.";
          } else {
            errorDiv.textContent = "This album's index is corrupted or unreadable. Indexing will start automatically.";
          }
          errorDiv.style.color = "#b00020";
          errorDiv.style.marginTop = "0.5em";
          errorDiv.style.fontWeight = "bold";

          cardElement.scrollIntoView({ behavior: "smooth", block: "center" });

          // Automatically start indexing
          await albumManager.startIndexing(albumKey, cardElement, errorType === "corrupted");
          albumManager.showProgressUI(cardElement);
        }
      }, 500);
    });
  }

  // Utility methods
  async fetchAvailableAlbums() {
    return await fetchJson("available_albums/");
  }

  async getAlbum(albumKey) {
    return await fetchJson(`album/${albumKey}/`);
  }

  async refreshAlbumsAndDropdown() {
    await this.loadAlbums();
    await loadAvailableAlbums();
  }

  async updateCurrentAlbum(album) {
    // Update state and localStorage
    setAlbum(album.key);

    // Update settings dropdown
    await loadAvailableAlbums();

    // Update page title
    if (this.elements.slideshowTitle) {
      this.elements.slideshowTitle.textContent = `Slideshow - ${album.name}`;
    }
  }

  getNewAlbumFormData() {
    return {
      key: this.elements.newAlbumKey.value.trim(),
      name: this.elements.newAlbumName.value.trim(),
      description: this.elements.newAlbumDescription.value.trim(),
      paths: this.collectNewAlbumPathFields(), // Changed this line
      encoder_spec: this.elements.newAlbumEncoder?.value || DEFAULT_ENCODER_SPEC,
      source_type: this.getNewAlbumSourceType(),
      invokeai_url: this.elements.newAlbumInvokeUrl?.value.trim() || "",
      invokeai_root: this.elements.newAlbumInvokeRootRow?.querySelector(".invoke-root-input")?.value.trim() || "",
      invokeai_username: this.elements.newAlbumInvokeUsername?.value.trim() || "",
      invokeai_password: this.elements.newAlbumInvokePassword?.value || "",
      invokeai_board_ids: collectSelectedBoardIds(this.elements.newAlbumInvokeBoards),
    };
  }

  // InvokeAI board-album source controls
  getNewAlbumSourceType() {
    const checked = document.querySelector('input[name="newAlbumSourceType"]:checked');
    return checked ? checked.value : "directory";
  }

  // Whether a global InvokeAI backend URL is configured in settings.
  async _isInvokeAIConfigured() {
    try {
      const config = await fetchJson("invokeai/config");
      return !!(config.url && config.url.trim());
    } catch {
      return false;
    }
  }

  setupNewAlbumSourceControls() {
    document.querySelectorAll('input[name="newAlbumSourceType"]').forEach((radio) => {
      radio.addEventListener("change", () => this.toggleNewAlbumSourceSections());
    });

    // Keep the surfaced settings credentials in sync as the URL changes:
    // matching the settings backend shows them, leaving it clears them.
    if (this.elements.newAlbumInvokeUrl) {
      this.elements.newAlbumInvokeUrl.addEventListener("input", () => this._applySettingsCredentialDefaults());
    }
    // A username the user edits by hand is theirs — stop treating it as
    // auto-filled so URL changes no longer overwrite or clear it.
    if (this.elements.newAlbumInvokeUsername) {
      this.elements.newAlbumInvokeUsername.addEventListener("input", () => {
        delete this.elements.newAlbumInvokeUsername.dataset.autofilled;
      });
    }

    if (this.elements.newAlbumInvokeConnectBtn) {
      this.elements.newAlbumInvokeConnectBtn.addEventListener("click", () => {
        this.connectAndLoadBoards({
          urlInput: this.elements.newAlbumInvokeUrl,
          usernameInput: this.elements.newAlbumInvokeUsername,
          passwordInput: this.elements.newAlbumInvokePassword,
          authSection: this.elements.newAlbumInvokeAuth,
          hintElement: this.elements.newAlbumInvokeStatusHint,
          boardsContainer: this.elements.newAlbumInvokeBoards,
          selectedIds: collectSelectedBoardIds(this.elements.newAlbumInvokeBoards),
        });
      });
    }
  }

  toggleNewAlbumSourceSections() {
    const isBoard = this.getNewAlbumSourceType() === "invokeai_board";
    if (this.elements.newAlbumDirectorySection) {
      this.elements.newAlbumDirectorySection.hidden = isBoard;
    }
    if (this.elements.newAlbumInvokeAISection) {
      this.elements.newAlbumInvokeAISection.hidden = !isBoard;
    }
  }

  // Show or hide the album-source chooser based on whether a global InvokeAI
  // backend is configured. With no backend the board option is meaningless, so
  // we hide the radios and force the directory source.
  _setNewAlbumInvokeAvailable(available) {
    if (this.elements.newAlbumSourceGroup) {
      this.elements.newAlbumSourceGroup.hidden = !available;
    }
    if (!available) {
      const directoryRadio = document.querySelector('input[name="newAlbumSourceType"][value="directory"]');
      if (directoryRadio) {
        directoryRadio.checked = true;
      }
      this.toggleNewAlbumSourceSections();
    }
  }

  // Build the InvokeAI-root input row: a text input plus the same 📁
  // filetree-picker button used by the image-path rows.
  _createInvokeRootRow(container, initialValue = "") {
    if (!container) {
      return;
    }
    container.innerHTML = "";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "invoke-root-input";
    input.value = initialValue;
    input.placeholder = "Path to the InvokeAI root directory";

    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.className = "open-folder-btn";
    folderBtn.title = "Select folder";
    folderBtn.innerHTML = "📁";
    folderBtn.style.cssText = "background: none; border: none; font-size: 1.2em; cursor: pointer; padding: 4px;";
    folderBtn.onclick = () => {
      createSimpleDirectoryPicker(
        (selectedPath) => {
          input.value = selectedPath;
        },
        input.value.trim(),
        { showCreateFolder: false }
      );
    };

    container.appendChild(input);
    container.appendChild(folderBtn);
  }

  _setInvokeHint(hintElement, message, isError = false) {
    if (!hintElement) {
      return;
    }
    hintElement.textContent = message || "";
    hintElement.style.color = isError ? "#c0392b" : "#7bd47b";
  }

  // Shared probe-then-load-boards flow for the add and edit forms. On
  // success the auth section is revealed (mirrors the settings panel: the
  // username/password rows only matter once the backend answers) and the
  // board checklist is rendered.
  async connectAndLoadBoards({
    urlInput,
    usernameInput,
    passwordInput,
    authSection,
    hintElement,
    boardsContainer,
    selectedIds = [],
    albumKey = null,
  }) {
    const url = urlInput?.value.trim();
    if (!url) {
      this._setInvokeHint(hintElement, "Enter the InvokeAI backend URL first.", true);
      return false;
    }

    this._setInvokeHint(hintElement, "Checking connection…");
    let status;
    try {
      status = await probeInvokeAI(url);
    } catch (error) {
      this._setInvokeHint(hintElement, error.body?.detail || "Could not contact the PhotoMap backend.", true);
      return false;
    }
    if (!status.reachable) {
      this._setInvokeHint(hintElement, status.detail || "InvokeAI backend is not reachable.", true);
      if (authSection) {
        authSection.hidden = true;
      }
      return false;
    }

    if (authSection) {
      authSection.hidden = false;
    }

    let boards;
    try {
      boards = await fetchInvokeAIBoards({
        url,
        username: usernameInput?.value.trim() || "",
        password: passwordInput?.value || "",
        albumKey,
      });
    } catch (error) {
      this._setInvokeHint(
        hintElement,
        error.body?.detail || "Connected, but the board list could not be fetched. Check the credentials.",
        true
      );
      return false;
    }

    renderBoardChecklist(boardsContainer, boards, selectedIds);
    if (boardsContainer) {
      boardsContainer.hidden = false;
      // Marks the checklist as authoritative: until a fetch succeeds, the
      // edit-save path keeps the album's stored board selection instead of
      // trusting a placeholder render.
      boardsContainer.dataset.loaded = "true";
      boardsContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    this._setInvokeHint(hintElement, `Connected to InvokeAI ${status.version || ""} — select one or more boards.`);
    return true;
  }

  async initializeNewAlbumInvokeSection() {
    this._setInvokeHint(this.elements.newAlbumInvokeStatusHint, "");
    if (this.elements.newAlbumInvokeAuth) {
      this.elements.newAlbumInvokeAuth.hidden = true;
    }
    if (this.elements.newAlbumInvokeBoards) {
      this.elements.newAlbumInvokeBoards.innerHTML = "";
      this.elements.newAlbumInvokeBoards.hidden = true;
    }
    if (this.elements.newAlbumInvokeUsername) {
      this.elements.newAlbumInvokeUsername.value = "";
      delete this.elements.newAlbumInvokeUsername.dataset.autofilled;
    }
    if (this.elements.newAlbumInvokePassword) {
      this.elements.newAlbumInvokePassword.value = "";
    }
    this._createInvokeRootRow(this.elements.newAlbumInvokeRootRow);

    // Prefill the URL — and surface the credential fallback — from the
    // global InvokeAI settings when available.
    this._settingsInvokeDefaults = null;
    let hasBackend = false;
    if (this.elements.newAlbumInvokeUrl) {
      this.elements.newAlbumInvokeUrl.value = "";
      try {
        const config = await fetchJson("invokeai/config");
        hasBackend = !!(config.url && config.url.trim());
        if (config.url) {
          this.elements.newAlbumInvokeUrl.value = config.url;
        }
        this._settingsInvokeDefaults = {
          url: config.url || "",
          username: config.username || "",
          hasPassword: !!config.has_password,
        };
      } catch {
        // No prefill — the field stays empty.
      }
      this._applySettingsCredentialDefaults();
    }
    // The board-album option only makes sense with a configured backend.
    this._setNewAlbumInvokeAvailable(hasBackend);
  }

  // The backend reuses the settings-panel credentials when the album form
  // targets the same URL as the settings panel (and only then). Surface
  // that: show the stored username and say the saved password will be
  // used. When the user points the form at a different backend — where
  // stored credentials are never sent — the auto-filled username is
  // cleared again. A username the user typed themselves is left alone.
  _applySettingsCredentialDefaults() {
    const defaults = this._settingsInvokeDefaults;
    const urlInput = this.elements.newAlbumInvokeUrl;
    const usernameInput = this.elements.newAlbumInvokeUsername;
    const passwordInput = this.elements.newAlbumInvokePassword;
    if (!urlInput || !usernameInput || !passwordInput) {
      return;
    }

    const normalize = (url) => (url || "").trim().replace(/\/+$/, "");
    const matchesSettings = !!defaults && !!defaults.url && normalize(urlInput.value) === normalize(defaults.url);

    if (matchesSettings) {
      if (defaults.username && (!usernameInput.value || usernameInput.dataset.autofilled === "true")) {
        usernameInput.value = defaults.username;
        usernameInput.dataset.autofilled = "true";
      }
      passwordInput.placeholder = defaults.hasPassword
        ? "(password saved in Settings — leave blank to use it)"
        : "(optional, multi-user mode)";
    } else {
      if (usernameInput.dataset.autofilled === "true") {
        usernameInput.value = "";
        delete usernameInput.dataset.autofilled;
      }
      passwordInput.placeholder = "(optional, multi-user mode)";
    }
  }

  clearAddAlbumForm() {
    this.elements.newAlbumKey.value = "";
    this.elements.newAlbumName.value = "";
    this.elements.newAlbumDescription.value = "";

    // Clear path fields container
    if (this.elements.newAlbumPathsContainer) {
      this.elements.newAlbumPathsContainer.innerHTML = "";
    }

    // Reset the source selector to the directory default
    const directoryRadio = document.querySelector('input[name="newAlbumSourceType"][value="directory"]');
    if (directoryRadio) {
      directoryRadio.checked = true;
    }
    this.toggleNewAlbumSourceSections();

    // Reset encoder dropdown to the host-resolved default
    getServerDefaultEncoderSpec().then((spec) => populateEncoderSelect(this.elements.newAlbumEncoder, spec));
  }

  // Form management
  showAddAlbumForm() {
    this.addAlbumSection.style.display = "block";
    this.addAlbumSection.classList.remove("slide-up");
    this.addAlbumSection.classList.add("slide-down");

    // Initialize path fields for the add album form
    this.initializeNewAlbumPathFields();

    // Reset the InvokeAI source section (prefills the URL from settings)
    this.toggleNewAlbumSourceSections();
    this.initializeNewAlbumInvokeSection();

    // Initialize encoder dropdown to the host-resolved default
    getServerDefaultEncoderSpec().then((spec) => populateEncoderSelect(this.elements.newAlbumEncoder, spec));

    // Focus on the first input field
    this.elements.newAlbumKey.focus();
  }

  hideAddAlbumForm() {
    this.addAlbumSection.classList.remove("slide-down");
    this.addAlbumSection.classList.add("slide-up");

    // Hide the section after animation completes
    setTimeout(() => {
      this.addAlbumSection.style.display = "none";
      this.clearAddAlbumForm();
    }, AlbumManager.FORM_ANIMATION_DELAY);
  }

  // New methods for add album form
  initializeNewAlbumPathFields() {
    const container = this.elements.newAlbumPathsContainer;
    if (container) {
      container.innerHTML = "";
      // Add one empty field to start
      this.addNewAlbumPathField("");
    }
  }

  addNewAlbumPathField(path = "") {
    const container = this.elements.newAlbumPathsContainer;
    if (container) {
      const row = this.createNewAlbumPathField(path);
      container.appendChild(row);
    }
  }

  _createAlbumPathRow({ path = "", onAddRow, onRemoveRow, onFolderPick } = {}) {
    const wrapper = document.createElement("div");
    wrapper.className = "album-path-row";
    wrapper.style.cssText = `
      display: flex;
      align-items: center;
      margin-bottom: 0.5em;
      gap: 0.5em;
    `;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "album-path-input";
    input.value = path;
    input.placeholder = "Enter the path to a folder of images, or click the folder icon";
    input.style.cssText = `
      flex: 1;
      background: #222;
      color: #faea0e;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 8px;
    `;

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        // Show the trash icon when Enter is pressed
        trashBtn.style.display = "inline-block";
        // Only add a new row if this is the last row
        if (wrapper.nextElementSibling === null && typeof onAddRow === "function") {
          onAddRow();
        }
      }
    });

    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.className = "open-folder-btn";
    folderBtn.title = "Select folder";
    folderBtn.innerHTML = "📁";
    folderBtn.style.cssText = `
      background: none;
      border: none;
      font-size: 1.2em;
      cursor: pointer;
      padding: 4px;
    `;

    folderBtn.onclick = () => {
      const currentPath = input.value.trim();
      if (typeof onFolderPick === "function") {
        onFolderPick(currentPath, (selectedPath) => {
          input.value = selectedPath;
          trashBtn.style.display = "inline-block";
          if (wrapper.nextElementSibling === null && typeof onAddRow === "function") {
            onAddRow();
          }
        });
      }
    };

    const trashBtn = document.createElement("button");
    trashBtn.type = "button";
    trashBtn.className = "remove-path-btn";
    trashBtn.title = "Remove path";
    trashBtn.innerHTML = "🗑️";
    trashBtn.style.cssText = `
      background: none;
      border: none;
      font-size: 1.2em;
      cursor: pointer;
      padding: 4px;
      display: ${path ? "inline-block" : "none"};
    `;

    trashBtn.onclick = () => {
      wrapper.remove();
      if (typeof onRemoveRow === "function") {
        onRemoveRow();
      }
    };

    wrapper.appendChild(input);
    wrapper.appendChild(folderBtn);
    wrapper.appendChild(trashBtn);

    return wrapper;
  }

  createNewAlbumPathField(path = "") {
    const container = this.elements.newAlbumPathsContainer;
    return this._createAlbumPathRow({
      path,
      container,
      onAddRow: () => this.addNewAlbumPathField(""),
      onRemoveRow: () => {
        if (container && container.children.length === 0) {
          this.addNewAlbumPathField("");
        }
      },
      onFolderPick: (currentPath, setPath) => {
        createSimpleDirectoryPicker(
          (selectedPath) => {
            setPath(selectedPath);
          },
          currentPath,
          { showCreateFolder: true }
        );
      },
    });
  }

  createPathField(path = "", cardElement) {
    const container = cardElement.querySelector(".edit-album-paths-container");
    return this._createAlbumPathRow({
      path,
      container,
      onAddRow: () => this.addPathField("", cardElement),
      onRemoveRow: () => {
        if (container && container.children.length === 0) {
          this.addPathField("", cardElement);
        }
      },
      onFolderPick: (currentPath, setPath) => {
        createSimpleDirectoryPicker(
          (selectedPath) => {
            setPath(selectedPath);
          },
          currentPath,
          { showCreateFolder: true }
        );
      },
    });
  }

  collectNewAlbumPathFields() {
    const inputs = this.elements.newAlbumPathsContainer.querySelectorAll(".album-path-input");
    return Array.from(inputs)
      .map((input) => input.value.trim())
      .filter((path) => path.length > 0);
  }

  // Main show/hide methods
  async show() {
    this.overlay.classList.add("visible");
    hideSpinner();
    await this.loadAlbums();
    await this.checkForOngoingIndexing(); // <-- Move this after loadAlbums

    // Ensure add album form is hidden when opening normally
    if (!this.isSetupMode) {
      this.addAlbumSection.style.display = "none";
      this.addAlbumSection.classList.remove("slide-down", "slide-up");
    }
  }

  hide() {
    if (this.isSetupMode) {
      console.log("Cannot close Album Manager - setup required");
      return; // Don't allow closing in setup mode
    }

    this.overlay.classList.remove("visible");
    this.hideAddAlbumForm();

    // Stop all progress polling
    this.progressPollers.forEach((interval) => {
      clearInterval(interval);
    });
    this.progressPollers.clear();
  }

  // Setup mode management
  async enterSetupMode() {
    console.log("Entering setup mode - no albums found.");
    this.isSetupMode = true;

    await this.show();
    this.showSetupMessage();
    this.showAddAlbumForm();
    this.disableClosing();
  }

  showSetupMessage() {
    const existingMessage = this.overlay.querySelector(".setup-message");
    if (existingMessage) {
      return;
    }

    const setupMessage = this.createSetupMessage();
    if (this.elements.albumManagementContent) {
      this.elements.albumManagementContent.insertBefore(setupMessage, this.elements.albumManagementContent.firstChild);
    }
  }

  createSetupMessage() {
    const setupMessage = document.createElement("div");
    setupMessage.className = "setup-message";
    setupMessage.style.cssText = `
      background: #ff9800;
      color: white;
      padding: 1em;
      border-radius: 8px;
      margin-bottom: 1em;
      text-align: center;
    `;
    setupMessage.innerHTML = `
      <h3 style="margin: 0 0 0.5em 0;">Welcome to PhotoMapAI!</h3>
      <p style="margin: 0;">
        To get started, please add your first image album below. 
        You'll need to specify the name and directory paths containing your images.
      </p>
    `;
    return setupMessage;
  }

  removeSetupMessage() {
    const setupMessage = this.overlay.querySelector(".setup-message");
    if (setupMessage) {
      setupMessage.remove();
    }
  }

  showIndexingCompletedUI(cardElement) {
    const cancelBtn = cardElement.querySelector(".cancel-index-btn");
    const updateBtn = cardElement.querySelector(".create-index-btn");
    const progressContainer = cardElement.querySelector(".progress-container");

    // Hide the Cancel button and the progress indicator
    cancelBtn.style.display = "none";
    progressContainer.style.display = "none";
    // Show the Update Index button
    updateBtn.style.display = "inline-block";
  }

  createCompletionMessage() {
    const completionMessage = document.createElement("div");
    completionMessage.className = "completion-message";
    completionMessage.style.cssText = `
      background: #4caf50;
      color: white;
      padding: 1em;
      border-radius: 8px;
      margin-bottom: 1em;
      text-align: center;
    `;
    completionMessage.innerHTML = `
      <h4 style="margin: 0 0 0.5em 0;">Setup In Progress!</h4>
      <p style="margin: 0;">
        Your album "${state.album}" is being indexed. 
        Once indexing completes, this window will close and the semantic map will display.
      </p>
    `;
    return completionMessage;
  }

  showCompletionMessage() {
    // Remove any existing completion message before adding a new one
    const existingCompletion = this.overlay.querySelector(".completion-message");
    if (existingCompletion && existingCompletion.parentNode) {
      existingCompletion.remove();
    }

    const completionMessage = this.createCompletionMessage();
    if (this.elements.albumManagementContent) {
      this.elements.albumManagementContent.insertBefore(
        completionMessage,
        this.elements.albumManagementContent.firstChild
      );
    }
    return completionMessage;
  }

  async setupModeIndexingInProgress() {
    this.removeSetupMessage();
    this.showCompletionMessage();
  }

  async completeSetupMode() {
    console.log("Exiting setup mode - indexing completed.");
    this.enableClosing();
    this.removeSetupMessage();
    // Remove any existing completion message
    const existingCompletion = this.overlay.querySelector(".completion-message");
    if (existingCompletion && existingCompletion.parentNode) {
      existingCompletion.remove();
    }
  }

  // Closing control
  disableClosing() {
    const closeBtn = this.overlay.querySelector(".close-albums-btn");
    if (closeBtn) {
      closeBtn.style.display = "none";
    }
    this.overlay.onclick = null;
  }

  enableClosing() {
    const closeBtn = this.overlay.querySelector(".close-albums-btn");
    if (closeBtn) {
      closeBtn.style.display = "block";
    }

    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });
  }

  // Album management
  async loadAlbums() {
    try {
      const albums = await this.fetchAvailableAlbums();
      this.albumsList.innerHTML = "";
      albums.forEach((album) => {
        this.createAlbumCard(album);
      });
    } catch (error) {
      console.error("Failed to load albums:", error);
    }
  }

  createAlbumCard(album) {
    const card = this.template.content.cloneNode(true);

    // Populate album info with defensive handling
    card.querySelector(".album-name").textContent = album.name || "Unknown Album";
    card.querySelector(".album-key").textContent = `Key: ${album.key || "Unknown"}`;
    card.querySelector(".album-description").textContent = album.description || "No description";

    if (album.source_type === "invokeai_board") {
      const boardCount = (album.invokeai_board_ids || []).length;
      card.querySelector(".album-paths").textContent =
        `Source: ${boardCount} InvokeAI board${boardCount === 1 ? "" : "s"} @ ${album.invokeai_url || "?"}`;
    } else {
      const imagePaths = album.image_paths || [];
      card.querySelector(".album-paths").textContent = `Paths: ${imagePaths.join(", ") || "No paths configured"}`;
    }

    // Set up event listeners
    const cardElement = card.querySelector(".album-card");
    cardElement.dataset.albumKey = album.key;

    this.attachCardEventListeners(card, cardElement, album);
    this.albumsList.appendChild(card);

    this.updateAlbumCardIndexStatus(cardElement, album);
  }

  async updateAlbumCardIndexStatus(cardElement, album) {
    const status = cardElement.querySelector(".index-status");
    const createBtn = cardElement.querySelector(".create-index-btn");

    try {
      const metadata = await getIndexMetadata(album.key);
      if (metadata) {
        const modDate = new Date(metadata.last_modified * 1000).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        });
        const fileCount = metadata.filename_count;
        // Reset the className so any leftover ``.indexing`` (orange,
        // !important in CSS) from a prior showProgressUI doesn't override
        // the inline color set below.
        status.className = "index-status";
        status.textContent = `Index updated ${modDate} (${fileCount} images)`;
        status.style.color = "green";
        createBtn.textContent = "Update Index";
      } else {
        status.className = "index-status";
        status.textContent = "No index present";
        status.style.color = "red";
        createBtn.textContent = "Create Index";
      }
    } catch {
      status.className = "index-status";
      status.textContent = "No index present";
      status.style.color = "red";
      createBtn.textContent = "Create Index";
    }
  }

  attachCardEventListeners(card, cardElement, album) {
    // Edit button
    card.querySelector(".edit-album-btn").addEventListener("click", () => {
      this.editAlbum(cardElement, album);
    });

    // Delete button
    card.querySelector(".delete-album-btn").addEventListener("click", () => {
      this.deleteAlbum(album.key);
    });

    // Index button
    card.querySelector(".create-index-btn").addEventListener("click", () => {
      this.startIndexing(album.key, cardElement);
    });

    // Cancel index button
    card.querySelector(".cancel-index-btn").addEventListener("click", () => {
      this.cancelIndexing(album.key, cardElement);
    });
  }

  async addAlbum() {
    const formData = this.getNewAlbumFormData();
    const isBoardAlbum = formData.source_type === "invokeai_board";

    // Map field names to their corresponding elements
    const requiredFields = [
      { value: formData.key, element: this.elements.newAlbumKey },
      { value: formData.name, element: this.elements.newAlbumName },
    ];
    if (isBoardAlbum) {
      requiredFields.push(
        { value: formData.invokeai_url, element: this.elements.newAlbumInvokeUrl },
        { value: formData.invokeai_root, element: this.elements.newAlbumInvokeRootRow },
        {
          value: formData.invokeai_board_ids.length > 0 ? "has boards" : "",
          element: this.elements.newAlbumInvokeBoards,
        }
      );
    } else {
      requiredFields.push({
        value: formData.paths.length > 0 ? "has paths" : "",
        element: this.elements.newAlbumPathsContainer,
      });
    }

    let hasError = false;

    // Remove previous error highlights and check for missing fields
    requiredFields.forEach(({ value, element }) => {
      element.classList.remove("input-error");
      if (!value) {
        element.classList.add("input-error");
        hasError = true;
      }
    });

    if (hasError) {
      alert(
        isBoardAlbum
          ? "Please fill in all required fields and select at least one board"
          : "Please fill in all required fields"
      );
      return;
    }

    // Check for duplicate album key
    const albums = await this.fetchAvailableAlbums();
    const duplicate = albums.some((album) => album.key === formData.key);
    if (duplicate) {
      this.elements.newAlbumKey.classList.add("input-error");
      alert(`An album with the key "${formData.key}" already exists. Please choose a different key.`);
      return;
    }

    let newAlbum;
    if (isBoardAlbum) {
      // image_paths and index are deliberately omitted: the backend derives
      // them from the InvokeAI root and the album key.
      newAlbum = {
        key: formData.key,
        name: formData.name,
        umap_eps: 0.1,
        description: formData.description,
        encoder_spec: formData.encoder_spec,
        source_type: "invokeai_board",
        invokeai_url: formData.invokeai_url,
        invokeai_root: formData.invokeai_root,
        invokeai_username: formData.invokeai_username || null,
        invokeai_password: formData.invokeai_password || null,
        invokeai_board_ids: formData.invokeai_board_ids,
      };
    } else {
      // Use the collected paths directly
      const paths = formData.paths;

      // Always set index path based on first path
      const indexPath = paths.length > 0 ? `${paths[0]}/photomap_index/embeddings.npz` : "";

      newAlbum = {
        key: formData.key,
        name: formData.name,
        image_paths: paths,
        index: indexPath,
        umap_eps: 0.1,
        description: formData.description,
        encoder_spec: formData.encoder_spec,
      };
    }

    try {
      await fetchJson("add_album/", { json: newAlbum });
      await this.handleSuccessfulAlbumAdd(formData.key);
    } catch (error) {
      console.error("Failed to add album:", error);
      alert(`Failed to add album: ${error.statusText || error.message}`);
    }
  }

  async handleSuccessfulAlbumAdd(albumKey) {
    this.hideAddAlbumForm();
    // Mark the album as auto-indexing BEFORE rebuilding the cards: the
    // rebuild's index-metadata probe 404s for the brand-new album and
    // fires albumIndexError, whose handler would otherwise start a
    // second, racing kickoff (a duplicate POST that 409s, and a progress
    // poller bound to a card the rebuild has already detached).
    this.autoIndexingAlbums.add(albumKey);
    await this.loadAlbums();

    // Set state.album directly to avoid triggering slideshow before indexing
    if (state.album === null) {
      state.album = albumKey;
    }

    await this.startAutoIndexing(albumKey);
    if (this.isSetupMode) {
      await this.setupModeIndexingInProgress();
      // force reindexing
      this.send_update_index_event(albumKey);
    }
  }

  send_update_index_event(albumKey = state.album) {
    window.dispatchEvent(
      new CustomEvent("albumIndexError", {
        detail: { albumKey, errorType: "outOfDate" },
      })
    );
  }

  async startAutoIndexing(albumKey) {
    const albumCard = Array.from(this.albumsList.querySelectorAll(".album-card")).find(
      (card) => card.dataset.albumKey === albumKey
    );

    if (!albumCard) {
      return;
    }

    // Kick off indexing for the freshly-added album. We can't rely on the
    // ``albumIndexError`` event from ``getIndexMetadata`` to start it
    // because the chosen image directory may already contain a stale
    // ``photomap_index/embeddings.npz`` from a prior session — in that
    // case the metadata fetch succeeds, no error event fires, and without
    // this call the new album would just inherit the old index (the bug
    // surfaced as "Index updated …" in orange with 0% completion that
    // never advances).
    //
    // ``startIndexing`` itself is idempotent — its backend-progress probe
    // attaches to an in-flight indexing run instead of starting a second
    // one, so the no-prior-index path (where the event listener also
    // calls ``startIndexing``) still only triggers one backend POST.
    setTimeout(() => {
      const indexingSection = albumCard.querySelector(".indexing-section");
      if (indexingSection) {
        indexingSection.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "nearest",
        });
      }
      this.startIndexing(albumKey, albumCard);
    }, AlbumManager.AUTO_INDEXING_DELAY);
  }

  async deleteAlbum(albumKey) {
    if (!confirm(`Are you sure you want to delete album "${albumKey}"? This action cannot be undone.`)) {
      return;
    }

    try {
      await fetchJson(`delete_album/${albumKey}`, { method: "DELETE" });
      const isCurrentAlbum = state.album === albumKey;
      await this.refreshAlbumsAndDropdown();
      if (isCurrentAlbum) {
        await this.handleDeletedCurrentAlbum();
      }
    } catch (error) {
      console.error("Failed to delete album:", error);
      alert("Failed to delete album");
    }
  }

  async handleDeletedCurrentAlbum() {
    try {
      const albums = await this.fetchAvailableAlbums();

      if (albums.length > 0) {
        const firstAlbum = albums[0];
        console.log(`Switching from deleted album to: ${firstAlbum.key}`);

        await this.updateCurrentAlbum(firstAlbum);

        // Clear and reset slideshow (specific to deletion)
        exitSearchMode();
        this.single_swiper.removeSlidesAfterCurrent();

        this.showAlbumSwitchNotification(firstAlbum.name);
      } else {
        console.warn("No albums available after deletion");
        alert("No albums available. Please add a new album.");
      }
    } catch (error) {
      console.error("Failed to handle deleted current album:", error);
    }
  }

  // Edit functionality
  editAlbum(cardElement, album) {
    const editForm = cardElement.querySelector(".edit-form");
    const albumInfo = cardElement.querySelector(".album-info");

    // Remove 'editing' class from all cards first
    document.querySelectorAll(".album-card.editing").forEach((card) => {
      card.classList.remove("editing");
    });

    // Add 'editing' class to this card
    cardElement.classList.add("editing");

    // Set the edit form title to include the album name
    const editTitle = editForm.querySelector(".edit-album-title");
    if (editTitle) {
      editTitle.innerHTML = `Editing Album <i>${album.name || "</i>"}`;
    }

    // Populate edit form
    editForm.querySelector(".edit-album-name").value = album.name;
    editForm.querySelector(".edit-album-description").value = album.description || "";

    // Reflect the (immutable) source type and show the matching section
    const isBoardAlbum = album.source_type === "invokeai_board";
    const sourceDisplay = editForm.querySelector(".edit-album-source-display");
    if (sourceDisplay) {
      sourceDisplay.textContent = isBoardAlbum ? "An InvokeAI Image Gallery Board" : "Directory of Image Files";
    }
    // Show the (immutable) source line only when an InvokeAI backend is
    // configured — or when this album is itself a board album, so its type is
    // never silently hidden.
    const sourceGroup = editForm.querySelector(".edit-album-source-group");
    if (sourceGroup) {
      this._isInvokeAIConfigured().then((available) => {
        sourceGroup.hidden = !(available || isBoardAlbum);
      });
    }
    const directorySection = editForm.querySelector(".edit-album-directory-section");
    const invokeSection = editForm.querySelector(".edit-album-invokeai-section");
    if (directorySection) {
      directorySection.hidden = isBoardAlbum;
    }
    if (invokeSection) {
      invokeSection.hidden = !isBoardAlbum;
    }

    if (isBoardAlbum) {
      this.populateBoardAlbumEditForm(editForm, album);
    } else {
      // Initialize the dynamic path fields for THIS specific card
      this.initializePathFields(album.image_paths || [], cardElement);
    }

    // Minimum-pixel-dimension gate. Fall back to 256 if the album predates
    // the field — matches the backend default (Album.min_image_dimension).
    const minDimInput = editForm.querySelector(".edit-album-min-image-dimension");
    if (minDimInput) {
      minDimInput.value = album.min_image_dimension ?? 256;
    }

    // Initialize the encoder dropdown for THIS specific card
    populateEncoderSelect(editForm.querySelector(".edit-album-encoder"), album.encoder_spec);

    // Show edit form
    albumInfo.style.display = "none";
    editForm.style.display = "block";

    // Attach event listeners
    editForm.querySelector(".save-album-btn").onclick = () => {
      this.saveAlbumChanges(cardElement, album);
      cardElement.classList.remove("editing");
    };

    editForm.querySelector(".cancel-edit-btn").onclick = () => {
      albumInfo.style.display = "block";
      editForm.style.display = "none";
      cardElement.classList.remove("editing");
    };

    // --- Scroll the card so its bottom is visible ---
    cardElement.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  // Populate the InvokeAI fields of the edit form and auto-load the board
  // checklist with the album's saved selection.
  populateBoardAlbumEditForm(editForm, album) {
    const urlInput = editForm.querySelector(".edit-album-invoke-url");
    const usernameInput = editForm.querySelector(".edit-album-invoke-username");
    const passwordInput = editForm.querySelector(".edit-album-invoke-password");
    const hintElement = editForm.querySelector(".edit-album-invoke-status-hint");
    const boardsContainer = editForm.querySelector(".edit-album-invoke-boards");

    if (urlInput) {
      urlInput.value = album.invokeai_url || "";
    }
    if (usernameInput) {
      usernameInput.value = album.invokeai_username || "";
    }
    if (passwordInput) {
      // Never echo passwords; indicate if one is stored.
      passwordInput.value = "";
      passwordInput.placeholder = album.has_invokeai_password
        ? "(password saved — leave blank to keep)"
        : "(optional, multi-user mode)";
    }
    this._createInvokeRootRow(editForm.querySelector(".edit-album-invoke-root-row"), album.invokeai_root || "");

    // preferredIds wins when given; otherwise fall back to the album's saved
    // selection. The initial auto-load must pass the saved ids explicitly: it
    // can't read them back from the DOM, because the placeholder render below
    // only paints "Uncategorized" (board names are still unresolved), so a DOM
    // scrape would collapse an "all boards" selection down to just ["none"].
    const loadBoards = (preferredIds) =>
      this.connectAndLoadBoards({
        urlInput,
        usernameInput,
        passwordInput,
        authSection: null,
        hintElement,
        boardsContainer,
        selectedIds: preferredIds?.length ? preferredIds : album.invokeai_board_ids || [],
        albumKey: album.key,
      });

    const connectBtn = editForm.querySelector(".edit-album-invoke-connect-btn");
    if (connectBtn) {
      // Manual reconnect keeps whatever the user currently has checked.
      connectBtn.onclick = () => loadBoards(collectSelectedBoardIds(boardsContainer));
    }

    // Show the saved selection immediately (board names unresolved until
    // the fetch returns), then refresh from the backend.
    if (boardsContainer) {
      delete boardsContainer.dataset.loaded;
    }
    renderBoardChecklist(boardsContainer, [], album.invokeai_board_ids || []);
    loadBoards(album.invokeai_board_ids || []);
  }

  // Path field methods
  addPathField(path = "", cardElement) {
    const container = cardElement.querySelector(".edit-album-paths-container");
    if (container) {
      const row = this.createPathField(path, cardElement);
      container.appendChild(row);
    }
  }

  initializePathFields(paths, cardElement) {
    const container = cardElement.querySelector(".edit-album-paths-container");
    if (container) {
      container.innerHTML = "";
      // Add existing paths
      if (paths && paths.length > 0) {
        paths.forEach((path) => this.addPathField(path, cardElement));
      }
      // Always ensure there's at least one empty field at the end
      this.addPathField("", cardElement);
    }
  }

  collectPathFields(cardElement) {
    const inputs = cardElement.querySelectorAll(".edit-album-paths-container .album-path-input");
    return Array.from(inputs)
      .map((input) => input.value.trim())
      .filter((path) => path.length > 0);
  }

  async saveAlbumChanges(cardElement, album) {
    const editForm = cardElement.querySelector(".edit-form");
    const isBoardAlbum = album.source_type === "invokeai_board";

    // Parse the dimension input. Invalid / non-positive values fall back to
    // the saved value, then to the backend default (256). The backend's
    // Pydantic validator enforces ge=1, so we shield it from junk here too.
    const minDimRaw = editForm.querySelector(".edit-album-min-image-dimension")?.value;
    const minDimParsed = Number.parseInt(minDimRaw, 10);
    const minDim =
      Number.isFinite(minDimParsed) && minDimParsed >= 1 ? minDimParsed : (album.min_image_dimension ?? 256);

    const updatedAlbum = {
      key: album.key,
      name: editForm.querySelector(".edit-album-name").value,
      description: editForm.querySelector(".edit-album-description").value,
      encoder_spec: editForm.querySelector(".edit-album-encoder")?.value || album.encoder_spec || DEFAULT_ENCODER_SPEC,
      min_image_dimension: minDim,
    };

    let sourceChanged = false;
    if (isBoardAlbum) {
      const boardsContainer = editForm.querySelector(".edit-album-invoke-boards");
      // Only trust the checklist once a board fetch has succeeded —
      // otherwise (e.g. InvokeAI unreachable during this edit) keep the
      // album's saved selection.
      const boardIds =
        boardsContainer?.dataset.loaded === "true"
          ? collectSelectedBoardIds(boardsContainer)
          : album.invokeai_board_ids || [];
      if (boardsContainer?.dataset.loaded === "true" && boardIds.length === 0) {
        alert("Please select at least one board");
        return;
      }
      const url = editForm.querySelector(".edit-album-invoke-url")?.value.trim() || "";
      const root = editForm.querySelector(".edit-album-invoke-root-row .invoke-root-input")?.value.trim() || "";
      if (!url || !root) {
        alert("The InvokeAI backend URL and root directory are required");
        return;
      }

      updatedAlbum.source_type = "invokeai_board";
      updatedAlbum.invokeai_url = url;
      updatedAlbum.invokeai_root = root;
      updatedAlbum.invokeai_username = editForm.querySelector(".edit-album-invoke-username")?.value.trim() || null;
      // Blank password means "keep the stored one" — omit it entirely.
      const password = editForm.querySelector(".edit-album-invoke-password")?.value;
      if (password) {
        updatedAlbum.invokeai_password = password;
      }
      updatedAlbum.invokeai_board_ids = boardIds;
      // index and image_paths are omitted: the backend keeps the stored
      // index and re-derives image_paths from the InvokeAI root.

      const oldBoardIds = album.invokeai_board_ids || [];
      sourceChanged =
        url !== (album.invokeai_url || "") ||
        root !== (album.invokeai_root || "") ||
        oldBoardIds.length !== boardIds.length ||
        oldBoardIds.some((id) => !boardIds.includes(id));
    } else {
      // Collect paths from dynamic fields for THIS specific card
      const updatedPaths = this.collectPathFields(cardElement);

      // Always set index path based on first path
      const indexPath = updatedPaths.length > 0 ? `${updatedPaths[0]}/photomap_index/embeddings.npz` : "";

      updatedAlbum.image_paths = updatedPaths;
      updatedAlbum.index = indexPath;

      // Compare old and new paths (order and content)
      const oldPaths = Array.isArray(album.image_paths) ? album.image_paths : [];
      sourceChanged = oldPaths.length !== updatedPaths.length || oldPaths.some((p, i) => p !== updatedPaths[i]);
    }

    try {
      await fetchJson("update_album/", { json: updatedAlbum });
      await this.refreshAlbumsAndDropdown();
      if (sourceChanged) {
        this.send_update_index_event(updatedAlbum.key);
      }
    } catch (error) {
      console.error("Failed to update album:", error);
      alert("Failed to update album");
    }
  }

  // Indexing functionality
  async startIndexing(albumKey, cardElement, isCorrupted = false) {
    // Prevent duplicate indexing requests (local guard)
    if (this.progressPollers.has(albumKey)) {
      console.log(`Indexing already in progress for album: ${albumKey}`);
      return;
    }

    // Provide immediate feedback while the indexing request is being processed
    const createBtn = cardElement.querySelector(".create-index-btn");
    const originalBtnText = createBtn.textContent;
    createBtn.textContent = "Update Pending...";
    createBtn.disabled = true;

    // Backend guard: check if indexing is already running
    try {
      const progress = await fetchJson(`index_progress/${albumKey}`);
      if (progress.status === "indexing" || progress.status === "scanning" || progress.status === "mapping") {
        console.log(`Backend reports indexing already in progress for album: ${albumKey}`);
        this.showProgressUIWithoutScroll(cardElement, progress);
        this.startProgressPolling(albumKey, cardElement);
        return;
      }
    } catch {
      console.debug(`Could not check backend indexing status for album: ${albumKey}`);
    }

    if (isCorrupted) {
      console.log(`Starting indexing for corrupted album: ${albumKey}`);
      const response = await removeIndex(albumKey);
      console.log(`Remove index response:`, response);
      if (!response.success) {
        const album = await this.getAlbum(albumKey);
        alert(
          `Failed to remove corrupted index for album: ${albumKey}.` +
            ` Please remove the index file manually and try again.` +
            ` The path for the index file is: ${album.index}`
        );
        createBtn.textContent = originalBtnText;
        createBtn.disabled = false;
        await this.handleIndexingCompletion(albumKey, cardElement);
        return;
      }
    }
    const progress = await updateIndex(albumKey);
    if (!progress) {
      createBtn.textContent = originalBtnText;
      createBtn.disabled = false;
      return;
    }
    this.showProgressUIWithoutScroll(cardElement, progress);
    this.startProgressPolling(albumKey, cardElement);
  }

  showProgressUI(cardElement) {
    this.showProgressUIWithoutScroll(cardElement);

    setTimeout(() => {
      const indexingSection = cardElement.querySelector(".indexing-section");
      indexingSection.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
    }, AlbumManager.SCROLL_DELAY);
  }

  showProgressUIWithoutScroll(cardElement, progress = null) {
    const createBtn = cardElement.querySelector(".create-index-btn");
    createBtn.disabled = true; // Disable while indexing

    const progressContainer = cardElement.querySelector(".progress-container");
    const cancelBtn = cardElement.querySelector(".cancel-index-btn");
    const status = cardElement.querySelector(".index-status");

    progressContainer.style.display = "block";
    createBtn.style.display = "none";
    cancelBtn.style.display = "inline-block";

    // Only set generic message if no progress data is provided
    if (!progress) {
      status.className = AlbumManager.STATUS_CLASSES.INDEXING;
      status.textContent = "Indexing in progress...";
    } else {
      // Use the actual progress data to show proper status
      this.updateProgress(cardElement, progress);
    }
  }

  hideProgressUI(cardElement) {
    const createBtn = cardElement.querySelector(".create-index-btn");
    createBtn.disabled = false; // Re-enable when done

    const progressContainer = cardElement.querySelector(".progress-container");
    const cancelBtn = cardElement.querySelector(".cancel-index-btn");

    progressContainer.style.display = "none";
    cancelBtn.style.display = "none";
  }

  // loadAlbums() rebuilds the card list wholesale, and several flows do
  // that while indexing is running (album add, edit save, the auto-index
  // event handler). A card element captured at kickoff may therefore be
  // detached by the time a poll tick fires — updating it paints a node
  // nobody sees while the on-screen card stays frozen. Always resolve the
  // album's live card by key, falling back to the captured element.
  _liveCardFor(albumKey, fallback = null) {
    return document.querySelector(`.album-card[data-album-key="${albumKey}"]`) || fallback;
  }

  startProgressPolling(albumKey, cardElement) {
    if (this.progressPollers.has(albumKey)) {
      console.log(`Already polling progress for album: ${albumKey}`);
      return;
    }

    const interval = setInterval(async () => {
      try {
        const progress = await fetchJson(`index_progress/${albumKey}`);

        const liveCard = this._liveCardFor(albumKey, cardElement);
        this.updateProgress(liveCard, progress);

        if (progress.status === "completed" || progress.status === "error") {
          clearInterval(interval);
          this.progressPollers.delete(albumKey);

          if (progress.status === "completed") {
            await this.handleIndexingCompletion(albumKey, liveCard);
          }

          setTimeout(() => {
            this.hideProgressUI(this._liveCardFor(albumKey, liveCard));
          }, AlbumManager.PROGRESS_HIDE_DELAY);
        }
      } catch (error) {
        console.error("Failed to get progress:", error);
        clearInterval(interval);
        this.progressPollers.delete(albumKey);
      }
    }, AlbumManager.POLL_INTERVAL);

    this.progressPollers.set(albumKey, interval);
  }

  async handleIndexingCompletion(albumKey, cardElement = null) {
    await loadAvailableAlbums();
    this.showIndexingCompletedUI(cardElement);

    if (albumKey === state.album) {
      console.log(`Refreshing slideshow for completed indexing of current album: ${albumKey}`);
      this.single_swiper.resetAllSlides();
    }

    // After a delay set the status
    if (cardElement) {
      setTimeout(async () => {
        const album = await this.getCurrentAlbum(albumKey);
        this.updateAlbumCardIndexStatus(cardElement, album);
      }, 2000);
    }

    // If in setup mode, set the album and exit setup mode
    if (this.isSetupMode) {
      await setAlbum(albumKey); // This will trigger the slideshow to start
      this.isSetupMode = false;
      this.enableClosing();
      this.removeSetupMessage();
      // Now close the album manager window after a short delay
      setTimeout(async () => {
        this.completeSetupMode();
        this.hide();
        // send the albumChanged message
        const album = await getIndexMetadata(albumKey);
        window.dispatchEvent(
          new CustomEvent("albumChanged", {
            detail: {
              totalImages: album ? album.filename_count : 0,
            },
          })
        );
      }, AlbumManager.AUTO_INDEXING_DELAY);
    }

    // Remove from autoIndexingAlbums set so future errors can trigger again
    this.autoIndexingAlbums.delete(albumKey);

    // --- Restore UI state ---
    if (cardElement) {
      // Show the "Update Index" button
      const createBtn = cardElement.querySelector(".create-index-btn");
      if (createBtn) {
        createBtn.style.display = "inline-block";
        createBtn.disabled = false;
      }

      // Remove error message if present
      const errorDiv = cardElement.querySelector(".album-error-message");
      if (errorDiv) {
        errorDiv.remove();
      }
    }
    if (albumKey === state.album) {
      const album = await getIndexMetadata(albumKey);
      window.dispatchEvent(
        new CustomEvent("albumChanged", {
          detail: {
            totalImages: album ? album.filename_count : 0,
          },
        })
      );
    }
  }

  updateProgress(cardElement, progress) {
    const progressBar = cardElement.querySelector(".progress-bar");
    const progressText = cardElement.querySelector(".progress-text");
    const status = cardElement.querySelector(".index-status");
    const estimatedTime = cardElement.querySelector(".estimated-time");

    // Defensive: ensure progress_percentage is a number between 0 and 100
    let percentage = Number(progress.progress_percentage);
    if (isNaN(percentage) || percentage < 0) {
      percentage = 0;
    }
    if (percentage > 100) {
      percentage = 100;
    }
    progressBar.style.width = `${percentage}%`;
    progressText.textContent = `${Math.round(percentage)}%`;

    // Defensive: ensure current_step is a string
    if (typeof progress.current_step !== "string" || !progress.current_step) {
      progress.current_step = "Indexing in progress...";
    }

    // Update estimated time remaining
    if (progress.estimated_time_remaining !== null && progress.estimated_time_remaining !== undefined) {
      const timeRemaining = this.formatTimeRemaining(progress.estimated_time_remaining);
      estimatedTime.textContent = `Estimated time remaining: ${timeRemaining}`;
    } else {
      estimatedTime.textContent = "";
    }

    this.updateProgressStatus(status, progress, estimatedTime);
  }

  updateProgressStatus(status, progress, estimatedTime) {
    if (progress.status === "completed") {
      status.className = AlbumManager.STATUS_CLASSES.COMPLETED;
      status.textContent = "Indexing completed successfully";
      status.style.color = "green";
      estimatedTime.textContent = "";
    } else if (progress.status === "error") {
      status.className = AlbumManager.STATUS_CLASSES.ERROR;
      status.textContent = `Error: ${progress.error_message}`;
      status.style.color = "#b00020"; // Explicit red
      estimatedTime.textContent = "";
      // Detect the specific error of empty or invalid image directory and dispatch a custom event
      if (progress.error_message && progress.error_message.includes("No image files found")) {
        window.dispatchEvent(
          new CustomEvent("albumIndexingNoImages", {
            detail: { albumKey: progress.album_key },
          })
        );
      }
    } else if (progress.status === "scanning") {
      status.className = AlbumManager.STATUS_CLASSES.INDEXING;
      status.textContent = progress.current_step || "Scanning for images...";
      status.style.color = "#ff9800"; // Orange for scanning
      estimatedTime.textContent = "";
    } else if (progress.status === "downloading") {
      // First-use model download. The bar width/percent and ETA are already set
      // from progress_percentage/estimated_time_remaining in updateProgress();
      // here we just label the phase and leave the ETA line in place.
      status.className = AlbumManager.STATUS_CLASSES.DOWNLOADING;
      status.textContent = progress.current_step || "Downloading encoder model…";
      status.style.color = "#9c27b0"; // Purple for downloading
    } else if (progress.status === "mapping") {
      status.className = AlbumManager.STATUS_CLASSES.UMAPPING;
      status.textContent = progress.current_step || "Generating image map...";
      status.style.color = "#2196f3"; // Blue for umapping
      estimatedTime.textContent = "";
    } else {
      // Defensive: fallback to 0 if undefined
      const processed = progress.images_processed ?? 0;
      const total = progress.total_images ?? 0;
      status.textContent = `${progress.current_step} (${processed}/${total})`;
      status.className = AlbumManager.STATUS_CLASSES.DEFAULT;
      status.style.color = ""; // Use default color
    }
  }

  async cancelIndexing(albumKey, cardElement) {
    try {
      await fetchJson(`cancel_index/${albumKey}`, { method: "DELETE" });
      // Stop polling
      if (this.progressPollers.has(albumKey)) {
        clearInterval(this.progressPollers.get(albumKey));
        this.progressPollers.delete(albumKey);
      }

      this.hideProgressUI(cardElement);

      const status = cardElement.querySelector(".index-status");
      status.className = AlbumManager.STATUS_CLASSES.DEFAULT;
      status.textContent = "Operation cancelled";
    } catch (error) {
      console.error("Failed to cancel indexing:", error);
    }

    // Remove from autoIndexingAlbums set so future errors can trigger again
    this.autoIndexingAlbums.delete(albumKey);
  }

  async checkForOngoingIndexing() {
    const albumCards = this.albumsList.querySelectorAll(".album-card");

    const checkPromises = Array.from(albumCards).map(async (cardElement) => {
      const albumKey = cardElement.dataset.albumKey;

      try {
        const progress = await fetchJson(`index_progress/${albumKey}`);

        if (progress.status === "indexing" || progress.status === "scanning") {
          console.log(`Restoring progress UI for ongoing operation: ${albumKey} (${progress.status})`);

          this.showProgressUIWithoutScroll(cardElement, progress);
          this.startProgressPolling(albumKey, cardElement);
          this.updateProgress(cardElement, progress);

          return { albumKey, restored: true };
        }
      } catch {
        console.debug(`No ongoing operation for album: ${albumKey}`);
      }

      return { albumKey, restored: false };
    });

    const results = await Promise.all(checkPromises);
    const restoredCount = results.filter((r) => r.restored).length;

    if (restoredCount > 0) {
      console.log(`Restored progress UI for ${restoredCount} ongoing operation(s)`);
    }
  }

  // Utility methods
  formatTimeRemaining(seconds) {
    if (seconds < 0 || !isFinite(seconds)) {
      return "Calculating...";
    }

    if (seconds < 60) {
      return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = Math.round(seconds % 60);
      return `${minutes}m ${remainingSeconds}s`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }
  }

  showAlbumSwitchNotification(newAlbumName) {
    const notification = document.createElement("div");
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #ff9800;
      color: white;
      padding: 1em;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      z-index: 4000;
      max-width: 300px;
    `;

    notification.innerHTML = `
      <div>
        <strong>Album switched to "${newAlbumName}"</strong><br>
        <small>The previous album was deleted</small>
      </div>
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, AlbumManager.SETUP_EXIT_DELAY);
  }

  relativePath(fullPath, album) {
    // Get the current album's image_paths from state or settings
    const imagePaths = album.image_paths || [];

    // Try to make fullPath relative to any image path
    for (const imagePath of imagePaths) {
      // Normalize paths to handle
      if (fullPath.startsWith(imagePath)) {
        // Remove the imagePath prefix and any leading slash
        let rel = fullPath.slice(imagePath.length);
        if (rel.startsWith("/") || rel.startsWith("\\")) {
          rel = rel.slice(1);
        }
        return rel;
      }
    }
    // If not found, return the basename
    return fullPath.split("/").pop();
  }

  async getCurrentAlbum(albumKey = null) {
    // Get the current album key from state
    albumKey = albumKey || state.album;
    if (!albumKey) {
      return null;
    }

    // Fetch albums from the backend
    const albums = await fetchJson("available_albums/");

    // Find the album with the matching key
    const album = albums.find((a) => a.key === albumKey);
    return album || null;
  }

  setSwiperManager(swiperManager) {
    this.single_swiper = swiperManager;
  }
}

// Check for existence of an album index
export async function checkAlbumIndex() {
  const albumKey = state.album;
  if (!albumKey) {
    return;
  }

  // Fetch album info from backend
  const albums = await fetchJson("available_albums/");
  const album = albums.find((a) => a.key === albumKey);

  if (!album) {
    return;
  }

  // Check if index file exists (ask backend or check album.index)
  const indexExists = (await fetchJson(`index_exists/${albumKey}`)).exists;

  if (!indexExists) {
    alert("This album needs to be indexed before you can use it. Please build/update the index.");
    albumManager.show();
    setTimeout(() => {
      const cardElement = document.querySelector(`.album-card[data-album-key="${albumKey}"]`);
      if (cardElement) {
        albumManager.startIndexing(albumKey, cardElement);
        albumManager.showProgressUI(cardElement);
      }
    }, 500);
    return;
  }

  // If we get here, the index exists, but may not contain any slides.
  // Check if index contains any slides/images
  const indexMetadata = await getIndexMetadata(albumKey);
  const totalImages = indexMetadata.filename_count ?? 0;

  if (totalImages === 0) {
    alert(
      `The album named "${album.name}" contains no images. Please check that it contains at least one directory of images, then reindex if necessary.`
    );
    albumManager.show();
    setTimeout(() => {
      const cardElement = document.querySelector(`.album-card[data-album-key="${albumKey}"]`);
      if (cardElement) {
        albumManager.editAlbum(cardElement, album); // Open card for edit
        cardElement.scrollIntoView({ behavior: "smooth", block: "center" }); // Autoscroll to card
      }
    }, 500);
    return;
  }
}

// singleton exported to other js modules
export const albumManager = new AlbumManager();
