// swiper.js
// This file initializes the Swiper instance and manages slide transitions.
import { albumManager } from "./album-manager.js";
import { toggleGridSwiperView } from "./events.js";
import { updateMetadataOverlay } from "./metadata-drawer.js";
import { fetchImageByIndex } from "./search.js";
import { getCurrentSlideIndex, slideState } from "./slide-state.js";
import { slideShowRunning, updateSlideshowButtonIcon } from "./slideshow.js";
import { state } from "./state.js";
import { updateCurrentImageMarker } from "./umap.js";

export const initializeSingleSwiper = async () => {
  const swiperManager = new SwiperManager();
  swiperManager.initializeSingleSwiper();
  albumManager.setSwiperManager(swiperManager);
  return swiperManager;
};

class SwiperManager {
  constructor() {
    if (SwiperManager.instance) {
      return SwiperManager.instance;
    }

    this.swiper = null;
    this.hasTouchCapability = this.isTouchDevice();
    this.isPrepending = false;
    this.isAppending = false;
    this.isInternalSlideChange = false;

    // Store event listeners for cleanup
    this.eventListeners = [];

    SwiperManager.instance = this;
  }

  // Helper to store and manage event listeners
  addEventListener(target, event, handler) {
    target.addEventListener(event, handler);
    this.eventListeners.push({ target, event, handler });
  }

  removeAllEventListeners() {
    this.eventListeners.forEach(({ target, event, handler }) => {
      target.removeEventListener(event, handler);
    });
    this.eventListeners = [];
  }

  // Check if the device is mobile
  isTouchDevice() {
    return "ontouchstart" in window || navigator.maxTouchPoints > 0 || navigator.msMaxTouchPoints > 0;
  }

  isVisible() {
    const singleContainer = document.getElementById("singleSwiperContainer");
    return singleContainer && singleContainer.style.display !== "none";
  }

  async initializeSingleSwiper() {
    // Swiper config for single-image mode
    const swiperConfig = {
      direction: "horizontal",
      slidesPerView: 1,
      spaceBetween: 0,
      navigation: {
        prevEl: "#singleSwiperPrevButton",
        nextEl: "#singleSwiperNextButton",
      },
      autoplay: {
        delay: state.currentDelay * 1000,
        disableOnInteraction: true,
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
        toggle: false,
        containerClass: "swiper-zoom-container",
        zoomedSlideClass: "swiper-slide-zoomed",
      };
    }

    // Initialize Swiper
    this.swiper = new Swiper("#singleSwiper", swiperConfig);
    state.swiper = this.swiper; // Keep state.swiper in sync for backward compatibility

    this.initializeSwiperHandlers();
    this.initializeEventHandlers();
    this.addDoubleTapHandlersToSlides();

    updateMetadataOverlay(this.currentSlide());
  }

