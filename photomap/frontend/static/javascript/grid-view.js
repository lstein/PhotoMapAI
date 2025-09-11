import { eventRegistry } from "./event-registry.js";
import { toggleGridSwiperView } from "./events.js";
import { fetchImageByIndex } from "./search.js"; // Use individual image fetching
import { slideState } from "./slide-state.js";
import { state } from "./state.js";
import { hideSpinner, showSpinner } from "./utils.js";

let loadedImageIndices = new Set(); // Track which images we've already loaded
let batchLoading = false; // Prevent concurrent batch loads
let slidesPerBatch = 0; // Number of slides to load per batch
let slideHeight = 140; // Default slide height (reduced from 200)
let currentRows = 0; // Track current grid dimensions
let currentColumns = 0;

const GRID_MAX_SCREENS = 6; // Keep up to this many screens in memory (tweakable)

// Consolidated geometry calculation function
function calculateGridGeometry() {
  const gridContainer = document.querySelector(".swiper");
  const availableWidth = gridContainer.offsetWidth - 24; // Account for padding
  const availableHeight = window.innerHeight - 120; // Account for header/footer

  // Target square tile size (reduced)
  const targetTileSize = 140; // Base tile size (was 200)
  const minTileSize = 100; // allow smaller tiles
  const maxTileSize = 200; // cap max size lower than before

  // Calculate columns and rows to fit available space with square tiles
  const columns = Math.max(2, Math.floor(availableWidth / targetTileSize));
  const rows = Math.max(2, Math.floor(availableHeight / targetTileSize));

  // Calculate actual tile size to fit perfectly in available space
  const actualTileWidth = Math.floor(availableWidth / columns);
  const actualTileHeight = Math.floor(availableHeight / rows);

  // Use the smaller dimension to keep tiles square
  const tileSize = Math.max(
    minTileSize,
    Math.min(maxTileSize, Math.min(actualTileWidth, actualTileHeight))
  );
  // Calculate slides per batch (one screen worth plus buffer)
  const batchSize = rows * columns; // batchSize == screen size

  return {
    rows,
    columns,
    tileSize,
    batchSize,
  };
}

export async function initializeGridSwiper() {
  // Destroy previous Swiper instance if it exists
  if (state.swiper) {
    state.swiper.destroy(true, true);
    state.swiper = null;
  }
  loadedImageIndices = new Set(); // Reset loaded images

  // Calculate grid geometry
  const geometry = calculateGridGeometry();
  currentRows = geometry.rows;
  currentColumns = geometry.columns;
  slideHeight = geometry.tileSize;
  slidesPerBatch = geometry.batchSize;

  // Prepare Swiper container
  const swiperWrapper = document.querySelector(".swiper .swiper-wrapper");
  swiperWrapper.innerHTML = "";

  // Initialize Swiper in grid mode
  state.swiper = new Swiper(".swiper", {
    direction: "horizontal",
    slidesPerView: currentColumns, // Number of columns
    slidesPerGroup: currentColumns, // Advance by full columns
    grid: {
      rows: currentRows,
      fill: "column",
    },
    virtual: {
      enabled: false,
    },
    spaceBetween: 6, // Reduced spacing for smaller tiles (was 8)
    mousewheel: {
      enabled: true,
      sensitivity: 10,
      releaseOnEdges: true,
      thresholdDelta: 10,
      thresholdTime: 100,
    },
    keyboard: true,
    navigation: {
      nextEl: ".swiper-button-next",
      prevEl: ".swiper-button-prev",
    },
  });

  // Wait for Swiper to be fully initialized
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Add grid-mode class to the swiper container
  const swiperContainer = document.querySelector(".swiper");
  swiperContainer.classList.add("grid-mode");

  // --- Add this block ---
  state.swiper.on("slideChange", () => {
    // Get the top-left visible slide's global index
    const slideEl = state.swiper.slides[state.swiper.activeIndex * currentRows];
    if (slideEl) {
      const globalIndex = parseInt(slideEl.dataset.globalIndex, 10);
      console.log("Grid view slideChange, global index:", globalIndex);
      if (!isNaN(globalIndex)) {
        slideState.navigateToIndex(globalIndex, false);
      }
    }
  });
  // --- end block ---

  addGridEventListeners();
  updateCurrentSlideHighlight();
  setupContinuousNavigation();
  setupGridResizeHandler();

  // For console debugging
  window.gridSwiper = state.swiper;
}

