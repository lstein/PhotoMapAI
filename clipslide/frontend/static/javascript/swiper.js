// swiper.js
// This file initializes the Swiper instance and manages slide transitions.
import { state } from "./state.js";
import { fetchNextImage } from "./api.js";
import { updateOverlay } from "./overlay.js";
import { scoreDisplay } from "./score-display.js";

// Swiper initialization
document.addEventListener("DOMContentLoaded", async function () {
  // Initialize Swiper
  state.swiper = new Swiper(".swiper", {
    navigation: {
      nextEl: ".swiper-button-next",
      prevEl: ".swiper-button-prev",
    },
    autoplay: {
      delay: state.currentDelay * 1000,
      disableOnInteraction: false,
    },
    scrollbar: {
      el: ".swiper-scrollbar",
      draggable: true,
      hide: false,
    },
    loop: false, // Enable looping to allow continuous navigation
    on: {
      slideNextTransitionStart: async function () {
        // Only add a new slide if we're at the end and moving forward
        if (state.swiper.activeIndex >= state.swiper.slides.length - 1) {
          await addNewSlide();
        }
      },
      sliderFirstMove: function () {
        pauseSlideshow();
      },
    },
  });

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

  // Initial icon state
  updateSlideshowIcon();

  // Call twice to initialize the carousel and start slideshow if requested
  await addNewSlide();
  await addNewSlide();
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
export async function addNewSlide() {
  const data = await fetchNextImage();

  // Stop if data is empty (null, undefined, or empty object)
  if (!data || Object.keys(data).length === 0) {
    return;
  }

  // Create a new slide element
  const path = data.filepath; // Full path to the image
  const url = data.url; // URL path to the image
  const slide = document.createElement("div");
  slide.className = "swiper-slide";

  slide.innerHTML = `
    <div style="position:relative; width:100%; height:100%; display:flex; align-items:center; justify-content:center;">
      <img src="${url}" alt="" draggable="true" class="slide-image">
    </div>
  `;

  slide.dataset.filename = data.filename || "";
  slide.dataset.description = data.description || "";
  slide.dataset.textToCopy = data.textToCopy || "";
  slide.dataset.filepath = path || "";
  slide.dataset.score = data.score || ""; // Store score in dataset

  state.swiper.appendSlide(slide);

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
  } else {
    // Hide score if not in search mode or no score
    scoreDisplay.hide();
  }
}

export function removeSlidesAfterCurrent() {
  if (!state.swiper) return;
  const activeIndex = state.swiper.activeIndex;
  const slidesToRemove = state.swiper.slides.length - activeIndex - 1;
  if (slidesToRemove > 0) {
    state.swiper.removeSlide(activeIndex + 1, slidesToRemove);
  }
  enforceHighWaterMark();
}

export async function resetAllSlides() {
  if (state.swiper?.slides?.length > 0) {
    state.swiper.removeAllSlides();
  }
  await addNewSlide();
  await addNewSlide();
  updateOverlay();
}

// Clear carousel and optionally append a first slide
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
  // restart the slideshow if it was running
  if (slideShowRunning) resumeSlideshow();
}

// Enforce the high water mark by removing excess slides
function enforceHighWaterMark() {
  if (!state.swiper) return;

  const slideShowActive = state.swiper?.autoplay?.running;
  if (slideShowActive) state.swiper.autoplay.stop();

  while (state.swiper.slides.length > state.highWaterMark) {
    if (state.swiper.activeIndex > 0) {
      state.swiper.removeSlide(0);
      state.swiper.slideTo(state.swiper.activeIndex, 0, false);
    } else {
      state.swiper.removeSlide(state.swiper.slides.length - 1);
    }
  }

  if (slideShowActive) state.swiper.autoplay.start();
}
