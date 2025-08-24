import { updateMetadataOverlay } from "./metadata-drawer.js";
import { scoreDisplay } from "./score-display.js";
import { state } from "./state.js";
import { addSlideByIndex, getCurrentSlideIndex } from "./swiper.js";

let sliderVisible = false;
let scoreText, slider, ticksContainer, sliderContainer, contextLabel, hoverZone;
let fadeOutTimeoutId = null;
let TICK_COUNT = 10; // Number of ticks to show on the slider
const FADE_OUT_DELAY = 10000; // 10 seconds
let isUserSeeking = false;

document.addEventListener("DOMContentLoaded", initializeEvents);

function initializeEvents() {
  scoreText = document.getElementById("scoreText");
  slider = document.getElementById("slideSeekSlider");
  ticksContainer = document.getElementById("sliderTicks");
  sliderContainer = document.getElementById("sliderWithTicksContainer");
  contextLabel = document.getElementById("contextLabel");
  hoverZone = document.getElementById("sliderHoverZone");
  const scoreElement = scoreDisplay.scoreElement;
  const infoPanel = document.getElementById("sliderInfoPanel");

  // Show slider on hover over score display or hover zone
  scoreElement.addEventListener("mouseenter", showSlider);
  hoverZone.addEventListener("mouseenter", showSlider);

  // Hide slider when mouse leaves score display or hover zone
  scoreElement.addEventListener("mouseleave", hideSliderWithDelay);
  hoverZone.addEventListener("mouseleave", hideSliderWithDelay);

  // Show/hide slider on score display click/tap
  function handleScoreTap(e) {
    e.preventDefault();
    e.stopPropagation();
    toggleSlider();
  }

  // Use touch events for iPad/mobile, click for desktop
  if ("ontouchstart" in window || navigator.maxTouchPoints > 0) {
    scoreElement.addEventListener(
      "touchend",
      (event) => {
        handleScoreTap(event);
        hideSliderWithDelay(event);
      },
      {
        passive: false,
      }
    );
    hoverZone.addEventListener(
      "touchend",
      (event) => {
        handleScoreTap(event);
        hideSliderWithDelay(event);
      },
      { passive: false }
    );
  } else {
    scoreDisplay.scoreElement.addEventListener("click", handleScoreTap);
  }

  // Make sure the score element has proper touch handling
  scoreDisplay.scoreElement.style.touchAction = "manipulation";

  // When slider changes, update score display and seek to slide
  let lastFetchTime = 0;
  const FETCH_THROTTLE_MS = 200; // Maximum one request per 200ms

  slider.addEventListener("input", async function (e) {
    const now = Date.now();
    const value = parseInt(slider.value, 10);

    // Show panel immediately with placeholder
    infoPanel.style.display = "block";

    // Only fetch if enough time has passed
    if (now - lastFetchTime >= FETCH_THROTTLE_MS) {
      lastFetchTime = now;

      if (!state.searchResults || state.searchResults.length === 0) {
        try {
          const albumKey = state.album;
          const resp = await fetch(`image_info/${albumKey}/${value - 1}`);
          if (resp.ok) {
            const info = await resp.json();
            const date = new Date(info.last_modified * 1000);
            const panelText = `${String(date.getDate()).padStart(
              2,
              "0"
            )}/${String(date.getMonth() + 1).padStart(
              2,
              "0"
            )}/${String(date.getFullYear()).slice(-2)}`;
            infoPanel.textContent = panelText;
          }
        } catch {
          infoPanel.textContent = "";
        }
      }
    }

    resetFadeOutTimer();

    let panelText = "";
    if (
      state.searchResults?.length > 0 &&
      state.searchResults[0].score !== undefined
    ) {
      const result = state.searchResults[value - 1];
      panelText = result ? `Score: ${result.score.toFixed(3)}` : "";
    } else if (!state.searchResults || state.searchResults.length === 0) {
      try {
        const albumKey = state.album;
        const resp = await fetch(`image_info/${albumKey}/${value - 1}`);
        if (resp.ok) {
          const info = await resp.json();
          const date = new Date(info.last_modified * 1000);
          panelText = `${String(date.getDate()).padStart(2, "0")}/${String(
            date.getMonth() + 1
          ).padStart(2, "0")}/${String(date.getFullYear()).slice(-2)}`;
        }
      } catch {
        panelText = "";
      }
    } else if (state.searchResults[0].cluster !== undefined) {
      panelText = "";
    }

    if (panelText) {
      infoPanel.textContent = panelText;
      infoPanel.style.display = "block";

      // Position panel above mouse if possible, else above thumb
      let left = 0;
      let top = 0;
      const containerRect = sliderContainer.getBoundingClientRect();

      if (e && typeof e.clientX === "number") {
        // Mouse event: position above mouse
        left = e.clientX - containerRect.left - infoPanel.offsetWidth / 2;
        top = slider.offsetTop - infoPanel.offsetHeight - 8;
      } else {
        // Fallback: position above slider thumb
        const percent = (value - slider.min) / (slider.max - slider.min);
        const sliderRect = slider.getBoundingClientRect();
        left = percent * sliderRect.width - infoPanel.offsetWidth / 2;
        top = slider.offsetTop - infoPanel.offsetHeight - 8;
      }

      infoPanel.style.left = `${left}px`;
      infoPanel.style.top = `${top}px`;
    } else {
      infoPanel.style.display = "none";
    }

    resetFadeOutTimer();
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
  });

  // When slider is released, seek to slide
  slider.addEventListener("change", async function () {
    isUserSeeking = true; // Set flag before seeking
    resetFadeOutTimer();
    let globalIndex;
    let [, totalSlides] = await getCurrentSlideIndex();

    const targetIndex = parseInt(slider.value, 10) - 1;
    if (state.searchResults?.length > 0) {
      globalIndex = state.searchResults[targetIndex]?.index;
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
      let randomMode =
        state.mode === "random" && state.searchResults?.length === 0;
      let seekIndex =
        randomMode && i != 0
          ? Math.floor(Math.random() * totalSlides)
          : globalIndex + i;
      await addSlideByIndex(seekIndex, targetIndex + i);
    }
    state.swiper.slideTo(-origin, 0);
    swiperContainer.style.visibility = "visible";

    updateMetadataOverlay();
    slider.blur();

    // Reset flag after a short delay
    setTimeout(() => {
      isUserSeeking = false;
    }, 1500); // Slightly longer than the slideChanged timeout
  });

  window.addEventListener("slideChanged", async (event) => {
    setTimeout(async () => {
      if (isUserSeeking) return; // Don't update slider if user is seeking

      const [globalIndex, total, searchIndex] = await getCurrentSlideIndex();
      slider.value =
        state.searchResults?.length > 0 ? searchIndex + 1 : globalIndex + 1;
      resetFadeOutTimer();
    }, 1000);
  });

  // Hide panel when slider loses focus or mouse leaves
  slider.addEventListener("mouseleave", () => {
    infoPanel.style.display = "none";
  });
  slider.addEventListener("blur", () => {
    infoPanel.style.display = "none";
  });
}