function addGridEventListeners() {
  // Handle relevant events
  eventRegistry.install(
    { type: "grid", event: "swiperModeChanged" },
    async (e) => {
      resetAllSlides();
    }
  );

  eventRegistry.install({ type: "grid", event: "searchResultsChanged" }, () => {
    resetAllSlides(0);
  });

  eventRegistry.install(
    { type: "grid", event: "slideChanged" },
    updateCurrentSlideHighlight
  );

  eventRegistry.install({ type: "grid", event: "setSlideIndex" }, (e) => {
    const { targetIndex, isSearchMode } = e.detail;
    if (isSearchMode !== slideState.isSearchMode) {
      console.error("Mismatched search mode in setSlideIndex event");
      return;
    }
    slideState.navigateToIndex(targetIndex, isSearchMode);
    resetAllSlides(targetIndex); // Pass the target index
  });

  // Reset grid when search results or album changes
  eventRegistry.install({ type: "grid", event: "albumChanged" }, () => {
    // slideState.handleAlbumChanged();
    resetAllSlides();
  });

  if (state.swiper) {
    // Load more when reaching the end
    state.swiper.on("slideNextTransitionStart", async () => {
      if (batchLoading) return; // Prevent concurrent loads
      const slidesLeft =
        Math.floor(state.swiper.slides.length / currentRows) -
        state.swiper.activeIndex;
      if (slidesLeft <= currentColumns) {
        loadBatch();
      }
    });

    // Load more when reaching the start
    state.swiper.on("slidePrevTransitionStart", async () => {
      if (batchLoading) return; // Prevent concurrent loads
      const firstSlide = parseInt(
        state.swiper.slides[0].dataset.globalIndex,
        10
      );
      if (firstSlide > 0 && state.swiper.activeIndex === 0) {
        loadBatch(firstSlide - 1, false); // Prepend a batch at the start
      }
    });
  }

  // Handle clicks on grid slides
  window.handleGridSlideClick = function (globalIndex) {
    console.log("Grid slide clicked, global index:", globalIndex);
    slideState.navigateToIndex(globalIndex, false);
  };

  // Handle double clicks on grid slides
  window.handleGridSlideDblClick = function (globalIndex) {
    console.log("Grid slide double clicked, global index:", globalIndex);
    slideState.navigateToIndex(globalIndex, false), 100;

    // add slight pause so that swiper settles down
    setTimeout(() => {
      toggleGridSwiperView(false); // Switch to swiper view
    });
  };
}

//------------------ LOADING IMAGES AND BATCHES ------------------//
// Reset batch to include the current slide in the first screen.
// @param {number|null} targetIndex - Optional index to include in first screen.
// If null, use current slide index.
async function resetAllSlides(targetIndex = null) {
  showSpinner();
  if (targetIndex === null) targetIndex = slideState.getCurrentIndex() || 0;

  loadedImageIndices.clear();

  if (!state.swiper) return;

  // remove all slides and force Swiper internal state to a safe baseline
  try {
    state.swiper.removeAllSlides();
  } catch (err) {
    console.warn("removeAllSlides failed:", err);
  }

  // Ensure internal structures are recalculated and activeIndex is valid (0)
  try {
    state.swiper.update();
    // jump to 0 instantly to avoid Swiper trying to reference stale slide elements
    state.swiper.slideTo(0, 0);
  } catch (err) {
    console.warn("Swiper reset/update failed:", err);
  }

  const currentSlide = slideState.getCurrentSlide();
  const currentPosition = slideState.isSearchMode
    ? currentSlide.searchIndex
    : currentSlide.globalIndex;

  await loadBatch(currentPosition, true);
  await loadBatch(); // Load two batches to start in order to enable forward navigation
  if (currentPosition > 0) {
    await loadBatch(currentPosition, false); // Prepend a screen if not at start
  }
  hideSpinner();
}

