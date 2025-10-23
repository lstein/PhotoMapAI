import { eventRegistry } from "./event-registry.js";
import { toggleGridSwiperView } from "./events.js";
import {
  replaceReferenceImagesWithLinks,
  updateCurrentImageScore,
} from "./metadata-drawer.js";
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
    this.slideData = {};
    this.GRID_MAX_SCREENS = 6;

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

    const tileSize = Math.max(
      minTileSize,
      Math.min(maxTileSize, Math.min(actualTileWidth, actualTileHeight))
    );

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

  initializeGridSwiper() {
    this.gridInitialized = false;
    showSpinner();
    eventRegistry.removeAll("grid");

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
    state.single_swiper.updateSlideshowIcon();

    this.gridInitialized = true;
    window.swiper = this.swiper; // for debugging
  }

  getIndexForSlideElement(slideEl) {
    const globalIndex = parseInt(slideEl.dataset.globalIndex, 10);
    if (isNaN(globalIndex)) return null;
    return globalIndex;
  }

  addGridEventListeners() {
    eventRegistry.install(
      { type: "grid", event: "swiperModeChanged" },
      async (e) => {
        await this.resetAllSlides();
      }
    );

    eventRegistry.install(
      { type: "grid", event: "searchResultsChanged" },
      async (e) => {
        await this.resetAllSlides();
      }
    );

    eventRegistry.install(
      { type: "grid", event: "slideChanged" },
      async function (e) {
        // nothing for now
      }
    );

    eventRegistry.install(
      { type: "grid", event: "gridThumbSizeFactorChanged" },
      async () => {
        this.initializeGridSwiper();
        await this.resetAllSlides();
        const currentSlide = slideState.getCurrentSlide();
        updateCurrentImageScore(
          this.slideData[currentSlide.globalIndex] || null
        );
      }
    );

    eventRegistry.install(
      { type: "grid", event: "seekToSlideIndex" },
      async (e) => {
        const { globalIndex, searchIndex, totalSlides, isSearchMode } =
          e.detail;
        if (isSearchMode !== slideState.isSearchMode) {
          console.error("Mismatched search mode in setSlideIndex event");
          return;
        }

        const gridContainer = document.getElementById("gridViewContainer");
        const slideEl = gridContainer.querySelector(
          `.swiper-slide[data-global-index='${globalIndex}']`
        );
        if (slideEl) {
          this.updateCurrentSlideHighlight(globalIndex);
          const slideIndex = Array.from(this.swiper.slides).indexOf(slideEl);
          const screenIndex = Math.floor(
            slideIndex / (this.currentRows * this.currentColumns)
          );
          this.swiper.slideTo(screenIndex * this.currentColumns);
          return;
        }

        await this.resetAllSlides();
      }
    );

    eventRegistry.install({ type: "grid", event: "albumChanged" }, async () => {
      await this.resetAllSlides();
    });

    if (this.swiper) {
      this.swiper.on("slideNextTransitionStart", async () => {
        if (this.suppressSlideChange) return;
        const slidesLeft =
          Math.floor(this.swiper.slides.length / this.currentRows) -
          this.swiper.activeIndex;
        if (slidesLeft <= this.currentColumns) {
          showSpinner();
          const lastSlideIndex =
            this.getIndexForSlideElement(
              this.swiper.slides[this.swiper.slides.length - 1]
            ) || 0;
          const index = slideState.isSearchMode
            ? slideState.globalToSearch(lastSlideIndex) + 1
            : lastSlideIndex + 1;
          await this.waitForBatchLoadingToFinish();
          this.setBatchLoading(true);
          try {
            await this.loadBatch(index, true);
          } catch (error) {
            console.warn(error);
          } finally {
            this.setBatchLoading(false);
          }
        }
        hideSpinner();
      });

      this.swiper.on("slidePrevTransitionStart", async () => {
        if (this.suppressSlideChange) return;
        const firstSlide = this.getIndexForSlideElement(this.swiper.slides[0]);
        const index = slideState.isSearchMode
          ? slideState.globalToSearch(firstSlide)
          : firstSlide;
        if (firstSlide > 0 && this.swiper.activeIndex === 0) {
          await this.waitForBatchLoadingToFinish();
          this.setBatchLoading(true);
          await this.loadBatch(index - this.slidesPerBatch, false);
        }
        this.setBatchLoading(false);
      });

      this.swiper.on("transitionEnd", () => {
        this.suppressSlideChange = false;
      });

      this.swiper.on("slideChange", async () => {
        if (this.suppressSlideChange) return;

        const currentSlide = slideState.getCurrentSlide();
        const currentGlobal = currentSlide.globalIndex;
        const gridContainer = document.getElementById("gridViewContainer");
        const slideEl = gridContainer.querySelector(
          `.swiper-slide[data-global-index='${currentGlobal}']`
        );
        if (slideEl) {
          const slideIndex = Array.from(this.swiper.slides).indexOf(slideEl);
          const activeIndex = this.swiper.activeIndex * this.currentRows;
          if (
            slideIndex < activeIndex ||
            slideIndex >= activeIndex + this.currentRows * this.currentColumns
          ) {
            const topLeftSlideEl = this.swiper.slides[activeIndex];
            if (topLeftSlideEl) {
              const topLeftGlobal =
                this.getIndexForSlideElement(topLeftSlideEl);
              slideState.updateFromExternal(
                topLeftGlobal,
                slideState.globalToSearch(topLeftGlobal)
              );
              // Skip if batch loading is in progress
              if (!this.isBatchLoading()) this.updateCurrentSlide();
            }
          }
        }
      });
    }

    window.handleGridSlideClick = (globalIndex) => {
      slideState.updateFromExternal(
        globalIndex,
        slideState.globalToSearch(globalIndex)
      );
      this.updateCurrentSlide();
    };

    window.handleGridSlideDblClick = async (globalIndex) => {
      slideState.setCurrentIndex(globalIndex, false);
      this.updateCurrentSlideHighlight(globalIndex);
      await toggleGridSwiperView(false);
    };
  }

  addDoubleTapHandler(slideEl, globalIndex) {
    if (slideEl.dataset.doubleTapHandlerAttached) return;
    let lastTap = 0;
    slideEl.addEventListener("touchend", (e) => {
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
    } else {
      await this.resetAllSlides();
    }
  }

  async resetAllSlides() {
    if (!this.gridInitialized) return;
    if (!this.swiper) return;
    if (!this.isVisible()) return;

    showSpinner();
    await this.waitForBatchLoadingToFinish();

    await new Promise(requestAnimationFrame);
    const targetIndex = slideState.getCurrentIndex();
    this.loadedImageIndices.clear();

    console.log("Resetting all slides to index", targetIndex);

    try {
      if (!this.swiper.destroyed) {
        this.swiper.slideTo(0, 0, false); // prevents a TypeError warning
        await this.swiper.removeAllSlides();
      }
    } catch (err) {
      console.warn("removeAllSlides failed:", err);
    }

    try {
      await this.waitForBatchLoadingToFinish();
      this.setBatchLoading(true);

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

    this.setBatchLoading(false);
    hideSpinner();
  }

  async loadBatch(startIndex = null, append = true) {
    let topLeftIndex =
      Math.floor(startIndex / this.slidesPerBatch) * this.slidesPerBatch;

    console.log(
      `Loading batch at index ${topLeftIndex} (${
        append ? "append" : "prepend"
      })`
    );

    const slides = [];
    let actuallyLoaded = 0;

    for (let i = 0; i < this.slidesPerBatch; i++) {
      if (i % 4 === 0) {
        await new Promise(requestAnimationFrame);
      }

      const offset = topLeftIndex + i;
      const globalIndex = slideState.indexToGlobal(offset);
      if (globalIndex === null) continue;

      if (this.loadedImageIndices.has(globalIndex)) {
        continue;
      }

      try {
        const data = await fetchImageByIndex(globalIndex);
        if (!data) break;
        data.globalIndex = globalIndex;
        this.loadedImageIndices.add(globalIndex);

        slides.push(this.makeSlideHTML(data, globalIndex));
        actuallyLoaded++;
      } catch (error) {
        console.error("Failed to load image:", error);
        break;
      }
    }

    if (slides.length > 0) {
      if (append) {
        this.swiper.appendSlide(slides);
      } else {
        this.suppressSlideChange = true;
        this.swiper.prependSlide(slides.reverse());
        this.swiper.slideTo(this.currentColumns, 0);
      }

      for (let i = 0; i < this.swiper.slides.length; i++) {
        const slideEl = this.swiper.slides[i];
        if (slideEl) {
          const globalIndex = slideEl.dataset.globalIndex;
          this.addDoubleTapHandler(slideEl, globalIndex);
        } else {
          console.warn("Slide element not found for double-tap handler");
        }
      }
      this.enforceHighWaterMark(!append);
    }

    return actuallyLoaded > 0;
  }

  // NOTE: Refactor this call
  enforceHighWaterMark(trimFromEnd = false) {
    if (!this.swiper || !this.slidesPerBatch || this.slidesPerBatch <= 0)
      return;

    const maxScreens = this.GRID_MAX_SCREENS;
    const highWaterSlides = this.slidesPerBatch * maxScreens;

    const len = this.swiper.slides.length;
    if (len <= highWaterSlides) return;

    let excessSlides = len - highWaterSlides;
    const removeScreens = Math.ceil(excessSlides / this.slidesPerBatch);
    const removeCount = Math.min(removeScreens * this.slidesPerBatch, len);

    const removeIndices = [];
    if (!trimFromEnd) {
      for (let i = 0; i < removeCount; i++) removeIndices.push(i);
    } else {
      for (let i = len - removeCount; i < len; i++) removeIndices.push(i);
    }

    const prevActive = this.swiper.activeIndex;

    const removedGlobalIndices = [];
    for (const idx of removeIndices) {
      const slideEl = this.swiper.slides[idx];
      if (!slideEl) continue;
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
      const maxActive = Math.max(
        0,
        this.swiper.slides.length - this.currentColumns
      );
      const targetActive = Math.min(prevActive, maxActive);
      this.swiper.slideTo(targetActive, 0);
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
        if (!state.gridViewActive) return;

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

    eventRegistry.install({ type: "grid", event: "resize" }, handleResize);
  }

  updateCurrentSlideHighlight(globalIndex = null) {
    if (!state.gridViewActive) return;

    const gridSwiperContainer = document.getElementById("gridViewContainer");
    if (!gridSwiperContainer) return;

    const currentGlobalIndex =
      globalIndex === null
        ? slideState.getCurrentSlide().globalIndex
        : globalIndex;

    gridSwiperContainer
      .querySelectorAll(".swiper-slide.current-slide")
      .forEach((slide) => {
        slide.classList.remove("current-slide");
      });

    const currentSlide = gridSwiperContainer.querySelector(
      `.swiper-slide[data-global-index="${currentGlobalIndex}"]`
    );
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

    const thumbnail_url = `thumbnails/${state.album}/${globalIndex}?size=${this.slideHeight}`;
    return `
    <div class="swiper-slide" style="width:${this.slideHeight}px; height:${
      this.slideHeight
    }px;" 
        data-global-index="${globalIndex}"
        data-filepath="${data.filepath || ""}"
        onclick="handleGridSlideClick(${globalIndex})"
        ondblclick="handleGridSlideDblClick(${globalIndex})">
      <img src="${thumbnail_url}" alt="${data.filename}" 
          style="width:100%; height:100%; object-fit:contain; background:#222; border-radius:4px; display:block;" />
    </div>
  `;
  }

  updateMetadataOverlay() {
    const globalIndex = slideState.getCurrentSlide().globalIndex;
    const data = this.slideData[globalIndex];
    if (!data) return;

    const rawDescription = data["description"] || "";
    const referenceImages = data["reference_images"] || [];
    const processedDescription = replaceReferenceImagesWithLinks(
      rawDescription,
      referenceImages,
      state.album
    );

    document.getElementById("descriptionText").innerHTML = processedDescription;
    document.getElementById("filenameText").textContent =
      data["filename"] || "";
    document.getElementById("filepathText").textContent =
      data["filepath"] || "";
    document.getElementById("metadataLink").href = data["metadata_url"] || "#";
  }

  // These functions act as a semaphore to prevent overlapping batch loads
  setBatchLoading(isLoading) {
    this.batchLoading = isLoading;
  }

  isBatchLoading() {
    return this.batchLoading;
  }

  async waitForBatchLoadingToFinish(timeoutMs = 10000, intervalMs = 50) {
    const start =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    while (this.batchLoading) {
      const now =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
      if (now - start > timeoutMs) {
        console.warn(
          "waitForBatchLoadingToFinish: timeout after",
          timeoutMs,
          "ms"
        );
        break;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
