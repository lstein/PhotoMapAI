// Tests for mobile-sheets.js: the phone layout's top and bottom sheets.
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const MODULE = "../../photomap/frontend/static/javascript/mobile-sheets.js";

// jsdom 20 has no PointerEvent; a MouseEvent carrying the pointer fields is
// all the module reads.
function pointer(
  type,
  target,
  { x = 100, y = 100, id = 1, time = 0, primary = true, button = 0, kind = "touch", buttons } = {}
) {
  // A held button reads as buttons = 1 until it is released.
  const held = buttons ?? (type === "pointerup" ? 0 : 1);
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button,
    buttons: held,
  });
  Object.defineProperty(event, "pointerId", { value: id });
  Object.defineProperty(event, "isPrimary", { value: primary });
  Object.defineProperty(event, "pointerType", { value: kind });
  Object.defineProperty(event, "timeStamp", { value: time });
  target.dispatchEvent(event);
  return event;
}

/** Press on `target`, move vertically in `steps` to `y1`, release. */
function drag(target, y0, y1, { steps = 10, duration = 400, release = true, kind = "touch" } = {}) {
  pointer("pointerdown", target, { y: y0, time: 0, kind });
  for (let i = 1; i <= steps; i++) {
    pointer("pointermove", target, { y: y0 + ((y1 - y0) * i) / steps, time: (duration * i) / steps, kind });
  }
  if (release) {
    pointer("pointerup", target, { y: y1, time: duration, kind });
  }
}

let queryListeners;
let queryMatches;

function installMatchMedia(matches) {
  queryMatches = matches;
  queryListeners = [];
  window.matchMedia = jest.fn((query) => ({
    media: query,
    get matches() {
      return queryMatches;
    },
    addEventListener: (type, listener) => queryListeners.push(listener),
    removeEventListener: jest.fn(),
  }));
}

function flipQuery(matches) {
  queryMatches = matches;
  queryListeners.forEach((listener) => listener({ matches }));
}

function buildDom() {
  document.body.innerHTML = `
    <div id="topSheetContainer" class="mobile-sheet">
      <div id="fixedScoreDisplay"></div>
      <div id="sliderHoverStrip" data-sheet-peek></div>
      <div id="scoreSliderRow"><input type="range" id="slideSeekSlider" /></div>
      <button id="topSheetHandle" class="sheet-handle"></button>
    </div>
    <div id="panelStackContainer" class="mobile-sheet">
      <button id="bottomSheetHandle" class="sheet-handle"></button>
      <div id="searchPanel"><button id="textSearchBtn"></button></div>
      <div id="controlPanel"><button id="deleteBtn"></button></div>
    </div>
  `;
  for (const [id, height] of [
    ["topSheetContainer", 160],
    ["panelStackContainer", 130],
  ]) {
    Object.defineProperty(document.getElementById(id), "offsetHeight", { configurable: true, value: height });
  }
}

const root = document.documentElement;

