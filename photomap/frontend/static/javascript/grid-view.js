import { eventRegistry } from "./event-registry.js";
import { toggleGridSwiperView } from "./events.js";
import {
  replaceReferenceImagesWithLinks,
  updateCurrentImageScore,
} from "./metadata-drawer.js";
import { fetchImageByIndex } from "./search.js"; // Use individual image fetching
import { slideState } from "./slide-state.js";
import { state } from "./state.js";
import { updateSlideshowIcon } from "./swiper.js";
import {
  hideSpinner,
  setBatchLoading,
  showSpinner,
  waitForBatchLoadingToFinish,
} from "./utils.js";

let loadedImageIndices = new Set(); // Track which images we've already loaded
let gridInitialized = false; // Track if grid has been initialized
let slidesPerBatch = 0; // Number of slides to load per batch
let slideHeight = 140; // Default slide height (reduced from 200)
let currentRows = 0; // Track current grid dimensions
let currentColumns = 0;
let slideData = {}; // Store data for each slide

const GRID_MAX_SCREENS = 6; // Keep up to this many screens in memory (tweakable)

// Consolidated geometry calculation function
function calculateGridGeometry() {
  const gridContainer = document.querySelector(".swiper");
  const availableWidth = gridContainer.offsetWidth - 24;
  const availableHeight = window.innerHeight - 120;

  // Use the factor from state
  const factor = state.gridThumbSizeFactor || 1.0;
  const targetTileSize = 150 * factor;
  const minTileSize = 75; // allow smaller tiles
  const maxTileSize = 300; // cap max size lower than before

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

// Initialization code
export async function initializeGridSwiper() {
  gridInitialized = false;
  showSpinner();
  eventRegistry.removeAll("grid"); // Clear previous event handlers

  // Destroy previous Swiper instance if it exists
  if (state.swiper) {
    state.swiper.destroy(true, true);
    state.swiper = null;
  }
  loadedImageIndices = new Set(); // Reset loaded images
  slideData = {}; // Reset slide data

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

  state.swiper.on("slideChange", () => {
    // do nothing with this.
    return;
  });

  addGridEventListeners();
  setupContinuousNavigation();
  setupGridResizeHandler();
  updateSlideshowIcon();
  updateCurrentSlide();

  gridInitialized = true;
  // For console debugging
  window.gridSwiper = state.swiper;
}

function addGridEventListeners() {
  // Handle relevant events
  eventRegistry.install(
    { type: "grid", event: "swiperModeChanged" },
    async (e) => {
      await resetAllSlides();
    }
  );

  eventRegistry.install(
    { type: "grid", event: "searchResultsChanged" },
    async (e) => {
      await resetAllSlides();
    }
  );

  // we don't do anything with this event, yet
  eventRegistry.install(
    { type: "grid", event: "slideChanged" },
    async function (e) {
      // nothing for now
    }
  );

  // Handle changes to tile size factor
  // Listen for gridThumbSizeFactorChanged event to reinitialize grid
  eventRegistry.install(
    { type: "grid", event: "gridThumbSizeFactorChanged" },
    async function () {
      await initializeGridSwiper();
      await resetAllSlides();
    }
  );

  eventRegistry.install(
    { type: "grid", event: "seekToSlideIndex" },
    async (e) => {
      const { globalIndex, searchIndex, totalSlides, isSearchMode } = e.detail;
      if (isSearchMode !== slideState.isSearchMode) {
        console.error("Mismatched search mode in setSlideIndex event");
        return;
      }
      // If the globalIndex is already visible, just highlight it
      const slideEl = document.querySelector(
        `.swiper-slide[data-global-index='${globalIndex}']`
      );
      if (slideEl) {
        updateCurrentSlideHighlight(globalIndex);
        // Also ensure it's on the currently visible screen
        const slideIndex = Array.from(state.swiper.slides).indexOf(slideEl);
        const screenIndex = Math.floor(
          slideIndex / (currentRows * currentColumns)
        );
        state.swiper.slideTo(screenIndex * currentColumns);
        return;
      }
      // Otherwise, load the screen that contains the globalIndex slide
      await resetAllSlides(); // Pass the target index
    }
  );

  // Reset grid when search results or album changes
  eventRegistry.install({ type: "grid", event: "albumChanged" }, async () => {
    await resetAllSlides();
  });

  if (state.swiper) {
    // Load more when reaching the end
    state.swiper.on("slideNextTransitionStart", async () => {
      await waitForBatchLoadingToFinish();
      const slidesLeft =
        Math.floor(state.swiper.slides.length / currentRows) -
        state.swiper.activeIndex;
      if (slidesLeft <= currentColumns) {
        const lastSlideIndex =
          parseInt(
            state.swiper.slides[state.swiper.slides.length - 1].dataset
              .globalIndex,
            10
          ) || 0;
        const index = slideState.isSearchMode
          ? slideState.globalToSearch(lastSlideIndex) + 1
          : lastSlideIndex + 1;
        loadBatch(index, true); // Append a batch at the end
      }
    });

    // Load more when reaching the start
    state.swiper.on("slidePrevTransitionStas.seart", async () => {
      await waitForBatchLoadingToFinish();
      const firstSlide = parseInt(
        state.swiper.slides[0].dataset.globalIndex,
        10
      );
      const index = slideState.isSearchMode
        ? slideState.globalToSearch(firstSlide)
        : firstSlide;
      if (firstSlide > 0 && state.swiper.activeIndex === 0) {
        loadBatch(index - 1, false); // Prepend a batch at the start
      }
    });

    // onChange event
    state.swiper.on("slideChange", async () => {
      // If the currently highlighted slide s.seais not visible, move the highlight to the top-left slide
      await state.swiper.update(); // Ensure Swiper state is current
      const currentSlide = slideState.getCurrentSlide();
      const currentGlobal = currentSlide.globalIndex;
      const slideEl = document.querySelector(
        `.swiper-slide[data-global-index='${currentGlobal}']`
      );
      if (slideEl) {
        const slideIndex = Array.from(state.swiper.slides).indexOf(slideEl);
        const activeIndex = state.swiper.activeIndex * currentRows;
        if (
          slideIndex < activeIndex ||
          slideIndex >= activeIndex + currentRows * currentColumns
        ) {
          // Move highlight to top-left slide
          const topLeftSlideEl = state.swiper.slides[activeIndex]; // first slide in active view
          if (topLeftSlideEl) {
            const topLeftGlobal = parseInt(
              topLeftSlideEl.dataset.globalIndex,
              10
            );
            slideState.updateFromExternal(
              topLeftGlobal,
              slideState.globalToSearch(topLeftGlobal)
            );
            updateCurrentSlide();
          }
        }
      }
    });
  }

  // Handle clicks on grid slides
  window.handleGridSlideClick = function (globalIndex) {
    //slideState.setCurrentIndex(globalIndex, false);
    slideState.updateFromExternal(
      globalIndex,
      slideState.globalToSearch(globalIndex)
    );

    updateCurrentSlide();
  };

  // Handle double clicks on grid slides
  window.handleGridSlideDblClick = async function (globalIndex) {
    slideState.setCurrentIndex(globalIndex, false);
    updateCurrentSlideHighlight(globalIndex);

    // Await the mode switch before proceeding
    await toggleGridSwiperView(false); // Switch to swiper view
  };
}
// Double tap for touch devices
function addDoubleTapHandler(slideEl, globalIndex) {
  // Prevent duplicate handlers
  if (slideEl.dataset.doubleTapHandlerAttached) return;
  let lastTap = 0;
  slideEl.addEventListener("touchend", function (e) {
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

//------------------ LOADING IMAGES AND BATCHES ------------------//
// Reset batch to include the current slide in the first screen.
// @param {number|null} targetIndex - Optional index to include in first screen.
// If null, use current slide index.
async function resetAllSlides() {
  if (!gridInitialized) return;
  if (!state.swiper) return;
  showSpinner();

  await new Promise(requestAnimationFrame); // display spinner

  await waitForBatchLoadingToFinish();
  setBatchLoading(true);

  const targetIndex = slideState.getCurrentIndex();

  loadedImageIndices.clear();

  // remove all slides and force Swiper internal state to a safe baseline
  try {
    // state.swiper.slideTo(0, 0); // jump to 0 instantly to avoid issues
    if (!state.swiper.destroyed) state.swiper.removeAllSlides();
  } catch (err) {
    true;
    console.warn("removeAllSlides failed:", err);
  }
  try {
    state.swiper.update(); // ensure internal state is correct
  } catch (err) {
    console.warn(
      "swiper.update() failed:",
      err,
      "\ncontinuing anyway, slide length =",
      state.swiper.slides.length
    );
  }
  await loadBatch(targetIndex, true);
  await loadBatch(targetIndex + slidesPerBatch, true); // Load two batches to start in order to enable forward navigation
  if (targetIndex > 0) {
    await loadBatch(targetIndex, false); // Prepend a screen if not at start
  }
  updateCurrentSlide();
  setBatchLoading(false);
  hideSpinner();
}

// Load a batch of slides starting at startIndex
// The index is either the global index or search index based on current mode.
// The startIndex will be adjusted to be an even multiple of the screen size.
// If startIndex is null, load the next batch after the last loaded slide.
async function loadBatch(startIndex = null, append = true) {
  if (startIndex === null) {
    // Load after the last loaded slide
    if (!state.swiper.slides?.length) {
      startIndex = 0;
    } else {
      let lastSlideIndex = state.swiper.slides.length - 1;
      startIndex = slideState.isSearchMode
        ? lastSlideIndex + 1
        : parseInt(
            state.swiper.slides[lastSlideIndex].dataset.globalIndex,
            10
          ) + 1;
    }
  }

  // Round to closest multiple of slidesPerBatch
  startIndex = Math.floor(startIndex / slidesPerBatch) * slidesPerBatch;

  // Subtle gotcha here. The swiper activeIndex is the index of the first visible column.
  // So if the number of columns is 4, then the activeIndexes will be 0, 4, 8, 12, ...
  const prepend_screen =
    state.swiper.activeIndex == 0 && startIndex >= slidesPerBatch;

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
        data.globalIndex = globalIndex; // Ensure globalIndex is set in data
        loadedImageIndices.add(globalIndex);

        // Note: slide creation should be its own function call.
        slides.push(makeSlideHTML(data, globalIndex));
        actuallyLoaded++;
      } catch (error) {
        console.error("Failed to load image:", error);
        break;
      }
      if (i % 8 === 0) {
        await new Promise(requestAnimationFrame);
      }
    }

    if (slides.length > 0) state.swiper.appendSlide(slides);

    // After appending slides, add the double-tap handler to the new ones.
    // This needs to be done after appending so we can access the DOM elements.
    const allSlides = state.swiper.slides;
    const numNew = slides.length;
    for (let i = allSlides.length - numNew; i < allSlides.length; i++) {
      const slideEl = allSlides[i];
      if (slideEl) {
        const globalIndex = slideEl.dataset.globalIndex;
        addDoubleTapHandler(slideEl, globalIndex);
      }
    }

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
        data.globalIndex = globalIndex; // Ensure globalIndex is set in data

        loadedImageIndices.add(globalIndex);
        slides.push(makeSlideHTML(data, globalIndex));
      } catch (error) {
        console.error("Failed to load image (prepend):", error);
        continue;
      }
      if (i % 8 === 0) {
        await new Promise(requestAnimationFrame);
      }
    }
    if (slides.length > 0) {
      state.swiper.prependSlide(slides);

      // After prepending slides, add double-tap handlers to all the new ones.
      for (let i = 0; i < slides.length; i++) {
        const slideEl = state.swiper.slides[i];
        if (slideEl) {
          const globalIndex = slideEl.dataset.globalIndex;
          addDoubleTapHandler(slideEl, globalIndex);
        }
      }
      state.swiper.slideTo(currentColumns, 0); // maintain current view
      // enforce high water mark after prepending (trim the other side)
      enforceHighWaterMark(true);
    }
  }

  updateCurrentSlide();

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

  // Attempt to remove all at once
  try {
    state.swiper.removeSlide(removeIndices);
  } catch (err) {
    console.warn("Batch remove failed, falling back to one-by-one:", err);
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
    delete slideData[g];
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
        await loadBatch();
        await loadBatch(); // Load two batches to start
      }
    }, 300); // 300ms debounce delay
  }

  eventRegistry.install({ type: "grid", event: "resize" }, handleResize);
}