// Load a batch of slides starting at startIndex
// The index is either the global index or search index based on current mode.
// The startIndex will be adjusted to be an even multiple of the screen size.
// If startIndex is null, load the next batch after the last loaded slide.
async function loadBatch(startIndex = null, append = true) {
  if (batchLoading) return; // Prevent concurrent loads
  batchLoading = true;
  console.trace("Loading batch, startIndex:", startIndex, "append:", append);

  if (startIndex === null) {
    // Load after the last loaded slide
    if (!state.swiper.slides?.length) {
      startIndex = 0;
    } else {
      let lastSlideIndex = state.swiper.slides.length - 1;
      startIndex = slideState.isSearchMode
        ? lastSlideIndex
        : parseInt(
            state.swiper.slides[lastSlideIndex].dataset.globalIndex,
            10
          ) + 1;
    }
  }

  // Round to closest multiple of slidesPerBatch
  startIndex = Math.floor((startIndex + 1) / slidesPerBatch) * slidesPerBatch;

  // Subtle gotcha here. The swiper activeIndex is the index of the first visible column.
  // So if the number of columns is 4, then the activeIndexes will be 0, 4, 8, 12, ...
  const prepend_screen =
    state.swiper.activeIndex == 0 && startIndex >= slidesPerBatch;

  // Get the currentPosition for highlighting. This does not
  // affect the number or order of slides loaded.
  const currentSlide = slideState.getCurrentSlide();
  const currentPosition = slideState.isSearchMode
    ? currentSlide.searchIndex
    : currentSlide.globalIndex;

  const slides = [];
  let actuallyLoaded = 0;

  // --- NORMAL BATCH LOAD ---
  if (append) {
    for (let i = 0; i < slidesPerBatch; i++) {
      // Calculate offset from current slide position
      const offset = startIndex + i;

      // Use slideState.resolveOffset to get the correct indices for this position
      const globalIndex = slideState.indexToGlobal(offset);

      // In the event that the slide is already loaded, skip it.
      // I'm not sure this logic is necessary if load tracking is done correctly.
      if (loadedImageIndices.has(globalIndex)) {
        continue;
      }

      try {
        const data = await fetchImageByIndex(globalIndex);
        if (!data) break;

        loadedImageIndices.add(globalIndex);

        // Note: slide creation should be its own function call.
        slides.push(`
          <div class="swiper-slide" style="width:${slideHeight}px; height:${slideHeight}px;" 
              data-global-index="${globalIndex}"
              data-filename="${data.filename}"
              onclick="handleGridSlideClick(${globalIndex})"
              ondblclick="handleGridSlideDblClick(${globalIndex})">
            <img src="${data.image_url}" alt="${data.filename}" 
                style="width:100%; height:100%; object-fit:contain; background:#222; border-radius:4px; display:block;" />
          </div>
        `);
        actuallyLoaded++;
      } catch (error) {
        console.error("Failed to load image:", error);
        break;
      }
    }

    if (slides.length > 0) state.swiper.appendSlide(slides);
    // enforce high water mark after appending
    enforceHighWaterMark(false);
  } else {
    // --- PREPEND LOGIC: Add a full screen's worth of slides before startIndex ---
    for (let i = 0; i < slidesPerBatch; i++) {
      const globalIndex = slideState.indexToGlobal(startIndex - i - 1); // reverse order
      // not sure this is wanted here
      if (loadedImageIndices.has(globalIndex)) continue;

      try {
        const data = await fetchImageByIndex(globalIndex);
        if (!data) continue;

        loadedImageIndices.add(globalIndex);

        slides.push(`
          <div class="swiper-slide" style="width:${slideHeight}px; height:${slideHeight}px;" 
               data-global-index="${globalIndex}"
               onclick="handleGridSlideClick(${globalIndex})">
                ondblclick="handleGridSlideDblClick(${globalIndex})">
            <img src="${data.image_url}" alt="${data.filename}" style="width:100%; height:100%; object-fit:cover; border-radius:4px;" />
          </div>
        `);
      } catch (error) {
        console.error("Failed to load image (prepend):", error);
        continue;
      }
    }
    if (slides.length > 0) {
      state.swiper.prependSlide(slides);
      state.swiper.slideTo(currentColumns, 0); // maintain current view
      // enforce high water mark after prepending (trim the other side)
      enforceHighWaterMark(true);
    }
  }

  batchLoading = false;
  const screenContainingCurrent = Math.floor(currentPosition / slidesPerBatch);
  // state.swiper.slideTo(screenContainingCurrent * currentColumns);
  updateCurrentSlideHighlight();
  return actuallyLoaded > 0;
}

