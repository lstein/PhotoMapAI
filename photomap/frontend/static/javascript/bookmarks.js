// bookmarks.js
// This file manages bookmark functionality for the application.
// Bookmarks are stored per-album in localStorage and persist across sessions.

import { showDeleteConfirmModal } from "./control-panel.js";
import { createSimpleDirectoryPicker } from "./filetree.js";
import { showConfirmModal } from "./modal-utils.js";
import { setSearchResults } from "./search.js";
import { slideState } from "./slide-state.js";
import { state } from "./state.js";
import { hideSpinner, setCheckmarkOnIcon, showSpinner } from "./utils.js";

// SVG icons for bookmark actions
const BOOKMARK_SVG = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
</svg>`;

const BOOKMARK_FILLED_SVG = `<svg width="32" height="32" viewBox="0 0 24 24" fill="#ffc107" stroke="#ffc107" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
</svg>`;

const SHOW_SVG = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
  <circle cx="12" cy="12" r="3"/>
</svg>`;

const DOWNLOAD_SVG = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="7 10 12 15 17 10"/>
  <line x1="12" y1="15" x2="12" y2="3"/>
</svg>`;

const DELETE_SVG = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="3 6 5 6 21 6"/>
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  <line x1="10" y1="11" x2="10" y2="17"/>
  <line x1="14" y1="11" x2="14" y2="17"/>
</svg>`;

const CLEAR_SVG = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <line x1="18" y1="6" x2="6" y2="18"/>
  <line x1="6" y1="6" x2="18" y2="18"/>
</svg>`;

const MOVE_SVG = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
  <polyline points="9 22 9 12 15 12 15 22"/>
</svg>`;

const EXPORT_SVG = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="17 8 12 3 7 8"/>
  <line x1="12" y1="3" x2="12" y2="15"/>
</svg>`;

const HIDE_SVG = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
  <line x1="1" y1="1" x2="23" y2="23"/>
</svg>`;

const SELECT_ALL_SVG = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
  <polyline points="9 11 12 14 15 8"/>
</svg>`;

const CURATE_SVG = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 20h9"/>
  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
</svg>`;

class BookmarkManager {
  constructor() {
    if (BookmarkManager.instance) {
      return BookmarkManager.instance;
    }

    this.bookmarks = new Set();
    this.isShowingBookmarks = false;
    this.previousSearchResults = null; // Store previous search results before showing bookmarks
    this.previousSearchType = null; // Store previous search type

    BookmarkManager.instance = this;
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Listen for album changes to load bookmarks for the new album
    window.addEventListener("albumChanged", () => {
      this.loadBookmarks();
      this.isShowingBookmarks = false;
      this.previousSearchResults = null;
      this.previousSearchType = null;
      this.updateBookmarkButton();
      this.updateAllBookmarkIcons();
    });

    // Listen for slide changes to update bookmark icons
    window.addEventListener("slideChanged", () => {
      this.updateAllBookmarkIcons();
    });

    // Listen for search results changes
    window.addEventListener("searchResultsChanged", (e) => {
      // If we were showing bookmarks and search changed, update state
      if (e.detail.searchType !== "bookmarks") {
        this.isShowingBookmarks = false;
        // Discard previous search results when a new search is performed
        this.previousSearchResults = null;
        this.previousSearchType = null;
        this.updateBookmarkButton();
      }
    });
  }

  /**
   * Get localStorage key for current album
   */
  getStorageKey() {
    if (!state.album) {
      return null;
    }
    return `photomap_bookmarks_${state.album}`;
  }

  /**
   * Load bookmarks from localStorage for current album
   */
  loadBookmarks() {
    const key = this.getStorageKey();
    if (!key) {
      this.bookmarks = new Set();
      return;
    }

    try {
      const stored = localStorage.getItem(key);
      if (stored) {
        const indices = JSON.parse(stored);
        this.bookmarks = new Set(indices);
      } else {
        this.bookmarks = new Set();
      }
    } catch (e) {
      console.warn("Failed to load bookmarks:", e);
      this.bookmarks = new Set();
    }

    this.updateBookmarkButton();
  }

