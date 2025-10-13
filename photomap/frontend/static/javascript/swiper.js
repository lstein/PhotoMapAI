// swiper.js
// This file initializes the Swiper instance and manages slide transitions.
import { eventRegistry } from "./event-registry.js";
import { updateMetadataOverlay } from "./metadata-drawer.js";
import { fetchImageByIndex } from "./search.js";
import { getCurrentSlideIndex, slideState } from "./slide-state.js";
import { state } from "./state.js";
import { updateCurrentImageMarker } from "./umap.js";
import { setBatchLoading } from "./utils.js";

class SwiperManager {
  constructor() {
    if (SwiperManager.instance) {
      return SwiperManager.instance;
    }
    
    this.hasTouchCapability = this.isTouchDevice();
    this.isPrepending = false;
    this.isAppending = false;
    this.isInternalSlideChange = false;
    
    SwiperManager.instance = this;
  }

  // Check if the device is mobile
  isTouchDevice() {
    return (
      "ontouchstart" in window ||
      navigator.maxTouchPoints > 0 ||
      navigator.msMaxTouchPoints > 0
    );
  }

  async initializeSingleSwiper() {
    console.trace("Initializing single swiper...");

    // Swiper config for single-image mode
    const swiperConfig = {
      direction: "horizontal",
      slidesPerView: 1,
      spaceBetween: 0,
      navigation: {
        prevEl: ".swiper-button-prev",
        nextEl: ".swiper-button-next",
      },
      autoplay: {
        delay: state.currentDelay * 1000,
        disableOnInteraction: false,
        enabled: false,
      },
      pagination: {
        el: ".swiper-pagination",
        clickable: true,
        dynamicBullets: true,
      },
      loop: false,
      touchEventsTarget: "container",
      allowTouchMove: true,
      simulateTouch: true,
      touchStartPreventDefault: false,
      touchMoveStopPropagation: false,
      keyboard: {
        enabled: true,
        onlyInViewport: true,
      },
      mousewheel: {
        enabled: true,
        releaseonEdges: true,
      },
    };

    if (this.hasTouchCapability) {
      swiperConfig.zoom = {
        maxRatio: 3,
        minRatio: 1,
        toggle: true,
        containerClass: "swiper-zoom-container",
        zoomedSlideClass: "swiper-slide-zoomed",
      };
    }

    // Initialize Swiper
    state.swiper = new Swiper("#singleSwiper", swiperConfig);

    this.initializeSwiperHandlers();
    this.initializeEventHandlers();

    // Initial icon state and overlay
    this.updateSlideshowIcon();
    updateMetadataOverlay();
  }

