// Unit tests for slideshow.js
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// Note: We use jest.unstable_mockModule because this is the current recommended approach
// for mocking ES modules in Jest. The "unstable" prefix indicates the API may change,
// but it's the only way to mock modules before they're imported in ESM.
// See: https://jestjs.io/docs/ecmascript-modules#module-mocking-in-esm

// Mock album-manager to prevent DOM errors (it has side effects on import)
jest.unstable_mockModule("../../photomap/frontend/static/javascript/album-manager.js", () => ({
  albumManager: {
    fetchAvailableAlbums: jest.fn(() => Promise.resolve([])),
  },
  checkAlbumIndex: jest.fn(),
}));

// Mock index.js to prevent DOM errors
jest.unstable_mockModule("../../photomap/frontend/static/javascript/index.js", () => ({
  getIndexMetadata: jest.fn(() => Promise.resolve({ filename_count: 0 })),
}));

// Create mocked state
const mockState = {
  single_swiper: null,
  mode: "chronological",
};

// Mock state module before importing slideshow
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: mockState,
  saveSettingsToLocalStorage: jest.fn(),
}));

// Mock umap module
jest.unstable_mockModule("../../photomap/frontend/static/javascript/umap.js", () => ({
  isUmapFullscreen: jest.fn(() => false),
  toggleUmapWindow: jest.fn(),
}));

// Now import the module we want to test
const {
  slideShowRunning,
  updateSlideshowButtonIcon,
  showPlayPauseIndicator,
  removeExistingIndicator,
  toggleSlideshowWithIndicator,
  initializeSlideshowControls,
} = await import("../../photomap/frontend/static/javascript/slideshow.js");

const { state, saveSettingsToLocalStorage } = await import("../../photomap/frontend/static/javascript/state.js");

