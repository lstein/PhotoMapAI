// The control panel's fullscreen handling as an iPad browser exercises it.
//
// Every case here is one where a single reading of document.fullscreenElement
// on a single unprefixed event gets the answer wrong, and the panels end up
// with .hidden-fullscreen (opacity:0 + visibility:hidden, both !important)
// while the app is windowed. That state is unrecoverable in the running page:
// visibility:hidden takes the fullscreen button out of hit testing too, so the
// user cannot toggle fullscreen again to shake it off.
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

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

const { initializeControlPanel, toggleFullscreen } =
  await import("../../photomap/frontend/static/javascript/control-panel.js");

const PANEL_IDS = ["controlPanel", "searchPanel", "fixedScoreDisplay"];

/** Define a (possibly vendor-prefixed) fullscreen element property. */
function setFullscreenElement(name, el) {
  Object.defineProperty(document, name, { value: el, configurable: true });
}

const panelsHidden = () => PANEL_IDS.map((id) => document.getElementById(id).classList.contains("hidden-fullscreen"));

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = `
    <div id="controlPanel"><button id="fullscreenBtn"></button></div>
    <div id="searchPanel"></div>
    <div id="fixedScoreDisplay"></div>`;
  setFullscreenElement("fullscreenElement", null);
  setFullscreenElement("webkitFullscreenElement", null);
  // jsdom has no visualViewport; the control panel subscribes to it, and one
  // test fires through it, so it has to dispatch for real.
  window.visualViewport = new window.EventTarget();
  initializeControlPanel();
});

afterEach(() => {
  jest.useRealTimers();
  delete window.visualViewport;
});

describe("vendor-prefixed fullscreen", () => {
  it("hides the panels for a webkit-only fullscreen transition", () => {
    // WebKit browsers that predate unprefixed element fullscreen set only the
    // -webkit- property and fire only the -webkit- event. Reading the
    // unprefixed one alone reports "windowed" while the app is fullscreen.
    setFullscreenElement("webkitFullscreenElement", document.documentElement);
    document.dispatchEvent(new Event("webkitfullscreenchange"));
    jest.runAllTimers();

    expect(panelsHidden()).toEqual([true, true, true]);
  });

  it("restores the panels when webkit fullscreen ends", () => {
    setFullscreenElement("webkitFullscreenElement", document.documentElement);
    document.dispatchEvent(new Event("webkitfullscreenchange"));
    jest.runAllTimers();

    setFullscreenElement("webkitFullscreenElement", null);
    document.dispatchEvent(new Event("webkitfullscreenchange"));
    jest.runAllTimers();

    expect(panelsHidden()).toEqual([false, false, false]);
  });

  it("requests and exits fullscreen through the prefixed methods when they are all there is", () => {
    const request = jest.fn();
    const exit = jest.fn();
    document.documentElement.webkitRequestFullscreen = request;
    document.webkitExitFullscreen = exit;

    toggleFullscreen();
    expect(request).toHaveBeenCalled();

    setFullscreenElement("webkitFullscreenElement", document.documentElement);
    toggleFullscreen();
    expect(exit).toHaveBeenCalled();

    delete document.documentElement.webkitRequestFullscreen;
    delete document.webkitExitFullscreen;
  });

  it('cancels fullscreen on a browser that spells exit "cancel"', () => {
    // Neither legacy vendor calls it exit: Firefox is mozCancelFullScreen and
    // older WebKit webkitCancelFullScreen. Accepting a prefixed property as
    // proof of fullscreen while having no matching way out makes the button a
    // one-way trip — enter works, exit silently does nothing, for ever.
    const cancel = jest.fn();
    document.mozCancelFullScreen = cancel;
    setFullscreenElement("mozFullScreenElement", document.documentElement);

    toggleFullscreen();

    expect(cancel).toHaveBeenCalled();
    delete document.mozCancelFullScreen;
    setFullscreenElement("mozFullScreenElement", null);
  });

  it("does not throw on a browser with no fullscreen API at all", () => {
    expect(() => toggleFullscreen()).not.toThrow();
  });
});

describe("a fullscreenchange that arrives before the state settles", () => {
  it("unhides the panels once the document reports the exit", () => {
    setFullscreenElement("fullscreenElement", document.documentElement);
    document.dispatchEvent(new Event("fullscreenchange"));
    jest.runAllTimers();
    expect(panelsHidden()).toEqual([true, true, true]);

    // The exit event, delivered while the document still names the outgoing
    // element: read once and the panels latch hidden in windowed mode.
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(panelsHidden()).toEqual([true, true, true]);

    setFullscreenElement("fullscreenElement", null);
    jest.runAllTimers();

    expect(panelsHidden()).toEqual([false, false, false]);
  });
});

describe("resync outside the fullscreen events", () => {
  it("restores the panels on rotate when the exit event never arrived", () => {
    setFullscreenElement("fullscreenElement", document.documentElement);
    document.dispatchEvent(new Event("fullscreenchange"));
    jest.runAllTimers();

    // Fullscreen ends with no event of any spelling delivered to the page.
    setFullscreenElement("fullscreenElement", null);
    expect(panelsHidden()).toEqual([true, true, true]);

    window.dispatchEvent(new Event("orientationchange"));

    expect(panelsHidden()).toEqual([false, false, false]);
  });

  it("restores the panels on a visual-viewport resize, which iPadOS does fire", () => {
    // The failure this guards is the one where every other signal is absent:
    // the exit event samples a document that still names the outgoing element,
    // and the layout viewport does not change, so window.resize never comes.
    // The visible area shrinking is the one thing that always happens.
    setFullscreenElement("fullscreenElement", document.documentElement);
    document.dispatchEvent(new Event("fullscreenchange"));
    jest.runAllTimers();

    setFullscreenElement("fullscreenElement", null);
    window.visualViewport.dispatchEvent(new Event("resize"));

    expect(panelsHidden()).toEqual([false, false, false]);
  });

  it("re-hides the panels on resize while still fullscreen", () => {
    setFullscreenElement("fullscreenElement", document.documentElement);
    window.dispatchEvent(new Event("resize"));

    expect(panelsHidden()).toEqual([true, true, true]);
  });
});
