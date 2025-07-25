// swiper.js
// This file initializes the Swiper instance and manages slide transitions.
import { fetchNextImage } from "./api.js";
import { clusterDisplay } from "./cluster-display.js";
import { updateOverlay } from "./overlay.js";
import { scoreDisplay } from "./score-display.js";
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
  // state.swiper.slideTo(0);

  // Initial icon state and overlay
  updateSlideshowIcon();
  updateOverlay();
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

  // Use feature detection instead of user agent
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
    // Optionally: state.swiper.slideTo(0);
  } else {
    state.swiper.appendSlide(slide);
    // Optionally: state.swiper.slideTo(state.swiper.slides.length - 1);
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
export function handleSlideChange() {
  updateOverlay();

  const activeSlide = state.swiper.slides[state.swiper.activeIndex];
  if (
    activeSlide &&
    activeSlide.dataset.score &&
    state.searchResults.length > 0
  ) {
    // Show score if we're in search mode and slide has a score
    const score = parseFloat(activeSlide.dataset.score);
    scoreDisplay.show(score);
  } else if (activeSlide && activeSlide?.dataset?.cluster) {
    clusterDisplay.show(activeSlide.dataset.cluster, activeSlide.dataset.color);
  } else {
    // Hide score if not in search mode or no score
    scoreDisplay.hide();
  }
  // Delay moving the umap marker until the slide transition is complete.
  // Otherwise, on the iPad, there is an obvious hesitation.
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

export async function resetAllSlides() {
  const slideShowRunning = state.swiper?.autoplay?.running;
  pauseSlideshow(); // Pause the slideshow if it's running
  if (state.swiper?.slides?.length > 0) {
    state.swiper.removeAllSlides();
  }
  await addNewSlide(false); // Add a new slide to start fresh
  await addNewSlide(false); // Add another slide to ensure navigation works
  updateOverlay();
  if (slideShowRunning) {
    resumeSlideshow();
  }
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
    if (backward) {
      // Remove from end
      swiper.removeSlide(swiper.slides.length - 1);
    } else {
      // Remove from beginning
      swiper.removeSlide(0);
      state.searchOrigin += 1; // Adjust the searchOrigin so that it reflects the searchIndex of the first slide
    }
  }
}
