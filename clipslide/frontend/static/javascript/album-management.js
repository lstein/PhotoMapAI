// album-management.js
import { exitSearchMode } from "./search.js";
import { loadAvailableAlbums } from "./settings.js";
import { saveSettingsToLocalStorage, state } from "./state.js";
import { removeSlidesAfterCurrent, resetAllSlides } from "./swiper.js";

export class AlbumManager {
  // Constants
  static POLL_INTERVAL = 1000;
  static PROGRESS_HIDE_DELAY = 3000;
  static AUTO_INDEX_DELAY = 500;
  static SETUP_EXIT_DELAY = 5000;
  static FORM_ANIMATION_DELAY = 300;
  static SCROLL_DELAY = 100;

  static STATUS_CLASSES = {
    INDEXING: "index-status indexing",
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
      newAlbumPaths: document.getElementById("newAlbumPaths"),
      albumSelect: document.getElementById("albumSelect"),
      slideshowTitle: document.getElementById("slideshow_title"),
      albumManagementContent: document.querySelector("#albumManagementContent"),
    };

    this.progressPollers = new Map();
    this.isSetupMode = false;

    this.initializeEventListeners();

    window.addEventListener("noAlbumsFound", () => {
      this.enterSetupMode();
    });
  }

  initializeEventListeners() {
    // Main management button
    document.getElementById("manageAlbumsBtn").addEventListener("click", () => {
      this.show();
    });

    // Close button
    document
      .getElementById("closeAlbumManagementBtn")
      .addEventListener("click", () => {
        this.hide();
      });

    // Show add album form button
    document.getElementById("showAddAlbumBtn").addEventListener("click", () => {
      this.showAddAlbumForm();
    });

    // Cancel add album buttons (both X and Cancel button)
    document
      .getElementById("cancelAddAlbumBtn")
      .addEventListener("click", () => {
        this.hideAddAlbumForm();
      });

    document
      .getElementById("cancelAddAlbumBtn2")
      .addEventListener("click", () => {
        this.hideAddAlbumForm();
      });

    // Add album button
    document.getElementById("addAlbumBtn").addEventListener("click", () => {
      this.addAlbum();
    });

    // Click outside to close
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });
  }

  // Utility methods
  async fetchAvailableAlbums() {
    const response = await fetch("available_albums/");
    return await response.json();
  }

  async refreshAlbumsAndDropdown() {
    await this.loadAlbums();
    await loadAvailableAlbums();
  }

  async updateCurrentAlbum(album) {
    // Update state and localStorage
    state.album = album.key;
    state.embeddingsFile = album.embeddings_file;
    saveSettingsToLocalStorage();

    // Update settings dropdown
    await loadAvailableAlbums();

    // Update page title
    if (this.elements.slideshowTitle) {
      this.elements.slideshowTitle.textContent = `Slideshow - ${album.name}`;
    }

    // Refresh slideshow
    resetAllSlides();
  }

  getNewAlbumFormData() {
    return {
      key: this.elements.newAlbumKey.value.trim(),
      name: this.elements.newAlbumName.value.trim(),
      description: this.elements.newAlbumDescription.value.trim(),
      pathsText: this.elements.newAlbumPaths.value.trim(),
    };
  }

  clearAddAlbumForm() {
    this.elements.newAlbumKey.value = "";
    this.elements.newAlbumName.value = "";
    this.elements.newAlbumDescription.value = "";
    this.elements.newAlbumPaths.value = "";
  }

  // Form management
  showAddAlbumForm() {
    this.addAlbumSection.style.display = "block";
    this.addAlbumSection.classList.remove("slide-up");
    this.addAlbumSection.classList.add("slide-down");

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

  // Main show/hide methods
  async show() {
    await this.loadAlbums();
    this.overlay.classList.add("visible");

    // Ensure add album form is hidden when opening normally
    if (!this.isSetupMode) {
      this.addAlbumSection.style.display = "none";
      this.addAlbumSection.classList.remove("slide-down", "slide-up");
    }

    // Check for ongoing indexing operations
    await this.checkForOngoingIndexing();
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
    console.log("Entering setup mode - no albums found");
    this.isSetupMode = true;

    await this.show();
    this.showAddAlbumForm();
    this.showSetupMessage();
    this.disableClosing();
  }

  showSetupMessage() {
    const existingMessage = this.overlay.querySelector(".setup-message");
    if (existingMessage) return;

    const setupMessage = this.createSetupMessage();
    if (this.elements.albumManagementContent) {
      this.elements.albumManagementContent.insertBefore(
        setupMessage,
        this.elements.albumManagementContent.firstChild
      );
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
      <h3 style="margin: 0 0 0.5em 0;">Welcome to SlideShow!</h3>
      <p style="margin: 0;">
        To get started, please add your first album below. 
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

  createCompletionMessage() {
    const completionMessage = document.createElement("div");
    completionMessage.style.cssText = `
      background: #4caf50;
      color: white;
      padding: 1em;
      border-radius: 8px;
      margin-bottom: 1em;
      text-align: center;
    `;
    completionMessage.innerHTML = `
      <h4 style="margin: 0 0 0.5em 0;">✅ Setup Complete!</h4>
      <p style="margin: 0;">
        Your album "${state.album}" is being indexed and is now active. 
        Once indexing completes, you can close this manager and start using the slideshow.
      </p>
    `;
    return completionMessage;
  }

  showCompletionMessage() {
    const completionMessage = this.createCompletionMessage();
    if (this.elements.albumManagementContent) {
      this.elements.albumManagementContent.insertBefore(
        completionMessage,
        this.elements.albumManagementContent.firstChild
      );
    }
    return completionMessage;
  }

  scheduleSetupModeExit(completionMessage) {
    setTimeout(() => {
      this.isSetupMode = false;
      this.enableClosing();
      if (completionMessage && completionMessage.parentNode) {
        completionMessage.remove();
      }
    }, AlbumManager.SETUP_EXIT_DELAY);
  }

  async completeSetupMode() {
    this.removeSetupMessage();

    try {
      const albums = await this.fetchAvailableAlbums();
      if (albums.length > 0) {
        await this.updateCurrentAlbum(albums[0]);
      }
    } catch (error) {
      console.error("Failed to set up new album:", error);
    }

    const completionMessage = this.showCompletionMessage();
    this.scheduleSetupModeExit(completionMessage);
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
    card.querySelector(".album-name").textContent =
      album.name || "Unknown Album";
    card.querySelector(".album-key").textContent = `Key: ${
      album.key || "Unknown"
    }`;
    card.querySelector(".album-description").textContent =
      album.description || "No description";

    const imagePaths = album.image_paths || [];
    card.querySelector(".album-paths").textContent = `Paths: ${
      imagePaths.join(", ") || "No paths configured"
    }`;

    // Set up event listeners
    const cardElement = card.querySelector(".album-card");
    cardElement.dataset.albumKey = album.key;

    this.attachCardEventListeners(card, cardElement, album);
    this.albumsList.appendChild(card);
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

    if (!formData.key || !formData.name || !formData.pathsText) {
      alert("Please fill in all required fields");
      return;
    }

    const paths = formData.pathsText
      .split("\n")
      .map((path) => path.trim())
      .filter((path) => path.length > 0);

    const newAlbum = {
      key: formData.key,
      name: formData.name,
      description: formData.description,
      image_paths: paths,
      index: `${paths[0]}/embeddings.npz`,
    };

    try {
      const response = await fetch("add_album/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newAlbum),
      });

      if (response.ok) {
        await this.handleSuccessfulAlbumAdd(formData.key);
      } else {
        alert("Failed to add album");
      }
    } catch (error) {
      console.error("Failed to add album:", error);
      alert("Failed to add album");
    }
  }

  async handleSuccessfulAlbumAdd(albumKey) {
    this.hideAddAlbumForm();
    await this.loadAlbums();

    if (this.isSetupMode) {
      await this.completeSetupMode();
    }

    await this.startAutoIndexing(albumKey);
  }

  async startAutoIndexing(albumKey) {
    const albumCard = Array.from(
      this.albumsList.querySelectorAll(".album-card")
    ).find((card) => card.dataset.albumKey === albumKey);

    if (albumCard) {
      const status = albumCard.querySelector(".index-status");
      status.textContent = "Auto-starting indexing for new album...";
      status.className = AlbumManager.STATUS_CLASSES.INDEXING;

      setTimeout(async () => {
        await this.startIndexing(albumKey, albumCard);
        this.showProgressUI(albumCard); // <-- Scroll into view after starting indexing
      }, AlbumManager.AUTO_INDEX_DELAY);
    }
  }

  async deleteAlbum(albumKey) {
    if (
      !confirm(
        `Are you sure you want to delete album "${albumKey}"? This action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      const response = await fetch(`delete_album/${albumKey}`, {
        method: "DELETE",
      });

      if (response.ok) {
        const isCurrentAlbum = state.album === albumKey;
        await this.refreshAlbumsAndDropdown();

        if (isCurrentAlbum) {
          await this.handleDeletedCurrentAlbum();
        }
      } else {
        alert("Failed to delete album");
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
        removeSlidesAfterCurrent();

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

    // Populate edit form
    editForm.querySelector(".edit-album-name").value = album.name;
    editForm.querySelector(".edit-album-description").value =
      album.description || "";
    editForm.querySelector(".edit-album-paths").value = (
      album.image_paths || []
    ).join("\n");

    // Show edit form
    albumInfo.style.display = "none";
    editForm.style.display = "block";

    // Attach event listeners
    editForm.querySelector(".save-album-btn").onclick = () => {
      this.saveAlbumChanges(cardElement, album);
    };

    editForm.querySelector(".cancel-edit-btn").onclick = () => {
      albumInfo.style.display = "block";
      editForm.style.display = "none";
    };
  }

  async saveAlbumChanges(cardElement, album) {
    const editForm = cardElement.querySelector(".edit-form");

    const updatedAlbum = {
      key: album.key,
      name: editForm.querySelector(".edit-album-name").value,
      description: editForm.querySelector(".edit-album-description").value,
      image_paths: editForm
        .querySelector(".edit-album-paths")
        .value.split("\n")
        .map((path) => path.trim())
        .filter((path) => path.length > 0),
      index: album.embeddings_file,
    };

    try {
      const response = await fetch("update_album/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedAlbum),
      });

      if (response.ok) {
        await this.refreshAlbumsAndDropdown();
      } else {
        alert("Failed to update album");
      }
    } catch (error) {
      console.error("Failed to update album:", error);
      alert("Failed to update album");
    }
  }

  // Indexing functionality
  async startIndexing(albumKey, cardElement) {
    try {
      const response = await fetch("update_index_async/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `album_key=${encodeURIComponent(albumKey)}`,
      });

      if (response.ok) {
        const progress = await response.json();
        this.showProgressUIWithoutScroll(cardElement, progress);
        this.startProgressPolling(albumKey, cardElement);
      } else {
        alert("Failed to start indexing");
      }
    } catch (error) {
      console.error("Failed to start indexing:", error);
      alert("Failed to start indexing");
    }
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
    const progressContainer = cardElement.querySelector(".progress-container");
    const createBtn = cardElement.querySelector(".create-index-btn");
    const cancelBtn = cardElement.querySelector(".cancel-index-btn");
    const status = cardElement.querySelector(".index-status");
    const estimatedTime = cardElement.querySelector(".estimated-time");

    progressContainer.style.display = "block";
    createBtn.style.display = "none";
    cancelBtn.style.display = "inline-block";

    status.className = AlbumManager.STATUS_CLASSES.INDEXING;
    status.textContent = "Indexing in progress...";
  }

  hideProgressUI(cardElement) {
    const progressContainer = cardElement.querySelector(".progress-container");
    const createBtn = cardElement.querySelector(".create-index-btn");
    const cancelBtn = cardElement.querySelector(".cancel-index-btn");

    progressContainer.style.display = "none";
    createBtn.style.display = "inline-block";
    cancelBtn.style.display = "none";
  }

  startProgressPolling(albumKey, cardElement) {
    if (this.progressPollers.has(albumKey)) {
      console.log(`Already polling progress for album: ${albumKey}`);
      return;
    }

    const interval = setInterval(async () => {
      try {
        const response = await fetch(`index_progress/${albumKey}`);
        const progress = await response.json();

        this.updateProgress(cardElement, progress);

        if (progress.status === "completed" || progress.status === "error") {
          clearInterval(interval);
          this.progressPollers.delete(albumKey);

          if (progress.status === "completed") {
            await this.handleIndexingCompletion(albumKey);
          }

          setTimeout(() => {
            this.hideProgressUI(cardElement);
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

  async handleIndexingCompletion(albumKey) {
    await loadAvailableAlbums();

    if (albumKey === state.album) {
      console.log(
        `Refreshing slideshow for completed indexing of current album: ${albumKey}`
      );
      resetAllSlides();
    }
  }

  updateProgress(cardElement, progress) {
    const progressBar = cardElement.querySelector(".progress-bar");
    const progressText = cardElement.querySelector(".progress-text");
    const status = cardElement.querySelector(".index-status");
    const estimatedTime = cardElement.querySelector(".estimated-time");

    progressBar.style.width = `${progress.progress_percentage}%`;
    progressText.textContent = `${Math.round(progress.progress_percentage)}%`;

    // Update estimated time remaining
    if (
      progress.estimated_time_remaining !== null &&
      progress.estimated_time_remaining !== undefined
    ) {
      const timeRemaining = this.formatTimeRemaining(
        progress.estimated_time_remaining
      );
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
      estimatedTime.textContent = "";
    } else if (progress.status === "error") {
      status.className = AlbumManager.STATUS_CLASSES.ERROR;
      status.textContent = `Error: ${progress.error_message}`;
      estimatedTime.textContent = "";
    } else if (progress.status === "scanning") {
      status.className = AlbumManager.STATUS_CLASSES.INDEXING;
      status.textContent = progress.current_step || "Scanning for images...";
      estimatedTime.textContent = "";
    } else {
      // Defensive: fallback to 0 if undefined
      const processed = progress.images_processed ?? 0;
      const total = progress.total_images ?? 0;
      status.textContent = `${progress.current_step} (${processed}/${total})`;
    }
  }

  async cancelIndexing(albumKey, cardElement) {
    try {
      const response = await fetch(`cancel_index/${albumKey}`, {
        method: "DELETE",
      });

      if (response.ok) {
        // Stop polling
        if (this.progressPollers.has(albumKey)) {
          clearInterval(this.progressPollers.get(albumKey));
          this.progressPollers.delete(albumKey);
        }

        this.hideProgressUI(cardElement);

        const status = cardElement.querySelector(".index-status");
        status.className = AlbumManager.STATUS_CLASSES.DEFAULT;
        status.textContent = "Operation cancelled";
      }
    } catch (error) {
      console.error("Failed to cancel indexing:", error);
    }
  }

  async checkForOngoingIndexing() {
    const albumCards = this.albumsList.querySelectorAll(".album-card");

    const checkPromises = Array.from(albumCards).map(async (cardElement) => {
      const albumKey = cardElement.dataset.albumKey;

      try {
        const response = await fetch(`index_progress/${albumKey}`);

        if (response.ok) {
          const progress = await response.json();

          if (
            progress.status === "indexing" ||
            progress.status === "scanning"
          ) {
            console.log(
              `Restoring progress UI for ongoing operation: ${albumKey} (${progress.status})`
            );

            this.showProgressUIWithoutScroll(cardElement, progress);
            this.startProgressPolling(albumKey, cardElement);
            this.updateProgress(cardElement, progress);

            return { albumKey, restored: true };
          }
        }
      } catch (error) {
        console.debug(`No ongoing operation for album: ${albumKey}`);
      }

      return { albumKey, restored: false };
    });

    const results = await Promise.all(checkPromises);
    const restoredCount = results.filter((r) => r.restored).length;

    if (restoredCount > 0) {
      console.log(
        `Restored progress UI for ${restoredCount} ongoing operation(s)`
      );
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
}

// Initialize when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new AlbumManager();
});
