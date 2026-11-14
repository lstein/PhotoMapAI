// Tests for the bottom sheet's third stop: the metadata drawer's contents,
// borrowed into the sheet in the phone layout (mobile-sheets.js).
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const MODULE = "../../photomap/frontend/static/javascript/mobile-sheets.js";

// jsdom 20 has no PointerEvent; a MouseEvent carrying the pointer fields is
// all the module reads.
function pointer(type, target, { x = 100, y = 100, id = 1, time = 0 } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: id });
  Object.defineProperty(event, "isPrimary", { value: true });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  Object.defineProperty(event, "timeStamp", { value: time });
  target.dispatchEvent(event);
  return event;
}

/** Press on `target`, move vertically in `steps` to `y1`, release. */
function drag(target, y0, y1, { steps = 10, duration = 400 } = {}) {
  pointer("pointerdown", target, { y: y0, time: 0 });
  for (let i = 1; i <= steps; i++) {
    pointer("pointermove", target, { y: y0 + ((y1 - y0) * i) / steps, time: (duration * i) / steps });
  }
  pointer("pointerup", target, { y: y1, time: duration });
}

// jsdom has no Touch constructor; the module reads touches[i].clientY.
function touch(type, target, ys) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: ys.map((clientY) => ({ clientY })) });
  target.dispatchEvent(event);
  return event;
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

// Geometry, in px: the sheet is 700 tall, its details 500 starting 180 down,
// their title row 44. So the expanded stop is 456 below fully open, and the
// collapsed one 676 (700 less the 24px handle).
function buildDom() {
  document.body.innerHTML = `
    <div id="panelStackContainer" class="mobile-sheet">
      <button id="bottomSheetHandle" class="sheet-handle"></button>
      <div id="searchPanel"><button id="textSearchBtn"></button></div>
      <div id="controlPanel"><button id="deleteBtn"></button></div>
      <div id="sheetDetails"></div>
    </div>
    <div id="bannerDrawerContainer">
      <div id="overlayDrawer"></div>
      <div id="filenameBanner">
        <div id="filenameTitlebar"><span id="filenameText">photo.png</span><button id="copyTextBtn"></button></div>
        <div id="filenameDescContainer"><p id="descriptionText">details</p><select id="refTarget"></select></div>
        <div id="recallButtonsContainer"><button id="recallBtn"></button></div>
      </div>
    </div>
  `;
  const set = (id, property, value) =>
    Object.defineProperty(document.getElementById(id), property, { configurable: true, value });
  set("panelStackContainer", "offsetHeight", 700);
  set("sheetDetails", "offsetHeight", 500);
  set("sheetDetails", "offsetTop", 180);
  set("filenameTitlebar", "offsetHeight", 44);
}

const root = document.documentElement;
const $ = (id) => document.getElementById(id);

