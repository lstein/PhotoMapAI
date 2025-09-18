// swiper.js
// This file initializes the Swiper instance and manages slide transitions.
import { eventRegistry } from "./event-registry.js";
import { updateMetadataOverlay } from "./metadata-drawer.js";
import { fetchImageByIndex } from "./search.js";
import { getCurrentSlideIndex, slideState } from "./slide-state.js";
import { state } from "./state.js";
import { updateCurrentImageMarker } from "./umap.js";
import { setBatchLoading, waitForBatchLoadingToFinish } from "./utils.js";

// Check if the device is mobile
function isTouchDevice() {
  return (
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0 ||
    navigator.msMaxTouchPoints > 0
  );
}

const hasTouchCapability = isTouchDevice();
let isPrepending = false; // Place this at module scope
let isAppending = false;
let isInternalSlideChange = false; // To prevent recursion in slideChange handler

export async function initializeSingleSwiper() {
  // The swiper shares part of the DOM with the grid view,
  // so we need to clean up any existing state.
  eventRegistry.removeAll("swiper"); // Clear previous event handlers

  if (state.swiper) {
    state.swiper.destroy(true, true);
    state.swiper = null;
  }

  // To prevent unwanted visual effects during destruction and re-initialization,
  const swiperWrapper = document.querySelector(".swiper .swiper-wrapper");
  if (swiperWrapper) {
    swiperWrapper.innerHTML = "";
  }
  // Reset any grid-specific state
  state.gridViewActive = false;

  // Swiper config for single-image mode
  const swiperConfig = {
    direction: "horizontal", // Ensure it's horizontal for single view
    slidesPerView: 1, // Single slide view
    spaceBetween: 0, // No space between slides in single view
    navigation: {
      nextEl: ".swiper-button-next",
      prevEl: ".swiper-button-prev",
    },
    autoplay: {
      delay: state.currentDelay * 1000,
      disableOnInteraction: false,
      enabled: false,
    },
    pagination: {
      el: ".swiper-pagination",
      clickable: true,
      dynamicBullets: true,
    },
    loop: false,
    touchEventsTarget: "container",
    allowTouchMove: true,
    simulateTouch: true,
    touchStartPreventDefault: false,
    touchMoveStopPropagation: false,
    keyboard: {
      enabled: true,
      onlyInViewport: true,
    },
    mousewheel: {
      enabled: true,
      releaseonEdges: true,
    },
  };

  if (hasTouchCapability) {
    swiperConfig.zoom = {
      maxRatio: 3,
      minRatio: 1,
      toggle: true,
      containerClass: "swiper-zoom-container",
      zoomedSlideClass: "swiper-slide-zoomed",
    };
  }

  // Initialize Swiper
  state.swiper = new Swiper(".swiper", swiperConfig);

  // Wait for Swiper to be fully initialized
  // await new Promise((resolve) => setTimeout(resolve, 100));

  initializeSwiperHandlers();
  initializeEventHandlers();

  // Initial icon state and overlay
  updateSlideshowIcon();
  updateMetadataOverlay();

  // Remove grid-mode class from swiper container
  const swiperContainer = document.querySelector(".swiper");
  swiperContainer.classList.remove("grid-mode");
}

