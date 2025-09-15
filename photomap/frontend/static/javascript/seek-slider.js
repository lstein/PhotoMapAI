import { ScoreDisplay } from "./score-display.js";
import { getCurrentSlideIndex, slideState } from "./slide-state.js";
import { state } from "./state.js";

class SeekSlider {
  constructor() {
    this.sliderVisible = false;
    this.sliderContainer = null;
    this.scoreDisplayElement = null;
    this.scoreSliderRow = null;
    this.scoreDisplayObj = null;
    this.searchResultsChanged = true;

    this.scoreText = null;
    this.slider = null;
    this.ticksContainer = null;
    this.contextLabel = null;
    this.hoverZone = null;
    this.fadeOutTimeoutId = null;
    this.TICK_COUNT = 10;
    this.FADE_OUT_DELAY = 10000;
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

    this.scoreText = document.getElementById("scoreText");
    this.slider = document.getElementById("slideSeekSlider");
    this.ticksContainer = document.getElementById("sliderTicks");
    this.contextLabel = document.getElementById("contextLabel");
    this.hoverZone = document.getElementById("sliderHoverZone");
    this.infoPanel = document.getElementById("sliderInfoPanel");

    this.addEventListeners();
  }

  addEventListeners() {
    if (this.scoreDisplayElement) {
      this.scoreDisplayElement.addEventListener("click", () =>
        this.toggleSlider()
      );
      this.scoreDisplayElement.addEventListener("mouseenter", () =>
        this.showSlider()
      );
    }
    if (this.hoverZone) {
      this.hoverZone.addEventListener("mouseenter", () => this.showSlider());
      this.hoverZone.addEventListener("mouseleave", (e) =>
        this.hideSliderWithDelay(e)
      );
    }
    if (this.scoreSliderRow) {
      this.scoreSliderRow.addEventListener("mouseenter", () =>
        this.showSlider()
      );
      this.scoreSliderRow.addEventListener("mouseleave", () =>
        this.hideSlider()
      );
    }
    if (this.sliderContainer) {
      this.sliderContainer.addEventListener("mouseenter", () =>
        this.showSlider()
      );
      this.sliderContainer.addEventListener("mouseleave", () =>
        this.hideSlider()
      );
    }
    if (this.slider) {
      this.slider.addEventListener(
        "input",
        async (e) => await this.onSliderInput(e)
      );
      this.slider.addEventListener(
        "change",
        async () => await this.onSliderChange()
      );
      this.slider.addEventListener("blur", () => {
        if (this.infoPanel) this.infoPanel.style.display = "none";
      });
    }

    window.addEventListener(
      "slideChanged",
      async (event) => await this.onSlideChanged(event)
    );
    window.addEventListener("searchResultsChanged", () => {
      this.searchResultsChanged = true;
    });
    window.addEventListener("albumChanged", () => {
      this.searchResultsChanged = true;
    });
  }

