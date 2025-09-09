import { eventRegistry } from "./event-registry.js";
import { fetchImageByIndex } from "./search.js"; // Use individual image fetching
import { slideState } from "./slide-state.js";
import { state } from "./state.js";

let loadedImageIndices = new Set(); // Track which images we've already loaded
let batchLoading = false; // Prevent concurrent batch loads
let currentBatchStartIndex = 0;
let slidesPerBatch = 0; // Number of slides to load per batch
let slideHeight = 200; // Default slide height
let currentRows = 0; // Track current grid dimensions
let currentColumns = 0;

// Consolidated geometry calculation function
function calculateGridGeometry() {
  const gridContainer = document.querySelector(".swiper");
  const availableWidth = gridContainer.offsetWidth - 24; // Account for padding
  const availableHeight = window.innerHeight - 120; // Account for header/footer

  // Target square tile size
  const targetTileSize = 200; // Base tile size
  const minTileSize = 150;
  const maxTileSize = 300;

  // Calculate columns and rows to fit available space with square tiles
  const columns = Math.max(2, Math.floor(availableWidth / targetTileSize));
  const rows = Math.max(2, Math.floor(availableHeight / targetTileSize));

  // Calculate actual tile size to fit perfectly in available space
  const actualTileWidth = Math.floor(availableWidth / columns);
  const actualTileHeight = Math.floor(availableHeight / rows);

  // Use the smaller dimension to keep tiles square
  const tileSize = Math.max(
    minTileSize,
    Math.min(maxTileSize, Math.min(actualTileWidth, actualTileHeight)))
    ;

  // Calculate slides per batch (one screen worth plus buffer)
  const batchSize = rows * columns * 2; // Load 2 screens worth

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

  console.log(
    `Grid initialized: ${currentColumns}x${currentRows}, tile size: ${slideHeight}px, batch size: ${slidesPerBatch}`
  );

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
    spaceBetween: 8, // Reduced spacing for better fit
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

  // Track our current position in the grid
  currentBatchStartIndex = centeredBatchStartIndex();

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
    resetAllSlides();
    currentBatchStartIndex = centeredBatchStartIndex();
    loadBatch(currentBatchStartIndex);
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
    resetAllSlides();
    loadBatch();
  });

  if (state.swiper) {
    // Load more when reaching the end
    state.swiper.on("reachEnd", async () => {
      await loadBatch();
    });
  }

  // Handle clicks on grid slides
  window.handleGridSlideClick = function (globalIndex) {
    console.log("Grid slide clicked, global index:", globalIndex);
    slideState.navigateToIndex(globalIndex, false);
  };
}

