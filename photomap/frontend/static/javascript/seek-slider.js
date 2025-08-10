import { updateMetadataOverlay } from "./overlay.js";
import { scoreDisplay } from "./score-display.js";
import { state } from "./state.js";
import { addSlideByIndex, getCurrentSlideIndex } from "./swiper.js";

let sliderVisible = false;
let scoreText, slider, ticksContainer, sliderContainer, contextLabel;
let fadeOutTimeoutId = null;
let TICK_COUNT = 10; // Number of ticks to show on the slider

// Initialize event listeners after the DOM is fully loaded
document.addEventListener("DOMContentLoaded", initializeEvents);

function initializeEvents() {
  scoreText = document.getElementById("scoreText");
  slider = document.getElementById("slideSeekSlider");
  ticksContainer = document.getElementById("ticksContainer");
  sliderContainer = document.getElementById("sliderWithTicksContainer");
  contextLabel = document.getElementById("contextLabel");
  const scoreElement = scoreDisplay.scoreElement;

  // Show slider on hover over score display or slider container
  scoreElement.addEventListener("mouseenter", showSlider);
  sliderContainer.addEventListener("mouseenter", showSlider);

  // Hide slider when mouse leaves score display, slider container, or slider
  scoreElement.addEventListener("mouseleave", hideSliderWithDelay);
  sliderContainer.addEventListener("mouseleave", hideSliderWithDelay);

  function showSlider() {
    sliderContainer.classList.add("visible");
    sliderVisible = true;
    updateSliderRange().then(() => {
      renderSliderTicks();
    });
    if (fadeOutTimeoutId) {
      clearTimeout(fadeOutTimeoutId);
      fadeOutTimeoutId = null;
    }
  }

  function hideSliderWithDelay(event) {
    // Only hide if the mouse has actually left the container, not just moved between children
    if (
      !sliderContainer.contains(event.relatedTarget)
    ) {
      if (fadeOutTimeoutId) clearTimeout(fadeOutTimeoutId);
      fadeOutTimeoutId = setTimeout(() => {
        sliderContainer.classList.remove("visible");
        sliderVisible = false;
        ticksContainer.innerHTML = "";
        fadeOutTimeoutId = null;
      }, 600);
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
    await renderSliderTicks();
    // Cancel any pending fade out
    if (fadeOutTimeoutId) {
      clearTimeout(fadeOutTimeoutId);
      fadeOutTimeoutId = null;
      sliderContainer.classList.remove("fade-out");
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
      let randomMode =
        state.mode === "random" && state.searchResults?.length === 0; // in random mode, seek to the chosen image, but surrount it with random images
      let seekIndex =
        randomMode && i != 0
          ? Math.floor(Math.random() * totalSlides)
          : globalIndex + i;
      await addSlideByIndex(seekIndex, targetIndex + i);
    }
    // Introduvce a slight delay to ensure the swiper is ready
    state.swiper.slideTo(-origin, 0); // Slide to the current one
    swiperContainer.style.visibility = "visible";

    updateMetadataOverlay();

    // Blur the slider to remove focus. Otherwise the slider and swiper fight over
    // who responds to arrow keys.
    slider.blur();
  });

  window.addEventListener("slideChanged", async (event) => {
    setTimeout(async () => {
      const [globalIndex, total, searchIndex] = await getCurrentSlideIndex();
      slider.value =
        state.searchResults?.length > 0 ? searchIndex + 1 : globalIndex + 1;
      await renderSliderTicks();
    }, 1000);
  });
}

// Helper to render ticks
async function renderSliderTicks() {
  if (!slider || !ticksContainer || !contextLabel) return;
  if (!sliderVisible || !sliderContainer.classList.contains("visible")) {
    ticksContainer.innerHTML = "";
    contextLabel.textContent = "";
    return;
  }

  let ticks = [];
  let contextText = "";
  const numTicks = TICK_COUNT;
  let min = parseInt(slider.min, 10);
  let max = parseInt(slider.max, 10);

  if (max <= min) {
    ticksContainer.innerHTML = "";
    contextLabel.textContent = "";
    return;
  }

  // Calculate tick positions
  let positions = [];
  for (let i = 0; i < numTicks; i++) {
    let pos = Math.round(min + ((max - min) * i) / (numTicks - 1));
    positions.push(pos);
  }

  // Album mode: show modification dates
  if (!state.searchResults || state.searchResults.length === 0) {
    contextText = "Date";
    // Fetch modification dates for ticks
    ticks = await Promise.all(
      positions.map(async (idx) => {
        try {
          const albumKey = state.album;
          const resp = await fetch(`image_info/${albumKey}/${idx - 1}`);
          if (!resp.ok) return "";
          const info = await resp.json();
          const date = new Date(info.last_modified * 1000);
          return `${String(date.getMonth() + 1).padStart(
            2,
            "0"
          )}/${date.getFullYear()}`;
        } catch {
          return "";
        }
      })
    );
  }
  // Search mode: show similarity scores
  else if (
    state.searchResults.length > 0 &&
    state.searchResults[0].score !== undefined
  ) {
    contextText = "Score";
    ticks = positions.map((idx) => {
      const result = state.searchResults[idx - 1];
      return result ? result.score.toFixed(3) : "";
    });
  }
  // Cluster mode: show cluster indexes
  else if (
    state.searchResults.length > 0 &&
    state.searchResults[0].cluster !== undefined
  ) {
    contextText = "Cluster Position";
    ticks = positions.map((idx) => {
      return `${idx}`;
    });
  }

  // Set context label
  contextLabel.textContent = contextText;

  // Clear and rebuild ticks (but preserve contextLabel)
  const existingContextLabel = contextLabel;
  ticksContainer.innerHTML = "";
  ticksContainer.appendChild(existingContextLabel);

  // Render ticks as before
  positions.forEach((pos, i) => {
    const percent = ((pos - min) / (max - min)) * 100;
    const tick = document.createElement("div");
    tick.className = "slider-tick";
    tick.style.left = `${percent}%`;

    const mark = document.createElement("div");
    mark.className = "slider-tick-mark";
    tick.appendChild(mark);

    const labelDiv = document.createElement("div");
    labelDiv.className = "slider-tick-label";
    labelDiv.textContent = ticks[i] ?? "";
    tick.appendChild(labelDiv);

    ticksContainer.appendChild(tick);
  });
}

async function toggleSlider() {
  sliderVisible = !sliderVisible;
  if (sliderVisible) {
    sliderContainer.classList.add("visible"); // <-- use container
    await updateSliderRange();
    await renderSliderTicks();
  } else {
    sliderContainer.classList.remove("visible"); // <-- use container
    ticksContainer.innerHTML = "";
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
