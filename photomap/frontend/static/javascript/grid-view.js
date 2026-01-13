import { addBookmarkIconToSlide } from "./bookmarks.js";
import { toggleGridSwiperView } from "./events.js";
import { replaceReferenceImagesWithLinks, updateCurrentImageScore, updateClusterInfo } from "./metadata-drawer.js";
import { fetchImageByIndex } from "./search.js";
import { slideState } from "./slide-state.js";
import { state } from "./state.js";
import { hideSpinner, showSpinner } from "./utils.js";

// Create and export singleton instance
export const initializeGridSwiper = async () => {
  const gridViewManager = new GridViewManager();
  gridViewManager.initializeGridSwiper();
  return gridViewManager;
};

// GridViewManager class to handle grid view logic
class GridViewManager {
  constructor() {
    if (GridViewManager.instance) {
      return GridViewManager.instance;
    }

    this.swiper = null;
    this.loadedImageIndices = new Set();
    this.gridInitialized = false;
    this.slidesPerBatch = 0;
    this.slideHeight = 140;
    this.currentRows = 0;
    this.currentColumns = 0;
    this.suppressSlideChange = false;
    this.batchLoading = false;
    this.resetInProgress = false; // Guard against concurrent resets
    this.cacheBreaker = Date.now(); // Cache breaker for thumbnail URLs
    this.slideData = {};
    this.GRID_MAX_SCREENS = 6;

    // Store event listeners for cleanup
    this.eventListeners = [];

    GridViewManager.instance = this;
  }

  // Consolidated geometry calculation function
  calculateGridGeometry() {
    const gridContainer = document.querySelector(".swiper.grid-mode");
    const availableWidth = gridContainer.offsetWidth - 24;
    const availableHeight = window.innerHeight - 120;

    const factor = state.gridThumbSizeFactor || 1.0;
    const targetTileSize = 200 * factor;
    const minTileSize = 75;
    const maxTileSize = 300;

    const columns = Math.max(2, Math.floor(availableWidth / targetTileSize));
    const rows = Math.max(2, Math.floor(availableHeight / targetTileSize));

    const actualTileWidth = Math.floor(availableWidth / columns);
    const actualTileHeight = Math.floor(availableHeight / rows);

    const tileSize = Math.max(minTileSize, Math.min(maxTileSize, Math.min(actualTileWidth, actualTileHeight)));

    const batchSize = rows * columns;

    return {
      rows,
      columns,
      tileSize,
      batchSize,
    };
  }

  isVisible() {
    const gridContainer = document.getElementById("gridViewContainer");
    return gridContainer && gridContainer.style.display !== "none";
  }

  // Helper to store and manage event listeners
  addEventListener(target, event, handler) {
    target.addEventListener(event, handler);
    this.eventListeners.push({ target, event, handler });
  }

  removeAllEventListeners() {
    this.eventListeners.forEach(({ target, event, handler }) => {
      target.removeEventListener(event, handler);
    });
    this.eventListeners = [];
  }

  initializeGridSwiper() {
    this.gridInitialized = false;
    showSpinner();
    this.removeAllEventListeners();

    if (this.swiper) {
      this.swiper.destroy(true, true);
      this.swiper = null;
    }

    this.loadedImageIndices = new Set();
    this.slideData = {};

    const geometry = this.calculateGridGeometry();
    this.currentRows = geometry.rows;
    this.currentColumns = geometry.columns;
    this.slideHeight = geometry.tileSize;
    this.slidesPerBatch = geometry.batchSize;

    this.swiper = new Swiper("#gridViewSwiper", {
      direction: "horizontal",
      slidesPerView: this.currentColumns,
      slidesPerGroup: this.currentColumns,
      grid: {
        rows: this.currentRows,
        fill: "column",
      },
      virtual: {
        enabled: false,
      },
      spaceBetween: 6,
      navigation: {
        prevEl: "#gridSwiperPrevButton",
        nextEl: "#gridSwiperNextButton",
      },
      mousewheel: {
        enabled: true,
        sensitivity: 10,
        releaseOnEdges: true,
        thresholdDelta: 10,
        thresholdTime: 100,
      },
      keyboard: true,
    });

    // await new Promise((resolve) => setTimeout(resolve, 100));
    this.addGridEventListeners();
    this.setupGridResizeHandler();
    this.updateCurrentSlide();

    this.gridInitialized = true;
    window.swiper = this.swiper; // for debugging
  }