//------------------ LOADING IMAGES AND BATCHES ------------------//
// Reset batch position to center around current slide
async function resetAllSlides(targetIndex = null) {
  const currentSlide = slideState.getCurrentSlide();
  console.log(
    "Resetting grid batch start index around current slide:",
    currentSlide
  );
  currentBatchStartIndex = centeredBatchStartIndex();
  loadedImageIndices.clear();
  state.swiper.removeAllSlides(); // Clear existing slides

  // If a targetIndex is provided, recenter the batch around it
  if (targetIndex !== null) {
    if (slideState.isSearchMode) {
      currentBatchStartIndex = Math.max(
        0,
        targetIndex - Math.floor(slidesPerBatch / 3) + 1
      );
    } else {
      currentBatchStartIndex = Math.max(
        0,
        targetIndex - Math.floor(slidesPerBatch / 3) + 1
      );
    }
  }

  await loadBatch(currentBatchStartIndex);

  // After loading, find the slide index in the DOM and slide to it
  if (targetIndex !== null) {
    // Find the DOM index of the slide with data-global-index = globalIndex
    const globalIndex = slideState.isSearchMode
      ? state.searchResults[targetIndex]?.index
      : targetIndex;
    const slides = Array.from(state.swiper.slides);
    const domIndex = slides.findIndex(
      (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
    );
    if (domIndex >= 0) {
      state.swiper.slideTo(domIndex, 0);
    }
  }
}

// Load a batch of slides starting at currentBatchStartIndex
async function loadBatch(startIndex = currentBatchStartIndex) {
  console.log("batchLoading:", batchLoading);
  if (batchLoading) return; // Prevent concurrent loads
  batchLoading = true;

  // --- NORMAL BATCH LOAD (append) ---
  const slides = [];
  let actuallyLoaded = 0;

  // Get current slide info once, outside the loop
  const currentSlide = slideState.getCurrentSlide();
  const currentPosition = slideState.isSearchMode
    ? currentSlide.searchIndex
    : currentSlide.globalIndex;
  console.log(
    "Loading batch from index:",
    currentBatchStartIndex,
    "currentPosition:",
    currentPosition
  );

  // --- NORMAL BATCH LOAD ---
  for (let i = 0; i < slidesPerBatch; i++) {
    // Calculate offset from current slide position
    const offset = startIndex + i - currentPosition;

    // Use slideState.resolveOffset to get the correct indices for this position
    const { globalIndex, searchIndex } = slideState.resolveOffset(offset);
    // If we're out of bounds, stop loading
    if (globalIndex === null) break;

    if (loadedImageIndices.has(globalIndex)) {
      continue;
    }

    try {
      const data = await fetchImageByIndex(globalIndex);
      if (!data) break;

      loadedImageIndices.add(globalIndex);

      slides.push(`
          <div class="swiper-slide" style="width:${slideHeight}px; height:${slideHeight}px;" 
               data-global-index="${globalIndex}"
               onclick="handleGridSlideClick(${globalIndex})">
            <img src="${data.image_url}" alt="${data.filename}" style="width:100%; height:100%; object-fit:cover; border-radius:4px;" />
          </div>
        `);
      actuallyLoaded++;
    } catch (error) {
      console.error("Failed to load image:", error);
      break;
    }
  }

  if (slides.length > 0) {
    state.swiper.appendSlide(slides);
    // Optionally, scroll to the first slide of the batch if needed
    // state.swiper.slideTo(0, 0);
  }

  // --- PREPEND LOGIC: Add a full screen's worth of slides before startIndex ---
  if (startIndex > 0) {
    const slidesPerScreen = currentColumns * currentRows;
    const prependCount = Math.min(slidesPerScreen, startIndex);
    const prependSlides = [];
    for (let i = prependCount - 1; i >= 0; i--) {
      const offset = startIndex - prependCount + i - currentPosition;
      const { globalIndex, searchIndex } = slideState.resolveOffset(offset);
      if (globalIndex === null) continue;
      if (loadedImageIndices.has(globalIndex)) continue;

      try {
        const data = await fetchImageByIndex(globalIndex);
        if (!data) continue;

        loadedImageIndices.add(globalIndex);

        prependSlides.push(`
          <div class="swiper-slide" style="width:${slideHeight}px; height:${slideHeight}px;" 
               data-global-index="${globalIndex}"
               onclick="handleGridSlideClick(${globalIndex})">
            <img src="${data.image_url}" alt="${data.filename}" style="width:100%; height:100%; object-fit:cover; border-radius:4px;" />
          </div>
        `);
      } catch (error) {
        console.error("Failed to load image (prepend):", error);
        continue;
      }
    }
    if (prependSlides.length > 0) {
      state.swiper.prependSlide(prependSlides);
      // Move to the first slide of the newly loaded batch (top-left of the original batch)
      state.swiper.slideTo(currentColumns, 0);
      currentBatchStartIndex -= prependSlides.length;
    }
  }

  batchLoading = false;
  updateCurrentSlideHighlight();
  console.log("Finished loading batch, actuallyLoaded:", actuallyLoaded);
  return actuallyLoaded > 0;
}

// Return an index for a tile that is roughly centered on the window.
function centeredBatchStartIndex() {
  let index;
  const currentSlide = slideState.getCurrentSlide();
  if (slideState.isSearchMode) {
    index = Math.max(
      0,
      currentSlide.searchIndex - Math.floor(slidesPerBatch / 3) + 1
    );
  } else {
    index = Math.max(
      0,
      currentSlide.globalIndex - Math.floor(slidesPerBatch / 3) + 1
    );
  }
  return index;
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
        console.log(
          `Grid resize: ${currentColumns}x${currentRows} -> ${newGeometry.columns}x${newGeometry.rows}, tile size: ${slideHeight}px -> ${newGeometry.tileSize}px`
        );

        // Reinitialize the grid completely
        await initializeGridSwiper();
        loadBatch(centeredBatchStartIndex());
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
