import { bookmarkManager } from "./bookmarks.js";
import { ScoreDisplay } from "./score-display.js";
import { getCurrentSlideIndex, slideState } from "./slide-state.js";
import { state } from "./state.js";
import { debounce } from "./utils.js";

class SeekSlider {
  constructor() {
    this.sliderVisible = false;
    this.sliderContainer = null;
    this.scoreDisplayElement = null;
    this.scoreSliderRow = null;
    this.scoreDisplayObj = null;
    this.searchResultsChanged = true;
    this.hoverStrip = null;

    this.scoreText = null;
    this.slider = null;
    this.ticksContainer = null;
    this.contextLabel = null;
    this.hoverZone = null;
    this.fadeOutTimeoutId = null;
    this.hideTimerId = null;
    this.TICK_COUNT = 10;
    this.FADE_OUT_DELAY = 10000;
    this.HIDE_DELAY_MS = 150; // Delay before hiding to prevent jitter from rapid mouse events
    this.isUserSeeking = false;
    this.lastFetchTime = 0;
    this.FETCH_THROTTLE_MS = 200;
    this.slideChangedTimer = null;
  }

  initialize() {
    this.sliderContainer = document.getElementById("sliderWithTicksContainer");
    this.scoreDisplayElement = document.getElementById("fixedScoreDisplay");
    this.scoreSliderRow = document.getElementById("scoreSliderRow");
    this.scoreDisplayObj = new ScoreDisplay();
    this.hoverStrip = document.getElementById("sliderHoverStrip");

    this.scoreText = document.getElementById("scoreText");
    this.slider = document.getElementById("slideSeekSlider");
    this.ticksContainer = document.getElementById("sliderTicks");
    this.contextLabel = document.getElementById("contextLabel");
    this.hoverZone = document.getElementById("sliderHoverZone");
    this.infoPanel = document.getElementById("sliderInfoPanel");

    this.addEventListeners();
    this.updateSliderPosition();
    this.updateHoverStripProgress();

    // Update position when window resizes (debounced to avoid performance issues)
    this.debouncedUpdatePosition = debounce(() => this.updateSliderPosition(), 100);
    window.addEventListener("resize", this.debouncedUpdatePosition);

    // Update slider position when score display content changes
    window.addEventListener("scoreDisplayContentChanged", () => this.updateSliderPosition());
  }

  /**
   * Update the left position of slider and yellow strip based on score display's right edge
   */
  updateSliderPosition() {
    if (!this.scoreDisplayElement || !this.scoreSliderRow || !this.hoverStrip) {
      return;
    }

    const rect = this.scoreDisplayElement.getBoundingClientRect();
    const leftPosition = rect.right + 8; // 8px gap after score display

    this.scoreSliderRow.style.left = `${leftPosition}px`;
    this.hoverStrip.style.left = `${leftPosition}px`;
  }

  /**
   * Update the hover strip gradient to show current slide position
   * Everything to the left of the current position is yellow, right is white
   * @param {number|null} sliderValue - Optional slider value (1-indexed). If not provided, uses slideState.
   */
  updateHoverStripProgress(sliderValue = null) {
    if (!this.hoverStrip) {
      return;
    }

    let max = 1;

    if (state.searchResults?.length > 0) {
      max = state.searchResults.length;
    } else {
      const [, totalSlides] = getCurrentSlideIndex();
      max = totalSlides || 1;
    }

    // Calculate percentage using same formula as slider thumb positioning
    // Slider uses 1-indexed values with min=1
    const value = sliderValue !== null ? sliderValue : slideState.getCurrentIndex() + 1;
    const percent = max > 1 ? ((value - 1) / (max - 1)) * 100 : 0;

    // Apply gradient: yellow up to current position, white after
    // Use CSS custom properties for colors (defined in seek-slider.css)
    const progressColor =
      getComputedStyle(document.documentElement).getPropertyValue("--slider-progress-color").trim() || "#ffc107";
    const remainingColor =
      getComputedStyle(document.documentElement).getPropertyValue("--slider-remaining-color").trim() || "#ffffff";
    this.hoverStrip.style.background = `linear-gradient(to right, ${progressColor} ${percent}%, ${remainingColor} ${percent}%)`;

    // Also update the slider track to match
    this.updateSliderTrack(percent);
  }

  /**
   * Update the slider track gradient to show progress (yellow left, white right)
   * @param {number} percent - The percentage of progress (0-100)
   */
  updateSliderTrack(percent) {
    if (!this.slider) {
      return;
    }
    this.slider.style.setProperty("--slider-progress", `${percent}%`);
  }