  initializeSwiperHandlers() {
    if (!this.swiper) {
      return;
    }

    this.swiper.on("autoplayStart", () => {
      if (!state.gridViewActive) {
        updateSlideshowButtonIcon();
      }
    });

    this.swiper.on("autoplayResume", () => {
      if (!state.gridViewActive) {
        updateSlideshowButtonIcon();
      }
    });

    this.swiper.on("autoplayStop", () => {
      if (!state.gridViewActive) {
        updateSlideshowButtonIcon();
      }
    });

    this.swiper.on("autoplayPause", () => {
      if (!state.gridViewActive) {
        updateSlideshowButtonIcon();
      }
    });

    this.swiper.on("scrollbarDragStart", () => {
      if (!state.gridViewActive) {
        this.pauseSlideshow();
      }
    });

    this.swiper.on("slideChange", () => {
      if (this.isAppending || this.isPrepending || this.isInternalSlideChange) {
        return;
      }
      this.isInternalSlideChange = true;
      const activeSlide = this.swiper.slides[this.swiper.activeIndex];
      if (activeSlide) {
        const globalIndex = parseInt(activeSlide.dataset.globalIndex, 10) || 0;
        const searchIndex = parseInt(activeSlide.dataset.searchIndex, 10) || 0;
        slideState.updateFromExternal(globalIndex, searchIndex);
        updateMetadataOverlay(this.currentSlide());
      }
      this.isInternalSlideChange = false;
    });

    this.swiper.on("slideNextTransitionStart", () => {
      if (this.isAppending) {
        return;
      }

      if (this.swiper.activeIndex === this.swiper.slides.length - 1) {
        this.isAppending = true;
        this.swiper.allowSlideNext = false;

        const { globalIndex: nextGlobal, searchIndex: nextSearch } = slideState.resolveOffset(+1);

        if (nextGlobal !== null) {
          this.addSlideByIndex(nextGlobal, nextSearch)
            .then(() => {
              this.isAppending = false;
              this.swiper.allowSlideNext = true;
            })
            .catch(() => {
              this.isAppending = false;
              this.swiper.allowSlideNext = true;
            });
        } else {
          this.isAppending = false;
          this.swiper.allowSlideNext = true;
        }
      }
    });

    this.swiper.on("slidePrevTransitionEnd", () => {
      const [globalIndex] = getCurrentSlideIndex();
      if (this.swiper.activeIndex === 0 && globalIndex > 0) {
        const { globalIndex: prevGlobal, searchIndex: prevSearch } = slideState.resolveOffset(-1);
        if (prevGlobal !== null) {
          const prevExists = Array.from(this.swiper.slides).some(
            (el) => parseInt(el.dataset.globalIndex, 10) === prevGlobal
          );
          if (!prevExists) {
            this.isPrepending = true;
            this.swiper.allowSlidePrev = false;
            this.addSlideByIndex(prevGlobal, prevSearch, true)
              .then(() => {
                this.swiper.slideTo(1, 0);
                this.isPrepending = false;
                this.swiper.allowSlidePrev = true;
              })
              .catch(() => {
                this.isPrepending = false;
                this.swiper.allowSlidePrev = true;
              });
          }
        }
      }
    });

    this.swiper.on("sliderFirstMove", () => {
      this.pauseSlideshow();
    });
  }

