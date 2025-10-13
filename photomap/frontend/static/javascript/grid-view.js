import { eventRegistry } from "./event-registry.js";
import { toggleGridSwiperView } from "./events.js";
import {
  replaceReferenceImagesWithLinks,
  updateCurrentImageScore,
} from "./metadata-drawer.js";
import { fetchImageByIndex } from "./search.js";
import { slideState } from "./slide-state.js";
import { state } from "./state.js";
import {
  hideSpinner,
  isBatchLoading,
  setBatchLoading,
  showSpinner,
  waitForBatchLoadingToFinish,
} from "./utils.js";

// Create and export singleton instance
export const initializeGridSwiper = async () => {
  const gridViewManager = new GridViewManager();
  gridViewManager.initializeGridSwiper();
  return gridViewManager;
};

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
    this.slideData = {};
    this.GRID_MAX_SCREENS = 6;

    GridViewManager.instance = this;
  }

  // Consolidated geometry calculation function
  calculateGridGeometry() {
    const gridContainer = document.querySelector(".swiper");
    const availableWidth = gridContainer.offsetWidth - 24;
    const availableHeight = window.innerHeight - 120;

    const factor = state.gridThumbSizeFactor || 1.0;
    const targetTileSize = 150 * factor;
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
    console.log("Grid container display:", gridContainer?.style.display);
    return gridContainer && gridContainer.style.display !== "none";
  }

  initializeGridSwiper() {
    console.log("Initializing grid swiper...");
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
      mousewheel: {
        enabled: true,
        sensitivity: 10,
        releaseOnEdges: true,
        thresholdDelta: 10,
        thresholdTime: 100,
      },
      keyboard: true,
      // navigation: {
      //   prevEl: ".swiper-button-prev",
      //   nextEl: ".swiper-button-next",
      // },
    });

    // await new Promise((resolve) => setTimeout(resolve, 100));
    this.addGridEventListeners();
    this.setupGridResizeHandler();
    this.updateCurrentSlide();
    state.single_swiper.updateSlideshowIcon();

    this.gridInitialized = true;
    window.swiper = this.swiper; // for debugging
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
        await this.initializeGridSwiper();
        await this.resetAllSlides();
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
      console.log("Album changed - resetting grid view");
      await this.resetAllSlides();
    });
    console.log("Installed albumChanged event listener");

    if (this.swiper) {
      this.swiper.on("slideNextTransitionStart", async () => {
        if (state.isTransitioning) return;
        showSpinner();
        state.isTransitioning = true;
        await waitForBatchLoadingToFinish();
        state.isTransitioning = false;
        const slidesLeft =
          Math.floor(this.swiper.slides.length / this.currentRows) -
          this.swiper.activeIndex;
        if (slidesLeft <= this.currentColumns) {
          const lastSlideIndex =
            parseInt(
              this.swiper.slides[this.swiper.slides.length - 1].dataset
                .globalIndex,
              10
            ) || 0;
          const index = slideState.isSearchMode
            ? slideState.globalToSearch(lastSlideIndex) + 1
            : lastSlideIndex + 1;
          await waitForBatchLoadingToFinish();
          setBatchLoading(true);
          try {
            await this.loadBatch(index, true);
          } catch (error) {
            console.log(error);
          } finally {
            setBatchLoading(false);
          }
        }
        hideSpinner();
      });

      this.swiper.on("slidePrevTransitionStart", async () => {
        if (state.isTransitioning) return;
        state.isTransitioning = true;
        await waitForBatchLoadingToFinish();
        setBatchLoading(true);
        state.isTransitioning = false;
        const firstSlide = parseInt(
          this.swiper.slides[0].dataset.globalIndex,
          10
        );
        const index = slideState.isSearchMode
          ? slideState.globalToSearch(firstSlide)
          : firstSlide;
        if (firstSlide > 0 && this.swiper.activeIndex === 0) {
          await this.loadBatch(index - 1, false);
        }
        setBatchLoading(false);
      });

      this.swiper.on("transitionEnd", () => {
        this.suppressSlideChange = false;
      });

      this.swiper.on("slideChange", async () => {
        if (this.suppressSlideChange) return;

        const currentSlide = slideState.getCurrentSlide();
        const currentGlobal = currentSlide.globalIndex;
        const slideEl = document.querySelector(
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
              const topLeftGlobal = parseInt(
                topLeftSlideEl.dataset.globalIndex,
                10
              );
              slideState.updateFromExternal(
                topLeftGlobal,
                slideState.globalToSearch(topLeftGlobal)
              );
              // Skip if batch loading is in progress
              if (!isBatchLoading()) this.updateCurrentSlide();
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
      if (state.isTransitioning) return;
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

  async resetAllSlides() {
    if (!this.gridInitialized) return;
    if (!this.swiper) return;
    if (!this.isVisible()) return;
    console.trace("Resetting all slides in grid view...");

    showSpinner();

    await new Promise(requestAnimationFrame);

    const targetIndex = slideState.getCurrentIndex();

    this.loadedImageIndices.clear();

    try {
      if (!this.swiper.destroyed) this.swiper.removeAllSlides();
    } catch (err) {
      console.warn("removeAllSlides failed:", err);
    }

    try {
      await waitForBatchLoadingToFinish();
      setBatchLoading(true);

      await this.loadBatch(targetIndex, true);
      console.log("setting current slide to:", targetIndex);
      slideState.setCurrentIndex(targetIndex);
      this.updateCurrentSlide();

      // add some context slides before and after
      await this.loadBatch(targetIndex + this.slidesPerBatch, true);
      if (targetIndex > 0) {
        await this.loadBatch(targetIndex, false);
      }
    } catch (err) {
      console.log(err);
    }

    setBatchLoading(false);
    hideSpinner();
  }

  async loadBatch(startIndex = null, append = true) {
    console.log("Loading batch, startIndex:", startIndex, "append:", append);
    if (startIndex === null) {
      if (!this.swiper.slides?.length) {
        startIndex = 0;
      } else {
        let lastSlideIndex = this.swiper.slides.length - 1;
        startIndex = slideState.isSearchMode
          ? lastSlideIndex + 1
          : parseInt(
              this.swiper.slides[lastSlideIndex].dataset.globalIndex,
              10
            ) + 1;
      }
    }

    const topLeftIndex =
      Math.floor(startIndex / this.slidesPerBatch) * this.slidesPerBatch;

    const slides = [];
    let actuallyLoaded = 0;

    if (append) {
      for (let i = 0; i < this.slidesPerBatch; i++) {
        if (i % 4 === 0) {
          await new Promise(requestAnimationFrame);
          if (state.isTransitioning) {
            throw new Error("Aborted loadBatch due to transition");
          }
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

      if (slides.length > 0) this.swiper.appendSlide(slides);

      const allSlides = this.swiper.slides;
      const numNew = slides.length;
      for (let i = allSlides.length - numNew; i < allSlides.length; i++) {
        const slideEl = allSlides[i];
        if (slideEl) {
          const globalIndex = slideEl.dataset.globalIndex;
          this.addDoubleTapHandler(slideEl, globalIndex);
        }
      }

      this.enforceHighWaterMark(false);
    } else {
      for (let i = 0; i < this.slidesPerBatch; i++) {
        if (i % 4 === 0) {
          await new Promise(requestAnimationFrame);
          if (state.isTransitioning) {
            throw new Error("Aborted loadBatch due to transition");
          }
        }

        const globalIndex = slideState.indexToGlobal(topLeftIndex - i - 1);
        if (this.loadedImageIndices.has(globalIndex)) continue;

        try {
          const data = await fetchImageByIndex(globalIndex);
          if (!data) continue;
          data.globalIndex = globalIndex;

          this.loadedImageIndices.add(globalIndex);
          slides.push(this.makeSlideHTML(data, globalIndex));
        } catch (error) {
          console.error("Failed to load image (prepend):", error);
          continue;
        }
      }

      if (slides.length > 0) {
        this.suppressSlideChange = true;
        this.swiper.prependSlide(slides);

        for (let i = 0; i < slides.length; i++) {
          const slideEl = this.swiper.slides[i];
          if (slideEl) {
            const globalIndex = slideEl.dataset.globalIndex;
            this.addDoubleTapHandler(slideEl, globalIndex);
          }
        }
        this.swiper.slideTo(this.currentColumns, 0);
        this.enforceHighWaterMark(true);
      }
    }
    return actuallyLoaded > 0;
  }

  enforceHighWaterMark(trimFromEnd = false) {
    if (!this.swiper || !this.slidesPerBatch || this.slidesPerBatch <= 0)
      return;
    if (state.isTransitioning) return;

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

    try {
      this.swiper.removeSlide(removeIndices);
    } catch (err) {
      console.warn("Batch remove failed, falling back to one-by-one:", err);
      if (!trimFromEnd) {
        for (let i = 0; i < removeCount; i++) {
          const slideEl = this.swiper.slides[0];
          if (slideEl) {
            const g = slideEl.dataset?.globalIndex ?? slideEl.dataset?.index;
            if (g !== undefined && g !== null && g !== "") {
              removedGlobalIndices.push(parseInt(g, 10));
            }
          }
          this.swiper.removeSlide(0);
        }
      } else {
        for (let i = 0; i < removeCount; i++) {
          const idx = this.swiper.slides.length - 1;
          const slideEl = this.swiper.slides[idx];
          if (slideEl) {
            const g = slideEl.dataset?.globalIndex ?? slideEl.dataset?.index;
            if (g !== undefined && g !== null && g !== "") {
              removedGlobalIndices.push(parseInt(g, 10));
            }
          }
          this.swiper.removeSlide(idx);
        }
      }
    }

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

  setupGridResizeHandler() {
    let resizeTimeout;

    const handleResize = async () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(async () => {
        if (!state.gridViewActive) return;

        const newGeometry = this.calculateGridGeometry();

        if (
          newGeometry.rows !== this.currentRows ||
          newGeometry.columns !== this.currentColumns ||
          Math.abs(newGeometry.tileSize - this.slideHeight) > 10
        ) {
          const currentGlobalIndex = slideState.getCurrentSlide().globalIndex;
          this.initializeGridSwiper();

          await waitForBatchLoadingToFinish();
          setBatchLoading(true);
          await this.loadBatch(currentGlobalIndex);
          await this.loadBatch(currentGlobalIndex + this.slidesPerBatch);
          setBatchLoading(false);
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
      console.log("Highlighting current slide:", currentGlobalIndex);
      currentSlide.classList.add("current-slide");
    }
  }

  updateCurrentSlide() {
    console.trace("UpdateCurrentSlide called");
    this.updateCurrentSlideHighlight();
    this.updateMetadataOverlay();
    updateCurrentImageScore(
      this.slideData[slideState.getCurrentSlide().globalIndex] || null
    );
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
}
