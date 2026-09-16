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
import { applyVideoOverlay } from "./video-badge.js";

// How long to wait after an append/prepend before trimming the buffer. Long
// enough for Swiper's default 300ms transition to finish, so the trim's
// internal slideTo() never lands mid-animation.
const TRIM_DELAY_MS = 500;

// How many times a deferred trim will stand aside for an in-flight gesture
// before trimming anyway. This is the backstop for an ``animating`` flag that
// never clears — at which point a trim that is slightly visible beats a buffer
// that grows without limit.
const TRIM_MAX_RETRIES = 4;

// How far over the high-water mark the buffer may drift while a trim waits for
// a quiet moment. Sustained fast swiping keeps ``animating`` true almost
// continuously — measured against the real app, waiting politely let a 20-slide
// cap reach 39 before the retries ran out — so past this margin the trim stops
// waiting. Clipping the tail of a transition the user is already swiping past
// is cheaper than holding another dozen full-resolution bitmaps.
const TRIM_HARD_MARGIN = 5;

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
    this._resetPendingRandom = false; // random_nextslide requested by the queued reset

    // Set while trimBuffer is restarting autoplay after a trim, so the
    // autoplay event handlers don't flicker the play/pause icon (see below).
    this._suppressAutoplayIcon = false;

    // Deferred buffer trim. At most one is ever pending: trims are idempotent
    // and a later one subsumes an earlier one, so a second advance arriving
    // while a trim is queued just updates which end to drop from rather than
    // pushing the deadline back — otherwise fast, continuous swiping would
    // re-arm the timer forever and never actually trim.
    this._trimTimer = null;
    this._trimEnd = "front";

    // The slideshow's *logical* run state — what the user asked for — as
    // distinct from swiper.autoplay.running, which rebuilds and trims stop and
    // restart internally. resumeSlideshow() sets it; pauseSlideshow() and any
    // Swiper-initiated stop (a swipe or keypress with disableOnInteraction)
    // clear it via the autoplayStop handler. (stopOnLastSlide does not emit
    // autoplayStop — it just skips the wrap — so the end of the list is
    // handled by the explicit pauseSlideshow() in slideNextTransitionStart.)
    // Internal
    // stops are bracketed with _internalAutoplayStop so that handler ignores
    // them. This is what lets a rebuild that finishes after the user pressed
    // Pause stay paused, and one that finishes while they still want the
    // slideshow running restart it — without either party having to guess
    // from autoplay.running, which is false for the whole rebuild.
    this.slideshowActive = false;
    this._internalAutoplayStop = false;

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

    // trimBuffer stops+restarts autoplay internally (see its comment); that
    // churn would otherwise flip the play/pause icon on nearly every shuffle
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
    this.swiper.on("autoplayStop", () => {
      // Swiper stops autoplay itself on user interaction (disableOnInteraction:
      // a swipe, a keypress, a mousewheel move). That is the user's doing, so
      // drop the logical run state — but not for our own internal stops, which
      // are bracketed with _internalAutoplayStop.
      if (!this._internalAutoplayStop) {
        this.slideshowActive = false;
      }
      refreshSlideshowIcon();
    });
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
          // Every advance appends a slide, so every advance has to pay for one.
          // This covers manual swiping and the linear slideshow as well as
          // shuffle: the append above is the same code for all three, and the
          // buffer grows just as fast whichever of them is driving it.
          this._scheduleTrim("front");
        };

        // Shuffle mode has no "end of list": the next slide is a random pick,
        // not the one after the current index. addSlideByIndex(null, null)
        // selects a random slide internally when the slideshow is running in
        // random mode. We must NOT consult resolveOffset here — it reports null
        // whenever the current random slide happens to be the last album index,
        // which would otherwise stop the shuffle slideshow prematurely.
        const isRandom = state.mode === "random" && slideShowRunning();
        if (isRandom) {
          this.addSlideByIndex(null, null).then(finishAppend).catch(finishAppend);
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
          const finishPrepend = () => {
            this.isPrepending = false;
            this.swiper.allowSlidePrev = true;
            // Backing up grows the buffer at the head, so the stale slides are
            // the ones at the tail — the far end of wherever the user came from.
            this._scheduleTrim("back");
          };
          this.addSlideByIndex(prevGlobal, prevSearch, true)
            .then(() => {
              this.swiper.slideTo(1, 0);
              finishPrepend();
            })
            .catch(finishPrepend);
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
    // Slides added later get their handler at construction time, in
    // addSlideByIndex — which covers every path that creates one. This only has
    // to cover slides that already exist when the manager is initialized.
    //
    // There used to be a "slideChange" sweep here re-checking every slide on
    // every advance. It was redundant, and its cost grew with the buffer: it
    // ran the full list on each swipe, which is the wrong direction of travel
    // for a view whose whole problem was per-swipe work piling up.
    this.swiper.slides.forEach((slideEl) => {
      this.attachDoubleTapHandler(slideEl);
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

  /** The user's intent: true from resumeSlideshow() until pauseSlideshow()
   *  or a Swiper-initiated stop. Unlike swiper.autoplay.running this stays
   *  true across the internal stop/start of a rebuild or trim. */
  isSlideshowActive() {
    return this.slideshowActive;
  }

  pauseSlideshow() {
    this.slideshowActive = false;
    if (this.swiper && this.swiper.autoplay?.running) {
      this.swiper.autoplay.stop();
    }
  }

  resumeSlideshow() {
    if (!this.swiper) {
      return;
    }
    this.slideshowActive = true;
    // A rebuild in progress has stopped autoplay and will restart it when it
    // finishes (see resetAllSlides), provided the slideshow is still wanted
    // then. Starting here as well would run autoplay against a half-built
    // buffer, and would restart a slideshow the user pauses before the
    // rebuild completes.
    if (this._resetInFlight) {
      return;
    }
    this._startAutoplay();
  }

  // Start (or restart) autoplay without touching the logical run state. Used
  // by resumeSlideshow and by the rebuild/trim paths that stopped autoplay
  // internally and need to bring it back.
  _startAutoplay() {
    if (!this.swiper) {
      return;
    }
    // stopOnLastSlide is a *linear-mode* backstop only (see the autoplay
    // config comment). Shuffle has no end of list: its look-ahead append
    // keeps a slide past the active one, but once trimBuffer starts
    // dropping front slides at the high-water mark the index churn can briefly
    // expose Swiper's isEnd, and a global stopOnLastSlide would then freeze
    // autoplay (the "pauses after the 18th shuffled image" regression). Keep
    // it off whenever we're starting in random mode.
    this.swiper.params.autoplay.stopOnLastSlide = state.mode !== "random";
    this._stopAutoplayInternal();
    setTimeout(() => {
      // The user may have paused during the 50ms; a stale timer must not undo
      // that. And if a rebuild has started meanwhile, leave the start to the
      // rebuild's runner: autoplay running against a half-built buffer would
      // be stopped again by the rebuild's own slideTo — outside our internal
      // bracket, so it would read as a user pause and the slideshow would end
      // up stopped.
      if (this.slideshowActive && !this._resetInFlight) {
        this.swiper.autoplay.start();
      }
    }, 50);
  }

  // Stop autoplay for our own bookkeeping (rebuild, trim, restart) without it
  // counting as the user pausing. Swiper emits autoplayStop synchronously from
  // stop(), so the bracket only needs to cover the call.
  _stopAutoplayInternal() {
    if (!this.swiper?.autoplay) {
      return;
    }
    this._internalAutoplayStop = true;
    try {
      this.swiper.autoplay.stop();
    } finally {
      this._internalAutoplayStop = false;
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

      // src and alt are assigned as properties rather than interpolated into
      // the markup. A filename is user-controlled and needs only a double
      // quote to escape the attribute: `evil" onerror="…` renders as a live
      // event handler. Setting them on the element cannot inject anything,
      // whatever the name contains.
      if (this.hasTouchCapability) {
        slide.innerHTML = `
          <div class="swiper-zoom-container">
            <img />
          </div>
       `;
      } else {
        slide.innerHTML = `
          <img />
        `;
      }
      const poster = slide.querySelector("img");
      poster.src = url;
      poster.alt = data.filename || "";

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
      slide.dataset.mediaType = data.media_type || "image";
      slide.dataset.videoUrl = data.video_url || "";

      // Draws the play/duration/fps badge over the still. No-ops for images.
      // Applied here, at slide construction, rather than in a later sweep:
      // slides are also created by prependSlide, _doResetAllSlides and
      // seekToSlideIndex, and a badge added by a separate pass would be
      // missing on all of those paths.
      applyVideoOverlay(slide, data);

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
    this._scheduleTrim("front");
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
      // The coalesced re-pass must honour the *latest* caller's request, not
      // the one that started the in-flight rebuild. Otherwise a Play press in
      // shuffle mode (random_nextslide=true) followed by a switch to
      // sequential (false) would re-run with true and deal random neighbors
      // into a buffer the caller asked to have in album order.
      this._resetPendingRandom = random_nextslide;
      try {
        await this._resetInFlight;
      } catch {
        // Errors are logged by the underlying rebuild; don't propagate.
      }
      return;
    }

    const runner = (async () => {
      let random = random_nextslide;
      try {
        do {
          this._resetPending = false;
          await this._doResetAllSlides(random);
          random = this._resetPendingRandom;
        } while (this._resetPending);
        // Each pass stopped autoplay internally. Restart it once, after the
        // last pass, if the user still wants the slideshow running — a
        // pauseSlideshow() during the rebuild clears slideshowActive and so
        // leaves it stopped; a resumeSlideshow() during the rebuild sets it
        // and is honoured here rather than starting against a half-built
        // buffer.
        if (this.slideshowActive) {
          this._startAutoplay();
        }
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

    // Stop autoplay for the rebuild without recording a user pause; the
    // resetAllSlides runner restarts it afterwards if the slideshow is still
    // wanted.
    this._stopAutoplayInternal();

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

      // Navigate to the current slide. Swiper's autoplay treats this
      // programmatic move like a user interaction and stops itself if it is
      // running; that would be our doing, not the user's.
      const slideIndex = prevGlobal !== null ? 1 : 0;
      this._internalAutoplayStop = true;
      try {
        this.swiper.slideTo(slideIndex, 0);
      } finally {
        this._internalAutoplayStop = false;
      }

      await new Promise(requestAnimationFrame);
      if (swiperContainer) {
        swiperContainer.style.visibility = "";
      }

      updateMetadataOverlay(this.currentSlide());

      setTimeout(() => updateCurrentImageMarker(window.umapPoints), 500);
      window.dispatchEvent(new CustomEvent("slidesReset"));
    } finally {
      this.isInternalSlideChange = false;
    }
  }

  /**
   * Queue a buffer trim for once the current transition has settled.
   *
   * removeSlide() moves the buffer under Swiper's feet — it calls slideTo()
   * internally — so running it during a swipe would produce exactly the stutter
   * the trimming exists to prevent. We therefore stand aside while a gesture or
   * transition is in flight and re-arm, rather than trimming on the spot.
   *
   * Only one trim is ever pending. A second advance arriving while one is
   * queued updates which end to drop from but does NOT push the deadline back:
   * re-arming on every advance would mean continuous swiping never reaches a
   * quiet moment, and the buffer would grow unchecked for as long as the user
   * kept going — the bug this is here to fix.
   *
   * @param {"front"|"back"} end - which end of the buffer to drop slides from.
   */
  /** Slides the buffer is allowed to hold. The 50 is a fallback for a
   *  highWaterMark that was never set; state.js defaults it to 20. */
  _maxSlides() {
    return state.highWaterMark || 50;
  }

  _scheduleTrim(end) {
    this._trimEnd = end;
    if (this._trimTimer) {
      return;
    }
    let retriesLeft = TRIM_MAX_RETRIES;
    const attempt = () => {
      this._trimTimer = null;
      if (!this.swiper || this.swiper.destroyed) {
        return;
      }
      // A rebuild rewrites the whole buffer and sizes it itself, so a trim
      // landing in the middle of one would be operating on slides that are
      // about to be thrown away — and could remove the slide the rebuild is
      // navigating to.
      const busy =
        this.swiper.animating ||
        this.swiper.touchEventsData?.isTouched ||
        this.isAppending ||
        this.isPrepending ||
        this._resetInFlight;
      // A rebuild is the one thing worth waiting out however far the buffer has
      // drifted: it is about to replace the whole buffer anyway, and trimming
      // underneath it could remove the slide it is navigating to.
      const overshoot = this.swiper.slides.length - this._maxSlides();
      const mustTrim = overshoot >= TRIM_HARD_MARGIN && !this._resetInFlight;
      if (busy && !mustTrim && retriesLeft > 0) {
        retriesLeft -= 1;
        this._trimTimer = setTimeout(attempt, TRIM_DELAY_MS);
        return;
      }
      if (this._resetInFlight) {
        this._trimTimer = setTimeout(attempt, TRIM_DELAY_MS);
        return;
      }
      this.trimBuffer(this._trimEnd);
    };
    this._trimTimer = setTimeout(attempt, TRIM_DELAY_MS);
  }

  /**
   * Keep the slide buffer bounded at ``state.highWaterMark``.
   *
   * Every forward advance appends a full-resolution slide and every backward
   * advance prepends one (see the slideNextTransitionStart and
   * slidePrevTransitionEnd handlers), so without a trim the DOM grows for as
   * long as the user keeps navigating. That is not a slow leak: each slide
   * holds an original-size <img>, and on a tablet a few dozen decoded bitmaps
   * are enough to push the browser into evicting and re-decoding them
   * mid-transition. The swipe animation turns visibly jerky after roughly
   * ``highWaterMark`` advances and stays that way until something rebuilds the
   * buffer — which is why toggling to grid view and back used to "fix" it.
   *
   * Which end to drop from follows the direction of travel: after an append the
   * active slide and its look-ahead sit at the tail, so the oldest front slides
   * are dead weight; after a prepend they sit at the head. Either way we stop
   * short of the active slide and one neighbour, so what is on screen — or one
   * swipe away — is never removed.
   *
   * swiper.removeSlide() internally calls slideTo(), which emits
   * beforeTransitionStart; Swiper's autoplay treats that programmatic move like
   * a user interaction and (with disableOnInteraction) *stops* autoplay. So a
   * trim would silently kill a running slideshow. We restart autoplay
   * afterwards if it was running, muted via _suppressAutoplayIcon so the
   * stop/start doesn't flicker the play/pause icon on every advance (shuffle
   * trims on nearly every slide).
   *
   * All the indexes go to removeSlide in a single call: it does one
   * recalcSlides + update + slideTo for the whole batch, so a trim costs one
   * layout pass and one autoplay stop however many slides it drops.
   *
   * @param {"front"|"back"} end - which end of the buffer to drop slides from.
   */
  trimBuffer(end = "front") {
    if (!this.swiper) {
      return;
    }
    const maxSlides = this._maxSlides();
    const total = this.swiper.slides.length;
    if (total <= maxSlides) {
      return;
    }

    // ``excess`` is what we would like to drop; ``budget`` is what we can drop
    // from this end without eating into the active slide and its neighbour.
    const activeIndex = this.swiper.activeIndex;
    const excess = total - maxSlides;
    const budget = end === "back" ? total - (activeIndex + 2) : activeIndex - 1;
    const count = Math.min(excess, budget);
    if (count <= 0) {
      return;
    }

    // removeSlide() reads swiper.slides once, before detaching anything, so
    // these indexes all refer to the pre-trim buffer and stay valid across the
    // batch whichever order they come in.
    const indexes =
      end === "back"
        ? Array.from({ length: count }, (_, i) => total - 1 - i)
        : Array.from({ length: count }, (_, i) => i);

    const wasRunning = this.swiper.autoplay?.running;
    // removeSlide's implicit autoplay stop is our doing, not the user's, so it
    // must not clear the logical run state either.
    this._suppressAutoplayIcon = true;
    this._internalAutoplayStop = true;
    try {
      this.swiper.removeSlide(indexes);
      if (wasRunning && this.swiper.autoplay && !this.swiper.autoplay.running) {
        this.swiper.autoplay.start();
      }
    } finally {
      this._suppressAutoplayIcon = false;
      this._internalAutoplayStop = false;
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
