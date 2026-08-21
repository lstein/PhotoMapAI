// The bottom panels have to stay inside the region the tablet can actually
// show, which on iPadOS is not the same thing as the layout viewport they are
// positioned against. Every case here was observed as "the panels slide off
// the bottom of the iPad when leaving fullscreen and never come back".
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const { initializePanelAnchor, syncPanelAnchor, visibleViewportBottom } =
  await import("../../photomap/frontend/static/javascript/panel-anchor.js");

const listeners = new Map();

/** Install a visualViewport stub that records its listeners. */
function setVisualViewport(props) {
  if (props === null) {
    delete window.visualViewport;
    return;
  }
  window.visualViewport = {
    offsetTop: 0,
    scale: 1,
    ...props,
    addEventListener: (name, fn) => listeners.set(`vv:${name}`, fn),
    removeEventListener: () => {},
  };
}

/** The layout viewport height that `position: fixed; bottom` resolves against. */
function setLayoutViewportHeight(height) {
  Object.defineProperty(document.documentElement, "clientHeight", { value: height, configurable: true });
}

const panel = () => document.getElementById("controlPanel");

beforeEach(() => {
  listeners.clear();
  document.body.innerHTML = `<div id="controlPanel"></div><div id="searchPanel"></div><input id="searchInput" />`;
  setLayoutViewportHeight(1000);
  setVisualViewport({ height: 1000 });
});

afterEach(() => {
  delete window.visualViewport;
});

describe("a layout viewport taller than the visible area", () => {
  it("lifts the panels back into view by the overshoot", () => {
    // Leaving fullscreen returns the browser chrome: 130px of the layout
    // viewport is now off the bottom of the screen, taking the panels with it.
    setVisualViewport({ height: 870 });
    initializePanelAnchor([panel(), document.getElementById("searchPanel")]);

    expect(panel().style.transform).toBe("translateY(-130px)");
    expect(document.getElementById("searchPanel").style.transform).toBe("translateY(-130px)");
  });

  it("accounts for a visible area offset from the top as well", () => {
    setVisualViewport({ height: 800, offsetTop: 60 });
    initializePanelAnchor([panel()]);

    expect(panel().style.transform).toBe("translateY(-140px)");
  });

  it("clears the offset again once the viewport catches up", () => {
    setVisualViewport({ height: 870 });
    initializePanelAnchor([panel()]);
    expect(panel().style.transform).toBe("translateY(-130px)");

    setVisualViewport({ height: 1000 });
    syncPanelAnchor();

    expect(panel().style.transform).toBe("");
  });

  it("resyncs when the visual viewport resizes", () => {
    initializePanelAnchor([panel()]);
    expect(panel().style.transform).toBe("");

    setVisualViewport({ height: 870 });
    // The stub replaced the object, so fire through the recorded listener.
    listeners.get("vv:resize")();

    expect(panel().style.transform).toBe("translateY(-130px)");
  });

  it("resyncs on rotate", () => {
    initializePanelAnchor([panel()]);
    setVisualViewport({ height: 700 });

    window.dispatchEvent(new Event("orientationchange"));

    expect(panel().style.transform).toBe("translateY(-300px)");
  });
});

describe("cases that must not move the panels", () => {
  it("leaves them alone when the viewports agree", () => {
    initializePanelAnchor([panel()]);
    expect(panel().style.transform).toBe("");
  });

  it("ignores sub-pixel disagreement", () => {
    setVisualViewport({ height: 999.4 });
    initializePanelAnchor([panel()]);

    expect(panel().style.transform).toBe("");
  });

  it("ignores a shortfall too small to be browser chrome", () => {
    // The first fraction of a pinch shrinks the visual viewport while the
    // scale is still ~1.00; without a floor the panels twitch upward before
    // the scale guard takes over. Browser chrome is far taller than this.
    setVisualViewport({ height: 980 });
    initializePanelAnchor([panel()]);

    expect(panel().style.transform).toBe("");
  });

  it("leaves them alone while the user is zoomed in", () => {
    // Zoomed, the visual viewport is a window onto the page; correcting for it
    // would drag the panels around under the user's fingers, and WebKit
    // already handles fixed elements specially here.
    setVisualViewport({ height: 500, scale: 2 });
    initializePanelAnchor([panel()]);

    expect(panel().style.transform).toBe("");
  });

  it("does nothing on a browser without visualViewport", () => {
    setVisualViewport(null);
    setLayoutViewportHeight(1000);

    expect(() => initializePanelAnchor([panel()])).not.toThrow();
    expect(panel().style.transform).toBe("");
  });

  it("tolerates a missing panel", () => {
    setVisualViewport({ height: 870 });
    expect(() => initializePanelAnchor([panel(), null])).not.toThrow();
    expect(panel().style.transform).toBe("translateY(-130px)");
  });
});