  /**
   * Save bookmarks to localStorage for current album
   */
  saveBookmarks() {
    const key = this.getStorageKey();
    if (!key) {
      return;
    }

    try {
      const indices = Array.from(this.bookmarks);
      localStorage.setItem(key, JSON.stringify(indices));
    } catch (e) {
      console.warn("Failed to save bookmarks:", e);
    }

    this.updateBookmarkButton();
    window.dispatchEvent(
      new CustomEvent("bookmarksChanged", {
        detail: { count: this.bookmarks.size },
      })
    );
  }

  /**
   * Toggle bookmark for a specific image index
   */
  toggleBookmark(globalIndex) {
    if (this.bookmarks.has(globalIndex)) {
      this.bookmarks.delete(globalIndex);
    } else {
      this.bookmarks.add(globalIndex);
    }
    this.saveBookmarks();
    this.updateAllBookmarkIcons();

    // Update the score display star if in single swiper view
    if (window.scoreDisplay) {
      const isBookmarked = this.isBookmarked(globalIndex);
      window.scoreDisplay.setBookmarkStatus(globalIndex, isBookmarked);
      window.scoreDisplay.refreshDisplay();
    }
  }

  /**
   * Check if an image is bookmarked
   */
  isBookmarked(globalIndex) {
    return this.bookmarks.has(globalIndex);
  }

  /**
   * Get count of bookmarks
   */
  getCount() {
    return this.bookmarks.size;
  }

  /**
   * Get all bookmarked indices
   */
  getBookmarkedIndices() {
    return Array.from(this.bookmarks).sort((a, b) => a - b);
  }

  /**
   * Clear all bookmarks
   */
  clearBookmarks() {
    this.bookmarks.clear();
    this.saveBookmarks();
    this.updateAllBookmarkIcons();
    this.updateBookmarkButton();

    // If we were showing bookmarks, restore previous search results (like hideBookmarkedImages)
    if (this.isShowingBookmarks) {
      this.isShowingBookmarks = false;
      this.removeBookmarkMenu();

      if (this.previousSearchResults !== null) {
        // Restore previous search results
        setSearchResults(this.previousSearchResults, this.previousSearchType || "search");
      } else {
        // Return to chronological mode (clear search)
        setSearchResults([], "clear");
      }

      // Clear stored previous results
      this.previousSearchResults = null;
      this.previousSearchType = null;
    }
  }

  /**
   * Remove a bookmark (used when image is deleted)
   */
  removeBookmark(globalIndex) {
    if (this.bookmarks.has(globalIndex)) {
      this.bookmarks.delete(globalIndex);
      // Adjust indices for images after the deleted one
      const newBookmarks = new Set();
      for (const idx of this.bookmarks) {
        if (idx > globalIndex) {
          newBookmarks.add(idx - 1);
        } else {
          newBookmarks.add(idx);
        }
      }
      this.bookmarks = newBookmarks;
      this.saveBookmarks();
    }
  }

  /**
   * Toggle bookmark on current image (keyboard shortcut)
   */
  toggleCurrentBookmark() {
    const { globalIndex } = slideState.getCurrentSlide();
    this.toggleBookmark(globalIndex);

    // Update the score display star if in single swiper view
    if (window.scoreDisplay) {
      const isBookmarked = this.isBookmarked(globalIndex);
      window.scoreDisplay.setBookmarkStatus(globalIndex, isBookmarked);
      window.scoreDisplay.refreshDisplay();
    }
  }

  /**
   * Update all bookmark icons in the current view
   * Only updates grid view bookmark icons (swiper view uses ScoreDisplay star)
   */
  updateAllBookmarkIcons() {
    // Update grid bookmark icons only (swiper view uses the star in ScoreDisplay)
    const gridSlides = document.querySelectorAll("#gridViewSwiperWrapper .swiper-slide");
    gridSlides.forEach((slide) => {
      const globalIndex = parseInt(slide.dataset.globalIndex, 10);
      if (!isNaN(globalIndex)) {
        this.updateSlideBookmarkIcon(slide, globalIndex);
      }
    });
  }