  initializeEventHandlers() {
    // Stop slideshow on next and prev button clicks
    document.querySelectorAll(".swiper-button-next, .swiper-button-prev").forEach((btn) => {
      this.addEventListener(btn, "click", function (event) {
        state.single_swiper.pauseSlideshow();
        event.stopPropagation();
        this.blur();
      });
      this.addEventListener(btn, "mousedown", function () {
        this.blur();
      });
    });

    // Pause slideshow on arrow key navigation
    document.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        this.pauseSlideshow();
      }
    });

    // Reset slide show when the album changes
    this.addEventListener(window, "albumChanged", () => {
      this.resetAllSlides();
    });

    // Reset slide show when the search results change
    this.addEventListener(window, "searchResultsChanged", () => {
      this.resetAllSlides();
    });

    // Handle slideshow mode changes
    this.addEventListener(window, "swiperModeChanged", () => {
      this.resetAllSlides();
    });

    // Navigate to a slide
    this.addEventListener(window, "seekToSlideIndex", (event) => this.seekToSlideIndex(event));
  }

  addDoubleTapHandlersToSlides() {
    if (!this.swiper) {
      return;
    }
    // Attach handlers to all current slides
    this.swiper.slides.forEach((slideEl) => {
      this.attachDoubleTapHandler(slideEl);
    });
    // Attach handler to future slides (if slides are added dynamically)
    this.swiper.on("slideChange", () => {
      this.swiper.slides.forEach((slideEl) => {
        this.attachDoubleTapHandler(slideEl);
      });
    });
  }

  attachDoubleTapHandler(slideEl) {
    if (slideEl.dataset.doubleTapHandlerAttached) {
      return;
    }

    // Double-click (desktop)
    slideEl.addEventListener("dblclick", async () => {
      await toggleGridSwiperView(true);
    });

    // Double-tap (touch devices)
    let lastTap = 0;
    let tapCount = 0;
    let tapTimer = null;

    slideEl.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 1) {
          tapCount++;

          // Only prevent default on the second tap within the double-tap window
          if (tapCount === 2) {
            const now = Date.now();
            if (now - lastTap < 350) {
              e.preventDefault(); // Prevent zoom only on actual double-tap
            }
          }

          // Reset tap count after the double-tap window expires
          clearTimeout(tapTimer);
          tapTimer = setTimeout(() => {
            tapCount = 0;
          }, 350);
        }
      },
      { passive: false }
    );

    slideEl.addEventListener("touchend", async (e) => {
      // Only trigger on single-finger touch
      if (e.touches.length > 0 || (e.changedTouches && e.changedTouches.length > 1)) {
        return;
      }

      const now = Date.now();
      if (now - lastTap < 350) {
        e.preventDefault();
        await toggleGridSwiperView(true);
        lastTap = 0;
        tapCount = 0;
        clearTimeout(tapTimer);
      } else {
        lastTap = now;
      }
    });

    slideEl.dataset.doubleTapHandlerAttached = "true";
  }

  pauseSlideshow() {
    if (this.swiper && this.swiper.autoplay?.running) {
      this.swiper.autoplay.stop();
    }
  }

  resumeSlideshow() {
    if (this.swiper) {
      this.swiper.autoplay.stop();
      setTimeout(() => {
        this.swiper.autoplay.start();
      }, 50);
    }
  }

  /**
   * Select a random slide index that doesn't already exist in the swiper.
   * Tries multiple random selections to avoid duplicates.
   * @returns {{globalIndex: number|null, searchIndex: number|null}} The selected indices
   */
  selectRandomSlideIndex() {
    const totalPool = slideState.isSearchMode ? slideState.searchResults.length : slideState.totalAlbumImages;

    const existingIndices = new Set(Array.from(this.swiper.slides).map((el) => parseInt(el.dataset.globalIndex, 10)));

    // Try to find a random slide that doesn't already exist in the swiper
    // Limit attempts to avoid infinite loop when all slides are already loaded
    const MAX_RANDOM_ATTEMPTS = 50;
    const maxAttempts = Math.min(totalPool, MAX_RANDOM_ATTEMPTS);

    let globalIndex = null;
    let searchIndex = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (slideState.isSearchMode) {
        searchIndex = Math.floor(Math.random() * totalPool);
        globalIndex = slideState.searchToGlobal(searchIndex);
      } else {
        globalIndex = Math.floor(Math.random() * totalPool);
        searchIndex = null;
      }
      // Check for valid globalIndex and that it doesn't already exist
      if (globalIndex !== null && !existingIndices.has(globalIndex)) {
        break;
      }
    }

    return { globalIndex, searchIndex };
  }

  async addSlideByIndex(globalIndex, searchIndex = null, prepend = false, random = null) {
    if (!this.swiper) {
      return;
    }

    // only use random mode when the slideshow is running or when explicitly specified
    const is_random = random !== null ? random : state.mode === "random" && slideShowRunning();

    if (is_random) {
      const selected = this.selectRandomSlideIndex();
      globalIndex = selected.globalIndex;
      searchIndex = selected.searchIndex;
    }

    const exists = Array.from(this.swiper.slides).some((el) => parseInt(el.dataset.globalIndex, 10) === globalIndex);
    if (exists) {
      return;
    }

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
      slide.dataset.reference_images = JSON.stringify(data.reference_images || []);

      // Attach double-tap/double-click handler immediately
      this.attachDoubleTapHandler(slide);

      if (prepend) {
        this.swiper.prependSlide(slide);
      } else {
        this.swiper.appendSlide(slide);
      }
    } catch (error) {
      console.error("Failed to add new slide:", error);
      alert(`Failed to add new slide: ${error.message}`);
      return;
    }
  }

  async handleSlideChange() {
    const { globalIndex } = slideState.getCurrentSlide();
    const slideEls = this.swiper.slides;
    let activeIndex = Array.from(slideEls).findIndex((el) => parseInt(el.dataset.globalIndex, 10) === globalIndex);
    if (activeIndex === -1) {
      activeIndex = 0;
    }
    const activeSlide = slideEls[activeIndex];
    if (activeSlide) {
      const globalIndex = parseInt(activeSlide.dataset.globalIndex, 10) || 0;
      const searchIndex = parseInt(activeSlide.dataset.searchIndex, 10) || 0;
      slideState.updateFromExternal(globalIndex, searchIndex);
    }
    updateMetadataOverlay(this.currentSlide());
  }

  removeSlidesAfterCurrent() {
    if (!this.swiper) {
      return;
    }
    const { globalIndex } = slideState.getCurrentSlide();
    const slideEls = this.swiper.slides;
    let activeIndex = Array.from(slideEls).findIndex((el) => parseInt(el.dataset.globalIndex, 10) === globalIndex);
    if (activeIndex === -1) {
      activeIndex = 0;
    }
    const slidesToRemove = slideEls.length - activeIndex - 1;
    if (slidesToRemove > 0) {
      this.swiper.removeSlide(activeIndex + 1, slidesToRemove);
    }
    setTimeout(() => this.enforceHighWaterMark(), 500);
  }

  currentSlide() {
    if (!this.swiper) {
      return null;
    }
    return this.swiper.slides[this.swiper.activeIndex] || null;
  }

  // The random_nextslide parameter is a hack that will make the preloaded next slide a random one
  // It is a hack that should be fixed.
  async resetAllSlides(random_nextslide = false) {
    if (!this.swiper) {
      return;
    }

    const slideShowRunning = this.swiper.autoplay?.running;
    this.pauseSlideshow();
    this.swiper.removeAllSlides();

    const { globalIndex, searchIndex } = slideState.getCurrentSlide();

    const swiperContainer = document.getElementById("singleSwiper");
    if (swiperContainer) {
      swiperContainer.style.visibility = "hidden";
    }

    // Add previous slide if available
    const { globalIndex: prevGlobal, searchIndex: prevSearch } = slideState.resolveOffset(-1);
    if (prevGlobal !== null) {
      await this.addSlideByIndex(prevGlobal, prevSearch, false, random_nextslide);
    }

    // Add current slide
    await this.addSlideByIndex(globalIndex, searchIndex);

    // Add next slide if available
    const { globalIndex: nextGlobal, searchIndex: nextSearch } = slideState.resolveOffset(1);
    if (nextGlobal !== null) {
      await this.addSlideByIndex(nextGlobal, nextSearch, false, random_nextslide);
    }

    // Navigate to the current slide
    const slideIndex = prevGlobal !== null ? 1 : 0;
    this.swiper.slideTo(slideIndex, 0);

    await new Promise(requestAnimationFrame);
    if (swiperContainer) {
      swiperContainer.style.visibility = "";
    }

    updateMetadataOverlay(this.currentSlide());
    if (slideShowRunning) {
      this.resumeSlideshow();
    }

    setTimeout(() => updateCurrentImageMarker(window.umapPoints), 500);
  }

  enforceHighWaterMark(backward = false) {
    const maxSlides = state.highWaterMark || 50;
    const swiper = this.swiper;
    const slides = swiper.slides.length;

    if (slides > maxSlides) {
      const slideShowRunning = swiper.autoplay.running;
      this.pauseSlideshow();

      if (backward) {
        swiper.removeSlide(swiper.slides.length - 1);
      } else {
        swiper.removeSlide(0);
      }

      if (slideShowRunning) {
        this.resumeSlideshow();
      }
    }
  }

  async seekToSlideIndex(event) {
    let { globalIndex } = event.detail;
    const isSearchMode = event.detail.isSearchMode;
    const searchIndex = event.detail.searchIndex;
    const totalCount = event.detail.totalCount || slideState.totalAlbumImages;

    if (isSearchMode) {
      globalIndex = slideState.searchToGlobal(searchIndex);
    }

    let slideEls = this.swiper.slides;
    const exists = Array.from(slideEls).some((el) => parseInt(el.dataset.globalIndex, 10) === globalIndex);
    if (exists) {
      const targetSlideIdx = Array.from(slideEls).findIndex(
        (el) => parseInt(el.dataset.globalIndex, 10) === globalIndex
      );
      if (targetSlideIdx !== -1) {
        this.isInternalSlideChange = true;
        this.swiper.slideTo(targetSlideIdx, 300);
        this.isInternalSlideChange = false;
        updateMetadataOverlay(this.currentSlide());
        return;
      }
    }

    this.swiper.removeAllSlides();

    let origin = -2;
    const slides_to_add = 5;
    if (globalIndex + origin < 0) {
      origin = 0;
    }

    const swiperContainer = document.getElementById("singleSwiper");
    swiperContainer.style.visibility = "hidden";

    for (let i = origin; i < slides_to_add; i++) {
      if (searchIndex + i >= totalCount) {
        break;
      }
      if (globalIndex + i < 0) {
        continue;
      }
      if (globalIndex + i >= slideState.totalAlbumImages) {
        break;
      }
      await this.addSlideByIndex(globalIndex + i, searchIndex + i, false, false);
    }

    slideEls = this.swiper.slides;
    let targetSlideIdx = Array.from(slideEls).findIndex((el) => parseInt(el.dataset.globalIndex, 10) === globalIndex);
    if (targetSlideIdx === -1) {
      targetSlideIdx = 0;
    }
    this.swiper.slideTo(targetSlideIdx, 0);

    swiperContainer.style.visibility = "visible";
    updateMetadataOverlay(this.currentSlide());
  }
}