  addEventListeners() {
    if (this.scoreDisplayElement) {
      // Only toggle slider on click, not on hover
      this.scoreDisplayElement.addEventListener("click", (e) => {
        // Don't toggle slider if clicking on the star icon (for bookmark toggle)
        if (e.target.closest(".score-star")) {
          return;
        }
        this.toggleSlider();
      });
    }
    // Yellow hover strip triggers slider appearance
    if (this.hoverStrip) {
      this.hoverStrip.addEventListener("mouseenter", () => this.showSlider());
      this.hoverStrip.addEventListener("click", () => this.showSlider());
    }
    // Consolidated event handling on scoreSliderRow to prevent jitter.
    // Previously, multiple overlapping elements (hoverZone, sliderContainer, scoreSliderRow)
    // each had their own mouseenter/mouseleave handlers, causing rapid show/hide toggling
    // when the mouse moved between them during the slider animation.
    if (this.scoreSliderRow) {
      this.scoreSliderRow.addEventListener("mouseenter", () => {
        this.clearHideTimer();
        this.showSlider();
      });
      this.scoreSliderRow.addEventListener("mouseleave", (e) => {
        // Only hide if not moving to another slider-related element
        if (!this.scoreSliderRow.contains(e.relatedTarget) && e.relatedTarget !== this.hoverStrip) {
          this.scheduleHide();
        }
      });
    }
    if (this.slider) {
      this.slider.addEventListener("input", async (e) => await this.onSliderInput(e));
      this.slider.addEventListener("change", async () => await this.onSliderChange());
      this.slider.addEventListener("blur", () => {
        if (this.infoPanel) {
          this.infoPanel.style.display = "none";
        }
      });
    }

    window.addEventListener("slideChanged", async (event) => await this.onSlideChanged(event));
    window.addEventListener("searchResultsChanged", () => {
      this.searchResultsChanged = true;
      this.updateHoverStripProgress();
    });
    window.addEventListener("albumChanged", () => {
      this.searchResultsChanged = true;
      this.updateHoverStripProgress();
    });
  }

  /**
   * Schedule hiding the slider with a short delay to prevent jitter
   */
  scheduleHide() {
    this.clearHideTimer();
    this.hideTimerId = setTimeout(() => {
      this.hideSlider();
      this.hideTimerId = null;
    }, this.HIDE_DELAY_MS);
  }

  /**
   * Clear any pending hide timer
   */
  clearHideTimer() {
    if (this.hideTimerId) {
      clearTimeout(this.hideTimerId);
      this.hideTimerId = null;
    }
  }