  getIndexForSlideElement(slideEl) {
    const globalIndex = parseInt(slideEl.dataset.globalIndex, 10);
    if (isNaN(globalIndex)) {
      return null;
    }
    return globalIndex;
  }

  addGridEventListeners() {
    this.addEventListener(window, "swiperModeChanged", async () => {
      await this.resetAllSlides();
    });

    this.addEventListener(window, "searchResultsChanged", async () => {
      await this.resetAllSlides();
    });

    this.addEventListener(window, "slideChanged", async () => {
      // nothing for now
    });

    this.addEventListener(window, "gridThumbSizeFactorChanged", async () => {
      this.initializeGridSwiper();
      await this.resetAllSlides();
      const currentSlide = slideState.getCurrentSlide();
      updateCurrentImageScore(this.slideData[currentSlide.globalIndex] || null);
    });

    this.addEventListener(window, "seekToSlideIndex", async (e) => {
      const { globalIndex, isSearchMode } = e.detail;
      if (isSearchMode !== slideState.isSearchMode) {
        console.error("Mismatched search mode in setSlideIndex event");
        return;
      }

      const gridContainer = document.getElementById("gridViewContainer");
      const slideEl = gridContainer.querySelector(`.swiper-slide[data-global-index='${globalIndex}']`);
      if (slideEl) {
        this.updateCurrentSlideHighlight(globalIndex);
        const slideIndex = Array.from(this.swiper.slides).indexOf(slideEl);
        const screenIndex = Math.floor(slideIndex / (this.currentRows * this.currentColumns));
        this.swiper.slideTo(screenIndex * this.currentColumns);
        return;
      }

      await this.resetAllSlides();
    });

    this.addEventListener(window, "albumChanged", async (e) => {
      // Update cache breaker to force thumbnail reload, especially for deletions
      if (e.detail?.changeType === "deletion") {
        this.cacheBreaker = Date.now();
      }
      await this.resetAllSlides();
    });

    if (this.swiper) {
      this.swiper.on("slideNextTransitionStart", async () => {
        if (this.suppressSlideChange) {
          return;
        }
        if (this.isBatchLoading()) {
          return;
        } // Prevent overlapping batch loads

        const slidesLeft = Math.floor(this.swiper.slides.length / this.currentRows) - this.swiper.activeIndex;
        if (slidesLeft <= this.currentColumns) {
          const lastSlideIndex = this.getIndexForSlideElement(this.swiper.slides[this.swiper.slides.length - 1]) || 0;
          const index = slideState.isSearchMode ? slideState.globalToSearch(lastSlideIndex) + 1 : lastSlideIndex + 1;
          // Load batch without blocking - placeholders appear immediately
          this.setBatchLoading(true);
          this.loadBatch(index, true)
            .catch((error) => {
              console.warn(`Error loading next batch at index ${index}:`, error);
            })
            .finally(() => {
              this.setBatchLoading(false);
              // Update Swiper to ensure it knows about new slides
              if (this.swiper && !this.swiper.destroyed && typeof this.swiper.update === "function") {
                this.swiper.update();
              }
            });
        }
      });

      this.swiper.on("slidePrevTransitionStart", async () => {
        if (this.suppressSlideChange) {
          return;
        }
        if (this.isBatchLoading()) {
          return;
        } // Prevent overlapping batch loads

        const firstSlide = this.getIndexForSlideElement(this.swiper.slides[0]);
        const index = slideState.isSearchMode ? slideState.globalToSearch(firstSlide) : firstSlide;
        if (firstSlide > 0 && this.swiper.activeIndex === 0) {
          const batchIndex = index - this.slidesPerBatch;
          // Load batch without blocking - placeholders appear immediately
          this.setBatchLoading(true);
          this.loadBatch(batchIndex, false)
            .catch((error) => {
              console.warn(`Error loading prev batch at index ${batchIndex}:`, error);
            })
            .finally(() => {
              this.setBatchLoading(false);
              // Update Swiper to ensure it knows about new slides
              if (this.swiper && !this.swiper.destroyed && typeof this.swiper.update === "function") {
                this.swiper.update();
              }
            });
        }
      });

      this.swiper.on("transitionEnd", () => {
        this.suppressSlideChange = false;
      });

      this.swiper.on("slideChange", async () => {
        if (this.suppressSlideChange) {
          return;
        }

        const currentSlide = slideState.getCurrentSlide();
        const currentGlobal = currentSlide.globalIndex;
        const gridContainer = document.getElementById("gridViewContainer");
        const slideEl = gridContainer.querySelector(`.swiper-slide[data-global-index='${currentGlobal}']`);
        if (slideEl) {
          const slideIndex = Array.from(this.swiper.slides).indexOf(slideEl);
          const activeIndex = this.swiper.activeIndex * this.currentRows;
          if (slideIndex < activeIndex || slideIndex >= activeIndex + this.currentRows * this.currentColumns) {
            const topLeftSlideEl = this.swiper.slides[activeIndex];
            if (topLeftSlideEl) {
              const topLeftGlobal = this.getIndexForSlideElement(topLeftSlideEl);
              slideState.updateFromExternal(topLeftGlobal, slideState.globalToSearch(topLeftGlobal));
              this.updateCurrentSlide();
            }
          }
        }
      });
    }

    window.handleGridSlideClick = (globalIndex) => {
      slideState.updateFromExternal(globalIndex, slideState.globalToSearch(globalIndex));
      this.updateCurrentSlide();
    };

    window.handleGridSlideDblClick = async (globalIndex) => {
      slideState.setCurrentIndex(globalIndex, false);
      this.updateCurrentSlideHighlight(globalIndex);
      await toggleGridSwiperView(false);
    };
  }