  /**
   * Update bookmark icon on a specific slide element
   */
  updateSlideBookmarkIcon(slideEl, globalIndex) {
    let bookmarkIcon = slideEl.querySelector(".bookmark-icon");

    if (!bookmarkIcon) {
      // Create bookmark icon if it doesn't exist
      bookmarkIcon = document.createElement("button");
      bookmarkIcon.className = "bookmark-icon";
      bookmarkIcon.title = "Toggle bookmark";
      bookmarkIcon.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleBookmark(globalIndex);
      });
      slideEl.style.position = "relative";
      slideEl.appendChild(bookmarkIcon);
    }

    // Update icon state
    const isBookmarked = this.isBookmarked(globalIndex);
    bookmarkIcon.innerHTML = isBookmarked ? BOOKMARK_FILLED_SVG : BOOKMARK_SVG;
    bookmarkIcon.classList.toggle("bookmarked", isBookmarked);
  }

  /**
   * Add bookmark icon to a slide (called when slides are created)
   */
  addBookmarkIconToSlide(slideEl, globalIndex) {
    this.updateSlideBookmarkIcon(slideEl, globalIndex);
  }

  /**
   * Update the main bookmark button in search panel
   */
  updateBookmarkButton() {
    const btn = document.getElementById("bookmarkMenuBtn");
    if (!btn) {
      return;
    }

    const count = this.getCount();
    const iconSpan = btn.querySelector("#bookmarkMenuIcon");

    if (count > 0) {
      iconSpan.innerHTML = BOOKMARK_FILLED_SVG;
      btn.title = `Bookmarks (${count})`;
    } else {
      iconSpan.innerHTML = BOOKMARK_SVG;
      btn.title = "Bookmarks (none)";
    }

    // Update checkmark if showing bookmarks
    setCheckmarkOnIcon(btn, this.isShowingBookmarks);
  }

  // === Bookmark Actions ===

  /**
   * Show bookmarked images as search results
   */
  showBookmarkedImages() {
    const indices = this.getBookmarkedIndices();
    if (indices.length === 0) {
      alert("No images are bookmarked.");
      return;
    }

    // Save previous search results before showing bookmarks
    // If we're in search mode, save current results; otherwise save null (chronological mode)
    if (slideState.isSearchMode && !this.isShowingBookmarks) {
      this.previousSearchResults = [...slideState.searchResults];
      this.previousSearchType = state.searchType || "search";
    } else if (!this.isShowingBookmarks) {
      // We're in chronological mode
      this.previousSearchResults = null;
      this.previousSearchType = null;
    }

    // Create search results from bookmarked indices
    const results = indices.map((index) => ({
      index: index,
      score: 1.0,
      cluster: null,
      color: "#ffc107",
    }));

    this.isShowingBookmarks = true;
    setSearchResults(results, "bookmarks");
    this.updateBookmarkButton();
    this.removeBookmarkMenu();
  }

  /**
   * Hide bookmarked images and restore previous search results
   */
  hideBookmarkedImages() {
    this.isShowingBookmarks = false;
    this.removeBookmarkMenu();

    if (this.previousSearchResults !== null) {
      // Restore previous search results
      setSearchResults(this.previousSearchResults, this.previousSearchType || "search");
    } else {
      // Return to chronological mode (clear search)
      setSearchResults([], "clear");
    }

    // Clear stored previous results
    this.previousSearchResults = null;
    this.previousSearchType = null;
    this.updateBookmarkButton();
  }

  /**
   * Bookmark all images in the current search results
   */
  selectAllFromSearch() {
    if (!slideState.isSearchMode) {
      alert("Select All is only available when viewing search results.");
      return;
    }
    if (slideState.searchResults.length === 0) {
      alert("No search results available to bookmark.");
      return;
    }

    // Add all search result indices to bookmarks
    for (const result of slideState.searchResults) {
      this.bookmarks.add(result.index);
    }

    this.saveBookmarks();
    this.updateAllBookmarkIcons();
    this.removeBookmarkMenu();
  }

  /**
   * Download bookmarked images
   */
  async downloadBookmarkedImages() {
    const indices = this.getBookmarkedIndices();
    if (indices.length === 0) {
      alert("No images are bookmarked.");
      return;
    }

    showSpinner();
    this.removeBookmarkMenu();

    try {
      if (indices.length === 1) {
        // Single image - direct download
        await this.downloadSingleImage(indices[0]);
      } else {
        // Multiple images - download as ZIP
        await this.downloadAsZip(indices);
      }
    } catch (error) {
      console.error("Download failed:", error);
      alert(`Download failed: ${error.message}`);
    } finally {
      hideSpinner();
    }
  }

  async downloadSingleImage(globalIndex) {
    const response = await fetch(`retrieve_image/${encodeURIComponent(state.album)}/${globalIndex}`);
    if (!response.ok) {
      throw new Error("Failed to fetch image info");
    }

    const data = await response.json();
    const imageUrl = data.image_url;
    const filename = data.filename || `image_${globalIndex}.jpg`;

    // Fetch the actual image
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error("Failed to fetch image");
    }

    const blob = await imageResponse.blob();
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async downloadAsZip(indices) {
    // Request ZIP download from backend
    const response = await fetch(`download_images_zip/${encodeURIComponent(state.album)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ indices: indices }),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.album}_bookmarked_images.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Delete bookmarked images
   */
  async deleteBookmarkedImages() {
    const indices = this.getBookmarkedIndices();
    if (indices.length === 0) {
      alert("No images are bookmarked.");
      return;
    }

    this.removeBookmarkMenu();

    // Use existing delete confirmation modal with custom message for bookmarks
    const message = `${indices.length} bookmarked image${indices.length > 1 ? "s" : ""}`;
    const confirmed = await showDeleteConfirmModal(message, `${indices.length} images`);
    if (!confirmed) {
      return;
    }

    showSpinner();

    try {
      // Delete images in reverse order to maintain index consistency
      const sortedIndices = [...indices].sort((a, b) => b - a);

      for (const globalIndex of sortedIndices) {
        const response = await fetch(`delete_image/${encodeURIComponent(state.album)}/${globalIndex}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          console.warn(`Failed to delete image at index ${globalIndex}`);
        }
      }

      // Trigger album refresh BEFORE clearing bookmarks
      // This ensures slideState.totalAlbumImages is updated before any grid refreshes
      // Pass deletedIndices to allow position preservation
      window.dispatchEvent(
        new CustomEvent("albumChanged", {
          detail: {
            album: state.album,
            totalImages: slideState.totalAlbumImages - indices.length,
            changeType: "deletion",
            deletedIndices: indices,
          },
        })
      );

      // Clear bookmarks after album refresh
      this.clearBookmarks();
    } catch (error) {
      console.error("Delete failed:", error);
      alert(`Delete failed: ${error.message}`);
    } finally {
      hideSpinner();
    }
  }

  /**
   * Move bookmarked images to a different folder
   */
  async moveBookmarkedImages() {
    const indices = this.getBookmarkedIndices();
    if (indices.length === 0) {
      alert("No images are bookmarked.");
      return;
    }

    this.removeBookmarkMenu();

    // Get the first bookmarked image's directory as the starting path
    let startingPath = "";
    try {
      const firstIndex = indices[0];
      const response = await fetch(`image_path/${encodeURIComponent(state.album)}/${firstIndex}`);
      if (response.ok) {
        const imagePath = await response.text();
        // Extract directory from the path
        const lastSlash = Math.max(imagePath.lastIndexOf("/"), imagePath.lastIndexOf("\\"));
        if (lastSlash > 0) {
          startingPath = imagePath.substring(0, lastSlash);
        }
      }
    } catch (error) {
      console.warn("Could not determine starting path:", error);
    }

    // Show directory picker with custom labels
    createSimpleDirectoryPicker(
      async (targetDirectory) => {
        await this.performMove(indices, targetDirectory);
      },
      startingPath,
      {
        buttonLabel: "Move",
        title: "Select Destination Folder",
        pathLabel: "Move images to:",
        showCreateFolder: true,
      }
    );
  }

  /**
   * Perform the actual move operation
   */
  async performMove(indices, targetDirectory) {
    showSpinner();

    try {
      // Check if target folder is in the current album
      const albumConfig = await this.getAlbumConfig();
      const targetPath = targetDirectory.endsWith("/") ? targetDirectory.slice(0, -1) : targetDirectory;
      const targetInAlbum = albumConfig.image_paths.some((path) => {
        const cleanPath = path.endsWith("/") ? path.slice(0, -1) : path;
        return cleanPath === targetPath;
      });

      // If target folder is not in album, ask user to confirm adding it
      if (!targetInAlbum) {
        hideSpinner();
        const shouldAddFolder = await showConfirmModal(
          `The destination folder is not in the current album.\n\nWould you like to add "${targetDirectory}" to the "${state.album}" album?`,
          "Yes, Add Folder",
          "No, Continue Without Adding"
        );

        if (shouldAddFolder) {
          // Add the folder to the album
          await this.addFolderToAlbum(targetDirectory, albumConfig);
        }
        showSpinner();
      }

      const response = await fetch(`move_images/${encodeURIComponent(state.album)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          indices: indices,
          target_directory: targetDirectory,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || `Server error: ${response.status}`);
      }

      const result = await response.json();

      // Build confirmation message
      let message = "";
      if (result.moved_count > 0) {
        message += `Successfully moved ${result.moved_count} image${result.moved_count > 1 ? "s" : ""}.`;
      }

      if (result.same_folder_count > 0) {
        if (message) {
          message += "\n\n";
        }
        message += `${result.same_folder_count} image${result.same_folder_count > 1 ? "s were" : " was"} already in the target folder:\n`;
        message += result.same_folder_files.slice(0, 5).join("\n");
        if (result.same_folder_files.length > 5) {
          message += `\n... and ${result.same_folder_files.length - 5} more`;
        }
      }

      if (result.error_count > 0) {
        if (message) {
          message += "\n\n";
        }
        message += `${result.error_count} error${result.error_count > 1 ? "s" : ""} occurred:\n`;
        message += result.errors.slice(0, 5).join("\n");
        if (result.errors.length > 5) {
          message += `\n... and ${result.errors.length - 5} more`;
        }
      }

      alert(message || "Move operation completed.");

      // If any files were moved, trigger album refresh
      if (result.moved_count > 0) {
        window.dispatchEvent(
          new CustomEvent("albumChanged", {
            detail: { album: state.album, totalImages: slideState.totalAlbumImages },
          })
        );
      }
    } catch (error) {
      console.error("Move failed:", error);
      alert(`Move failed: ${error.message}`);
    } finally {
      hideSpinner();
    }
  }

  /**
   * Export bookmarked images to a different folder (copy, not move)
   */
  async exportBookmarkedImages() {
    const indices = this.getBookmarkedIndices();
    if (indices.length === 0) {
      alert("No images are bookmarked.");
      return;
    }

    this.removeBookmarkMenu();

    // Get the first bookmarked image's directory as the starting path
    let startingPath = "";
    try {
      const firstIndex = indices[0];
      const response = await fetch(`image_path/${encodeURIComponent(state.album)}/${firstIndex}`);
      if (response.ok) {
        const imagePath = await response.text();
        // Extract directory from the path
        const lastSlash = Math.max(imagePath.lastIndexOf("/"), imagePath.lastIndexOf("\\"));
        if (lastSlash > 0) {
          startingPath = imagePath.substring(0, lastSlash);
        }
      }
    } catch (error) {
      console.warn("Could not determine starting path:", error);
    }

    // Show directory picker with custom labels for export
    createSimpleDirectoryPicker(
      async (targetDirectory) => {
        await this.performExport(indices, targetDirectory);
      },
      startingPath,
      {
        buttonLabel: "Export",
        title: "Select Export Destination",
        pathLabel: "Export images to:",
        showCreateFolder: true,
      }
    );
  }

  /**
   * Perform the actual export operation
   */
  async performExport(indices, targetDirectory) {
    showSpinner();

    try {
      const response = await fetch(`copy_images/${encodeURIComponent(state.album)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          indices: indices,
          target_directory: targetDirectory,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || `Server error: ${response.status}`);
      }

      const result = await response.json();

      // Build confirmation message
      let message = "";
      if (result.copied_count > 0) {
        message += `Successfully exported ${result.copied_count} image${result.copied_count > 1 ? "s" : ""} to:\n${targetDirectory}`;
      }

      if (result.error_count > 0) {
        if (message) {
          message += "\n\n";
        }
        message += `${result.error_count} error${result.error_count > 1 ? "s" : ""} occurred:\n`;
        message += result.errors.slice(0, 5).join("\n");
        if (result.errors.length > 5) {
          message += `\n... and ${result.errors.length - 5} more`;
        }
      }

      alert(message || "Export operation completed.");
    } catch (error) {
      console.error("Export failed:", error);
      alert(`Export failed: ${error.message}`);
    } finally {
      hideSpinner();
    }
  }

  /**
   * Get the current album configuration
   */
  async getAlbumConfig() {
    const response = await fetch(`album/${encodeURIComponent(state.album)}/`);
    if (!response.ok) {
      throw new Error("Failed to get album configuration");
    }
    return await response.json();
  }

  /**
   * Add a folder to the current album
   */
  async addFolderToAlbum(folderPath, albumConfig) {
    const updatedPaths = [...albumConfig.image_paths, folderPath];

    const response = await fetch("update_album/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: albumConfig.key,
        name: albumConfig.name,
        image_paths: updatedPaths,
        index: albumConfig.index,
        umap_eps: albumConfig.umap_eps || 0.07,
        description: albumConfig.description || "",
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to add folder to album");
    }

    // Trigger album update (re-index may be needed)
    window.dispatchEvent(
      new CustomEvent("albumUpdated", {
        detail: { album: state.album },
      })
    );
  }

  // === Bookmark Menu ===

  /**
   * Create and show the bookmark actions menu
   */
  createBookmarkMenu(x, y) {
    this.removeBookmarkMenu();

    const count = this.getCount();
    const isInSearchMode = slideState.isSearchMode && !this.isShowingBookmarks;

    const menu = document.createElement("div");
    menu.id = "bookmarkActionsMenu";
    menu.style.position = "fixed";
    menu.style.background = "rgba(30,30,30,0.95)";
    menu.style.border = "1px solid #444";
    menu.style.padding = "6px";
    menu.style.borderRadius = "6px";
    menu.style.zIndex = "10000";
    menu.style.display = "flex";
    menu.style.flexDirection = "column";
    menu.style.gap = "6px";

    const makeButton = (svg, label, onClick, disabled = false) => {
      const btn = document.createElement("button");
      btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;">${svg}<span style="color:#fff">${label}</span></span>`;
      btn.style.display = "flex";
      btn.style.alignItems = "center";
      btn.style.gap = "8px";
      btn.style.background = "transparent";
      btn.style.border = "none";
      btn.style.cursor = disabled ? "not-allowed" : "pointer";
      btn.style.opacity = disabled ? "0.5" : "1";
      btn.style.padding = "6px 10px";
      btn.style.borderRadius = "4px";
      btn.disabled = disabled;

      if (!disabled) {
        btn.addEventListener("mouseover", () => {
          btn.style.background = "rgba(255,255,255,0.1)";
        });
        btn.addEventListener("mouseout", () => {
          btn.style.background = "transparent";
        });
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          onClick();
        });
      }
      return btn;
    };

    // Add count header
    const header = document.createElement("div");
    header.style.color = "#ffc107";
    header.style.fontWeight = "bold";
    header.style.textAlign = "center";
    header.style.padding = "4px 10px";
    header.style.borderBottom = "1px solid #444";
    header.style.marginBottom = "4px";
    header.textContent = `Bookmarks (${count})`;
    menu.appendChild(header);

    const hasBookmarks = count > 0;

    // Show/Hide toggle - Show when not showing bookmarks, Hide when showing bookmarks
    if (this.isShowingBookmarks) {
      menu.appendChild(makeButton(HIDE_SVG, "Hide", () => this.hideBookmarkedImages()));
    } else {
      menu.appendChild(makeButton(SHOW_SVG, "Show", () => this.showBookmarkedImages(), !hasBookmarks));
    }

    // Clear bookmarks (under Show/Hide)
    menu.appendChild(
      makeButton(
        CLEAR_SVG,
        "Clear",
        () => {
          this.clearBookmarks();
          this.removeBookmarkMenu();
        },
        !hasBookmarks
      )
    );

    // Select All - only active when a search is being displayed (and not showing bookmarks)
    menu.appendChild(makeButton(SELECT_ALL_SVG, "Select All", () => this.selectAllFromSearch(), !isInSearchMode));

    // Curate - opens the curation panel
    menu.appendChild(
      makeButton(
        CURATE_SVG,
        "Curate",
        () => {
          if (window.toggleCurationPanel) {
            window.toggleCurationPanel();
          }
        },
        false
      )
    );

    // Move, Export, Download, and Delete (Export is after Move as requested)
    menu.appendChild(
      makeButton(MOVE_SVG, "Move", () => this.moveBookmarkedImages(), !hasBookmarks || state.albumLocked)
    );
    menu.appendChild(makeButton(EXPORT_SVG, "Export", () => this.exportBookmarkedImages(), !hasBookmarks));
    menu.appendChild(makeButton(DOWNLOAD_SVG, "Download", () => this.downloadBookmarkedImages(), !hasBookmarks));
    menu.appendChild(
      makeButton(DELETE_SVG, "Delete", () => this.deleteBookmarkedImages(), !hasBookmarks || state.albumLocked)
    );

    document.body.appendChild(menu);

    // Position after appending so we can measure
    const menuHeight = menu.offsetHeight;
    const menuWidth = menu.offsetWidth;
    const windowHeight = window.innerHeight;
    const windowWidth = window.innerWidth;

    // Position above the click if would go off bottom
    let finalY = y;
    if (y + menuHeight > windowHeight) {
      finalY = windowHeight - menuHeight - 6;
    }

    // Position to the left if would go off right
    let finalX = x;
    if (x + menuWidth > windowWidth) {
      finalX = windowWidth - menuWidth - 6;
    }

    menu.style.left = `${finalX}px`;
    menu.style.top = `${finalY}px`;

    // Close when clicking elsewhere or pressing Escape
    const onDocClick = (e) => {
      if (!menu.contains(e.target)) {
        this.removeBookmarkMenu();
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        this.removeBookmarkMenu();
      }
    };

    setTimeout(() => {
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
      menu._cleanup = () => {
        document.removeEventListener("click", onDocClick);
        document.removeEventListener("keydown", onKey);
      };
    }, 0);
  }

  /**
   * Remove the bookmark actions menu
   */
  removeBookmarkMenu() {
    const existing = document.getElementById("bookmarkActionsMenu");
    if (existing) {
      if (existing._cleanup) {
        existing._cleanup();
      }
      existing.remove();
    }
  }

  /**
   * Show the bookmark menu (called from button click)
   */
  showBookmarkMenu(x, y) {
    this.createBookmarkMenu(x, y);
  }
}

