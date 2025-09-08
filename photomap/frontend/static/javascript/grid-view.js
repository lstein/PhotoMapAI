import { fetchImageByIndex } from "./search.js"; // Use individual image fetching
import { slideState } from "./slide-state.js";
import { state } from "./state.js";

export async function initializeGridSwiper() {
  // Destroy previous Swiper instance if it exists
  if (state.swiper) {
    state.swiper.destroy(true, true);
    state.swiper = null;
  }

  // Calculate rows based on window height - UPDATED for smaller slides
  const minSlideHeight = 180;
  const maxSlideHeight = 600;
  const availableHeight = window.innerHeight - 120;
  const rows = Math.max(2, Math.floor(availableHeight / minSlideHeight));
  const slideHeight = Math.min(
    maxSlideHeight,
    Math.max(minSlideHeight, Math.floor(availableHeight / rows))
  );

  // Prepare Swiper container
  const swiperWrapper = document.querySelector(".swiper .swiper-wrapper");
  swiperWrapper.innerHTML = "";

  // Initialize Swiper in grid mode
  state.swiper = new Swiper(".swiper", {
    direction: "horizontal",
    slidesPerView: rows,
    grid: {
      rows: rows,
      fill: "column",
    },
    spaceBetween: 12,
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

  // Add grid-mode class to the swiper container
  const swiperContainer = document.querySelector(".swiper");
  swiperContainer.classList.add("grid-mode");

  // Calculate grid dimensions
  const gridContainer = document.querySelector(".swiper");
  const minSlideWidth = 180;
  const columns = Math.floor(gridContainer.offsetWidth / minSlideWidth) || 2;
  const slidesPerBatch = rows * columns + columns * 2; // buffer 2 extra columns

  // Track our current position in the grid - ALWAYS START FROM CURRENT SLIDE POSITION
  const currentSlide = slideState.getCurrentSlide();
  let currentBatchStartIndex;
  currentBatchStartIndex = centeredBatchStartIndex();
  let loadedImageIndices = new Set(); // Track which images we've already loaded
  let batchLoading = false; // Prevent concurrent batch loads

  // Updated loadBatch function using slideState.resolveOffset()
  async function loadBatch() {
    console.log("batchLoading:", batchLoading);
    if (batchLoading) return; // Prevent concurrent loads
    batchLoading = true;

    const slides = [];
    let actuallyLoaded = 0;

    // Get current slide info once, outside the loop
    const currentSlide = slideState.getCurrentSlide();
    const currentPosition = slideState.isSearchMode
      ? currentSlide.searchIndex
      : currentSlide.globalIndex;
    console.trace(
      "Loading batch from index:",
      currentBatchStartIndex,
      "currentPosition:",
      currentPosition
    );

    for (let i = 0; i < slidesPerBatch; i++) {
      // Calculate offset from current slide position
      const offset = currentBatchStartIndex + i - currentPosition;

      // Use slideState.resolveOffset to get the correct indices for this position
      const { globalIndex, searchIndex } = slideState.resolveOffset(offset);
      console.log("Resolved offset", offset, "to", { globalIndex, searchIndex });
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
          <div class="swiper-slide" style="height:${slideHeight}px" 
               data-global-index="${globalIndex}"
               onclick="handleGridSlideClick(${globalIndex})">
            <img src="${data.image_url}" alt="${data.filename}" style="width:100%; height:100%; object-fit:cover;" />
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
      state.swiper.update();
      currentBatchStartIndex += actuallyLoaded;

      // Update highlight after adding new slides
      setTimeout(updateCurrentSlideHighlight, 100);
    }
    batchLoading = false;
    console.log("Finished loading batch, actuallyLoaded:", actuallyLoaded);
    return actuallyLoaded > 0;
  }

  function centeredBatchStartIndex() {
    let index;
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

  window.addEventListener("swiperModeChanged", async (event) => {
    const isGridMode = event.detail?.isGridMode;
    if (!isGridMode) return;

    // Reset batch position to center around current slide
    const currentSlide = slideState.getCurrentSlide();
    console.log(
      "Resetting grid batch start index around current slide:",
      currentSlide
    );
    currentBatchStartIndex = centeredBatchStartIndex();
    loadedImageIndices.clear();

    state.swiper.removeAllSlides(); // Clear existing slides
    await loadBatch(); // Load initial batch of slides
  });

  window.addEventListener("searchResultsChanged", function () {
    // Reset to center around current slide
    const currentSlide = slideState.getCurrentSlide();
    currentBatchStartIndex = centeredBatchStartIndex();
    loadedImageIndices.clear();
    loadBatch();
  });

  // Load more when reaching the end
  state.swiper.on("reachEnd", async () => {
    await loadBatch();
  });

  // Setup continuous navigation
  setupContinuousNavigation();

  // Add window resize handler
  setupGridResizeHandler(rows, slideHeight, slidesPerBatch);
  window.addEventListener("slideChanged", updateCurrentSlideHighlight);
  updateCurrentSlideHighlight();
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
    nextBtn.addEventListener("mousedown", () => startContinuousScroll("next"));
    nextBtn.addEventListener("mouseup", stopContinuousScroll);
    nextBtn.addEventListener("mouseleave", stopContinuousScroll);

    // Touch events for mobile
    nextBtn.addEventListener("touchstart", () => startContinuousScroll("next"));
    nextBtn.addEventListener("touchend", stopContinuousScroll);
    nextBtn.addEventListener("touchcancel", stopContinuousScroll);
  }

  // Previous button events
  if (prevBtn) {
    prevBtn.addEventListener("mousedown", () => startContinuousScroll("prev"));
    prevBtn.addEventListener("mouseup", stopContinuousScroll);
    prevBtn.addEventListener("mouseleave", stopContinuousScroll);

    // Touch events for mobile
    prevBtn.addEventListener("touchstart", () => startContinuousScroll("prev"));
    prevBtn.addEventListener("touchend", stopContinuousScroll);
    prevBtn.addEventListener("touchcancel", stopContinuousScroll);
  }

  // Stop scrolling if window loses focus
  window.addEventListener("blur", stopContinuousScroll);
}

function setupGridResizeHandler(
  initialRows,
  initialSlideHeight,
  initialSlidesPerBatch
) {
  let resizeTimeout;

  function handleResize() {
    // Debounce the resize event to avoid excessive recalculations
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(async () => {
      if (!state.gridViewActive) return; // Only handle resize when grid is active

      // Recalculate dimensions
      const minSlideHeight = 180;
      const maxSlideHeight = 600;
      const availableHeight = window.innerHeight - 120;
      const newRows = Math.max(2, Math.floor(availableHeight / minSlideHeight));
      const newSlideHeight = Math.min(
        maxSlideHeight,
        Math.max(minSlideHeight, Math.floor(availableHeight / newRows))
      );

      const gridContainer = document.querySelector(".swiper");
      const minSlideWidth = 180;
      const newColumns =
        Math.floor(gridContainer.offsetWidth / minSlideWidth) || 2;
      const newSlidesPerBatch = newRows * newColumns + newColumns * 2;

      // Check if dimensions actually changed
      if (
        newRows !== initialRows ||
        Math.abs(newSlideHeight - initialSlideHeight) > 10
      ) {
        console.log(
          `Grid resize: ${initialRows}x${Math.floor(
            gridContainer.offsetWidth / minSlideWidth
          )} -> ${newRows}x${newColumns}`
        );

        // Reinitialize the grid completely
        await initializeGridSwiper();

        // Update stored values for next resize
        initialRows = newRows;
        initialSlideHeight = newSlideHeight;
        initialSlidesPerBatch = newSlidesPerBatch;
      }
    }, 300); // 300ms debounce delay
  }

  window.addEventListener("resize", handleResize);

  // Store the handler so we can remove it later if needed
  if (!window.gridResizeHandlers) {
    window.gridResizeHandlers = [];
  }
  window.gridResizeHandlers.push(handleResize);
}

// Clean up resize handlers when switching away from grid view
function cleanupGridResizeHandlers() {
  if (window.gridResizeHandlers) {
    window.gridResizeHandlers.forEach((handler) => {
      window.removeEventListener("resize", handler);
    });
    window.gridResizeHandlers = [];
  }

  // Clean up slideChanged listener
  window.removeEventListener("slideChanged", updateCurrentSlideHighlight);
}

// Reset grid when search results or album changes
window.addEventListener("searchResultsChanged", () => {
  if (state.gridViewActive) {
    initializeGridSwiper();
  }
});

window.addEventListener("albumChanged", () => {
  if (state.gridViewActive) {
    initializeGridSwiper();
  }
});

window.initializeGridSwiper = initializeGridSwiper;
window.cleanupGridResizeHandlers = cleanupGridResizeHandlers;

// Handle clicks on grid slides
window.handleGridSlideClick = function (globalIndex) {
  slideState.navigateToIndex(globalIndex, false);
  // The slideChanged event will trigger updateCurrentSlideHighlight()
};

function updateCurrentSlideHighlight() {
  if (!state.gridViewActive) return;

  const currentGlobalIndex = slideState.getCurrentSlide().globalIndex;

  // Remove existing highlights
  document.querySelectorAll(".swiper-slide.current-slide").forEach((slide) => {
    slide.classList.remove("current-slide");
  });

  // Add highlight to current slide
  const currentSlide = document.querySelector(
    `.swiper-slide[data-global-index="${currentGlobalIndex}"]`
  );
  if (currentSlide) {
    currentSlide.classList.add("current-slide");
  }
}