  addDoubleTapHandler(slideEl, globalIndex) {
    if (slideEl.dataset.doubleTapHandlerAttached) {
      return;
    }
    let lastTap = 0;
    slideEl.addEventListener("touchend", () => {
      const now = Date.now();
      if (now - lastTap < 350) {
        window.handleGridSlideDblClick(globalIndex);
        lastTap = 0;
      } else {
        lastTap = now;
      }
    });
    slideEl.dataset.doubleTapHandlerAttached = "true";
  }

  // This is similar to resetAllSlides(), but also re-initializes the swiper if geometry changed
  async resetOrInitialize() {
    if (this.gridGeometryChanged(this.calculateGridGeometry())) {
      this.initializeGridSwiper();
    }
    // Always call resetAllSlides() to load grid data and hide spinner
    // This fixes a race condition where initializeGridSwiper() shows the spinner
    // but doesn't load data, leaving the spinner spinning indefinitely
    await this.resetAllSlides();
  }

  async resetAllSlides() {
    if (!this.gridInitialized) {
      return;
    }
    if (!this.swiper) {
      return;
    }
    if (!this.isVisible()) {
      return;
    }

    // Guard against concurrent resets
    if (this.resetInProgress) {
      return;
    }

    this.resetInProgress = true;

    showSpinner();

    await new Promise(requestAnimationFrame);
    const targetIndex = slideState.getCurrentIndex();
    this.loadedImageIndices.clear();

    try {
      if (!this.swiper.destroyed) {
        this.swiper.slideTo(0, 0, false); // prevents a TypeError warning
        await this.swiper.removeAllSlides();
      }
    } catch (err) {
      console.warn("removeAllSlides failed:", err);
    }

    try {
      // Load batches - placeholders appear immediately, metadata loads in background
      await this.loadBatch(targetIndex, true);
      slideState.setCurrentIndex(targetIndex);
      this.updateCurrentSlide();

      // add some context slides before and after
      await this.loadBatch(targetIndex + this.slidesPerBatch, true);
      if (targetIndex > 0) {
        await this.loadBatch(targetIndex - this.slidesPerBatch, false);
      }
    } catch (err) {
      console.warn(err);
    }

    hideSpinner();
    this.resetInProgress = false;
  }