// Create singleton instance
export const bookmarkManager = new BookmarkManager();

// Initialize bookmark button and load bookmarks when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  initializeBookmarkButton();
});

// Also initialize when state is ready (album is loaded)
window.addEventListener("stateReady", () => {
  bookmarkManager.loadBookmarks();
  bookmarkManager.updateBookmarkButton();
});

function initializeBookmarkButton() {
  const btn = document.getElementById("bookmarkMenuBtn");
  if (!btn) {
    return;
  }

  // Left-click opens menu
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = btn.getBoundingClientRect();
    bookmarkManager.showBookmarkMenu(rect.left, rect.top - 10);
  });

  // Right-click also opens menu (consistent with slideshow button)
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    bookmarkManager.showBookmarkMenu(e.clientX + 6, e.clientY + 6);
  });

  bookmarkManager.updateBookmarkButton();
}

// Export for keyboard shortcut
export function toggleCurrentBookmark() {
  bookmarkManager.toggleCurrentBookmark();
}

// Export for adding bookmark icons to slides
export function addBookmarkIconToSlide(slideEl, globalIndex) {
  bookmarkManager.addBookmarkIconToSlide(slideEl, globalIndex);
}

// Export for updating icons after slide changes
export function updateAllBookmarkIcons() {
  bookmarkManager.updateAllBookmarkIcons();
}
