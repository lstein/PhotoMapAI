import { slideState } from "./slide-state.js";
import { fetchSlideBatch } from "./slides.js";
import { state } from "./state.js";

let firstSlideIndex = 0;

export async function initializeGridSwiper() {
  // Destroy previous Swiper instance if it exists
  if (state.swiper) {
    state.swiper.destroy(true, true);
    state.swiper = null;
  }

  // Calculate rows based on window height - UPDATED for smaller slides
  const minSlideHeight = 180; // Reduced from 256
  const maxSlideHeight = 600; // Reduced from 800
  const availableHeight = window.innerHeight - 120;
  const rows = Math.max(2, Math.floor(availableHeight / minSlideHeight)); // Minimum 2 rows
  const slideHeight = Math.min(
    maxSlideHeight,
    Math.max(minSlideHeight, Math.floor(availableHeight / rows))
  );

  // Prepare Swiper container
  const swiperWrapper = document.querySelector(".swiper .swiper-wrapper");
  swiperWrapper.innerHTML = "";

  // Initialize Swiper in grid mode FIRST
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
      sensitivity: 10,        // Increase sensitivity (default is 1)
      releaseOnEdges: true,  // Allow scrolling to continue at edges
      thresholdDelta: 10,    // Lower threshold for triggering scroll (default is 50)
      thresholdTime: 100,    // Time window for scroll detection (default is 500)
    },
    keyboard: true,
    navigation: {
      nextEl: ".swiper-button-next",
      prevEl: ".swiper-button-prev",
    },
    // Remove scrollbar if you don't want it
    // scrollbar: false,
  });

  // Estimate how many slides fit in the viewport (plus buffer) - UPDATED
  const gridContainer = document.querySelector(".swiper");
  const minSlideWidth = 180; // Match the minimum height for square-ish slides
  const columns = Math.floor(gridContainer.offsetWidth / minSlideWidth) || 2; // Minimum 2 columns
  const slidesPerBatch = rows * columns + columns * 2; // buffer 2 extra columns

  // Now load initial batch of slides using Swiper's API
  const batchSize = slidesPerBatch;

  async function loadBatch() {
    let batchLoaded = 0;
    console.log("Loading batch of", batchSize, "slides");
    const slideData = await fetchSlideBatch(firstSlideIndex, batchSize)
    const slides = [];
    for (let i = 0; i < batchSize; i++) {
      const data = slideData[i];
      if (!data) return false;
      
      slides.push(`
        <div class="swiper-slide" style="height:${slideHeight}px" onclick="handleGridSlideClick(${data.index})">
          <img src="${data.image_url}" alt="${data.filename}" style="width:100%; height:100%; object-fit:cover;" />
        </div>
      `);
      batchLoaded++;
      firstSlideIndex++;
    }
    state.swiper.appendSlide(slides);
    state.swiper.update();
    return batchLoaded > 0;
  }

  await loadBatch();

  // Infinite scroll: load more slides when reaching the end
  state.swiper.on("reachEnd", async () => {
    const loadedMore = await loadBatch();
    if (loadedMore) {
      state.swiper.update();
    }
  });

  // Setup continuous navigation
  setupContinuousNavigation();

  // Add window resize handler
  setupGridResizeHandler(rows, slideHeight, slidesPerBatch);
}