  async loadBatch(startIndex = null, append = true) {
    const topLeftIndex = Math.floor(startIndex / this.slidesPerBatch) * this.slidesPerBatch;

    const placeholderSlides = [];
    const indicesToLoad = [];

    // First pass: Create placeholders for all valid indices
    for (let i = 0; i < this.slidesPerBatch; i++) {
      const offset = topLeftIndex + i;
      const globalIndex = slideState.indexToGlobal(offset);
      if (globalIndex === null) {
        continue;
      }

      if (this.loadedImageIndices.has(globalIndex)) {
        continue;
      }

      // Mark as loaded immediately to prevent duplicates
      this.loadedImageIndices.add(globalIndex);

      // Create placeholder slide
      placeholderSlides.push(this.makePlaceholderSlideHTML(globalIndex));
      indicesToLoad.push(globalIndex);
    }

    // Append/prepend placeholder slides immediately
    if (placeholderSlides.length > 0) {
      if (append) {
        this.swiper.appendSlide(placeholderSlides);
      } else {
        this.suppressSlideChange = true;
        this.swiper.prependSlide(placeholderSlides.reverse());
        // After prepending, we need to adjust position to compensate for new slides
        // Use a microtask (Promise) to ensure prepend DOM changes are committed
        Promise.resolve().then(() => {
          if (this.swiper && !this.swiper.destroyed) {
            // Use default speed (300ms) for smooth animation, but suppress slide change event
            this.swiper.slideTo(this.currentColumns, 300, false);
            // Reset suppressSlideChange after transition completes
            setTimeout(() => {
              this.suppressSlideChange = false;
            }, 350); // Slightly longer than animation duration
          }
        });
      }

      // Add event handlers to new slides
      for (let i = 0; i < this.swiper.slides.length; i++) {
        const slideEl = this.swiper.slides[i];
        if (slideEl) {
          const globalIndex = parseInt(slideEl.dataset.globalIndex, 10);
          this.addDoubleTapHandler(slideEl, globalIndex);
          // Add bookmark icon to grid slide
          addBookmarkIconToSlide(slideEl, globalIndex);
        } else {
          console.warn("Slide element not found for double-tap handler");
        }
      }

      // Update Swiper to recalculate navigation bounds after adding slides
      if (this.swiper && !this.swiper.destroyed && typeof this.swiper.update === "function") {
        this.swiper.update();
      }

      // Defer enforceHighWaterMark to avoid interfering with navigation
      // Run it after a short delay to allow current transitions to complete
      setTimeout(() => {
        if (this.swiper && !this.swiper.destroyed) {
          this.enforceHighWaterMark(!append);
        }
      }, 100);
    }

    // Second pass: Load metadata in background (don't await)
    // Reverse the array if prepending to maintain visual order
    const loadOrder = append ? indicesToLoad : [...indicesToLoad].reverse();

    loadOrder.forEach((globalIndex, idx) => {
      // Stagger requests slightly to avoid overwhelming the server
      setTimeout(async () => {
        try {
          const data = await fetchImageByIndex(globalIndex);
          if (data) {
            data.globalIndex = globalIndex;
            this.updateSlideWithMetadata(globalIndex, data);
          }
        } catch (error) {
          console.warn(`Failed to load metadata for image ${globalIndex}:`, error);
        }
      }, idx * 10); // 10ms stagger
    });

    return placeholderSlides.length > 0;
  }