function initializeSwiperHandlers() {
  // Update icon on slide change or autoplay events (with guards)
  if (!state.swiper) return;

  state.swiper.on("autoplayStart", () => {
    if (!state.gridViewActive) updateSlideshowIcon();
  });

  state.swiper.on("autoplayResume", () => {
    if (!state.gridViewActive) updateSlideshowIcon();
  });

  state.swiper.on("autoplayStop", () => {
    if (!state.gridViewActive) updateSlideshowIcon();
  });

  state.swiper.on("autoplayPause", () => {
    if (!state.gridViewActive) updateSlideshowIcon();
  });

  state.swiper.on("scrollbarDragStart", () => {
    if (!state.gridViewActive) pauseSlideshow();
  });

  state.swiper.on("slideChange", function () {
    if (isAppending || isPrepending || isInternalSlideChange) return; // Prevent recursion
    isInternalSlideChange = true; // guard against recursion
    const activeSlide = this.slides[this.activeIndex];
    if (activeSlide) {
      const globalIndex = parseInt(activeSlide.dataset.globalIndex, 10) || 0;
      const searchIndex = parseInt(activeSlide.dataset.searchIndex, 10) || 0;
      slideState.updateFromExternal(globalIndex, searchIndex);
      updateMetadataOverlay();
    }
    isInternalSlideChange = false;
  });

  state.swiper.on("slideNextTransitionStart", function () {
    if (isAppending) return;

    if (this.activeIndex === this.slides.length - 1) {
      isAppending = true;
      this.allowSlideNext = false;

      // Use slideState to resolve next indices based on whether we are in album or search mode
      const { globalIndex: nextGlobal, searchIndex: nextSearch } =
        slideState.resolveOffset(+1);

      if (nextGlobal !== null) {
        addSlideByIndex(nextGlobal, nextSearch)
          .then(() => {
            isAppending = false;
            this.allowSlideNext = true;
          })
          .catch(() => {
            isAppending = false;
            this.allowSlideNext = true;
          });
      } else {
        isAppending = false;
        this.allowSlideNext = true;
      }
    }
  });

  state.swiper.on("slidePrevTransitionEnd", function () {
    const [globalIndex] = getCurrentSlideIndex();
    if (this.activeIndex === 0 && globalIndex > 0) {
      const { globalIndex: prevGlobal, searchIndex: prevSearch } =
        slideState.resolveOffset(-1);
      if (prevGlobal !== null) {
        const prevExists = Array.from(this.slides).some(
          (el) => parseInt(el.dataset.globalIndex, 10) === prevGlobal
        );
        if (!prevExists) {
          isPrepending = true;
          this.allowSlidePrev = false;
          addSlideByIndex(prevGlobal, prevSearch, true)
            .then(() => {
              this.slideTo(1, 0);
              isPrepending = false;
              this.allowSlidePrev = true;
            })
            .catch(() => {
              isPrepending = false;
              this.allowSlidePrev = true;
            });
        }
      }
    }
  });

  state.swiper.on("sliderFirstMove", function () {
    pauseSlideshow();
  });
}

function initializeEventHandlers() {
  // Stop slideshow on next and prev button clicks -- necessary?
  document
    .querySelectorAll(".swiper-button-next, .swiper-button-prev")
    .forEach((btn) => {
      eventRegistry.install(
        { type: "swiper", event: "click", object: btn },
        function (event) {
          pauseSlideshow();
          event.stopPropagation();
          this.blur();
        }
      );
      eventRegistry.install(
        { type: "swiper", event: "mousedown", object: btn },
        function (event) {
          this.blur();
        }
      );
    });

  // Reset slide show when the album changes
  eventRegistry.install({ type: "swiper", event: "albumChanged" }, () => {
    initializeSingleSwiper();
    resetAllSlides();
  });

  // Reset slide show when the search results change.
  eventRegistry.install(
    { type: "swiper", event: "searchResultsChanged" },
    (event) => {
      resetAllSlides();
    }
  );

  // Handle slideshow mode changes
  eventRegistry.install(
    { type: "swiper", event: "swiperModeChanged" },
    (event) => {
      resetAllSlides();
    }
  );

  // Navigate to a slide
  eventRegistry.install(
    { type: "swiper", event: "seekToSlideIndex" },
    seekToSlideIndex
  );
}

export function pauseSlideshow() {
  if (state.swiper && state.swiper.autoplay?.running) {
    state.swiper.autoplay.stop();
  }
}

export function resumeSlideshow() {
  if (state.swiper) {
    state.swiper.autoplay.stop();
    setTimeout(() => {
      state.swiper.autoplay.start();
    }, 50);
  }
}

// Toggle between the play and pause icons based on the slideshow state
export function updateSlideshowIcon() {
  const playIcon = document.getElementById("playIcon");
  const pauseIcon = document.getElementById("pauseIcon");

  if (state.swiper?.autoplay?.running) {
    playIcon.style.display = "none";
    pauseIcon.style.display = "inline";
  } else {
    playIcon.style.display = "inline";
    pauseIcon.style.display = "none";
  }
}

