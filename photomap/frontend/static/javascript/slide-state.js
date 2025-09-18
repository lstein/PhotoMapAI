import { state } from "./state.js";

class SlideStateManager {
  constructor() {
    // Current position tracking
    this.currentGlobalIndex = 0; // Index in the full album
    this.currentSearchIndex = 0; // Index in search results (if any)
    this.isSearchMode = false; // Whether we're browsing search results

    // Data references
    this.totalAlbumImages = 0; // Total images in album
    this.searchResults = []; // Current search results

    // Event listeners for updates
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Listen for search changes
    window.addEventListener("searchResultsChanged", (e) => {
      this.handleSearchResultsChanged(e.detail);
    });

    // Listen for album changes
    window.addEventListener("albumChanged", (e) => {
      this.handleAlbumChanged(e.detail);
    });
  }

  // --- Public API ---

  /**
   * Get current slide information
   * @returns {Object} { globalIndex, searchIndex, totalCount, isSearchMode }
   */
  getCurrentSlide() {
    return {
      globalIndex: this.currentGlobalIndex,
      searchIndex: this.isSearchMode ? this.currentSearchIndex : null,
      totalCount: this.isSearchMode
        ? this.searchResults.length
        : this.totalAlbumImages,
      isSearchMode: this.isSearchMode,
    };
  }

  /**
   * Get current slide index based on search mode
   * @returns {number} Current index (search or global)
   */
  getCurrentIndex() {
    return this.isSearchMode
      ? this.currentSearchIndex
      : this.currentGlobalIndex;
  }

  /**
   * Set the current slide to a specific index without navigating there
   * @param {number} index - The index to navigate to
   * @param {boolean} isSearchIndex - Whether the index is in search results or global album
   */
  setCurrentIndex(index, isSearchIndex = null) {
    // Auto-detect mode if not specified
    if (isSearchIndex === null) {
      isSearchIndex = this.isSearchMode;
    }

    if (isSearchIndex && this.searchResults.length > 0) {
      // Set within search results
      this.currentSearchIndex = Math.max(
        0,
        Math.min(index, this.searchResults.length - 1)
      );
      this.currentGlobalIndex =
        this.searchResults[this.currentSearchIndex]?.index || 0;
    } else {
      // Set within full album
      this.currentGlobalIndex = Math.max(
        0,
        Math.min(index, this.totalAlbumImages - 1)
      );
      if (this.isSearchMode) {
        // Find corresponding search index if in search mode
        this.currentSearchIndex = this.searchResults.findIndex(
          (result) => result.index === this.currentGlobalIndex
        );
        if (this.currentSearchIndex === -1) {
          // Exit search mode if global index not in search results
          this.exitSearchMode();
        }
      }
    }
  }

  /**
   * Navigate to a specific position
   * @param {number} index - The index to navigate to
   * @param {boolean} isSearchIndex - Whether the index is in search results or global album
   */
  navigateToIndex(index, isSearchIndex = null) {
    this.setCurrentIndex(index, isSearchIndex);
    this.seekToSlideIndex();
  }

  /**
   * Navigate by offset (next/previous)
   * @param {number} offset - Number of slides to move (positive = forward, negative = backward)
   */
  navigateByOffset(offset) {
    if (this.isSearchMode) {
      const newIndex = this.currentSearchIndex + offset;
      this.navigateToIndex(newIndex, true);
    } else {
      const newIndex = this.currentGlobalIndex + offset;
      this.navigateToIndex(newIndex, false);
    }
  }

  /**
   * Enter search mode with results
   * @param {Array} results - Search results array
   * @param {number} startIndex - Optional starting position in search results
   */
  enterSearchMode(results, startIndex = 0) {
    this.searchResults = results || [];
    this.isSearchMode = this.searchResults.length > 0;

    if (this.isSearchMode) {
      this.currentSearchIndex = Math.max(
        0,
        Math.min(startIndex, this.searchResults.length - 1)
      );
      this.currentGlobalIndex =
        this.searchResults[this.currentSearchIndex]?.index ||
        this.currentGlobalIndex;
    }

    this.notifySlideChanged();
  }

  /**
   * Exit search mode and return to album browsing
   */
  exitSearchMode() {
    this.isSearchMode = false;
    this.searchResults = [];
    this.currentSearchIndex = 0;
    // Keep current global index
    this.notifySlideChanged();
  }