  // NOTE: Refactor this call
  enforceHighWaterMark(trimFromEnd = false) {
    if (!this.swiper || !this.slidesPerBatch || this.slidesPerBatch <= 0) {
      return;
    }

    const maxScreens = this.GRID_MAX_SCREENS;
    const highWaterSlides = this.slidesPerBatch * maxScreens;

    const len = this.swiper.slides.length;
    if (len <= highWaterSlides) {
      return;
    }

    const excessSlides = len - highWaterSlides;
    const removeScreens = Math.ceil(excessSlides / this.slidesPerBatch);
    const removeCount = Math.min(removeScreens * this.slidesPerBatch, len);

    const removeIndices = [];
    if (!trimFromEnd) {
      for (let i = 0; i < removeCount; i++) {
        removeIndices.push(i);
      }
    } else {
      for (let i = len - removeCount; i < len; i++) {
        removeIndices.push(i);
      }
    }

    const prevActive = this.swiper.activeIndex;

    const removedGlobalIndices = [];
    for (const idx of removeIndices) {
      const slideEl = this.swiper.slides[idx];
      if (!slideEl) {
        continue;
      }
      const g = slideEl.dataset?.globalIndex ?? slideEl.dataset?.index;
      if (g !== undefined && g !== null && g !== "") {
        removedGlobalIndices.push(parseInt(g, 10));
      }
    }

    this.swiper.removeSlide(removeIndices);

    for (const g of removedGlobalIndices) {
      this.loadedImageIndices.delete(g);
      delete this.slideData[g];
    }

    if (!trimFromEnd) {
      const deltaColumns = this.currentColumns * removeScreens;
      const newActive = Math.max(0, prevActive - deltaColumns);
      this.swiper.slideTo(newActive, 0);
    } else {
      const maxActive = Math.max(0, this.swiper.slides.length - this.currentColumns);
      const targetActive = Math.min(prevActive, maxActive);
      this.swiper.slideTo(targetActive, 0);
    }

    // Update Swiper after modifying slides to recalculate navigation state
    if (this.swiper && !this.swiper.destroyed && typeof this.swiper.update === "function") {
      this.swiper.update();
    }
  }

  gridGeometryChanged(newGeometry) {
    return (
      newGeometry.rows !== this.currentRows ||
      newGeometry.columns !== this.currentColumns ||
      Math.abs(newGeometry.tileSize - this.slideHeight) > 10
    );
  }

  setupGridResizeHandler() {
    let resizeTimeout;

    const handleResize = async () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(async () => {
        if (!state.gridViewActive) {
          return;
        }

        const newGeometry = this.calculateGridGeometry();

        if (this.gridGeometryChanged(newGeometry)) {
          const currentGlobalIndex = slideState.getCurrentSlide().globalIndex;

          this.resetAllSlides();
          this.initializeGridSwiper();
          this.setBatchLoading(true);
          await this.loadBatch(currentGlobalIndex);
          await this.loadBatch(currentGlobalIndex + this.slidesPerBatch);
          this.setBatchLoading(false);
        }
      }, 300);
    };

