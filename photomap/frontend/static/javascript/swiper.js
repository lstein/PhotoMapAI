// swiper.js
// This file initializes the Swiper instance and manages slide transitions.
import { updateMetadataOverlay } from "./metadata-drawer.js";
import { fetchImageByIndex } from "./search.js";
import { getCurrentSlideIndex, slideState } from "./slide-state.js";
import { state } from "./state.js";
import { updateCurrentImageMarker } from "./umap.js";

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

export async function initializeSingleSwiper() {
  console.log("Swiper constructor:", typeof Swiper, Swiper);
  // Destroy previous Swiper instance if it exists
  if (state.swiper) {
    state.swiper.destroy(true, true);
    state.swiper = null;
  }

  // Clear the swiper wrapper completely
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
    on: {
      slideNextTransitionStart: function () {
        if (state.gridViewActive) return;
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
      },
      slidePrevTransitionEnd: function () {
        if (state.gridViewActive) return;
        if (isPrepending) return;

        const globalIndex = getCurrentSlideIndex();
        if (this.activeIndex === 0 && globalIndex > 0) {
          // Use slideState to resolve previous indices
          const { globalIndex: nextGlobal, searchIndex: nextSearch } =
            slideState.resolveOffset(-1);
          if (prevGlobal !== null) {
            const prevExists = Array.from(this.slides).some(
              (el) => parseInt(el.dataset.index, 10) === prevGlobal
            );
            if (!prevExists) {
              isPrepending = true;
              this.allowSlidePrev = false;
              addSlideByIndex(prevGlobal, prevSearch)
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
      },
      sliderFirstMove: function () {
        if (state.gridViewActive) return; // Guard against grid view
        pauseSlideshow();
      },
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
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Attach event listeners
  document
    .querySelectorAll(".swiper-button-next, .swiper-button-prev")
    .forEach((btn) => {
      btn.addEventListener("click", function (event) {
        if (state.gridViewActive) return; // Guard against grid view
        pauseSlideshow();
        event.stopPropagation();
        this.blur();
      });
      btn.addEventListener("mousedown", function () {
        this.blur();
      });
    });

  // Update icon on slide change or autoplay events (with guards)
  if (state.swiper) {
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
      if (state.gridViewActive) return;
      const activeSlide = this.slides[this.activeIndex];
      if (activeSlide) {
        const globalIndex = parseInt(activeSlide.dataset.index, 10) || 0;
        const searchIndex = parseInt(activeSlide.dataset.searchIndex, 10) || 0;
        slideState.updateFromExternal(globalIndex, searchIndex);
      }
      updateMetadataOverlay();
    });
  }
  // Initial icon state and overlay
  updateSlideshowIcon();
  updateMetadataOverlay();
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
  if (slideState.searchResults?.length > 0) {
    const searchImageCnt = slideState.searchResults.length || 1;
    searchIndex = searchIndex + offset;
    searchIndex = (searchIndex + searchImageCnt) % searchImageCnt; // wrap around
    globalIndex = slideState.searchResults[searchIndex].index || 0;
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

  // Prevent duplicates
  const exists = Array.from(state.swiper.slides).some(
    (el) => parseInt(el.dataset.index, 10) === globalIndex
  );
  if (exists) return;

  let currentScore, currentCluster, currentColor;
  if (searchIndex !== null && slideState.searchResults?.length > 0) {
    currentScore = slideState.searchResults[searchIndex]?.score || "";
    currentCluster = slideState.searchResults[searchIndex]?.cluster || "";
    currentColor = slideState.searchResults[searchIndex]?.color || "#000000"; // Default
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

    slide.dataset.filename = data.filename || "";
    slide.dataset.description = data.description || "";
    slide.dataset.filepath = path || "";
    slide.dataset.score = currentScore || "";
    slide.dataset.cluster = currentCluster || "";
    slide.dataset.color = currentColor || "#000000"; // Default color if not provided
    slide.dataset.index = data.index || 0;
    slide.dataset.total = data.total || 0;
    slide.dataset.searchIndex = searchIndex !== null ? searchIndex : '';
    slide.dataset.metadata_url = metadata_url || "";
    slide.dataset.reference_images = JSON.stringify(
      data.reference_images || []
    );
    if (prepend) {
      state.swiper.prependSlide(slide);
      setTimeout(() => enforceHighWaterMark(true), 500); // true = remove from end
    } else {
      state.swiper.appendSlide(slide);
      setTimeout(() => enforceHighWaterMark(false), 500); // false = remove from beginning
    }
    // Delay high water mark enforcement to allow transition to finish
    setTimeout(() => enforceHighWaterMark(), 500);
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
    (el) => parseInt(el.dataset.index, 10) === globalIndex
  );
  if (activeIndex === -1) activeIndex = 0;
  const activeSlide = slideEls[activeIndex];
  if (activeSlide) {
    const globalIndex = parseInt(activeSlide.dataset.index, 10) || 0;
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
    (el) => parseInt(el.dataset.index, 10) === globalIndex
  );
  if (activeIndex === -1) activeIndex = 0;
  const slidesToRemove = slideEls.length - activeIndex - 1;
  if (slidesToRemove > 0) {
    state.swiper.removeSlide(activeIndex + 1, slidesToRemove);
  }
  setTimeout(() => enforceHighWaterMark(), 500);
}

// Reset all the slides and reload the swiper, optionally keeping the current slide.
export async function resetAllSlides(keep_current_slide = false) {
  if (!state.swiper) return; // happens on first load.
  const slideShowRunning = state.swiper?.autoplay?.running;
  pauseSlideshow(); // Pause the slideshow if it's running
  if (keep_current_slide && !state.dataChanged) {
    // Keep the current slide and remove others
    const { globalIndex } = slideState.getCurrentSlide();
    const slideEls = state.swiper.slides;
    let activeIndex = Array.from(slideEls).findIndex(
      (el) => parseInt(el.dataset.index, 10) === globalIndex
    );
    if (activeIndex === -1) activeIndex = 0;
    const currentSlide = slideEls[activeIndex];
    state.swiper.removeAllSlides();
    state.swiper.appendSlide(currentSlide);
  } else {
    // Remove all slides
    state.swiper.removeAllSlides();
    await addNewSlide(0); // Add first slide
  }
  await addNewSlide(1); // Add second slide to enable navigation controls
  updateMetadataOverlay();
  if (slideShowRunning) {
    resumeSlideshow();
  }
  setTimeout(() => updateCurrentImageMarker(window.umapPoints), 500);
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

// Reset slide show when the album changes
window.addEventListener("albumChanged", () => {
  resetAllSlides();
});

// Reset slide show when the search results change.
// When clearing search results, we want to keep the current
// slide to avoid displaying something unexpected.
window.addEventListener("searchResultsChanged", (event) => {
  const searchType = event.detail?.searchType;
  if (searchType === "switchAlbum") return;
  const keep_current_slide = searchType === "clear";
  resetAllSlides(keep_current_slide);
});

// BAD CODE ALERT
// REMOVE THIS WHEN THE GALLERY IS REMOVED
window.addEventListener("setSlideIndex", async (event) => {
  const { targetIndex, isSearchMode } = event.detail;

  let globalIndex;
  let [, totalSlides] = getCurrentSlideIndex();

  if (isSearchMode && slideState.searchResults?.length > 0) {
    globalIndex = slideState.searchResults[targetIndex]?.index;
  } else {
    globalIndex = targetIndex;
  }

  await state.swiper.removeAllSlides();

  let origin = -2;
  let slides_to_add = 5;
  if (globalIndex + origin < 0) {
    origin = 0;
  }

  const swiperContainer = document.querySelector(".swiper");
  swiperContainer.style.visibility = "hidden";

  for (let i = origin; i < slides_to_add; i++) {
    if (targetIndex + i >= totalSlides) break;
    let seekIndex = globalIndex + i;
    await addSlideByIndex(seekIndex, targetIndex + i);
  }

  // Find the slide with the correct globalIndex and slide to it
  const slideEls = state.swiper.slides;
  let targetSlideIdx = Array.from(slideEls).findIndex(
    (el) => parseInt(el.dataset.index, 10) === globalIndex
  );
  if (targetSlideIdx === -1) targetSlideIdx = 0;
  state.swiper.slideTo(targetSlideIdx, 0);

  swiperContainer.style.visibility = "visible";
  updateMetadataOverlay();
});