function setupContinuousNavigation() {
  const nextBtn = document.querySelector(".swiper-button-next");
  const prevBtn = document.querySelector(".swiper-button-prev");

  let scrollInterval;
  let isScrolling = false;

  function startContinuousScroll(direction) {
    if (isScrolling) return;
    isScrolling = true;

    // Initial delay before continuous scrolling starts
    setTimeout(() => {
      if (isScrolling) {
        scrollInterval = setInterval(() => {
          if (direction === "next") {
            state.swiper.slideNext();
          } else {
            state.swiper.slidePrev();
          }
        }, 200); // Scroll every 200ms - adjust speed as needed
      }
    }, 300); // Wait 300ms before starting continuous scroll
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

function setupGridResizeHandler(initialRows, initialSlideHeight, initialSlidesPerBatch) {
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
      const newColumns = Math.floor(gridContainer.offsetWidth / minSlideWidth) || 2;
      const newSlidesPerBatch = newRows * newColumns + newColumns * 2;
      
      // Check if dimensions actually changed
      if (newRows !== initialRows || Math.abs(newSlideHeight - initialSlideHeight) > 10) {
        console.log(`Grid resize: ${initialRows}x${Math.floor(gridContainer.offsetWidth / minSlideWidth)} -> ${newRows}x${newColumns}`);
        
        // Store current position
        const currentSlideIndex = state.swiper.activeIndex;
        
        // Update Swiper configuration
        state.swiper.destroy(true, true);
        
        // Clear and reinitialize with new dimensions
        const swiperWrapper = document.querySelector(".swiper .swiper-wrapper");
        swiperWrapper.innerHTML = "";
        
        // Reinitialize Swiper with new dimensions
        state.swiper = new Swiper(".swiper", {
          direction: "horizontal",
          slidesPerView: newRows,
          grid: {
            rows: newRows,
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
        
        // Reload slides with new batch size
        async function loadBatchForResize() {
          const slideData = await fetchSlideBatch(firstSlideIndex, newSlidesPerBatch);
          const slides = [];
          for (let i = 0; i < slideData.length; i++) {
            const data = slideData[i];
            if (!data) break;
            slides.push(`
              <div class="swiper-slide" style="height:${newSlideHeight}px">
                <img src="${data.image_url}" alt="${data.filename}" style="width:100%; height:100%; object-fit:cover;" />
              </div>
            `);
          }
          if (slides.length > 0) {
            state.swiper.appendSlide(slides);
            state.swiper.update();
            firstSlideIndex = slides.length;
          }
        }
        
        await loadBatchForResize();
        
        // Restore approximate position (adjust for new grid layout)
        const newSlideIndex = Math.min(currentSlideIndex, state.swiper.slides.length - 1);
        if (newSlideIndex > 0) {
          state.swiper.slideTo(newSlideIndex, 0); // No animation for immediate positioning
        }
        
        // Re-setup event handlers
        state.swiper.on("reachEnd", async () => {
          const slideData = await fetchNextSlideBatch(newSlidesPerBatch);
          const slides = [];
          for (let i = 0; i < slideData.length; i++) {
            const data = slideData[i];
            if (!data) break;
            slides.push(`
              <div class="swiper-slide" style="height:${newSlideHeight}px">
                <img src="${data.image_url}" alt="${data.filename}" style="width:100%; height:100%; object-fit:cover;" />
              </div>
            `);
          }
          if (slides.length > 0) {
            state.swiper.appendSlide(slides);
            state.swiper.update();
          }
        });
        
        setupContinuousNavigation();
        
        // Update stored values for next resize
        initialRows = newRows;
        initialSlideHeight = newSlideHeight;
        initialSlidesPerBatch = newSlidesPerBatch;
      }
    }, 300); // 300ms debounce delay
  }
  
  window.addEventListener('resize', handleResize);
  
  // Store the handler so we can remove it later if needed
  if (!window.gridResizeHandlers) {
    window.gridResizeHandlers = [];
  }
  window.gridResizeHandlers.push(handleResize);
}

// Optional: Clean up resize handlers when switching away from grid view
function cleanupGridResizeHandlers() {
  if (window.gridResizeHandlers) {
    window.gridResizeHandlers.forEach(handler => {
      window.removeEventListener('resize', handler);
    });
    window.gridResizeHandlers = [];
  }
}

window.initializeGridSwiper = initializeGridSwiper;
window.cleanupGridResizeHandlers = cleanupGridResizeHandlers;

// Handle clicks on grid slides
window.handleGridSlideClick = function(globalIndex) {
  slideState.navigateToIndex(globalIndex, false);
};