//
// High-water mark trimming: remove slides in batches (slidesPerBatch) from the start or end
//
function enforceHighWaterMark(trimFromEnd = false) {
  if (!state.swiper || !slidesPerBatch || slidesPerBatch <= 0) return;

  const maxScreens = GRID_MAX_SCREENS;
  const highWaterSlides = slidesPerBatch * maxScreens;

  const len = state.swiper.slides.length;
  if (len <= highWaterSlides) return;

  // How many slides we need to remove to get back to the high-water mark
  let excessSlides = len - highWaterSlides;
  // Number of whole screens to remove (round up so we clear enough)
  const removeScreens = Math.ceil(excessSlides / slidesPerBatch);
  const removeCount = Math.min(removeScreens * slidesPerBatch, len);

  // Record indices to remove in one batch operation
  const removeIndices = [];
  if (!trimFromEnd) {
    // remove from start: 0 .. removeCount-1
    for (let i = 0; i < removeCount; i++) removeIndices.push(i);
  } else {
    // remove from end: len-removeCount .. len-1
    for (let i = len - removeCount; i < len; i++) removeIndices.push(i);
  }

  // Preserve current active index before removal so we can adjust after
  const prevActive = state.swiper.activeIndex;

  // Collect global indices to update loadedImageIndices
  const removedGlobalIndices = [];
  for (const idx of removeIndices) {
    const slideEl = state.swiper.slides[idx];
    if (!slideEl) continue;
    const g = slideEl.dataset?.globalIndex ?? slideEl.dataset?.index;
    if (g !== undefined && g !== null && g !== "") {
      removedGlobalIndices.push(parseInt(g, 10));
    }
  }

  console.log(
    `Enforcing high water mark: removing ${removeCount} slides (${removeScreens} screens) from ${
      trimFromEnd ? "end" : "start"
    }`
  );
  // Attempt to remove all at once
  try {
    state.swiper.removeSlide(removeIndices);
  } catch (err) {
    console.log("Batch remove failed, falling back to one-by-one:", err);
    // Fallback: remove one-by-one (should be rare)
    if (!trimFromEnd) {
      for (let i = 0; i < removeCount; i++) {
        const slideEl = state.swiper.slides[0];
        if (slideEl) {
          const g = slideEl.dataset?.globalIndex ?? slideEl.dataset?.index;
          if (g !== undefined && g !== null && g !== "") {
            removedGlobalIndices.push(parseInt(g, 10));
          }
        }
        state.swiper.removeSlide(0);
      }
    } else {
      for (let i = 0; i < removeCount; i++) {
        const idx = state.swiper.slides.length - 1;
        const slideEl = state.swiper.slides[idx];
        if (slideEl) {
          const g = slideEl.dataset?.globalIndex ?? slideEl.dataset?.index;
          if (g !== undefined && g !== null && g !== "") {
            removedGlobalIndices.push(parseInt(g, 10));
          }
        }
        state.swiper.removeSlide(idx);
      }
    }
  }

  // Remove from loadedImageIndices
  for (const g of removedGlobalIndices) {
    loadedImageIndices.delete(g);
  }

  // Update Swiper internals
  state.swiper.update();

  // Adjust active index once to avoid a jump:
  if (!trimFromEnd) {
    // We removed removeScreens full screens from the start.
    // Each screen corresponds to currentColumns columns.
    const deltaColumns = currentColumns * removeScreens;
    const newActive = Math.max(0, prevActive - deltaColumns);
    state.swiper.slideTo(newActive, 0);
  } else {
    // Trimmed the tail: clamp active index so it stays valid
    const maxActive = Math.max(0, state.swiper.slides.length - currentColumns);
    const targetActive = Math.min(prevActive, maxActive);
    console.log(
      "Trimmed end, adjusting active index:",
      prevActive,
      "->",
      targetActive
    );
    state.swiper.slideTo(targetActive, 0);
  }

  state.swiper.update();
}

