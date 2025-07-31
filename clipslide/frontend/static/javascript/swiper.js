// swiper.js
// This file initializes the Swiper instance and manages slide transitions.
import { albumManager } from "./album.js";
import { clusterDisplay } from "./cluster-display.js";
import { updateMetadataOverlay } from "./overlay.js";
import { scoreDisplay } from "./score-display.js";
import { fetchNextImage } from "./search.js";
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

document.addEventListener("DOMContentLoaded", async function () {
  const swiperConfig = {
    navigation: {
      nextEl: ".swiper-button-next",
      prevEl: ".swiper-button-prev",
    },
    autoplay: {
      delay: state.currentDelay * 1000,
      disableOnInteraction: false,
      enabled: false,
    },
    scrollbar: {
      el: ".swiper-scrollbar",
      draggable: true,
      hide: false,
    },
    loop: false,
    allowTouchMove: true,
    simulateTouch: true,
    touchStartPreventDefault: false,
    touchMoveStopPropagation: false,
    mousewheel: {
      enabled: true,
      forceToAxis: true,
    },
    keyboard: {
      enabled: true,
      onlyInViewport: true,
    },
    on: {
      slideNextTransitionStart: async function () {
        // Only add a new slide if we're at the end and moving forward
        if (this.activeIndex >= this.slides.length - 1) {
          await addNewSlide();
        }
      },
      slidePrevTransitionStart: async function () {
        // Only add a new slide if we're at the beginning and moving backward
        if (this.activeIndex <= 0) {
          await addNewSlide(true);
        }
      },
      sliderFirstMove: function () {
        pauseSlideshow();
      },
    },
  };

  // Enable zoom on any device with touch capability
  if (hasTouchCapability) {
    swiperConfig.zoom = {
      maxRatio: 3,
      minRatio: 1,
      toggle: true,
      containerClass: "swiper-zoom-container",
      zoomedSlideClass: "swiper-slide-zoomed",
    };
  }

  // Initialize Swiper with conditional config
  state.swiper = new Swiper(".swiper", swiperConfig);

  // Prevent overlay toggle when clicking Swiper navigation buttons
  document
    .querySelectorAll(".swiper-button-next, .swiper-button-prev")
    .forEach((btn) => {
      btn.addEventListener("click", function (event) {
        pauseSlideshow(); // Pause slideshow on navigation
        event.stopPropagation();
        this.blur(); // Remove focus from button to prevent keyboard navigation issues
      });
      btn.addEventListener("mousedown", function (event) {
        this.blur();
      });
    });

  // Update icon on slide change or autoplay events
  if (state.swiper) {
    state.swiper.on("autoplayStart", updateSlideshowIcon);
    state.swiper.on("autoplayResume", updateSlideshowIcon);
    state.swiper.on("autoplayStop", updateSlideshowIcon);
    state.swiper.on("autoplayPause", updateSlideshowIcon);
    state.swiper.on("slideChange", handleSlideChange);
    state.swiper.on("scrollbarDragStart", pauseSlideshow);
  }

  // Call twice to initialize the carousel and start slideshow if requested
  await addNewSlide(false);
  await addNewSlide(false);

  // Initial icon state and overlay
  updateSlideshowIcon();
  updateMetadataOverlay();
});

export function pauseSlideshow() {
  if (state.swiper && state.swiper.autoplay.running) {
    state.swiper.autoplay.stop();
  }
}