    this.addEventListener(window, "resize", handleResize);
  }

  updateCurrentSlideHighlight(globalIndex = null) {
    if (!state.gridViewActive) {
      return;
    }

    const gridSwiperContainer = document.getElementById("gridViewContainer");
    if (!gridSwiperContainer) {
      return;
    }

    const currentGlobalIndex = globalIndex === null ? slideState.getCurrentSlide().globalIndex : globalIndex;

    gridSwiperContainer.querySelectorAll(".swiper-slide.current-slide").forEach((slide) => {
      slide.classList.remove("current-slide");
    });

    const currentSlide = gridSwiperContainer.querySelector(`.swiper-slide[data-global-index="${currentGlobalIndex}"]`);
    if (currentSlide) {
      currentSlide.classList.add("current-slide");
    }
  }

  updateCurrentSlide() {
    const currentSlide = slideState.getCurrentSlide();
    this.updateCurrentSlideHighlight();
    this.updateMetadataOverlay();
    updateCurrentImageScore(this.slideData[currentSlide.globalIndex] || null);
  }

  makePlaceholderSlideHTML(globalIndex) {
    const thumbnail_url = `thumbnails/${state.album}/${globalIndex}?size=${this.slideHeight}&t=${this.cacheBreaker}`;
    return `
    <div class="swiper-slide" style="width:${this.slideHeight}px; height:${this.slideHeight}px;" 
        data-global-index="${globalIndex}"
        data-filepath=""
        onclick="handleGridSlideClick(${globalIndex})"
        ondblclick="handleGridSlideDblClick(${globalIndex})">
      <img src="${thumbnail_url}" alt="Loading..." 
          style="width:100%; height:100%; object-fit:contain; background:#222; border-radius:4px; display:block;" />
    </div>
  `;
  }

  makeSlideHTML(data, globalIndex) {
    const searchIndex = slideState.globalToSearch(globalIndex);
    if (searchIndex !== null && slideState.isSearchMode) {
      const results = slideState.searchResults[searchIndex];
      data.score = results?.score || "";
      data.cluster = results?.cluster || "";
      data.color = results?.color || "#000000";
    }
    data.searchIndex = slideState.globalToSearch(globalIndex);
    this.slideData[globalIndex] = data;

    const thumbnail_url = `thumbnails/${state.album}/${globalIndex}?size=${this.slideHeight}&t=${this.cacheBreaker}`;
    return `
    <div class="swiper-slide" style="width:${this.slideHeight}px; height:${this.slideHeight}px;" 
        data-global-index="${globalIndex}"
        data-filepath="${data.filepath || ""}"
        onclick="handleGridSlideClick(${globalIndex})"
        ondblclick="handleGridSlideDblClick(${globalIndex})">
      <img src="${thumbnail_url}" alt="${data.filename}" 
          style="width:100%; height:100%; object-fit:contain; background:#222; border-radius:4px; display:block;" />
    </div>
  `;
  }

  updateSlideWithMetadata(globalIndex, data) {
    const searchIndex = slideState.globalToSearch(globalIndex);
    if (searchIndex !== null && slideState.isSearchMode) {
      const results = slideState.searchResults[searchIndex];
      data.score = results?.score || "";
      data.cluster = results?.cluster || "";
      data.color = results?.color || "#000000";
    }
    data.searchIndex = slideState.globalToSearch(globalIndex);
    this.slideData[globalIndex] = data;

    // Update the slide element if it still exists in the DOM
    const gridContainer = document.getElementById("gridViewContainer");
    if (!gridContainer) {
      return;
    }

    const slideEl = gridContainer.querySelector(`.swiper-slide[data-global-index="${globalIndex}"]`);
    if (slideEl) {
      slideEl.dataset.filepath = data.filepath || "";
      const img = slideEl.querySelector("img");
      if (img) {
        img.alt = data.filename || "";
      }
    }
  }

  updateMetadataOverlay() {
    const globalIndex = slideState.getCurrentSlide().globalIndex;
    const data = this.slideData[globalIndex];
    if (!data) {
      return;
    }

    const rawDescription = data["description"] || "";
    const referenceImages = data["reference_images"] || [];
    const processedDescription = replaceReferenceImagesWithLinks(rawDescription, referenceImages, state.album);

    document.getElementById("descriptionText").innerHTML = processedDescription;
    document.getElementById("filenameText").textContent = data["filename"] || "";
    document.getElementById("filepathText").textContent = data["filepath"] || "";
    document.getElementById("metadataLink").href = data["metadata_url"] || "#";

    // Update cluster information display
    updateClusterInfo(data);
  }

  // These functions act as a semaphore to prevent overlapping batch loads
  setBatchLoading(isLoading) {
    this.batchLoading = isLoading;
  }

  isBatchLoading() {
    return this.batchLoading;
  }

  async waitForBatchLoadingToFinish(timeoutMs = 10000, intervalMs = 50) {
    const start = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    while (this.batchLoading) {
      const now = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
      if (now - start > timeoutMs) {
        console.warn("waitForBatchLoadingToFinish: timeout after", timeoutMs, "ms");
        break;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