function showSlider() {
  sliderContainer.classList.add("visible");
  sliderVisible = true;
  updateSliderRange().then(() => {
    renderSliderTicks();
  });
  resetFadeOutTimer();
}

function hideSliderWithDelay(event) {
  // Only hide if the mouse has actually left the container, not just moved between children
  if (!sliderContainer.contains(event.relatedTarget)) {
    clearFadeOutTimer();
    fadeOutTimeoutId = setTimeout(() => {
      sliderContainer.classList.remove("visible");
      sliderVisible = false;
      if (ticksContainer) ticksContainer.innerHTML = "";
      fadeOutTimeoutId = null;
    }, 600);
  }
}

function resetFadeOutTimer() {
  clearFadeOutTimer();
  fadeOutTimeoutId = setTimeout(() => {
    // Only fade out if mouse is NOT inside hoverZone
    if (!hoverZone.matches(":hover")) {
      sliderContainer.classList.remove("visible");
      sliderVisible = false;
      if (ticksContainer) ticksContainer.innerHTML = "";
      fadeOutTimeoutId = null;
    }
  }, FADE_OUT_DELAY);
}

function clearFadeOutTimer() {
  if (fadeOutTimeoutId) {
    clearTimeout(fadeOutTimeoutId);
    fadeOutTimeoutId = null;
  }
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

  // Clear and rebuild ticks
  ticksContainer.innerHTML = "";

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
    sliderContainer.classList.add("visible");
    await updateSliderRange();
    await renderSliderTicks();
    resetFadeOutTimer();
  } else {
    sliderContainer.classList.remove("visible");
    if (ticksContainer) ticksContainer.innerHTML = "";
    clearFadeOutTimer();
  }
}

// Update slider range and value based on mode
async function updateSliderRange() {
  const [, totalSlides] = await getCurrentSlideIndex();
  if (state.searchResults?.length > 0) {
    slider.min = 1;
    slider.max = state.searchResults.length;
  } else {
    slider.min = 1;
    slider.max = totalSlides;
  }
}
