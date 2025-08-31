import { ScoreDisplay } from "./score-display.js"; // Add this import
import { state } from "./state.js";
import { getCurrentSlideIndex } from "./swiper.js";

let sliderVisible = false;
let sliderContainer;
let scoreDisplayElement; // Rename to avoid confusion
let scoreSliderRow;
let scoreDisplayObj; // Add this for the actual score display object
let searchResultsChanged = true;

let scoreText, slider, ticksContainer, contextLabel, hoverZone;
let fadeOutTimeoutId = null;
let TICK_COUNT = 10; // Number of ticks to show on the slider
const FADE_OUT_DELAY = 10000; // 10 seconds
let isUserSeeking = false;

document.addEventListener("DOMContentLoaded", () => {
  // Initialize the DOM elements
  sliderContainer = document.getElementById("sliderWithTicksContainer");
  scoreDisplayElement = document.getElementById("fixedScoreDisplay"); // Renamed
  scoreSliderRow = document.getElementById("scoreSliderRow");

  // Initialize the score display object
  scoreDisplayObj = new ScoreDisplay(); // Create the score display object

  initializeEvents();
});

function initializeEvents() {
  scoreText = document.getElementById("scoreText");
  slider = document.getElementById("slideSeekSlider");
  ticksContainer = document.getElementById("sliderTicks");
  contextLabel = document.getElementById("contextLabel");
  hoverZone = document.getElementById("sliderHoverZone");

  const scoreElement = scoreDisplayElement; // Use the DOM element for events
  const infoPanel = document.getElementById("sliderInfoPanel");

  // Show slider on hover over score display or hover zone
  scoreElement.addEventListener("click", toggleSlider);
  hoverZone.addEventListener("mouseenter", showSlider);

  // Hide slider when mouse leaves score display or hover zone
  hoverZone.addEventListener("mouseleave", hideSliderWithDelay);

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
            )}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(
              date.getFullYear()
            ).slice(-2)}`;
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
        scoreDisplayObj.showCluster(
          // Use scoreDisplayObj instead of scoreDisplay
          cluster,
          color,
          targetIndex + 1,
          state.searchResults.length
        );
      } else {
        scoreDisplayObj.show(
          // Use scoreDisplayObj instead of scoreDisplay
          state.searchResults[targetIndex]?.score,
          targetIndex + 1,
          state.searchResults.length
        );
      }
    } else {
      globalIndex = targetIndex;
      scoreDisplayObj.showIndex(globalIndex, slider.max); // Use scoreDisplayObj instead of scoreDisplay
    }
  });

  // When slider is released, seek to slide
  slider.addEventListener("change", async function () {
    const targetIndex = parseInt(slider.value, 10) - 1;
    const isSearchMode = state.searchResults?.length > 0;
    isUserSeeking = true; // Set flag before seeking

    // Dispatch event to swiper.js for handling
    window.dispatchEvent(
      new CustomEvent("setSlideIndex", {
        detail: { targetIndex, isSearchMode },
      })
    );

    slider.blur();
    // Reset flag after a short delay
    setTimeout(() => {
      isUserSeeking = false;
    }, 1500);
  });

  let slideChangedTimer = null;

  window.addEventListener("slideChanged", async (event) => {
    searchResultsChanged = true;
    if (slideChangedTimer) clearTimeout(slideChangedTimer);
    slideChangedTimer = setTimeout(async () => {
      if (isUserSeeking) return; // Don't update slider if user is seeking

      const [globalIndex, total, searchIndex] = await getCurrentSlideIndex();
      slider.value =
        state.searchResults?.length > 0 ? searchIndex + 1 : globalIndex + 1;
      resetFadeOutTimer();
    }, 200); // 100ms delay to allow swiper/gallery to settle
  });

  // Fix the hover event handlers - use scoreDisplayElement for DOM events
  if (scoreSliderRow) {
    scoreSliderRow.addEventListener("mouseenter", showSlider);
    scoreSliderRow.addEventListener("mouseleave", hideSlider);
  }

  if (scoreDisplayElement) {
    scoreDisplayElement.addEventListener("mouseenter", showSlider);
  }

  if (sliderContainer) {
    sliderContainer.addEventListener("mouseenter", showSlider);
    sliderContainer.addEventListener("mouseleave", hideSlider);
  }
}

// Hover handlers for the entire slider row to show/hide slider
async function showSlider() {
  if (!sliderVisible && sliderContainer) {
    sliderVisible = true;
    sliderContainer.classList.add("visible");

    let [, total] = await getCurrentSlideIndex();
    if (total > 0 && searchResultsChanged)
      updateSliderRange().then(() => {
        renderSliderTicks();
        searchResultsChanged = false;
      });

    resetFadeOutTimer();

    // Trigger gallery update if available
    if (window.thumbnailGallery) {
      getCurrentSlideIndex().then(([globalIndex, total, searchIndex]) => {
        const slideDetail = { globalIndex, total, searchIndex };
        window.thumbnailGallery.updateGallery(slideDetail);
      });
    }
  }
}

function hideSlider() {
  if (sliderVisible && sliderContainer) {
    sliderVisible = false;
    sliderContainer.classList.remove("visible");
  }
}

function hideSliderWithDelay(event) {
  // Only hide if the mouse has actually left the container, not just moved between children
  if (!sliderContainer.contains(event.relatedTarget)) {
    clearFadeOutTimer();
    fadeOutTimeoutId = setTimeout(() => {
      sliderContainer.classList.remove("visible");
      sliderVisible = false;
      fadeOutTimeoutId = null;
    }, 600);
  }
}

function resetFadeOutTimer() {
  clearFadeOutTimer();
  fadeOutTimeoutId = setTimeout(() => {
    // Only fade out if mouse is NOT inside hoverZone
    if (!sliderContainer.querySelector(":hover")) {
      sliderContainer.classList.remove("visible");
      sliderVisible = false;
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
  console.log("Toggling slider. Now visible:", sliderVisible);
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

window.addEventListener("searchResultsChanged", () => {
  searchResultsChanged = true;
});

window.addEventListener("albumChanged", () => {
  searchResultsChanged = true;
});