describe("mobile-sheets.js", () => {
  let mod;
  let events;
  const record = (event) => events.push(event.detail);

  beforeEach(async () => {
    jest.useFakeTimers();
    localStorage.clear();
    root.className = "";
    delete root.dataset.topSheet;
    delete root.dataset.bottomSheet;
    root.removeAttribute("style");
    installMatchMedia(true);
    buildDom();
    mod = await import(MODULE);
    mod.resetMobileSheetsForTests();
    events = [];
    window.addEventListener("mobileSheetChanged", record);
  });

  afterEach(() => {
    window.removeEventListener("mobileSheetChanged", record);
    jest.useRealTimers();
  });

  describe("initialization", () => {
    it("turns on the phone layout when the query matches", () => {
      mod.initializeMobileSheets();
      expect(mod.isMobileSheetsMode()).toBe(true);
      expect(root.dataset.bottomSheet).toBe("expanded");
      expect(root.dataset.topSheet).toBe("collapsed");
    });

    it("leaves the desktop layout alone when it does not", () => {
      installMatchMedia(false);
      mod.initializeMobileSheets();
      expect(mod.isMobileSheetsMode()).toBe(false);
      expect(mod.sheetVisibleHeight("bottom")).toBe(0);
      expect(document.getElementById("controlPanel").inert).toBe(false);
      expect(root.style.getPropertyValue("--bottom-sheet-height")).toBe("");
    });

    it("restores a bottom sheet the user had closed", () => {
      localStorage.setItem("bottomSheetState", "collapsed");
      mod.initializeMobileSheets();
      expect(root.dataset.bottomSheet).toBe("collapsed");
    });

    it("keeps the state the <head> script already set", () => {
      root.dataset.bottomSheet = "collapsed";
      mod.initializeMobileSheets();
      expect(root.dataset.bottomSheet).toBe("collapsed");
    });

    it("announces the starting state of both sheets", () => {
      mod.initializeMobileSheets();
      expect(events).toEqual(
        expect.arrayContaining([
          { sheet: "bottom", state: "expanded", expanded: true, mobile: true },
          { sheet: "top", state: "collapsed", expanded: false, mobile: true },
        ])
      );
    });

    it("publishes each sheet's on-screen height", () => {
      mod.initializeMobileSheets();
      expect(root.style.getPropertyValue("--bottom-sheet-height")).toBe("130px");
      // Collapsed: only the peek (the stylesheet is not loaded, so the fallback).
      expect(root.style.getPropertyValue("--top-sheet-height")).toBe("26px");
    });
  });

  describe("accessibility of a collapsed sheet", () => {
    it("makes everything but the handle and the progress strip inert", () => {
      mod.initializeMobileSheets();
      expect(document.getElementById("fixedScoreDisplay").inert).toBe(true);
      expect(document.getElementById("scoreSliderRow").inert).toBe(true);
      expect(document.getElementById("sliderHoverStrip").inert).toBeFalsy();
      expect(document.getElementById("topSheetHandle").inert).toBeFalsy();
      expect(document.getElementById("topSheetHandle").getAttribute("aria-expanded")).toBe("false");

      expect(document.getElementById("controlPanel").inert).toBe(false);
      expect(document.getElementById("bottomSheetHandle").getAttribute("aria-expanded")).toBe("true");
    });
  });

  describe("tapping", () => {
    beforeEach(() => mod.initializeMobileSheets());

    it("toggles a sheet from its handle and remembers the bottom one", () => {
      document.getElementById("bottomSheetHandle").click();
      expect(root.dataset.bottomSheet).toBe("collapsed");
      expect(localStorage.getItem("bottomSheetState")).toBe("collapsed");
      expect(document.getElementById("controlPanel").inert).toBe(true);
      expect(root.style.getPropertyValue("--bottom-sheet-height")).toBe("24px");
      expect(events.at(-1)).toEqual({ sheet: "bottom", state: "collapsed", expanded: false, mobile: true });

      document.getElementById("bottomSheetHandle").click();
      expect(root.dataset.bottomSheet).toBe("expanded");
      expect(localStorage.getItem("bottomSheetState")).toBe("expanded");
    });

    it("does not remember the top sheet", () => {
      document.getElementById("topSheetHandle").click();
      expect(root.dataset.topSheet).toBe("expanded");
      expect(localStorage.getItem("bottomSheetState")).toBeNull();
    });

    it("opens a collapsed sheet from the strip left showing", () => {
      document.getElementById("sliderHoverStrip").click();
      expect(root.dataset.topSheet).toBe("expanded");
    });

    it("leaves an open sheet alone when one of its controls is used", () => {
      document.getElementById("deleteBtn").click();
      expect(root.dataset.bottomSheet).toBe("expanded");
    });
  });

  describe("dragging", () => {
    beforeEach(() => mod.initializeMobileSheets());

    it("closes the bottom sheet when dragged down past half way", () => {
      const sheet = document.getElementById("panelStackContainer");
      // Slow, so it is the distance and not a flick that decides.
      drag(sheet, 500, 580, { duration: 4000 });
      expect(root.dataset.bottomSheet).toBe("collapsed");
      expect(sheet.style.transform).toBe("");
      expect(sheet.classList.contains("sheet-dragging")).toBe(false);
    });

    it("springs back when let go short of half way", () => {
      drag(document.getElementById("panelStackContainer"), 500, 530, { duration: 4000 });
      expect(root.dataset.bottomSheet).toBe("expanded");
    });

    it("follows the finger while dragging, within its travel", () => {
      const sheet = document.getElementById("panelStackContainer");
      drag(sheet, 500, 540, { release: false });
      expect(sheet.style.transform).toBe("translateY(40px)");
      expect(sheet.classList.contains("sheet-dragging")).toBe(true);
      pointer("pointermove", sheet, { y: 900, time: 500 });
      // 130px tall, 24px peek: 106px of travel.
      expect(sheet.style.transform).toBe("translateY(106px)");
      pointer("pointerup", sheet, { y: 900, time: 500 });
    });

    it("closes on a short fast flick", () => {
      drag(document.getElementById("panelStackContainer"), 500, 530, { duration: 50 });
      expect(root.dataset.bottomSheet).toBe("collapsed");
    });

    it("opens the top sheet when pulled down", () => {
      const sheet = document.getElementById("topSheetContainer");
      drag(sheet, 10, 140, { duration: 4000 });
      expect(root.dataset.topSheet).toBe("expanded");
    });

    it("moves the top sheet the other way", () => {
      const sheet = document.getElementById("topSheetContainer");
      drag(sheet, 10, 50, { release: false });
      // Collapsed starts at the far end (160 - 26 = 134) and pulling down opens.
      expect(sheet.style.transform).toBe("translateY(-94px)");
      pointer("pointerup", sheet, { y: 50, time: 400 });
    });

    it("swallows the click that ends a mouse drag started on a button", () => {
      const button = document.getElementById("deleteBtn");
      const onClick = jest.fn();
      button.addEventListener("click", onClick);
      drag(button, 500, 600, { duration: 4000, kind: "mouse" });
      button.click();
      expect(onClick).not.toHaveBeenCalled();
      // Only that one click.
      button.click();
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("swallows nothing after a touch drag, which never clicks", () => {
      const button = document.getElementById("deleteBtn");
      const onClick = jest.fn();
      button.addEventListener("click", onClick);
      drag(button, 500, 600, { duration: 4000 });
      // The user's next tap, straight after.
      button.click();
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("swallows nothing after a cancelled drag", () => {
      const button = document.getElementById("deleteBtn");
      const onClick = jest.fn();
      button.addEventListener("click", onClick);
      drag(button, 500, 600, { release: false, kind: "mouse" });
      pointer("pointercancel", button, { y: 600, kind: "mouse" });
      button.click();
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("forgets a mouse press released off the sheet before it became a drag", () => {
      const sheet = document.getElementById("panelStackContainer");
      pointer("pointerdown", sheet, { y: 500, kind: "mouse" });
      // The button comes up elsewhere; later the mouse hovers back down.
      pointer("pointermove", sheet, { y: 520, kind: "mouse", buttons: 0 });
      pointer("pointermove", sheet, { y: 540, kind: "mouse", buttons: 0 });
      expect(sheet.classList.contains("sheet-dragging")).toBe(false);
      expect(sheet.style.transform).toBe("");
    });

    it("stops swallowing if the click never comes", () => {
      const button = document.getElementById("deleteBtn");
      const onClick = jest.fn();
      button.addEventListener("click", onClick);
      drag(button, 500, 600, { duration: 4000, kind: "mouse" });
      jest.advanceTimersByTime(1000);
      button.click();
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("lets a tap through to the button it lands on", () => {
      const button = document.getElementById("deleteBtn");
      const onClick = jest.fn();
      button.addEventListener("click", onClick);
      drag(button, 500, 504);
      button.click();
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(root.dataset.bottomSheet).toBe("expanded");
    });

    it("ignores a sideways drag", () => {
      const sheet = document.getElementById("panelStackContainer");
      pointer("pointerdown", sheet, { x: 100, y: 500 });
      pointer("pointermove", sheet, { x: 160, y: 505 });
      pointer("pointermove", sheet, { x: 160, y: 600 });
      pointer("pointerup", sheet, { x: 160, y: 600 });
      expect(sheet.style.transform).toBe("");
      expect(root.dataset.bottomSheet).toBe("expanded");
    });

    it("never starts on the seek slider, which drags its own thumb", () => {
      document.getElementById("topSheetHandle").click();
      const sheet = document.getElementById("topSheetContainer");
      drag(document.getElementById("slideSeekSlider"), 60, 10, { duration: 4000 });
      expect(sheet.style.transform).toBe("");
      expect(root.dataset.topSheet).toBe("expanded");
    });

    it("settles at the nearer end when the browser cancels the gesture", () => {
      const sheet = document.getElementById("panelStackContainer");
      drag(sheet, 500, 590, { release: false });
      pointer("pointercancel", sheet, { y: 590, time: 500 });
      expect(root.dataset.bottomSheet).toBe("collapsed");
      expect(sheet.style.transform).toBe("");
    });
  });

  describe("switching layouts", () => {
    beforeEach(() => mod.initializeMobileSheets());

    it("tells listeners when the phone layout ends", () => {
      flipQuery(false);
      expect(mod.isMobileSheetsMode()).toBe(false);
      expect(events).toEqual(
        expect.arrayContaining([
          { sheet: "top", state: "collapsed", expanded: false, mobile: false },
          { sheet: "bottom", state: "expanded", expanded: true, mobile: false },
        ])
      );
      expect(root.style.getPropertyValue("--bottom-sheet-height")).toBe("");
      expect(document.getElementById("fixedScoreDisplay").inert).toBe(false);
    });

    it("comes back with the slider closed", () => {
      document.getElementById("topSheetHandle").click();
      flipQuery(false);
      flipQuery(true);
      expect(root.dataset.topSheet).toBe("collapsed");
      expect(events.at(-1).mobile).toBe(true);
    });

    it("abandons a drag in progress", () => {
      const sheet = document.getElementById("panelStackContainer");
      drag(sheet, 500, 560, { release: false });
      flipQuery(false);
      expect(sheet.style.transform).toBe("");
      expect(sheet.classList.contains("sheet-dragging")).toBe(false);
      pointer("pointerup", sheet, { y: 560, time: 500 });
      expect(root.dataset.bottomSheet).toBe("expanded");
    });

    it("ignores taps and drags outside the phone layout", () => {
      flipQuery(false);
      document.getElementById("bottomSheetHandle").click();
      drag(document.getElementById("panelStackContainer"), 500, 600);
      expect(root.dataset.bottomSheet).toBe("expanded");
    });
  });
});