export function resumeSlideshow() {
  if (state.swiper && !state.swiper.autoplay.running) {
    state.swiper.autoplay.start();
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
export async function addNewSlide(backward = false) {
  // new syntax for fetchNextImage -- provide the last image as context
  const lastImage = backward
    ? state.swiper.slides[0]
    : state.swiper.slides[state.swiper.slides.length - 1];
  const data = await fetchNextImage(lastImage, backward);

  if (!data || Object.keys(data).length === 0) {
    return;
  }

  const path = data.filepath;
  const url = data.url;
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
  slide.dataset.textToCopy = data.textToCopy || "";
  slide.dataset.filepath = path || "";
  slide.dataset.score = data.score || "";
  slide.dataset.cluster = data.cluster || "";
  slide.dataset.color = data.color || "#000000"; // Default color if not provided

  if (backward) {
    state.swiper.prependSlide(slide);
  } else {
    state.swiper.appendSlide(slide);
  }

  // Delay high water mark enforcement to allow transition to finish
  setTimeout(() => enforceHighWaterMark(backward), 500);

  const img = slide.querySelector("img");
  img.addEventListener("dragstart", function (e) {
    e.dataTransfer.setData(
      "DownloadURL",
      `image/jpeg:${data.filename || "image.jpg"}:${data.url}`
    );
  });
}

// Add function to handle slide changes
export async function handleSlideChange() {
  updateMetadataOverlay();
  let index = 0;

  const activeSlide = state.swiper.slides[state.swiper.activeIndex];
  if (state.searchResults.length > 0) {
    // Find the index of the current slide in searchResults
    const filename = activeSlide?.dataset?.filepath;
    if (filename) {
      const relpath = albumManager.relativePath(
        filename,
        await albumManager.getCurrentAlbum()
      );
      index = state.searchResults.findIndex(
        (item) => item.filename === relpath
      );
    }
  }

  if (activeSlide?.dataset?.score && state.searchResults.length > 0) {
    // Show score if we're in search mode and slide has a score
    const score = parseFloat(activeSlide.dataset.score);
    // index is 0-based, so add 1 for display
    scoreDisplay.show(score, index + 1, state.searchResults.length);
  } else if (activeSlide && activeSlide?.dataset?.cluster) {
    clusterDisplay.show(
      activeSlide.dataset.cluster,
      activeSlide.dataset.color,
      index + 1,
      state.searchResults.length
    );
  } else {
    scoreDisplay.hide();
  }
  setTimeout(() => updateCurrentImageMarker(window.umapPoints), 500);
}

export function removeSlidesAfterCurrent() {
  if (!state.swiper) return;
  const activeIndex = state.swiper.activeIndex;
  const slidesToRemove = state.swiper.slides.length - activeIndex - 1;
  if (slidesToRemove > 0) {
    state.swiper.removeSlide(activeIndex + 1, slidesToRemove);
  }
  setTimeout(() => enforceHighWaterMark(), 500);
}

// Reset all the slides and reload the swiper, optionally keeping the current slide.
export async function resetAllSlides(keep_current_slide = false) {
  if (!state.swiper?.slides?.length) return; // Nothing to reset
  const slideShowRunning = state.swiper?.autoplay?.running;
  pauseSlideshow(); // Pause the slideshow if it's running
  if (keep_current_slide && !state.dataChanged) {
    // Keep the current slide and remove others
    const currentSlide = state.swiper.slides[state.swiper.activeIndex];
    state.swiper.removeAllSlides();
    state.swiper.appendSlide(currentSlide);
  } else {
    // Remove all slides
    state.swiper.removeAllSlides();
    await addNewSlide(false);
  }
  await addNewSlide(false); // Add another slide to ensure navigation works
  updateMetadataOverlay();
  if (slideShowRunning) {
    resumeSlideshow();
  }
  setTimeout(() => updateCurrentImageMarker(window.umapPoints), 500);
}

export async function resetSlidesAndAppend(first_slide) {
  const slideShowRunning = state.swiper?.autoplay?.running;
  pauseSlideshow(); // Pause the slideshow if it's running
  if (state.swiper?.slides?.length > 0) {
    state.swiper.removeAllSlides();
  }
  if (first_slide) {
    state.swiper.appendSlide(first_slide);
  } else {
    await addNewSlide();
  }
  await addNewSlide(); // needed to enable navigation buttons
  state.swiper.slideTo(0); // Reset to the first slide
  handleSlideChange(); // Update the overlay and displays
  // restart the slideshow if it was running
  if (slideShowRunning) resumeSlideshow();
}

// Enforce the high water mark by removing excess slides
export function enforceHighWaterMark(backward = false) {
  const maxSlides = state.highWaterMark || 50;
  const swiper = state.swiper;
  const slides = swiper.slides.length;

  if (slides > maxSlides) {
    let slideShowRunning = swiper.autoplay.running;
    pauseSlideshow(); // Pause the slideshow to prevent issues during removal
    if (backward) {
      // Remove from end
      swiper.removeSlide(swiper.slides.length - 1);
    } else {
      // Remove from beginning
      swiper.removeSlide(0);
      state.searchOrigin += 1; // Adjust the searchOrigin so that it reflects the searchIndex of the first slide
    }
    if (slideShowRunning) resumeSlideshow(); // Resume the slideshow after removal
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
  const searchType  = event.detail?.searchType;
  if (searchType === "switchAlbum") return;
  const keep_current_slide = searchType === "clear";
  resetAllSlides(keep_current_slide);
});
