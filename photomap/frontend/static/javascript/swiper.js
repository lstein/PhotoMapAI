// swiper.js
// This file initializes the Swiper instance and manages slide transitions.
import { albumManager } from "./album-manager.js";
import { toggleGridSwiperView } from "./events.js";
import { updateMetadataOverlay } from "./metadata-drawer.js";
import { fetchImageByIndex } from "./search.js";
import { slideState } from "./slide-state.js";
import { slideShowRunning, updateSlideshowButtonIcon } from "./slideshow.js";
import { state } from "./state.js";
import { updateCurrentImageMarker } from "./umap.js";
import { showToast } from "./utils.js";

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

    // Shuffle-mode "bag": every image is dealt once per cycle in random order,
    // then the bag is refilled and reshuffled for a fresh order. This is what
    // lets shuffle run indefinitely even on tiny albums — avoiding
    // already-loaded slides would otherwise leave nothing to pick once all
    // images are in the buffer, stalling the slideshow on the last slide.
    this.shuffleBag = []; // iteration indices not yet dealt this cycle
    this.shuffleBagPool = 0; // pool size the current bag was built for
    this.lastShuffleIterIndex = null; // last index dealt, to avoid an immediate repeat across cycles

    // Single-flight gate for resetAllSlides. albumChanged, searchResultsChanged,
    // and swiperModeChanged can all fire in quick succession (e.g. switching
    // album while a search is in flight). Without coordination, two concurrent
    // resets each call removeAllSlides + addSlideByIndex + slideTo and race
    // for the DOM. ``_resetInFlight`` holds the active rebuild and
    // ``_resetPending`` records that another reset is queued; we coalesce so
    // at most one rebuild runs at a time and a second is run once on top of
    // the latest slideState.
    this._resetInFlight = null;
    this._resetPending = false;

    // Set while trimShuffleBacklog is restarting autoplay after a trim, so the
    // autoplay event handlers don't flicker the play/pause icon (see below).
    this._suppressAutoplayIcon = false;

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
        // Backstop for the "start the slideshow while already parked on the
        // last slide" case, where no slideNextTransitionStart fires for us to
        // intercept. Swiper's autoplay otherwise defaults this to false and, on
        // reaching the end with loop off, calls slideTo(0) — jumping to the
        // first slide of the in-memory buffer (a windowed subset, not the
        // album's first image). The primary end-of-list handling lives in the
        // slideNextTransitionStart handler below, which stops autoplay the
        // instant resolveOffset(+1) reports there is no next slide.
        //
        // This applies to *linear* mode only. resumeSlideshow() flips it off
        // for shuffle mode, which has no end of list and must never auto-stop
        // at a buffer boundary. We default it on here so a linear slideshow
        // started before resumeSlideshow ever runs still has the backstop.
        stopOnLastSlide: true,
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

    // trimShuffleBacklog stops+restarts autoplay internally (see its comment);
    // that churn would otherwise flip the play/pause icon on nearly every shuffle
    // advance, so it sets _suppressAutoplayIcon to mute these handlers while it
    // works. The slideshow's true running state is unchanged across a trim.
    const refreshSlideshowIcon = () => {
      if (this._suppressAutoplayIcon) {
        return;
      }
      if (!state.gridViewActive) {
        updateSlideshowButtonIcon();
      }
    };

    this.swiper.on("autoplayStart", refreshSlideshowIcon);
    this.swiper.on("autoplayResume", refreshSlideshowIcon);
    this.swiper.on("autoplayStop", refreshSlideshowIcon);
    this.swiper.on("autoplayPause", refreshSlideshowIcon);

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

        const finishAppend = () => {
          this.isAppending = false;
          this.swiper.allowSlideNext = true;
        };

        // Shuffle mode has no "end of list": the next slide is a random pick,
        // not the one after the current index. addSlideByIndex(null, null)
        // selects a random slide internally when the slideshow is running in
        // random mode. We must NOT consult resolveOffset here — it reports null
        // whenever the current random slide happens to be the last album index,
        // which would otherwise stop the shuffle slideshow prematurely.
        const isRandom = state.mode === "random" && slideShowRunning();
        if (isRandom) {
          const finishRandomAppend = () => {
            finishAppend();
            // Re-dealing images across shuffle cycles would grow the DOM without
            // bound, so drop the oldest slides once we exceed the high-water
            // mark. Deferred so it runs after the in-progress transition settles.
            setTimeout(() => this.trimShuffleBacklog(), 500);
          };
          this.addSlideByIndex(null, null).then(finishRandomAppend).catch(finishRandomAppend);
          return;
        }

        const { globalIndex: nextGlobal, searchIndex: nextSearch } = slideState.resolveOffset(+1);

        if (nextGlobal !== null) {
          this.addSlideByIndex(nextGlobal, nextSearch).then(finishAppend).catch(finishAppend);
        } else {
          finishAppend();
          // resolveOffset(+1) returned null: in linear mode we have just landed
          // on the genuine last item with wrap navigation off (it only returns
          // null at the end of the list — wrap mode always resolves to a real
          // index). Nothing gets appended, so the active slide is now the last
          // loaded one and Swiper considers itself at the end. Stop autoplay
          // here so the slideshow rests on this final slide. If we left autoplay
          // running, its next tick would see isEnd and call slideTo(0), snapping
          // back to the first slide still held in the windowed buffer (~10 back).
          this.pauseSlideshow();
        }
      }
    });

    this.swiper.on("slidePrevTransitionEnd", () => {
      if (this.swiper.activeIndex === 0) {
        const { globalIndex: prevGlobal, searchIndex: prevSearch } = slideState.resolveOffset(-1);
        if (prevGlobal !== null) {
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

    // (Arrow-key pause lives in events.js's KEYBOARD_SHORTCUTS table —
    // events.js owns global shortcuts per the CLAUDE.md contract.)

    // Reset slide show when the album, search results, or mode changes.
    // All three go through the single-flight resetAllSlides so they coalesce
    // instead of racing for the DOM if more than one fires in the same tick.
    this.addEventListener(window, "albumChanged", () => {
      this.resetAllSlides();
    });
    this.addEventListener(window, "searchResultsChanged", () => {
      this.resetAllSlides();
    });
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
      // stopOnLastSlide is a *linear-mode* backstop only (see the autoplay
      // config comment). Shuffle has no end of list: its look-ahead append
      // keeps a slide past the active one, but once trimShuffleBacklog starts
      // dropping front slides at the high-water mark the index churn can briefly
      // expose Swiper's isEnd, and a global stopOnLastSlide would then freeze
      // autoplay (the "pauses after the 18th shuffled image" regression). Keep
      // it off whenever we're starting in random mode.
      this.swiper.params.autoplay.stopOnLastSlide = state.mode !== "random";
      this.swiper.autoplay.stop();
      setTimeout(() => {
        this.swiper.autoplay.start();
      }, 50);
    }
  }

  /**
   * Deal the next slide for shuffle mode from a reshuffling "bag".
   *
   * Each image is dealt exactly once per cycle in a random order; when the bag
   * empties it is refilled and reshuffled, so every pass through the album uses
   * a fresh order and the slideshow never runs out of slides to show. The
   * index is an "iteration index": a search-results index in search mode, or a
   * global album index otherwise — matching slideState.getCurrentIndex().
   *
   * @returns {{globalIndex: number|null, searchIndex: number|null}} The selected indices
   */
  selectRandomSlideIndex() {
    const pool = slideState.isSearchMode ? slideState.searchResults.length : slideState.totalAlbumImages;
    if (!pool || pool <= 0) {
      return { globalIndex: null, searchIndex: null };
    }

    // Refill + reshuffle when the bag empties (new cycle) or the album/search
    // pool changes underneath us (album switch, search results changed).
    const poolChanged = this.shuffleBagPool !== pool;
    if (this.shuffleBag.length === 0 || poolChanged) {
      if (poolChanged) {
        this.lastShuffleIterIndex = null;
      }
      this.shuffleBag = Array.from({ length: pool }, (_, i) => i);
      this.shuffleBagPool = pool;

      // Fisher-Yates shuffle.
      for (let i = this.shuffleBag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.shuffleBag[i], this.shuffleBag[j]] = [this.shuffleBag[j], this.shuffleBag[i]];
      }

      // Avoid showing the same image twice in a row across a cycle boundary. The
      // bag is dealt from the end (pop), so if the last entry repeats the image
      // currently on screen, swap it to the front of the bag (dealt last).
      const avoidIter = this.lastShuffleIterIndex !== null ? this.lastShuffleIterIndex : slideState.getCurrentIndex();
      const lastPos = this.shuffleBag.length - 1;
      if (pool > 1 && this.shuffleBag[lastPos] === avoidIter) {
        [this.shuffleBag[0], this.shuffleBag[lastPos]] = [this.shuffleBag[lastPos], this.shuffleBag[0]];
      }
    }

    const iterIndex = this.shuffleBag.pop();
    this.lastShuffleIterIndex = iterIndex;

    if (slideState.isSearchMode) {
      return { globalIndex: slideState.searchToGlobal(iterIndex), searchIndex: iterIndex };
    }
    return { globalIndex: iterIndex, searchIndex: null };
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
      if (globalIndex === null) {
        return;
      }
      // No buffer-duplicate guard here: the shuffle bag already guarantees each
      // image is dealt once per cycle, and re-dealing an image on a later cycle
      // (so it can be shown again) is the whole point. An image already in the
      // windowed buffer from an earlier cycle is therefore an intentional repeat.
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
      // Surface the failure via the toast UI instead of a blocking
      // ``alert()``. Common trigger: backend went away mid-session, so
      // every slide-fetch fails until the server comes back; modal
      // dialogs make that scenario unusable. The catch around the
      // upstream search request shows its own toast, so during a search
      // the user may see two stacked toasts — one for the search call,
      // one for the slide retrieval — but neither blocks the UI.
      console.error("Failed to add new slide:", error);
      const detail = error?.body?.detail ?? error?.message ?? "Unknown error";
      showToast(`Failed to load image: ${detail}`, {
        level: "error",
        duration: 8000,
      });
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
    // Single-flight: if a rebuild is already running, mark that we want
    // another rebuild after it finishes and await the eventual completion.
    // Otherwise kick off a rebuild that loops until no further reset is
    // pending. Coalescing this way means three quickly-fired events become
    // at most two sequential rebuilds — one in flight, one that catches the
    // latest slideState afterwards.
    if (this._resetInFlight) {
      this._resetPending = true;
      try {
        await this._resetInFlight;
      } catch {
        // Errors are logged by the underlying rebuild; don't propagate.
      }
      return;
    }

    const runner = (async () => {
      try {
        do {
          this._resetPending = false;
          await this._doResetAllSlides(random_nextslide);
        } while (this._resetPending);
      } finally {
        this._resetInFlight = null;
      }
    })();
    this._resetInFlight = runner;
    await runner;
  }

  async _doResetAllSlides(random_nextslide = false) {
    if (!this.swiper) {
      return;
    }

    const slideShowRunning = this.swiper.autoplay?.running;
    this.pauseSlideshow();

    // Suppress the swiper.slideChange handler for the duration of the
    // rebuild. The first appendSlide after removeAllSlides moves activeIndex
    // onto the just-added prev slide, which fires slideChange; without
    // suppression, the handler writes that prev slide's globalIndex back
    // into slideState, and the resolveOffset(+1) call below then resolves
    // to the *original* current globalIndex — duplicating it as the "next"
    // slide. (seekToSlideIndex's rebuild path is suppressed the same way.)
    this.isInternalSlideChange = true;
    try {
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
      window.dispatchEvent(new CustomEvent("slidesReset"));
    } finally {
      this.isInternalSlideChange = false;
    }
  }

  /**
   * Keep the shuffle buffer bounded. The active slide and its single look-ahead
   * live at the tail, so dropping the oldest (front) slides never disturbs what
   * is on screen or about to be shown.
   *
   * swiper.removeSlide() internally calls slideTo(), which emits
   * beforeTransitionStart; Swiper's autoplay treats that programmatic move like
   * a user interaction and (with disableOnInteraction) *stops* autoplay. So the
   * very first trim — when the buffer first exceeds the high-water mark, ~18
   * slides into a shuffle run — would silently kill the slideshow. We therefore
   * restart autoplay after trimming, mirroring enforceHighWaterMark. The
   * stop+restart is muted via _suppressAutoplayIcon so it doesn't flicker the
   * play/pause icon on every advance (shuffle trims on nearly every slide).
   */
  trimShuffleBacklog() {
    if (!this.swiper) {
      return;
    }
    const maxSlides = state.highWaterMark || 50;
    if (this.swiper.slides.length <= maxSlides) {
      return;
    }
    const wasRunning = this.swiper.autoplay?.running;
    this._suppressAutoplayIcon = true;
    try {
      while (this.swiper.slides.length > maxSlides) {
        this.swiper.removeSlide(0);
      }
      if (wasRunning && this.swiper.autoplay && !this.swiper.autoplay.running) {
        this.swiper.autoplay.start();
      }
    } finally {
      this._suppressAutoplayIcon = false;
    }
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

    // Suppress swiper.slideChange while the rebuild is in progress. Without
    // this, the intermediate active-slide transitions during removeAllSlides /
    // appendSlide / slideTo would each invoke updateFromExternal and dispatch
    // slideChanged with transient globalIndex values — none of which represent
    // a slide the user actually viewed. slideState was already set to the
    // target by navigateToIndex's setCurrentIndex, so suppressing here is
    // safe (and mirrors what the nearby branch already does).
    this.isInternalSlideChange = true;
    try {
      this.swiper.removeAllSlides();

      const swiperContainer = document.getElementById("singleSwiper");
      swiperContainer.style.visibility = "hidden";

      // Load a small window of slides centred on the target so the user can
      // immediately swipe a couple of slides in either direction. In
      // search/cluster mode the neighbours are the adjacent *search results*,
      // which are NOT contiguous in global-album index, so each neighbour's
      // global index must be resolved through searchToGlobal. Stepping
      // globalIndex and searchIndex together (the old behaviour) loaded
      // album-adjacent images and tagged the prepended slides with bogus
      // search indices (including negatives), which corrupted the position
      // badge — seeking back to cluster image #1 could show "3", and swiping
      // left showed "0" then "-1".
      const SLIDES_BEFORE = 2;
      const SLIDES_AFTER = 2;

      for (let i = -SLIDES_BEFORE; i <= SLIDES_AFTER; i++) {
        if (isSearchMode) {
          const neighborSearch = searchIndex + i;
          if (neighborSearch < 0 || neighborSearch >= totalCount) {
            continue;
          }
          const neighborGlobal = slideState.searchToGlobal(neighborSearch);
          if (neighborGlobal === null) {
            continue;
          }
          await this.addSlideByIndex(neighborGlobal, neighborSearch, false, false);
        } else {
          const neighborGlobal = globalIndex + i;
          if (neighborGlobal < 0 || neighborGlobal >= slideState.totalAlbumImages) {
            continue;
          }
          await this.addSlideByIndex(neighborGlobal, null, false, false);
        }
      }

      slideEls = this.swiper.slides;
      let targetSlideIdx = Array.from(slideEls).findIndex((el) => parseInt(el.dataset.globalIndex, 10) === globalIndex);
      if (targetSlideIdx === -1) {
        targetSlideIdx = 0;
      }
      this.swiper.slideTo(targetSlideIdx, 0);

      swiperContainer.style.visibility = "visible";
      updateMetadataOverlay(this.currentSlide());
    } finally {
      this.isInternalSlideChange = false;
    }
  }
}