describe("slideshow.js", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("slideShowRunning", () => {
    it("should return false when single_swiper is null", () => {
      state.single_swiper = null;
      expect(slideShowRunning()).toBe(false);
    });

    it("should return false when swiper is null", () => {
      state.single_swiper = { swiper: null };
      expect(slideShowRunning()).toBe(false);
    });

    it("should return false when autoplay is null", () => {
      state.single_swiper = { swiper: { autoplay: null } };
      expect(slideShowRunning()).toBe(false);
    });

    it("should return false when autoplay is not running", () => {
      state.single_swiper = { swiper: { autoplay: { running: false } }, isSlideshowActive: () => false };
      expect(slideShowRunning()).toBe(false);
    });

    it("should return true when autoplay is running", () => {
      state.single_swiper = { swiper: { autoplay: { running: true } }, isSlideshowActive: () => true };
      expect(slideShowRunning()).toBe(true);
    });
  });

  describe("updateSlideshowButtonIcon", () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="slideshowIcon"></div>
        <button id="startStopSlideshowBtn" title=""></button>
      `;
    });

    it("should show pause icon when slideshow is running", () => {
      state.single_swiper = { swiper: { autoplay: { running: true } }, isSlideshowActive: () => true };
      state.mode = "chronological";

      updateSlideshowButtonIcon();

      const container = document.getElementById("slideshowIcon");
      expect(container.innerHTML).toContain("pauseIcon");
    });

    it("keeps the pause icon while a rebuild has stopped autoplay but the slideshow is active", () => {
      // An album switch mid-slideshow stops autoplay for the rebuild. The
      // icon must follow the user's intent, not the transient autoplay state,
      // or the button flips to Play for a second and then back.
      state.single_swiper = { swiper: { autoplay: { running: false } }, isSlideshowActive: () => true };
      state.mode = "chronological";

      updateSlideshowButtonIcon();

      expect(document.getElementById("slideshowIcon").innerHTML).toContain("pauseIcon");
    });

    it("should show play icon when slideshow is stopped in chronological mode", () => {
      state.single_swiper = { swiper: { autoplay: { running: false } }, isSlideshowActive: () => false };
      state.mode = "chronological";

      updateSlideshowButtonIcon();

      const container = document.getElementById("slideshowIcon");
      expect(container.innerHTML).toContain("playIcon");
    });

    it("should show shuffle icon when slideshow is stopped in random mode", () => {
      state.single_swiper = { swiper: { autoplay: { running: false } }, isSlideshowActive: () => false };
      state.mode = "random";

      updateSlideshowButtonIcon();

      const container = document.getElementById("slideshowIcon");
      expect(container.innerHTML).toContain("shuffleIcon");
    });

    it("should update button title when running in chronological mode", () => {
      state.single_swiper = { swiper: { autoplay: { running: true } }, isSlideshowActive: () => true };
      state.mode = "chronological";

      updateSlideshowButtonIcon();

      const btn = document.getElementById("startStopSlideshowBtn");
      expect(btn.title).toBe("Pause Slideshow (sequential mode)");
    });

    it("should update button title when running in random mode", () => {
      state.single_swiper = { swiper: { autoplay: { running: true } }, isSlideshowActive: () => true };
      state.mode = "random";

      updateSlideshowButtonIcon();

      const btn = document.getElementById("startStopSlideshowBtn");
      expect(btn.title).toBe("Pause Slideshow (shuffle mode)");
    });

    it("should update button title when stopped", () => {
      state.single_swiper = { swiper: { autoplay: { running: false } }, isSlideshowActive: () => false };
      state.mode = "chronological";

      updateSlideshowButtonIcon();

      const btn = document.getElementById("startStopSlideshowBtn");
      expect(btn.title).toBe("Start Slideshow (sequential mode)");
    });

    it("should do nothing if slideshowIcon element does not exist", () => {
      document.body.innerHTML = "";
      expect(() => updateSlideshowButtonIcon()).not.toThrow();
    });

    it("should handle null mode", () => {
      state.single_swiper = { swiper: { autoplay: { running: false } }, isSlideshowActive: () => false };
      state.mode = null;

      updateSlideshowButtonIcon();

      const container = document.getElementById("slideshowIcon");
      expect(container.innerHTML).toContain("playIcon");
    });
  });

  describe("toggleSlideshowWithIndicator (pause path)", () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="slideshowIcon"></div>
        <button id="startStopSlideshowBtn" title=""></button>
      `;
    });

    it("rebuilds the buffer sequentially when pausing a shuffle run", async () => {
      // Regression: after stopping a shuffle slideshow, the swiper buffer is
      // still in random order, so forward/back navigation would walk the
      // leftover shuffle instead of the current image's sequential neighbors.
      const resetAllSlides = jest.fn(() => Promise.resolve());
      const pauseSlideshow = jest.fn();
      state.single_swiper = {
        swiper: { autoplay: { running: true } },
        isSlideshowActive: () => true,
        pauseSlideshow,
        resetAllSlides,
      };
      state.mode = "random";

      await toggleSlideshowWithIndicator();

      expect(pauseSlideshow).toHaveBeenCalled();
      expect(resetAllSlides).toHaveBeenCalled();
    });

    it("pauses rather than starts when autoplay is stopped by a rebuild but the slideshow is active", async () => {
      // An album switch mid-slideshow rebuilds the buffer, which stops autoplay
      // for the duration. Pressing the button then must pause the slideshow,
      // not be mistaken for a Play press that dispatches a start request.
      const resetAllSlides = jest.fn(() => Promise.resolve());
      const pauseSlideshow = jest.fn();
      const resumeSlideshow = jest.fn();
      state.single_swiper = {
        swiper: { autoplay: { running: false } },
        isSlideshowActive: () => true,
        pauseSlideshow,
        resumeSlideshow,
        resetAllSlides,
      };
      state.mode = "chronological";
      const onStart = jest.fn();
      window.addEventListener("slideshowStartRequested", onStart);

      await toggleSlideshowWithIndicator();
      window.removeEventListener("slideshowStartRequested", onStart);

      expect(pauseSlideshow).toHaveBeenCalled();
      expect(resumeSlideshow).not.toHaveBeenCalled();
      expect(onStart).not.toHaveBeenCalled();
    });

    it("does not rebuild the buffer when pausing a sequential run", async () => {
      // Sequential runs already leave an in-order buffer, so no rebuild needed.
      const resetAllSlides = jest.fn(() => Promise.resolve());
      const pauseSlideshow = jest.fn();
      state.single_swiper = {
        swiper: { autoplay: { running: true } },
        isSlideshowActive: () => true,
        pauseSlideshow,
        resetAllSlides,
      };
      state.mode = "chronological";

      await toggleSlideshowWithIndicator();

      expect(pauseSlideshow).toHaveBeenCalled();
      expect(resetAllSlides).not.toHaveBeenCalled();
    });
  });

  describe("showPlayPauseIndicator", () => {
    it("should create indicator element when showing play", () => {
      state.mode = "chronological";

      showPlayPauseIndicator(true);

      const indicator = document.getElementById("fullscreen-indicator");
      expect(indicator).toBeInTheDocument();
      expect(indicator.innerHTML).toBe("▶");
    });

    it("should show shuffle icon in random mode when playing", () => {
      state.mode = "random";

      showPlayPauseIndicator(true);

      const indicator = document.getElementById("fullscreen-indicator");
      expect(indicator.innerHTML).toBe("🔀");
    });

    it("should show pause icon when pausing", () => {
      state.mode = "chronological";

      showPlayPauseIndicator(false);

      const indicator = document.getElementById("fullscreen-indicator");
      expect(indicator.innerHTML).toBe("⏸");
    });

    it("should have fullscreen-playback-indicator class", () => {
      showPlayPauseIndicator(true);

      const indicator = document.getElementById("fullscreen-indicator");
      expect(indicator.classList.contains("fullscreen-playback-indicator")).toBe(true);
    });

    it("should add show class after animation frame", () => {
      showPlayPauseIndicator(true);

      // The indicator should exist and get show class added via requestAnimationFrame
      // We need to check immediately after creation, before the removal timer fires
      const indicator = document.getElementById("fullscreen-indicator");
      expect(indicator).toBeInTheDocument();

      // Run just enough time for requestAnimationFrame but not the full removal
      jest.advanceTimersByTime(100);

      // Check if show class was added (requestAnimationFrame would have run by now)
      expect(indicator.classList.contains("show")).toBe(true);
    });

    it("should remove indicator after timeout", () => {
      showPlayPauseIndicator(true);

      // Run through all timers (requestAnimationFrame + 800ms timeout + 300ms removal)
      jest.advanceTimersByTime(1200);

      const indicator = document.getElementById("fullscreen-indicator");
      expect(indicator).not.toBeInTheDocument();
    });

    it("should remove existing indicator before creating new one", () => {
      // Create first indicator
      showPlayPauseIndicator(true);

      // Create second indicator
      showPlayPauseIndicator(false);

      const indicators = document.querySelectorAll("#fullscreen-indicator");
      expect(indicators.length).toBe(1);
      expect(indicators[0].innerHTML).toBe("⏸");
    });
  });

  describe("removeExistingIndicator", () => {
    it("should remove indicator element if it exists", () => {
      document.body.innerHTML = '<div id="fullscreen-indicator"></div>';

      removeExistingIndicator();

      expect(document.getElementById("fullscreen-indicator")).not.toBeInTheDocument();
    });

    it("should clear timer if one exists", () => {
      showPlayPauseIndicator(true);
      const clearTimeoutSpy = jest.spyOn(global, "clearTimeout");

      removeExistingIndicator();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it("should do nothing if no indicator exists", () => {
      document.body.innerHTML = "";
      expect(() => removeExistingIndicator()).not.toThrow();
    });
  });

  describe("the mode-menu chevron", () => {
    const chevron = () => document.getElementById("slideshowModeMenuBtn");
    const menu = () => document.getElementById("slideshowModeMenu");

    beforeEach(() => {
      // Mirrors control-panel.html: the chevron is a sibling of the play
      // button, inside the shared .icon-with-chevron wrapper.
      document.body.innerHTML = `
        <div class="icon-with-chevron">
          <button id="startStopSlideshowBtn" title=""><span id="slideshowIcon"></span></button>
          <button id="slideshowModeMenuBtn" class="menu-chevron" title="Slideshow mode"></button>
        </div>
      `;
      state.single_swiper = { swiper: { autoplay: { running: false } }, isSlideshowActive: () => false };
      state.mode = "chronological";
      initializeSlideshowControls();
    });

    it("opens the mode menu on a plain left-click", () => {
      chevron().click();
      expect(menu()).not.toBeNull();
      expect(menu().textContent).toContain("Sequential");
      expect(menu().textContent).toContain("Shuffled");
    });

    it("closes the menu when clicked a second time", () => {
      chevron().click();
      chevron().click();
      expect(menu()).toBeNull();
    });

    it("places the menu clear of the chevron that opened it", () => {
      // The control panel is pinned to the bottom of the window, so a menu
      // merely flipped up off the bottom edge lands on top of the chevron —
      // and the click meant to close it hits a mode button, silently changing
      // and persisting the mode. jsdom has no layout, so supply the geometry.
      const MENU_HEIGHT = 88;
      const chevronRect = { top: 727, bottom: 767, left: 300, right: 324, width: 24, height: 40 };
      jest.spyOn(chevron(), "getBoundingClientRect").mockReturnValue(chevronRect);
      const heightSpy = jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(MENU_HEIGHT);
      window.innerHeight = 800;

      chevron().click();
      const top = parseFloat(menu().style.top);
      heightSpy.mockRestore();

      expect(top + MENU_HEIGHT).toBeLessThanOrEqual(chevronRect.top);
    });

    it("does not change the mode when the chevron is clicked twice", () => {
      // The end-to-end shape of the bug above: open, then click the chevron
      // again to close. If the menu covers the chevron the second click lands
      // on "Sequential" and flips the user's shuffle setting.
      const MENU_HEIGHT = 88;
      const chevronRect = { top: 727, bottom: 767, left: 300, right: 324, width: 24, height: 40 };
      jest.spyOn(chevron(), "getBoundingClientRect").mockReturnValue(chevronRect);
      const heightSpy = jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(MENU_HEIGHT);
      window.innerHeight = 800;
      state.mode = "random";

      chevron().click();
      const menuTop = parseFloat(menu().style.top);
      const menuBottom = menuTop + MENU_HEIGHT;
      chevron().click();
      heightSpy.mockRestore();

      expect(menu()).toBeNull();
      expect(state.mode).toBe("random");
      // The chevron must not have been under the menu at all.
      expect(menuBottom).toBeLessThanOrEqual(chevronRect.top);
    });

    it("lets the click reach document so other popups can close themselves", () => {
      // Every other popup in the app (bookmarks menu, back flyout) closes from
      // its own listener on document. A stopPropagation() here would strand
      // them open behind this menu.
      const onDocClick = jest.fn();
      document.addEventListener("click", onDocClick);
      chevron().click();
      document.removeEventListener("click", onDocClick);
      expect(onDocClick).toHaveBeenCalled();
    });

    describe("switching mode", () => {
      // The menu handler is async (it awaits the pause + buffer rebuild), and
      // click() does not return its promise, so drain the microtask queue.
      const settle = async () => {
        for (let i = 0; i < 10; i++) {
          await Promise.resolve();
        }
      };
      const pick = (label) => {
        const btn = Array.from(menu().querySelectorAll("button")).find((b) => b.textContent.includes(label));
        btn.click();
        return settle();
      };

      it("rebuilds the buffer in album order when leaving shuffle while stopped", async () => {
        // An arrow key, swipe or scrollbar drag halts autoplay without ever
        // running the pause path, so the shuffled buffer is still on screen.
        // Picking Sequential must rebuild it or prev/next keep walking the
        // leftover shuffle instead of the current image's real neighbors.
        const resetAllSlides = jest.fn(() => Promise.resolve());
        state.single_swiper = { swiper: { autoplay: { running: false } }, pauseSlideshow: jest.fn(), resetAllSlides };
        state.mode = "random";

        chevron().click();
        await pick("Sequential");

        expect(resetAllSlides).toHaveBeenCalledTimes(1);
        expect(state.mode).toBe("chronological");
        expect(menu()).toBeNull();
      });

      it("rebuilds the buffer in album order when leaving shuffle while running", async () => {
        // Regression: the handler used to write the new mode *before* pausing,
        // so the pause path saw "chronological", concluded no shuffle had run,
        // and skipped the rebuild.
        const resetAllSlides = jest.fn(() => Promise.resolve());
        const pauseSlideshow = jest.fn();
        state.single_swiper = {
          swiper: { autoplay: { running: true } },
          isSlideshowActive: () => true,
          pauseSlideshow,
          resetAllSlides,
        };
        state.mode = "random";

        chevron().click();
        await pick("Sequential");

        expect(pauseSlideshow).toHaveBeenCalled();
        expect(resetAllSlides).toHaveBeenCalledTimes(1);
        expect(state.mode).toBe("chronological");
      });

      it("does not rebuild the buffer when switching from sequential to shuffle", async () => {
        // A sequential buffer is already in order and shuffle starts fresh.
        const resetAllSlides = jest.fn(() => Promise.resolve());
        state.single_swiper = { swiper: { autoplay: { running: false } }, pauseSlideshow: jest.fn(), resetAllSlides };
        state.mode = "chronological";

        chevron().click();
        await pick("Shuffled");

        expect(resetAllSlides).not.toHaveBeenCalled();
        expect(state.mode).toBe("random");
      });

      it("does not rebuild the buffer when re-selecting sequential", async () => {
        const resetAllSlides = jest.fn(() => Promise.resolve());
        state.single_swiper = { swiper: { autoplay: { running: false } }, pauseSlideshow: jest.fn(), resetAllSlides };
        state.mode = "chronological";

        chevron().click();
        await pick("Sequential");

        // The handler did run (it persisted the choice); it just had no
        // shuffled buffer to rebuild.
        expect(saveSettingsToLocalStorage).toHaveBeenCalled();
        expect(resetAllSlides).not.toHaveBeenCalled();
        expect(state.mode).toBe("chronological");
      });

      it("lets the last click win when a second pick lands during the rebuild", async () => {
        // The rebuild awaits several image fetches. A user who picks Sequential
        // and then changes their mind to Shuffled before it finishes must end
        // up in shuffle mode — the first handler's completion must not
        // overwrite the second's choice.
        let finishReset;
        const resetAllSlides = jest.fn(() => new Promise((resolve) => (finishReset = resolve)));
        state.single_swiper = { swiper: { autoplay: { running: false } }, pauseSlideshow: jest.fn(), resetAllSlides };
        state.mode = "random";

        chevron().click();
        await pick("Sequential");
        expect(resetAllSlides).toHaveBeenCalledTimes(1);
        chevron().click();
        await pick("Shuffled");
        // Let the first handler's post-rebuild continuation run fully before
        // asserting; pick() cannot await the handler itself (click() returns
        // void), so drain the queue after releasing the rebuild.
        finishReset();
        await settle();

        expect(state.mode).toBe("random");
      });

      it("pauses and rebuilds when leaving shuffle during a rebuild that has stopped autoplay", async () => {
        // Same shape as an album switch mid-shuffle: autoplay is stopped by the
        // in-flight rebuild, but the slideshow is still logically running. The
        // pick must pause it (so the rebuild does not restart it) and rebuild.
        const resetAllSlides = jest.fn(() => Promise.resolve());
        const pauseSlideshow = jest.fn();
        state.single_swiper = {
          swiper: { autoplay: { running: false } },
          isSlideshowActive: () => true,
          pauseSlideshow,
          resetAllSlides,
        };
        state.mode = "random";

        chevron().click();
        await pick("Sequential");

        expect(pauseSlideshow).toHaveBeenCalled();
        expect(resetAllSlides).toHaveBeenCalledTimes(1);
        expect(state.mode).toBe("chronological");
      });

      it("pauses and rebuilds when re-selecting shuffle while a shuffle run is playing", async () => {
        // Picking any mode while running pauses the slideshow, and stopping a
        // shuffle run always leaves a shuffled buffer behind — so this must
        // rebuild just like the Pause button does.
        const resetAllSlides = jest.fn(() => Promise.resolve());
        const pauseSlideshow = jest.fn();
        state.single_swiper = {
          swiper: { autoplay: { running: true } },
          isSlideshowActive: () => true,
          pauseSlideshow,
          resetAllSlides,
        };
        state.mode = "random";

        chevron().click();
        await pick("Shuffled");

        expect(pauseSlideshow).toHaveBeenCalled();
        expect(resetAllSlides).toHaveBeenCalledTimes(1);
        expect(state.mode).toBe("random");
      });
    });

    it("opens the menu on long-press rather than the browser's own menu", () => {
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      chevron().dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(menu()).not.toBeNull();
    });

    it("leaves right-click on the play button itself working", () => {
      const ev = new MouseEvent("contextmenu", { clientX: 50, clientY: 50, bubbles: true, cancelable: true });
      document.getElementById("startStopSlideshowBtn").dispatchEvent(ev);
      expect(menu()).not.toBeNull();
    });

    it("stays usable while Play is greyed out at the end of a sequential run", () => {
      // Switching to Shuffled is the way out of that state, so the chevron
      // must not inherit the play button's disabled treatment.
      document.getElementById("startStopSlideshowBtn").classList.add("slideshow-disabled");
      expect(chevron().disabled).toBe(false);
      chevron().click();
      expect(menu()).not.toBeNull();
    });

    it("cancels the deferred close-listeners when shut before they attach", () => {
      // The listeners are attached on a setTimeout(0) so the opening click
      // does not immediately close the menu. Toggling shut inside that window
      // must cancel the timer: merely removing not-yet-added listeners would
      // leave the timeout to attach them to a menu that no longer exists.
      const addSpy = jest.spyOn(document, "addEventListener");
      chevron().click();
      chevron().click();
      jest.runOnlyPendingTimers();
      const attached = addSpy.mock.calls.filter(([type]) => type === "click" || type === "keydown");
      addSpy.mockRestore();
      expect(attached).toHaveLength(0);
    });
  });
});