function setupContinuousNavigation() {
  const nextBtn = document.querySelector(".swiper-button-next");
  const prevBtn = document.querySelector(".swiper-button-prev");

  let scrollInterval;
  let isScrolling = false;

  function startContinuousScroll(direction) {
    if (isScrolling) return;
    isScrolling = true;

    setTimeout(() => {
      if (isScrolling) {
        scrollInterval = setInterval(() => {
          if (direction === "next") {
            state.swiper.slideNext();
          } else {
            state.swiper.slidePrev();
          }
        }, 200);
      }
    }, 300);
  }

  function stopContinuousScroll() {
    isScrolling = false;
    if (scrollInterval) {
      clearInterval(scrollInterval);
      scrollInterval = null;
    }
  }

  // Next button events
  if (nextBtn) {
    eventRegistry.install(
      { type: "grid", event: "mousedown", object: nextBtn },
      () => startContinuousScroll("next")
    );
    eventRegistry.install(
      { type: "grid", event: "mouseup", object: nextBtn },
      stopContinuousScroll
    );
    eventRegistry.install(
      { type: "grid", event: "mouseleave", object: nextBtn },
      stopContinuousScroll
    );

    // Touch events for mobile
    eventRegistry.install(
      { type: "grid", event: "touchstart", object: nextBtn },
      () => startContinuousScroll("next")
    );
    eventRegistry.install(
      { type: "grid", event: "touchend", object: nextBtn },
      stopContinuousScroll
    );
    eventRegistry.install(
      { type: "grid", event: "touchcancel", object: nextBtn },
      stopContinuousScroll
    );
  }

  // Previous button events
  if (prevBtn) {
    eventRegistry.install(
      { type: "grid", event: "mousedown", object: prevBtn },
      () => startContinuousScroll("prev")
    );
    eventRegistry.install(
      { type: "grid", event: "mouseup", object: prevBtn },
      stopContinuousScroll
    );
    eventRegistry.install(
      { type: "grid", event: "mouseleave", object: prevBtn },
      stopContinuousScroll
    );

    // Touch events for mobile
    eventRegistry.install(
      { type: "grid", event: "touchstart", object: prevBtn },
      () => startContinuousScroll("prev")
    );
    eventRegistry.install(
      { type: "grid", event: "touchend", object: prevBtn },
      stopContinuousScroll
    );
    eventRegistry.install(
      { type: "grid", event: "touchcancel", object: prevBtn },
      stopContinuousScroll
    );
  }

  // Stop scrolling if window loses focus
  eventRegistry.install({ type: "grid", event: "blur" }, stopContinuousScroll);
}

function setupGridResizeHandler() {
  let resizeTimeout;

  function handleResize() {
    // Debounce the resize event to avoid excessive recalculations
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(async () => {
      if (!state.gridViewActive) return; // Only handle resize when grid is active

      // Recalculate geometry
      const newGeometry = calculateGridGeometry();

      // Check if grid dimensions actually changed
      if (
        newGeometry.rows !== currentRows ||
        newGeometry.columns !== currentColumns ||
        Math.abs(newGeometry.tileSize - slideHeight) > 10
      ) {
        // Reinitialize the grid completely
        await initializeGridSwiper();
        loadBatch();
      }
    }, 300); // 300ms debounce delay
  }

  eventRegistry.install({ type: "grid", event: "resize" }, handleResize);
}

function updateCurrentSlideHighlight() {
  if (!state.gridViewActive) return;

  // Get the global index of the current slide
  const currentGlobalIndex = slideState.getCurrentSlide().globalIndex;

  // Remove existing highlights
  document.querySelectorAll(".swiper-slide.current-slide").forEach((slide) => {
    slide.classList.remove("current-slide");
  });

  // Add highlight to the current slide
  const currentSlide = document.querySelector(
    `.swiper-slide[data-global-index="${currentGlobalIndex}"]`
  );
  if (currentSlide) {
    currentSlide.classList.add("current-slide");
    // Optionally, scroll into view if needed:
    // currentSlide.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}