// Add a new slide to Swiper with image and metadata
export async function addNewSlide(offset = 0) {
  if (!state.album) return; // No album set, cannot add slide

  let [globalIndex, totalImages, searchIndex] = getCurrentSlideIndex();
  // Search mode -- we identify the next image based on the search results array,
  // then translate this into a global index for retrieval.
  if (slideState.isSearchMode) {
    globalIndex = slideState.resolveOffset(offset).globalIndex;
  } else {
    // Album mode -- navigate relative to the current slide's index
    if (state.mode === "random") {
      globalIndex = Math.floor(Math.random() * totalImages);
    } else {
      globalIndex = globalIndex + offset;
      globalIndex = (globalIndex + totalImages) % totalImages; // wrap around
    }
  }
  await addSlideByIndex(globalIndex, searchIndex);
}

export async function addSlideByIndex(
  globalIndex,
  searchIndex = null,
  prepend = false
) {
  if (!state.swiper) return;

  // pick a random slide if settings.mode is random
  if (state.mode === "random" && !slideState.isSearchMode) {
    const totalImages = slideState.totalAlbumImages;
    globalIndex = Math.floor(Math.random() * totalImages);
  }

  // Prevent duplicates
  const exists = Array.from(state.swiper.slides).some(
    (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
  );
  if (exists) return;

  let currentScore, currentCluster, currentColor;
  if (slideState.isSearchMode && searchIndex !== null) {
    const results = slideState.searchResults[searchIndex];
    currentScore = results?.score || "";
    currentCluster = results?.cluster || "";
    currentColor = results?.color || "#000000"; // Default
  }

  try {
    const data = await fetchImageByIndex(globalIndex);

    if (!data || Object.keys(data).length === 0) {
      return;
    }

    const path = data.filepath;
    const url = data.image_url;
    const metadata_url = data.metadata_url;
    const slide = document.createElement("div");
    slide.className = "swiper-slide";

    // Use feature detection
    if (hasTouchCapability) {
      // Touch-capable device - with zoom container
      slide.innerHTML = `
        <div class="swiper-zoom-container">
          <img src="${url}" alt="${data.filename}" />
        </div>
     `;
    } else {
      // Non-touch device - direct image
      slide.innerHTML = `
        <img src="${url}" alt="${data.filename}" />
      `;
    }

    // replace this with assignments to a module variable
    slide.dataset.filename = data.filename || "";
    slide.dataset.description = data.description || "";
    slide.dataset.filepath = path || "";
    slide.dataset.score = currentScore || "";
    slide.dataset.cluster = currentCluster || "";
    slide.dataset.color = currentColor || "#000000"; // Default color if not provided
    slide.dataset.globalIndex = data.index || 0;
    slide.dataset.total = data.total || 0;
    slide.dataset.searchIndex = searchIndex !== null ? searchIndex : "";
    slide.dataset.metadata_url = metadata_url || "";
    slide.dataset.reference_images = JSON.stringify(
      data.reference_images || []
    );
    if (prepend) {
      state.swiper.prependSlide(slide);
    } else {
      state.swiper.appendSlide(slide);
    }
  } catch (error) {
    console.error("Failed to add new slide:", error);
    alert(`Failed to add new slide: ${error.message}`);
    return;
  }
}

// Add function to handle slide changes
export async function handleSlideChange() {
  // Instead of using activeIndex, find the slide that matches the current slideState
  const { globalIndex } = slideState.getCurrentSlide();
  const slideEls = state.swiper.slides;
  let activeIndex = Array.from(slideEls).findIndex(
    (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
  );
  if (activeIndex === -1) activeIndex = 0;
  const activeSlide = slideEls[activeIndex];
  if (activeSlide) {
    const globalIndex = parseInt(activeSlide.dataset.globalIndex, 10) || 0;
    const searchIndex = parseInt(activeSlide.dataset.searchIndex, 10) || 0;
    slideState.updateFromExternal(globalIndex, searchIndex);
  }
  updateMetadataOverlay();
}

export function removeSlidesAfterCurrent() {
  if (!state.swiper) return;
  const { globalIndex } = slideState.getCurrentSlide();
  const slideEls = state.swiper.slides;
  let activeIndex = Array.from(slideEls).findIndex(
    (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
  );
  if (activeIndex === -1) activeIndex = 0;
  const slidesToRemove = slideEls.length - activeIndex - 1;
  if (slidesToRemove > 0) {
    state.swiper.removeSlide(activeIndex + 1, slidesToRemove);
  }
  setTimeout(() => enforceHighWaterMark(), 500);
}

// Reset all the slides and reload the swiper, optionally keeping the current slide.
// TO DO - the keep_current_slide logic is no longer needed.
export async function resetAllSlides() {
  if (!state.swiper) return;
  await waitForBatchLoadingToFinish();
  setBatchLoading(true);

  const slideShowRunning = state.swiper?.autoplay?.running;
  pauseSlideshow();

  state.swiper.removeAllSlides();

  const { globalIndex, searchIndex } = slideState.getCurrentSlide();

  // Prevent intermediate rendering while we add slides
  const swiperContainer = document.querySelector(".swiper");
  if (swiperContainer) swiperContainer.style.visibility = "hidden";

  // First slides added should not be random if in random mode
  // Add previous slide if available
  const { globalIndex: prevGlobal, searchIndex: prevSearch } =
    slideState.resolveOffset(-1);
  if (prevGlobal !== null) {
    await addSlideByIndex(prevGlobal, prevSearch);
  }

  // Add current slide
  const previousMode = state.mode;
  if (globalIndex > 0) state.mode = "chronological";
  await addSlideByIndex(globalIndex, searchIndex);
  state.mode = previousMode; // Restore mode if it was changed

  // Add next slide if available
  const { globalIndex: nextGlobal, searchIndex: nextSearch } =
    slideState.resolveOffset(1);
  if (nextGlobal !== null) {
    await addSlideByIndex(nextGlobal, nextSearch);
  }

  // Navigate to the current slide (will be at index 0 or 1 depending on whether prev exists)
  const slideIndex = prevGlobal !== null ? 1 : 0;
  state.swiper.slideTo(slideIndex, 0);

  // Let the browser paint the final state, then reveal the container
  await new Promise(requestAnimationFrame);
  if (swiperContainer) swiperContainer.style.visibility = "";

  updateMetadataOverlay();
  if (slideShowRunning) {
    resumeSlideshow();
  }
  setTimeout(() => updateCurrentImageMarker(window.umapPoints), 500);
  setBatchLoading(false);
}


// Enforce the high water mark by removing excess slides
export function enforceHighWaterMark(backward = false) {
  const maxSlides = state.highWaterMark || 50;
  const swiper = state.swiper;
  const slides = swiper.slides.length;

  if (slides > maxSlides) {
    let slideShowRunning = swiper.autoplay.running;
    pauseSlideshow();

    if (backward) {
      // Remove from end
      swiper.removeSlide(swiper.slides.length - 1);
    } else {
      // Remove from beginning
      // Only do this when appending, not when prepending!
      swiper.removeSlide(0);
    }

    if (slideShowRunning) resumeSlideshow();
  }
}

// Navigate to a slide based on its index
async function seekToSlideIndex(event) {
  let { globalIndex, searchIndex, totalSlides, isSearchMode } = event.detail;

  if (isSearchMode) {
    globalIndex = slideState.searchToGlobal(searchIndex);
  }

  // Find the slide with the correct globalIndex
  let slideEls = state.swiper.slides;
  const exists = Array.from(slideEls).some(
    (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
  );
  if (exists) {
    // Slide exists, navigate to it
    const targetSlideIdx = Array.from(slideEls).findIndex(
      (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
    );
    if (targetSlideIdx !== -1) {
      isInternalSlideChange = true; // guard against recursion
      state.swiper.slideTo(targetSlideIdx, 300);
      isInternalSlideChange = false;
      updateMetadataOverlay();
      return;
    }
  }

  state.swiper.removeAllSlides();

  let origin = -2;
  const slides_to_add = 5;
  if (globalIndex + origin < 0) {
    origin = 0;
  }

  const swiperContainer = document.querySelector(".swiper");
  swiperContainer.style.visibility = "hidden";

  for (let i = origin; i < slides_to_add; i++) {
    if (searchIndex + i >= totalSlides) break;
    await addSlideByIndex(globalIndex + i, searchIndex + i);
  }

  // Find the slide with the correct globalIndex and slide to it
  slideEls = state.swiper.slides;
  let targetSlideIdx = Array.from(slideEls).findIndex(
    (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
  );
  if (targetSlideIdx === -1) targetSlideIdx = 0;
  state.swiper.slideTo(targetSlideIdx, 0);

  swiperContainer.style.visibility = "visible";
  updateMetadataOverlay();
}