  async onSliderInput(e) {
    const now = Date.now();
    const value = parseInt(this.slider.value, 10);

    // Update hover strip progress immediately as user drags
    this.updateHoverStripProgress(value);

    this.infoPanel.style.display = "block";

    if (now - this.lastFetchTime >= this.FETCH_THROTTLE_MS) {
      this.lastFetchTime = now;
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
            )}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getFullYear()).slice(-2)}`;
            this.infoPanel.textContent = panelText;
          }
        } catch {
          this.infoPanel.textContent = "";
        }
      }
    }

    this.resetFadeOutTimer();

    let panelText = "";
    if (state.searchResults?.length > 0 && state.searchResults[0].score !== undefined) {
      const result = state.searchResults[value - 1];
      panelText = result ? `Score: ${result.score.toFixed(3)}` : "";
    } else if (!state.searchResults || state.searchResults.length === 0) {
      try {
        const albumKey = state.album;
        const resp = await fetch(`image_info/${albumKey}/${value - 1}`);
        if (resp.ok) {
          const info = await resp.json();
          const date = new Date(info.last_modified * 1000);
          panelText = `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(
            2,
            "0"
          )}/${String(date.getFullYear()).slice(-2)}`;
        }
      } catch {
        panelText = "";
      }
    } else if (state.searchResults[0].cluster !== undefined) {
      panelText = "";
    }

    if (panelText) {
      this.infoPanel.textContent = panelText;
      this.infoPanel.style.display = "block";
      let left = 0;
      let top = 0;
      const containerRect = this.sliderContainer.getBoundingClientRect();
      if (e && typeof e.clientX === "number") {
        left = e.clientX - containerRect.left - this.infoPanel.offsetWidth / 2;
        top = this.slider.offsetTop - this.infoPanel.offsetHeight - 8;
      } else {
        const percent = (value - this.slider.min) / (this.slider.max - this.slider.min);
        const sliderRect = this.slider.getBoundingClientRect();
        left = percent * sliderRect.width - this.infoPanel.offsetWidth / 2;
        top = this.slider.offsetBottom + 8;
      }
      this.infoPanel.style.left = `${left}px`;
      this.infoPanel.style.top = `${top}px`;
    } else {
      this.infoPanel.style.display = "none";
    }

    this.resetFadeOutTimer();
    const targetIndex = parseInt(this.slider.value, 10) - 1;
    let globalIndex;
    if (state.searchResults?.length > 0) {
      globalIndex = state.searchResults[targetIndex]?.index;
      // Update bookmark status for the star display
      const isBookmarked = globalIndex !== undefined ? bookmarkManager.isBookmarked(globalIndex) : false;
      this.scoreDisplayObj.setBookmarkStatus(globalIndex, isBookmarked);

      if (state.searchResults[targetIndex]?.cluster !== undefined) {
        const cluster = state.searchResults[targetIndex]?.cluster;
        const color = state.searchResults[targetIndex]?.color;
        this.scoreDisplayObj.showCluster(cluster, color, targetIndex + 1, state.searchResults.length);
      } else {
        this.scoreDisplayObj.showSearchScore(
          state.searchResults[targetIndex]?.score,
          targetIndex + 1,
          state.searchResults.length
        );
      }
    } else {
      globalIndex = targetIndex;
      // Update bookmark status for the star display
      const isBookmarked = bookmarkManager.isBookmarked(globalIndex);
      this.scoreDisplayObj.setBookmarkStatus(globalIndex, isBookmarked);
      this.scoreDisplayObj.showIndex(globalIndex, this.slider.max);
    }
  }

  async onSliderChange() {
    this.infoPanel.textContent = "";
    const targetIndex = parseInt(this.slider.value, 10) - 1;
    // Update hover strip with final slider position
    this.updateHoverStripProgress(targetIndex + 1);
    this.isUserSeeking = true;
    slideState.navigateToIndex(targetIndex, slideState.isSearchMode);
    setTimeout(() => {
      this.isUserSeeking = false;
    }, 1500);
  }

  async onSlideChanged() {
    this.searchResultsChanged = true;
    if (this.isUserSeeking) {
      return;
    }
    const currentIndex = slideState.getCurrentIndex();
    if (this.slider) {
      this.slider.value = currentIndex + 1;
    }
    this.updateHoverStripProgress();
    this.resetFadeOutTimer();
  }

  async showSlider() {
    // Clear any pending hide timer to prevent jitter
    this.clearHideTimer();

    if (!this.sliderVisible && this.sliderContainer) {
      this.sliderVisible = true;
      // Hide the yellow strip and show the slider row with animation
      if (this.hoverStrip) {
        this.hoverStrip.classList.add("hidden");
      }
      if (this.scoreSliderRow) {
        this.scoreSliderRow.classList.add("visible");
      }
      this.sliderContainer.classList.add("visible");
      const [, total] = getCurrentSlideIndex();
      if (total > 0 && this.searchResultsChanged) {
        this.updateSliderRange().then(() => {
          this.renderSliderTicks();
          this.searchResultsChanged = false;
        });
      }
      // Update slider value to reflect current index
      const currentIndex = slideState.getCurrentIndex();
      if (this.slider) {
        this.slider.value = currentIndex + 1;
      }
      this.resetFadeOutTimer();
    }
  }

  hideSlider() {
    if (this.sliderVisible && this.sliderContainer) {
      this.sliderVisible = false;
      this.sliderContainer.classList.remove("visible");
      // Show the yellow strip and hide the slider row with animation
      if (this.scoreSliderRow) {
        this.scoreSliderRow.classList.remove("visible");
      }
      if (this.hoverStrip) {
        this.hoverStrip.classList.remove("hidden");
      }
      this.slider.blur();
      if (this.infoPanel) {
        this.infoPanel.style.display = "none";
      } // Hide infoPanel
    }
  }

  hideSliderWithDelay(event) {
    if (!this.sliderContainer.contains(event.relatedTarget)) {
      this.clearFadeOutTimer();
      this.fadeOutTimeoutId = setTimeout(() => {
        this.sliderContainer.classList.remove("visible");
        this.sliderVisible = false;
        // Show the yellow strip and hide the slider row with animation
        if (this.scoreSliderRow) {
          this.scoreSliderRow.classList.remove("visible");
        }
        if (this.hoverStrip) {
          this.hoverStrip.classList.remove("hidden");
        }
        this.slider.blur();
        if (this.infoPanel) {
          this.infoPanel.style.display = "none";
        } // Hide infoPanel
        this.fadeOutTimeoutId = null;
      }, 600);
    }
  }

  resetFadeOutTimer() {
    this.clearFadeOutTimer();
    this.fadeOutTimeoutId = setTimeout(() => {
      if (!this.sliderContainer.querySelector(":hover")) {
        this.sliderContainer.classList.remove("visible");
        this.sliderVisible = false;
        // Show the yellow strip and hide the slider row with animation
        if (this.scoreSliderRow) {
          this.scoreSliderRow.classList.remove("visible");
        }
        if (this.hoverStrip) {
          this.hoverStrip.classList.remove("hidden");
        }
        if (this.infoPanel) {
          this.infoPanel.style.display = "none";
        } // Hide infoPanel
        this.fadeOutTimeoutId = null;
      }
    }, this.FADE_OUT_DELAY);
  }

  clearFadeOutTimer() {
    if (this.fadeOutTimeoutId) {
      clearTimeout(this.fadeOutTimeoutId);
      this.fadeOutTimeoutId = null;
    }
  }

  async renderSliderTicks() {
    if (!this.slider || !this.ticksContainer || !this.contextLabel) {
      return;
    }
    if (!this.sliderVisible || !this.sliderContainer.classList.contains("visible")) {
      this.ticksContainer.innerHTML = "";
      this.contextLabel.textContent = "";
      return;
    }

    let ticks = [];
    let contextText = "";
    const numTicks = this.TICK_COUNT;
    const min = parseInt(this.slider.min, 10);
    const max = parseInt(this.slider.max, 10);

    if (max <= min) {
      this.ticksContainer.innerHTML = "";
      this.contextLabel.textContent = "";
      return;
    }

    const positions = [];
    for (let i = 0; i < numTicks; i++) {
      const pos = Math.round(min + ((max - min) * i) / (numTicks - 1));
      positions.push(pos);
    }

    if (!state.searchResults || state.searchResults.length === 0) {
      contextText = "Date";
      ticks = await Promise.all(
        positions.map(async (idx) => {
          try {
            const albumKey = state.album;
            const resp = await fetch(`image_info/${albumKey}/${idx - 1}`);
            if (!resp.ok) {
              return "";
            }
            const info = await resp.json();
            const date = new Date(info.last_modified * 1000);
            return `${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
          } catch {
            return "";
          }
        })
      );
    } else if (state.searchResults.length > 0 && state.searchResults[0].score !== undefined) {
      contextText = "Score";
      ticks = positions.map((idx) => {
        const result = state.searchResults[idx - 1];
        return result ? result.score.toFixed(3) : "";
      });
    } else if (state.searchResults.length > 0 && state.searchResults[0].cluster !== undefined) {
      contextText = "Cluster Position";
      ticks = positions.map((idx) => `${idx}`);
    }

    this.contextLabel.textContent = contextText;
    this.ticksContainer.innerHTML = "";

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

      this.ticksContainer.appendChild(tick);
    });
  }

  async toggleSlider() {
    this.sliderVisible = !this.sliderVisible;
    if (this.sliderVisible) {
      // Hide the yellow strip and show the slider row with animation
      if (this.hoverStrip) {
        this.hoverStrip.classList.add("hidden");
      }
      if (this.scoreSliderRow) {
        this.scoreSliderRow.classList.add("visible");
      }
      this.sliderContainer.classList.add("visible");
      await this.updateSliderRange();
      // Update slider value to reflect current index
      const currentIndex = slideState.getCurrentIndex();
      if (this.slider) {
        this.slider.value = currentIndex + 1;
      }
      await this.renderSliderTicks();
      this.resetFadeOutTimer();
    } else {
      this.sliderContainer.classList.remove("visible");
      // Show the yellow strip and hide the slider row with animation
      if (this.scoreSliderRow) {
        this.scoreSliderRow.classList.remove("visible");
      }
      if (this.hoverStrip) {
        this.hoverStrip.classList.remove("hidden");
      }
      if (this.ticksContainer) {
        this.ticksContainer.innerHTML = "";
      }
      this.clearFadeOutTimer();
    }
  }

  async updateSliderRange() {
    const [, totalSlides] = getCurrentSlideIndex();
    if (state.searchResults?.length > 0) {
      this.slider.min = 1;
      this.slider.max = state.searchResults.length;
    } else {
      this.slider.min = 1;
      this.slider.max = totalSlides;
    }
  }
}

// Create and initialize the SeekSlider object
export const seekSlider = new SeekSlider();
window.seekSlider = seekSlider;

document.addEventListener("DOMContentLoaded", () => {
  seekSlider.initialize();
});