describe("the software keyboard", () => {
  // On iPad the keyboard shrinks the visual viewport exactly as a stranded
  // layout viewport does, and it is much the more common of the two. Treating
  // it as an overshoot flings both panels hundreds of pixels up into the
  // middle of the photo, over the search dialog they belong under.
  it("does not lift the panels when a text field takes focus", () => {
    initializePanelAnchor([panel()]);
    document.getElementById("searchInput").focus();

    setVisualViewport({ height: 620 });
    syncPanelAnchor();

    expect(panel().style.transform).toBe("");
  });

  it("holds an existing correction rather than adding the keyboard to it", () => {
    setVisualViewport({ height: 870 });
    initializePanelAnchor([panel()]);
    expect(panel().style.transform).toBe("translateY(-130px)");

    document.getElementById("searchInput").focus();
    setVisualViewport({ height: 490 });
    syncPanelAnchor();

    expect(panel().style.transform).toBe("translateY(-130px)");
  });

  it("recomputes once the field is blurred again", () => {
    setVisualViewport({ height: 870 });
    initializePanelAnchor([panel()]);
    document.getElementById("searchInput").focus();
    setVisualViewport({ height: 490 });
    syncPanelAnchor();

    document.getElementById("searchInput").blur();
    setVisualViewport({ height: 1000 });
    syncPanelAnchor();

    expect(panel().style.transform).toBe("");
  });
});

describe("resampling after the viewport settles", () => {
  it("corrects a reading taken mid-transition", () => {
    jest.useFakeTimers();
    initializePanelAnchor([panel()]);

    // The fullscreen exit is animated: this event carries a height that is on
    // its way somewhere, and no further event need follow.
    setVisualViewport({ height: 940 });
    listeners.get("vv:resize")();
    expect(panel().style.transform).toBe("translateY(-60px)");

    setVisualViewport({ height: 870 });
    jest.runAllTimers();

    expect(panel().style.transform).toBe("translateY(-130px)");
    jest.useRealTimers();
  });
});

describe("visibleViewportBottom", () => {
  it("reports the visible bottom edge, not the layout one", () => {
    setVisualViewport({ height: 870 });
    expect(visibleViewportBottom()).toBe(870);
  });

  it("falls back to the layout viewport where the two agree", () => {
    expect(visibleViewportBottom()).toBe(1000);
  });

  it("falls back to the layout viewport with no visualViewport at all", () => {
    setVisualViewport(null);
    expect(visibleViewportBottom()).toBe(1000);
  });
});

describe("the seam with fullscreen handling", () => {
  it("re-seats the panels on a fullscreen transition", async () => {
    jest.useFakeTimers();
    // control-panel.js owns the fullscreen events and calls into this module;
    // this asserts the wiring rather than the module in isolation.
    jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
      state: {},
      saveSettingsToLocalStorage: jest.fn(),
    }));
    jest.unstable_mockModule("../../photomap/frontend/static/javascript/index.js", () => ({
      deleteImage: jest.fn(),
      getIndexMetadata: jest.fn(),
    }));
    jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
      getCurrentFilepath: jest.fn(),
      getCurrentSlideIndex: jest.fn(),
      slideState: { getCurrentSlide: () => ({ globalIndex: 0 }) },
    }));
    jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
      errorDetail: jest.fn(),
      hideSpinner: jest.fn(),
      showSpinner: jest.fn(),
      setCheckmarkOnIcon: jest.fn(),
    }));
    const { initializeControlPanel } = await import("../../photomap/frontend/static/javascript/control-panel.js");

    document.body.innerHTML = `<div id="controlPanel"></div><div id="searchPanel"></div><div id="fixedScoreDisplay"></div>`;
    Object.defineProperty(document, "fullscreenElement", { value: document.documentElement, configurable: true });
    initializeControlPanel();

    // The viewport only settles after the exit animation, well after the event.
    Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
    document.dispatchEvent(new Event("fullscreenchange"));
    setVisualViewport({ height: 870 });
    jest.runAllTimers();

    expect(document.getElementById("controlPanel").style.transform).toBe("translateY(-130px)");
    expect(document.getElementById("controlPanel").classList.contains("hidden-fullscreen")).toBe(false);
    jest.useRealTimers();
  });
});
