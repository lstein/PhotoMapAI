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
  console.log("Initializing seek slider events");
  scoreText = document.getElementById("scoreText");
  slider = document.getElementById("slideSeekSlider");

  // Show/hide slider on score display click/tap
  scoreDisplay.scoreElement.addEventListener("click", toggleSlider);
  scoreDisplay.scoreElement.addEventListener("touchstart", (e) => {
    e.preventDefault();
    toggleSlider();
  });

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
    console.log("Slider change event fired");
    let globalIndex;
    let [, totalSlides] = await getCurrentSlideIndex();

    const targetIndex = parseInt(slider.value, 10) - 1;
    if (state.searchResults?.length > 0) {
      globalIndex = state.searchResults[targetIndex]?.index;
    } else {
      globalIndex = targetIndex;
    }
    // Seek: reset slides and load previous, current, next
    console.log(
      "Seeking to slide index:",
      globalIndex,
      "targetIndex:",
      targetIndex
    );
    await state.swiper.removeAllSlides();

    if (globalIndex < totalSlides - 1) {
      await addSlideByIndex(globalIndex, targetIndex);
      await addSlideByIndex(globalIndex + 1, targetIndex + 1);
    } else {
      await addSlideByIndex(globalIndex - 1, targetIndex - 1);
      await addSlideByIndex(globalIndex, targetIndex);
      state.swiper.slideTo(1);
    }
    updateMetadataOverlay();

    // Fade out after 5s
    slider.classList.add("fade-out");
    // Cancel any previous fade out
    if (fadeOutTimeoutId) {
      clearTimeout(fadeOutTimeoutId);
    }
    fadeOutTimeoutId = setTimeout(() => {
      slider.classList.remove("fade-out");
      slider.style.display = "none";
      sliderVisible = false;
      fadeOutTimeoutId = null;
    }, 5000);
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
  slider.style.display = sliderVisible ? "block" : "none";
  if (sliderVisible) {
    await updateSliderRange();
    // slider.value = getCurrentSliderValue();
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