function updateCurrentSlideHighlight(globalIndex = null) {
  if (!state.gridViewActive) return;

  // Get the global index of the current slide
  const currentGlobalIndex =
    globalIndex === null
      ? slideState.getCurrentSlide().globalIndex
      : globalIndex;

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
  }
}

// After a slide change, call this to update the metadata overlay, slide score, and highlight
function updateCurrentSlide() {
  updateCurrentSlideHighlight();
  updateMetadataOverlay();
  updateCurrentImageScore(
    slideData[slideState.getCurrentSlide().globalIndex] || null
  );
}

// Make the slide and record its metadata prior to inserting into the grid
// this should be harmonized with swiper.js
// Data is the image metadata retrieved from the server side
function makeSlideHTML(data, globalIndex) {
  const searchIndex = slideState.globalToSearch(globalIndex);
  if (searchIndex !== null && slideState.isSearchMode) {
    const results = slideState.searchResults[searchIndex];
    data.score = results?.score || "";
    data.cluster = results?.cluster || "";
    data.color = results?.color || "#000000"; // Default
  }
  data.searchIndex = slideState.globalToSearch(globalIndex);
  slideData[globalIndex] = data; // Cache the data

  return `
    <div class="swiper-slide" style="width:${slideHeight}px; height:${slideHeight}px;" 
        data-global-index="${globalIndex}"
        data-filepath="${data.filepath || ""}"
        onclick="handleGridSlideClick(${globalIndex})"
        ondblclick="handleGridSlideDblClick(${globalIndex})">
      <img src="${data.image_url}" alt="${data.filename}" 
          style="width:100%; height:100%; object-fit:contain; background:#222; border-radius:4px; display:block;" />
    </div>
  `;
}

// Update banner with current slide's metadata
// To do: harmonize this with the similarly-named function in swiper.js
function updateMetadataOverlay() {
  const globalIndex = slideState.getCurrentSlide().globalIndex;
  const data = slideData[globalIndex];
  if (!data) return;

  // Process description with reference image links
  const rawDescription = data["description"] || "";
  const referenceImages = data["reference_images"] || [];
  const processedDescription = replaceReferenceImagesWithLinks(
    rawDescription,
    referenceImages,
    state.album
  );

  document.getElementById("descriptionText").innerHTML = processedDescription;
  document.getElementById("filenameText").textContent = data["filename"] || "";
  document.getElementById("filepathText").textContent = data["filepath"] || "";
  document.getElementById("metadataLink").href = data["metadata_url"] || "#";
}
