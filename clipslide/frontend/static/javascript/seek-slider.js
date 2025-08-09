import { updateMetadataOverlay } from "./overlay.js";
import { scoreDisplay } from "./score-display.js";
import { state } from "./state.js";
import { addSlideByIndex, getCurrentSlideIndex } from "./swiper.js";

let sliderVisible = false;
let scoreText, slider;
let fadeOutTimeoutId = null;

// Initialize event listeners after the DOM is fully loaded
document.addEventListener("DOMContentLoaded", initializeEvents);

function initializeEvents() {
  scoreText = document.getElementById("scoreText");
  slider = document.getElementById("slideSeekSlider");
  const hotspot = document.getElementById("sliderHotspot");
  const scoreElement = scoreDisplay.scoreElement;

  // Show slider on hover over score display or hotspot
  scoreElement.addEventListener("mouseenter", showSlider);
  hotspot.addEventListener("mouseenter", showSlider);
  slider.addEventListener("mouseenter", showSlider);

  // Hide slider when mouse leaves score display, hotspot, or slider
  scoreElement.addEventListener("mouseleave", hideSliderWithDelay);
  hotspot.addEventListener("mouseleave", hideSliderWithDelay);
  slider.addEventListener("mouseleave", hideSliderWithDelay);

  function showSlider() {
    slider.classList.add("visible");
    sliderVisible = true;
    updateSliderRange();
    if (fadeOutTimeoutId) {
      clearTimeout(fadeOutTimeoutId);
      fadeOutTimeoutId = null;
    }
  }

  function hideSliderWithDelay() {
    // Only hide if mouse is not over score element, hotspot, or slider
    if (
      !scoreElement.matches(':hover') &&
      !hotspot.matches(':hover') &&
      !slider.matches(':hover')
    ) {
      if (fadeOutTimeoutId) clearTimeout(fadeOutTimeoutId);
      fadeOutTimeoutId = setTimeout(() => {
        slider.classList.remove("visible");
        sliderVisible = false;
        fadeOutTimeoutId = null;
      }, 600); // fade out delay
    }
  }

  // Show/hide slider on score display click/tap
  scoreDisplay.scoreElement.addEventListener("click", toggleSlider);
  // Touch event for mobile devices
  scoreDisplay.scoreElement.addEventListener("touchend", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSlider();
  });

  // Make sure the score element has proper touch handling
  scoreDisplay.scoreElement.style.touchAction = "manipulation";

  // When slider changes, update score display and seek to slide
  slider.addEventListener("input", async function () {
    // Cancel any pending fade out
    if (fadeOutTimeoutId) {
      clearTimeout(fadeOutTimeoutId);
      fadeOutTimeoutId = null;
      slider.classList.remove("fade-out");
    }
    const targetIndex = parseInt(slider.value, 10) - 1;
    let globalIndex;
    if (state.searchResults?.length > 0) {
      if (state.searchResults[targetIndex]?.cluster !== undefined) {
        const cluster = state.searchResults[targetIndex]?.cluster;
        const color = state.searchResults[targetIndex]?.color;
        scoreDisplay.showCluster(
          cluster,
          color,
          targetIndex + 1,
          state.searchResults.length
        );
      } else {
        scoreDisplay.show(
          state.searchResults[targetIndex]?.score,
          targetIndex + 1,
          state.searchResults.length
        );
      }
    } else {
      globalIndex = targetIndex;
      scoreDisplay.showIndex(globalIndex, slider.max);
    }
    // scoreText.textContent = `score=${getScoreForIndex(globalIndex)}`;
  });

  // When slider is released, seek to slide
  slider.addEventListener("change", async function () {
    let globalIndex;
    let [, totalSlides] = await getCurrentSlideIndex();

    const targetIndex = parseInt(slider.value, 10) - 1;
    if (state.searchResults?.length > 0) {
      globalIndex = state.searchResults[targetIndex]?.index;
    } else {
      globalIndex = targetIndex;
    }
    // Seek: reset slides and load previous, current, next
    await state.swiper.removeAllSlides();

    // Add 2 slides before and after the current one
    let origin = -2;
    let slides_to_add = 5;
    if (globalIndex + origin < 0) {
      origin = 0;
    }
    const swiperContainer = document.querySelector(".swiper");
    swiperContainer.style.visibility = "hidden";
    for (let i = origin; i < slides_to_add; i++) {
      if (targetIndex + i >= totalSlides) break;
      await addSlideByIndex(globalIndex + i, targetIndex + i);
    }
    state.swiper.slideTo(-origin, 0); // Slide to the current one
    swiperContainer.style.visibility = "visible";

    updateMetadataOverlay();

    // Fade out after 5s
    slider.classList.add("fade-out");
    if (fadeOutTimeoutId) {
      clearTimeout(fadeOutTimeoutId);
    }
    fadeOutTimeoutId = setTimeout(() => {
      slider.classList.remove("visible");
      sliderVisible = false;
      fadeOutTimeoutId = null;
    }, 600);

    // Blur the slider to remove focus. Otherwise the slider and swiper fight over
    // who responds to arrow keys.
    slider.blur();
  });

  window.addEventListener("slideChanged", async (event) => {
    setTimeout(async () => {
      const [globalIndex, total, searchIndex] = await getCurrentSlideIndex();
      slider.value =
        state.searchResults?.length > 0 ? searchIndex + 1 : globalIndex + 1;
    }, 500);
  });
}


async function toggleSlider() {
  sliderVisible = !sliderVisible;
  if (sliderVisible) {
    slider.classList.add("visible");
    await updateSliderRange();
  } else {
    slider.classList.remove("visible");
  }
}

// Update slider range and value based on mode
async function updateSliderRange() {
  const [globalIndex, totalSlides, searchIndex] = await getCurrentSlideIndex();
  if (state.searchResults?.length > 0) {
    slider.min = 1;
    // slider.value = searchIndex + 1; // 1-based index
    slider.max = state.searchResults.length;
  } else {
    slider.min = 1;
    // slider.value = globalIndex + 1; // 1-based index
    slider.max = totalSlides;
  }
}

// Get current slide index for slider value (1-based)
function getCurrentSliderValue() {
  if (state.searchResults?.length > 0) {
    return (
      (state.swiper?.slides[state.swiper.activeIndex]?.dataset?.searchIndex ||
        0) + 1
    );
  } else {
    return (
      (state.swiper?.slides[state.swiper.activeIndex]?.dataset?.index || 0) + 1
    );
  }
}

// Helper to get score for a given index
function getScoreForIndex(globalIndex) {
  if (state.searchResults?.length > 0) {
    const result = state.searchResults.find((r) => r.index === globalIndex);
    return result?.score?.toFixed(3) ?? "0.000";
  }
  // For album mode, you may want to fetch score from slide or elsewhere
  const slide = state.swiper?.slides?.find(
    (s) => parseInt(s.dataset.index, 10) === globalIndex
  );
  return slide?.dataset?.score ?? "0.000";
}