  initializeSwiperHandlers() {
    if (!state.swiper) return;

    state.swiper.on("autoplayStart", () => {
      if (!state.gridViewActive) this.updateSlideshowIcon();
    });

    state.swiper.on("autoplayResume", () => {
      if (!state.gridViewActive) this.updateSlideshowIcon();
    });

    state.swiper.on("autoplayStop", () => {
      if (!state.gridViewActive) this.updateSlideshowIcon();
    });

    state.swiper.on("autoplayPause", () => {
      if (!state.gridViewActive) this.updateSlideshowIcon();
    });

    state.swiper.on("scrollbarDragStart", () => {
      if (!state.gridViewActive) this.pauseSlideshow();
    });

    state.swiper.on("slideChange", () => {
      if (this.isAppending || this.isPrepending || this.isInternalSlideChange) return;
      this.isInternalSlideChange = true;
      const activeSlide = state.swiper.slides[state.swiper.activeIndex];
      if (activeSlide) {
        const globalIndex = parseInt(activeSlide.dataset.globalIndex, 10) || 0;
        const searchIndex = parseInt(activeSlide.dataset.searchIndex, 10) || 0;
        slideState.updateFromExternal(globalIndex, searchIndex);
        updateMetadataOverlay();
      }
      this.isInternalSlideChange = false;
    });

    state.swiper.on("slideNextTransitionStart", () => {
      if (this.isAppending) return;

      if (state.swiper.activeIndex === state.swiper.slides.length - 1) {
        this.isAppending = true;
        state.swiper.allowSlideNext = false;

        const { globalIndex: nextGlobal, searchIndex: nextSearch } =
          slideState.resolveOffset(+1);

        if (nextGlobal !== null) {
          this.addSlideByIndex(nextGlobal, nextSearch)
            .then(() => {
              this.isAppending = false;
              state.swiper.allowSlideNext = true;
            })
            .catch(() => {
              this.isAppending = false;
              state.swiper.allowSlideNext = true;
            });
        } else {
          this.isAppending = false;
          state.swiper.allowSlideNext = true;
        }
      }
    });

    state.swiper.on("slidePrevTransitionEnd", () => {
      const [globalIndex] = getCurrentSlideIndex();
      if (state.swiper.activeIndex === 0 && globalIndex > 0) {
        const { globalIndex: prevGlobal, searchIndex: prevSearch } =
          slideState.resolveOffset(-1);
        if (prevGlobal !== null) {
          const prevExists = Array.from(state.swiper.slides).some(
            (el) => parseInt(el.dataset.globalIndex, 10) === prevGlobal
          );
          if (!prevExists) {
            this.isPrepending = true;
            state.swiper.allowSlidePrev = false;
            this.addSlideByIndex(prevGlobal, prevSearch, true)
              .then(() => {
                state.swiper.slideTo(1, 0);
                this.isPrepending = false;
                state.swiper.allowSlidePrev = true;
              })
              .catch(() => {
                this.isPrepending = false;
                state.swiper.allowSlidePrev = true;
              });
          }
        }
      }
    });

    state.swiper.on("sliderFirstMove", () => {
      this.pauseSlideshow();
    });
  }

  initializeEventHandlers() {
    // Stop slideshow on next and prev button clicks
    document
      .querySelectorAll(".swiper-button-next, .swiper-button-prev")
      .forEach((btn) => {
        eventRegistry.install(
          { type: "swiper", event: "click", object: btn },
          function (event) {
            swiperManager.pauseSlideshow();
            event.stopPropagation();
            this.blur();
          }
        );
        eventRegistry.install(
          { type: "swiper", event: "mousedown", object: btn },
          function (event) {
            this.blur();
          }
        );
      });

    // Reset slide show when the album changes
    eventRegistry.install({ type: "swiper", event: "albumChanged" }, () => {
      this.resetAllSlides();
    });

    // Reset slide show when the search results change
    eventRegistry.install(
      { type: "swiper", event: "searchResultsChanged" },
      () => {
        this.resetAllSlides();
      }
    );

    // Handle slideshow mode changes
    eventRegistry.install(
      { type: "swiper", event: "swiperModeChanged" },
      () => {
        this.resetAllSlides();
      }
    );

    // Navigate to a slide
    eventRegistry.install(
      { type: "swiper", event: "seekToSlideIndex" },
      (event) => this.seekToSlideIndex(event)
    );
  }

  pauseSlideshow() {
    if (state.swiper && state.swiper.autoplay?.running) {
      state.swiper.autoplay.stop();
    }
  }

  resumeSlideshow() {
    if (state.swiper) {
      state.swiper.autoplay.stop();
      setTimeout(() => {
        state.swiper.autoplay.start();
      }, 50);
    }
  }