  /**
   * Update slide position from external source (e.g., UI interaction)
   * @param {number} globalIndex - The global album index
   * @param {number} searchIndex - The search results index (optional)
   */
  updateFromExternal(globalIndex, searchIndex = null) {
    if (
      this.isSearchMode &&
      searchIndex !== null &&
      this.searchResults.length > 0
    ) {
      this.currentGlobalIndex = this.searchResults[searchIndex]?.index;
      this.currentSearchIndex = searchIndex;
    } else {
      this.currentGlobalIndex = globalIndex;
      this.currentSearchIndex = searchIndex;
    }
    this.notifySlideChanged();
  }

  /**
   * Convert an index into a globalIndex.
   * The provided index will be interpreted according to the search mode.
   * @param {number} index - The index to convert
   * @returns {number|null} The corresponding global index, or null if out of bounds
   */
  indexToGlobal(index) {
    if (this.isSearchMode && this.searchResults.length > 0) {
      // Clamp to valid range
      const clampedIndex = Math.max(
        0,
        Math.min(index, this.searchResults.length - 1)
      );
      return this.searchResults[clampedIndex]?.index || null;
    } else {
      // Clamp to valid range
      return Math.max(0, Math.min(index, this.totalAlbumImages - 1));
    }
  }

  /**Reset
   * Given a current index and an offset, return the correct global and search indices.
   * @param {number} offset - The offset to apply (e.g., +1 for next, -1 for prev)
   * @returns {{globalIndex: number, searchIndex: number|null}}
   */
  resolveOffset(offset) {
    if (this.isSearchMode && this.searchResults.length > 0) {
      let searchIndex = this.currentSearchIndex + offset;
      if (searchIndex < 0 || searchIndex >= this.searchResults.length) {
        return { globalIndex: null, searchIndex: null }; // Out of bounds
      }

      let globalIndex = this.searchResults[searchIndex]?.index;
      return { globalIndex, searchIndex };
    } else {
      let globalIndex = this.currentGlobalIndex + offset;
      if (globalIndex < 0 || globalIndex >= this.totalAlbumImages) {
        return { globalIndex: null, searchIndex: null }; // Out of bounds
      }
      return { globalIndex, searchIndex: null };
    }
  }

  /**
   * Given a search index, return the corresponding global index (or null if out of bounds)
   */
  searchToGlobal(searchIndex) {
    if (this.isSearchMode && this.searchResults.length > 0) {
      if (searchIndex < 0 || searchIndex >= this.searchResults.length)
        return null;
      return this.searchResults[searchIndex]?.index;
    }
    return null;
  }

  /**
   * Given a global index, return the corresponding search index (or null if not found)
   */
  globalToSearch(globalIndex) {
    if (this.isSearchMode && this.searchResults.length > 0) {
      return this.searchResults.findIndex((r) => r.index === globalIndex);
    }
    return null;
  }

  // --- Event Handlers ---
  handleSearchResultsChanged({ results, searchType }) {
    if (searchType === "clear" || results.length === 0) {
      this.exitSearchMode();
    } else {
      this.enterSearchMode(results, 0);
    }
  }

  handleAlbumChanged(detail) {
    this.currentGlobalIndex = 0;
    this.currentSearchIndex = 0;
    this.exitSearchMode();
    this.totalAlbumImages = detail.totalImages; // Update from state
  }

  // --- Private Methods ---
  notifySlideChanged() {
    const slideInfo = this.getCurrentSlide();
    window.dispatchEvent(
      new CustomEvent("slideChanged", {
        detail: slideInfo,
      })
    );
  }

  seekToSlideIndex() {
    const slideInfo = this.getCurrentSlide();
    window.dispatchEvent(
      new CustomEvent("seekToSlideIndex", {
        detail: slideInfo,
      })
    );
  }
}

// Create singleton instance
export const slideState = new SlideStateManager();

// Convenience functions for backwards compatibility
export function navigateToSlide(index, isSearchIndex = false) {
  slideState.navigateToIndex(index, isSearchIndex);
}

export function navigateSlide(direction) {
  const offset = direction === "next" ? 1 : -1;
  slideState.navigateByOffset(offset);
}

export function getCurrentSlideIndex() {
  const current = slideState.getCurrentSlide();
  return [current.globalIndex, current.totalCount, current.searchIndex];
}

export async function getCurrentFilepath() {
  // Call the /image_path/ endpoint to get the filepath
  const response = await fetch(
    `image_path/${encodeURIComponent(state.album)}/${encodeURIComponent(
      slideState.currentGlobalIndex
    )}`
  );
  if (!response.ok) return null;
  return await response.text();
}