  async onSliderInput(e) {
    const now = Date.now();
    const value = parseInt(this.slider.value, 10);

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
            )}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(
              date.getFullYear()
            ).slice(-2)}`;
            this.infoPanel.textContent = panelText;
          }
        } catch {
          this.infoPanel.textContent = "";
        }
      }
    }

    this.resetFadeOutTimer();

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
      this.infoPanel.textContent = panelText;
      this.infoPanel.style.display = "block";
      let left = 0;
      let top = 0;
      const containerRect = this.sliderContainer.getBoundingClientRect();
      if (e && typeof e.clientX === "number") {
        left = e.clientX - containerRect.left - this.infoPanel.offsetWidth / 2;
        top = this.slider.offsetTop - this.infoPanel.offsetHeight - 8;
      } else {
        const percent =
          (value - this.slider.min) / (this.slider.max - this.slider.min);
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
      if (state.searchResults[targetIndex]?.cluster !== undefined) {
        const cluster = state.searchResults[targetIndex]?.cluster;
        const color = state.searchResults[targetIndex]?.color;
        this.scoreDisplayObj.showCluster(
          cluster,
          color,
          targetIndex + 1,
          state.searchResults.length
        );
      } else {
        this.scoreDisplayObj.show(
          state.searchResults[targetIndex]?.score,
          targetIndex + 1,
          state.searchResults.length
        );
      }
    } else {
      globalIndex = targetIndex;
      this.scoreDisplayObj.showIndex(globalIndex, this.slider.max);
    }
  }

  async onSliderChange() {
    this.infoPanel.textContent = "";
    const targetIndex = parseInt(this.slider.value, 10) - 1;
    this.isUserSeeking = true;
    slideState.navigateToIndex(targetIndex, slideState.isSearchMode);
    setTimeout(() => {
      this.isUserSeeking = false;
    }, 1500);
  }

  async onSlideChanged(event) {
    this.searchResultsChanged = true;
    if (this.isUserSeeking) return;
    const currentIndex = slideState.getCurrentIndex();
    if (this.slider) this.slider.value = currentIndex + 1;
    this.resetFadeOutTimer();
  }

  async showSlider() {
    if (!this.sliderVisible && this.sliderContainer) {
      this.sliderVisible = true;
      this.sliderContainer.classList.add("visible");
      let [globalIndex, total, searchIndex] = getCurrentSlideIndex();
      if (total > 0 && this.searchResultsChanged)
        this.updateSliderRange().then(() => {
          this.renderSliderTicks();
          this.searchResultsChanged = false;
        });
      this.resetFadeOutTimer();
    }
  }

  hideSlider() {
    if (this.sliderVisible && this.sliderContainer) {
      this.sliderVisible = false;
      this.sliderContainer.classList.remove("visible");
      this.slider.blur();
      if (this.infoPanel) this.infoPanel.style.display = "none"; // Hide infoPanel
    }
  }

  hideSliderWithDelay(event) {
    if (!this.sliderContainer.contains(event.relatedTarget)) {
      this.clearFadeOutTimer();
      this.fadeOutTimeoutId = setTimeout(() => {
        this.sliderContainer.classList.remove("visible");
        this.sliderVisible = false;
        this.slider.blur();
        if (this.infoPanel) this.infoPanel.style.display = "none"; // Hide infoPanel
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
        if (this.infoPanel) this.infoPanel.style.display = "none"; // Hide infoPanel
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
    if (!this.slider || !this.ticksContainer || !this.contextLabel) return;
    if (
      !this.sliderVisible ||
      !this.sliderContainer.classList.contains("visible")
    ) {
      this.ticksContainer.innerHTML = "";
      this.contextLabel.textContent = "";
      return;
    }

    let ticks = [];
    let contextText = "";
    const numTicks = this.TICK_COUNT;
    let min = parseInt(this.slider.min, 10);
    let max = parseInt(this.slider.max, 10);

    if (max <= min) {
      this.ticksContainer.innerHTML = "";
      this.contextLabel.textContent = "";
      return;
    }

    let positions = [];
    for (let i = 0; i < numTicks; i++) {
      let pos = Math.round(min + ((max - min) * i) / (numTicks - 1));
      positions.push(pos);
    }

    if (!state.searchResults || state.searchResults.length === 0) {
      contextText = "Date";
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
    } else if (
      state.searchResults.length > 0 &&
      state.searchResults[0].score !== undefined
    ) {
      contextText = "Score";
      ticks = positions.map((idx) => {
        const result = state.searchResults[idx - 1];
        return result ? result.score.toFixed(3) : "";
      });
    } else if (
      state.searchResults.length > 0 &&
      state.searchResults[0].cluster !== undefined
    ) {
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
      this.sliderContainer.classList.add("visible");
      await this.updateSliderRange();
      await this.renderSliderTicks();
      this.resetFadeOutTimer();
    } else {
      this.sliderContainer.classList.remove("visible");
      if (this.ticksContainer) this.ticksContainer.innerHTML = "";
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