  updateSlideshowIcon() {
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

  async addNewSlide(offset = 0) {
    if (!state.album) return;

    let [globalIndex, totalImages, searchIndex] = getCurrentSlideIndex();

    if (slideState.isSearchMode) {
      globalIndex = slideState.resolveOffset(offset).globalIndex;
    } else {
      if (state.mode === "random") {
        globalIndex = Math.floor(Math.random() * totalImages);
      } else {
        globalIndex = globalIndex + offset;
        globalIndex = (globalIndex + totalImages) % totalImages;
      }
    }
    await this.addSlideByIndex(globalIndex, searchIndex);
  }

  async addSlideByIndex(globalIndex, searchIndex = null, prepend = false) {
    if (!state.swiper) return;
    if (state.isTransitioning) return;

    if (state.mode === "random" && !slideState.isSearchMode) {
      const totalImages = slideState.totalAlbumImages;
      globalIndex = Math.floor(Math.random() * totalImages);
    }

    const exists = Array.from(state.swiper.slides).some(
      (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
    );
    if (exists) return;

    let currentScore, currentCluster, currentColor;
    if (slideState.isSearchMode && searchIndex !== null) {
      const results = slideState.searchResults[searchIndex];
      currentScore = results?.score || "";
      currentCluster = results?.cluster || "";
      currentColor = results?.color || "#000000";
    }

    try {
      const data = await fetchImageByIndex(globalIndex);

      if (!data || Object.keys(data).length === 0) {
        return;
      }

      const path = data.filepath;
      const url = data.image_url;
      const metadata_url = data.metadata_url;
      const slide = document.createElement("div");
      slide.className = "swiper-slide";

      if (this.hasTouchCapability) {
        slide.innerHTML = `
          <div class="swiper-zoom-container">
            <img src="${url}" alt="${data.filename}" />
          </div>
       `;
      } else {
        slide.innerHTML = `
          <img src="${url}" alt="${data.filename}" />
        `;
      }

      slide.dataset.filename = data.filename || "";
      slide.dataset.description = data.description || "";
      slide.dataset.filepath = path || "";
      slide.dataset.score = currentScore || "";
      slide.dataset.cluster = currentCluster || "";
      slide.dataset.color = currentColor || "#000000";
      slide.dataset.globalIndex = data.index || 0;
      slide.dataset.total = data.total || 0;
      slide.dataset.searchIndex = searchIndex !== null ? searchIndex : "";
      slide.dataset.metadata_url = metadata_url || "";
      slide.dataset.reference_images = JSON.stringify(
        data.reference_images || []
      );

      if (prepend) {
        state.swiper.prependSlide(slide);
      } else {
        state.swiper.appendSlide(slide);
      }
    } catch (error) {
      console.error("Failed to add new slide:", error);
      alert(`Failed to add new slide: ${error.message}`);
      return;
    }
  }

  async handleSlideChange() {
    const { globalIndex } = slideState.getCurrentSlide();
    const slideEls = state.swiper.slides;
    let activeIndex = Array.from(slideEls).findIndex(
      (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
    );
    if (activeIndex === -1) activeIndex = 0;
    const activeSlide = slideEls[activeIndex];
    if (activeSlide) {
      const globalIndex = parseInt(activeSlide.dataset.globalIndex, 10) || 0;
      const searchIndex = parseInt(activeSlide.dataset.searchIndex, 10) || 0;
      slideState.updateFromExternal(globalIndex, searchIndex);
    }
    updateMetadataOverlay();
  }

  removeSlidesAfterCurrent() {
    if (!state.swiper) return;
    const { globalIndex } = slideState.getCurrentSlide();
    const slideEls = state.swiper.slides;
    let activeIndex = Array.from(slideEls).findIndex(
      (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
    );
    if (activeIndex === -1) activeIndex = 0;
    const slidesToRemove = slideEls.length - activeIndex - 1;
    if (slidesToRemove > 0) {
      state.swiper.removeSlide(activeIndex + 1, slidesToRemove);
    }
    setTimeout(() => this.enforceHighWaterMark(), 500);
  }

  async resetAllSlides() {
    if (!state.swiper) return;

    console.log("Resetting all slides in single swiper");

    const slideShowRunning = state.swiper?.autoplay?.running;
    this.pauseSlideshow();

    state.swiper.removeAllSlides();

    const { globalIndex, searchIndex } = slideState.getCurrentSlide();
    console.log("Current slide index:", globalIndex, searchIndex);

    const swiperContainer = document.getElementById("singleSwiper");
    if (swiperContainer) swiperContainer.style.visibility = "hidden";

    // Add previous slide if available
    const { globalIndex: prevGlobal, searchIndex: prevSearch } =
      slideState.resolveOffset(-1);
    if (prevGlobal !== null) {
      await this.addSlideByIndex(prevGlobal, prevSearch);
    }

    // Add current slide
    const previousMode = state.mode;
    if (globalIndex > 0) state.mode = "chronological";
    await this.addSlideByIndex(globalIndex, searchIndex);
    state.mode = previousMode;

    // Add next slide if available
    const { globalIndex: nextGlobal, searchIndex: nextSearch } =
      slideState.resolveOffset(1);
    if (nextGlobal !== null) {
      await this.addSlideByIndex(nextGlobal, nextSearch);
    }

    // Navigate to the current slide
    const slideIndex = prevGlobal !== null ? 1 : 0;
    state.swiper.slideTo(slideIndex, 0);

    await new Promise(requestAnimationFrame);
    if (swiperContainer) swiperContainer.style.visibility = "";

    updateMetadataOverlay();
    if (slideShowRunning) this.resumeSlideshow();

    setTimeout(() => updateCurrentImageMarker(window.umapPoints), 500);
    setBatchLoading(false);
  }

  enforceHighWaterMark(backward = false) {
    const maxSlides = state.highWaterMark || 50;
    const swiper = state.swiper;
    const slides = swiper.slides.length;
    if (state.isTransitioning) return;

    if (slides > maxSlides) {
      let slideShowRunning = swiper.autoplay.running;
      this.pauseSlideshow();

      if (backward) {
        swiper.removeSlide(swiper.slides.length - 1);
      } else {
        swiper.removeSlide(0);
      }

      if (slideShowRunning) this.resumeSlideshow();
    }
  }

  async seekToSlideIndex(event) {
    let { globalIndex, searchIndex, totalSlides, isSearchMode } = event.detail;

    if (isSearchMode) {
      globalIndex = slideState.searchToGlobal(searchIndex);
    }

    let slideEls = state.swiper.slides;
    const exists = Array.from(slideEls).some(
      (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
    );
    if (exists) {
      const targetSlideIdx = Array.from(slideEls).findIndex(
        (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
      );
      if (targetSlideIdx !== -1) {
        this.isInternalSlideChange = true;
        state.swiper.slideTo(targetSlideIdx, 300);
        this.isInternalSlideChange = false;
        updateMetadataOverlay();
        return;
      }
    }

    state.swiper.removeAllSlides();

    let origin = -2;
    const slides_to_add = 5;
    if (globalIndex + origin < 0) {
      origin = 0;
    }

    const swiperContainer = document.getElementById("singleSwiper");
    swiperContainer.style.visibility = "hidden";

    for (let i = origin; i < slides_to_add; i++) {
      if (searchIndex + i >= totalSlides) break;
      await this.addSlideByIndex(globalIndex + i, searchIndex + i);
    }

    slideEls = state.swiper.slides;
    let targetSlideIdx = Array.from(slideEls).findIndex(
      (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
    );
    if (targetSlideIdx === -1) targetSlideIdx = 0;
    state.swiper.slideTo(targetSlideIdx, 0);

    swiperContainer.style.visibility = "visible";
    updateMetadataOverlay();
  }
}

// Create and export singleton instance
const swiperManager = new SwiperManager();

// Export methods for backward compatibility
export const initializeSingleSwiper = () => swiperManager.initializeSingleSwiper();
export const pauseSlideshow = () => swiperManager.pauseSlideshow();
export const resumeSlideshow = () => swiperManager.resumeSlideshow();
export const updateSlideshowIcon = () => swiperManager.updateSlideshowIcon();
export const addNewSlide = (offset) => swiperManager.addNewSlide(offset);
export const addSlideByIndex = (globalIndex, searchIndex, prepend) => 
  swiperManager.addSlideByIndex(globalIndex, searchIndex, prepend);
export const handleSlideChange = () => swiperManager.handleSlideChange();
export const removeSlidesAfterCurrent = () => swiperManager.removeSlidesAfterCurrent();
export const resetAllSlides = () => swiperManager.resetAllSlides();
export const enforceHighWaterMark = (backward) => swiperManager.enforceHighWaterMark(backward);

// Export the singleton instance itself if needed
export { swiperManager };