describe("mobile-sheets.js details stop", () => {
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
    mod.initializeMobileSheets();
  });

  afterEach(() => {
    window.removeEventListener("mobileSheetChanged", record);
    jest.useRealTimers();
  });

  describe("placement", () => {
    it("borrows the drawer's contents into the sheet", () => {
      expect($("filenameBanner").parentElement).toBe($("sheetDetails"));
      expect(root.style.getPropertyValue("--bottom-sheet-panels-height")).toBe("180px");
    });

    it("hands them back when the phone layout ends, and borrows them again", () => {
      flipQuery(false);
      expect($("filenameBanner").parentElement).toBe($("bannerDrawerContainer"));
      expect(root.style.getPropertyValue("--bottom-sheet-panels-height")).toBe("");
      expect($("descriptionText").parentElement.inert).toBeFalsy();
      expect($("filenameTitlebar").hasAttribute("aria-expanded")).toBe(false);
      flipQuery(true);
      expect($("filenameBanner").parentElement).toBe($("sheetDetails"));
    });

    it("leaves them in the drawer outside the phone layout", () => {
      mod.resetMobileSheetsForTests();
      root.className = "";
      installMatchMedia(false);
      buildDom();
      mod.initializeMobileSheets();
      expect($("filenameBanner").parentElement).toBe($("bannerDrawerContainer"));
      expect(mod.sheetVisibleHeight("bottom")).toBe(0);
    });
  });

  describe("fullscreen", () => {
    afterEach(() => {
      delete document.fullscreenElement;
    });

    it("does not move the hidden sheets from code", () => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.body });
      mod.setSheetState("bottom", "details");
      expect(root.dataset.bottomSheet).toBe("expanded");
    });
  });

  describe("re-announcing", () => {
    it("tells listeners when the sheet changes height without changing stop", () => {
      // What the ResizeObserver does when, say, the panel labels come on.
      Object.defineProperty($("sheetDetails"), "offsetTop", { configurable: true, value: 230 });
      Object.defineProperty($("panelStackContainer"), "offsetHeight", { configurable: true, value: 750 });
      const before = events.length;
      mod.notifySheetsResizedForTests();
      expect(events.length).toBe(before + 1);
      expect(events.at(-1)).toEqual({ sheet: "bottom", state: "expanded", expanded: true, mobile: true });
      mod.notifySheetsResizedForTests();
      expect(events.length).toBe(before + 1);
    });
  });

  describe("heights", () => {
    it("measures the collapsed peek from the handle, whatever the CSS says", () => {
      // Sideways, the peek is a calc() with env(), which reads back unevaluated.
      Object.defineProperty($("bottomSheetHandle"), "offsetHeight", { configurable: true, value: 46 });
      mod.setSheetState("bottom", "collapsed");
      expect(mod.sheetVisibleHeight("bottom")).toBe(46);
      expect(root.style.getPropertyValue("--bottom-sheet-height")).toBe("46px");
    });

    it("counts the title row, not the details below it, as the open sheet", () => {
      expect(mod.sheetVisibleHeight("bottom")).toBe(244);
      expect(root.style.getPropertyValue("--bottom-sheet-height")).toBe("244px");
    });

    it("reports the same height at the details stop, which floats over the page", () => {
      mod.setSheetState("bottom", "details");
      expect(mod.sheetVisibleHeight("bottom")).toBe(244);
    });
  });

  describe("tapping", () => {
    it("opens and closes the details from their title row", () => {
      $("filenameText").click();
      expect(root.dataset.bottomSheet).toBe("details");
      expect(events.at(-1)).toEqual({ sheet: "bottom", state: "details", expanded: true, mobile: true });
      $("filenameTitlebar").click();
      expect(root.dataset.bottomSheet).toBe("expanded");
    });

    it("leaves the title row's copy button to copy", () => {
      $("copyTextBtn").click();
      expect(root.dataset.bottomSheet).toBe("expanded");
    });

    it("steps down from the details to the panels from the handle", () => {
      mod.setSheetState("bottom", "details");
      $("bottomSheetHandle").click();
      expect(root.dataset.bottomSheet).toBe("expanded");
    });

    it("does not open the details from the title row of a collapsed sheet", () => {
      mod.setSheetState("bottom", "collapsed");
      $("filenameTitlebar").click();
      expect(root.dataset.bottomSheet).toBe("expanded");
    });
  });

  describe("accessibility", () => {
    it("keeps everything under the title row out of reach until the details open", () => {
      expect($("filenameTitlebar").inert).toBeFalsy();
      expect($("recallButtonsContainer").inert).toBe(true);
      expect($("filenameTitlebar").getAttribute("aria-expanded")).toBe("false");
      mod.setSheetState("bottom", "details");
      expect($("recallButtonsContainer").inert).toBe(false);
      expect($("filenameTitlebar").getAttribute("aria-expanded")).toBe("true");
    });

    it("hides the whole slot with the collapsed sheet", () => {
      mod.setSheetState("bottom", "collapsed");
      expect($("sheetDetails").inert).toBe(true);
    });
  });

  describe("persistence", () => {
    it("does not remember the details stop", () => {
      mod.setSheetState("bottom", "collapsed");
      mod.setSheetState("bottom", "details");
      expect(localStorage.getItem("bottomSheetState")).toBe("collapsed");
    });

    it("closes the details back to the stop they were opened from", () => {
      mod.setSheetState("bottom", "collapsed");
      mod.setSheetState("bottom", "details");
      mod.closeSheetDetails();
      expect(root.dataset.bottomSheet).toBe("collapsed");
      mod.setSheetState("bottom", "expanded");
      mod.setSheetState("bottom", "details");
      mod.closeSheetDetails();
      expect(root.dataset.bottomSheet).toBe("expanded");
    });

    it("leaves the sheet alone if the details are not open", () => {
      mod.setSheetState("bottom", "collapsed");
      mod.closeSheetDetails();
      expect(root.dataset.bottomSheet).toBe("collapsed");
    });

    it("does not carry the details stop across a change of layout", () => {
      mod.setSheetState("bottom", "details");
      flipQuery(false);
      expect(root.dataset.bottomSheet).toBe("expanded");
    });

    it("starts the details from the top each time they open", () => {
      mod.setSheetState("bottom", "details");
      $("filenameBanner").scrollTop = 120;
      mod.setSheetState("bottom", "expanded");
      expect($("filenameBanner").scrollTop).toBe(0);
    });
  });

  describe("dragging", () => {
    it("settles at the nearest stop after a slow drag", () => {
      // From expanded (456) up 300 to 156: nearer details (0) than expanded.
      drag($("controlPanel"), 400, 100, { duration: 2000 });
      expect(root.dataset.bottomSheet).toBe("details");
      // From details down 150: still nearer details.
      drag($("controlPanel"), 100, 250, { duration: 2000 });
      expect(root.dataset.bottomSheet).toBe("details");
    });

    it("flicks one stop at a time", () => {
      mod.setSheetState("bottom", "details");
      drag($("controlPanel"), 100, 140, { duration: 60 });
      expect(root.dataset.bottomSheet).toBe("expanded");
      drag($("controlPanel"), 300, 340, { duration: 60 });
      expect(root.dataset.bottomSheet).toBe("collapsed");
      drag($("bottomSheetHandle"), 700, 660, { duration: 60 });
      expect(root.dataset.bottomSheet).toBe("expanded");
    });

    it("pulls the sheet down from the details content when it is at the top", () => {
      mod.setSheetState("bottom", "details");
      drag($("descriptionText"), 200, 260, { duration: 60 });
      expect(root.dataset.bottomSheet).toBe("expanded");
    });

    it("leaves the details content to scroll once it has scrolled", () => {
      mod.setSheetState("bottom", "details");
      $("filenameBanner").scrollTop = 40;
      drag($("descriptionText"), 200, 400, { duration: 60 });
      expect(root.dataset.bottomSheet).toBe("details");
      expect($("panelStackContainer").style.transform).toBe("");
    });

    it("leaves an upward drag in the details content to scroll", () => {
      mod.setSheetState("bottom", "details");
      drag($("descriptionText"), 400, 300, { duration: 60 });
      expect(root.dataset.bottomSheet).toBe("details");
      expect($("panelStackContainer").classList.contains("sheet-dragging")).toBe(false);
    });

    it("always drags from the title row, however far the content has scrolled", () => {
      mod.setSheetState("bottom", "details");
      $("filenameBanner").scrollTop = 40;
      drag($("filenameText"), 100, 140, { duration: 60 });
      expect(root.dataset.bottomSheet).toBe("expanded");
    });
  });

  describe("native scrolling of the details", () => {
    beforeEach(() => mod.setSheetState("bottom", "details"));

    it("keeps the browser from claiming a downward drag at the top", () => {
      touch("touchstart", $("descriptionText"), [200]);
      expect(touch("touchmove", $("descriptionText"), [206]).defaultPrevented).toBe(true);
      expect(touch("touchmove", $("descriptionText"), [190]).defaultPrevented).toBe(true);
    });

    it("waits out a finger's jitter before deciding", () => {
      touch("touchstart", $("descriptionText"), [200]);
      expect(touch("touchmove", $("descriptionText"), [198]).defaultPrevented).toBe(false);
      expect(touch("touchmove", $("descriptionText"), [230]).defaultPrevented).toBe(true);
    });

    it("lets an upward first move scroll for the rest of the touch", () => {
      touch("touchstart", $("descriptionText"), [200]);
      expect(touch("touchmove", $("descriptionText"), [195]).defaultPrevented).toBe(false);
      expect(touch("touchmove", $("descriptionText"), [230]).defaultPrevented).toBe(false);
    });

    it("lets scrolled content scroll back up", () => {
      $("filenameBanner").scrollTop = 40;
      touch("touchstart", $("descriptionText"), [200]);
      expect(touch("touchmove", $("descriptionText"), [230]).defaultPrevented).toBe(false);
    });

    it("leaves pulldowns and pinches alone", () => {
      touch("touchstart", $("refTarget"), [200]);
      expect(touch("touchmove", $("refTarget"), [230]).defaultPrevented).toBe(false);
      touch("touchstart", $("descriptionText"), [200, 300]);
      expect(touch("touchmove", $("descriptionText"), [230, 330]).defaultPrevented).toBe(false);
    });

    it("does nothing at the other stops", () => {
      mod.setSheetState("bottom", "expanded");
      touch("touchstart", $("descriptionText"), [200]);
      expect(touch("touchmove", $("descriptionText"), [230]).defaultPrevented).toBe(false);
    });
  });
});
