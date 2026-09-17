// Unit tests for settings.js — collapsing accordion sections so the settings
// modal never grows taller than the window.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// settings.js pulls in several other modules; stub them so the module loads
// cleanly under jsdom.
jest.unstable_mockModule("../../photomap/frontend/static/javascript/album-manager.js", () => ({
  albumManager: { fetchAvailableAlbums: jest.fn(() => Promise.resolve([])) },
  checkAlbumIndex: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/search-ui.js", () => ({
  exitSearchMode: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/preferences-client.js", () => ({
  cancelPendingPatches: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/slideshow.js", () => ({
  setSlideshowMode: jest.fn(),
}));
const mockState = {
  mode: "chronological",
  currentDelay: 10,
  album: "",
  showControlPanelText: true,
};
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  clearPersistedSettingsCache: jest.fn(),
  saveSettingsToLocalStorage: jest.fn(),
  setAlbum: jest.fn(),
  setAutotaggingEnabled: jest.fn(),
  setWrapNavigation: jest.fn(),
  state: mockState,
}));

// jsdom has no layout, so the real measurement is stubbed on both sides: the
// visible bottom edge here, and the modal's scrollHeight below.
let viewportBottom = 600;
let viewportSettled = true;
jest.unstable_mockModule("../../photomap/frontend/static/javascript/panel-anchor.js", () => ({
  visibleViewportBottom: () => viewportBottom,
  visibleViewportSettled: () => viewportSettled,
}));

// Height the modal gains once its fields have finished loading — the InvokeAI
// auth rows, in production. Applied when the field loaders' fetch resolves,
// which is the point the un-awaited version of openSettingsModal measured
// before. utils.js itself is left real; only the network underneath it moves.
let lateGrowth = 0;
let pendingGrowth = 0;
global.fetch = jest.fn(async () => {
  // Off the synchronous turn, as a real request is: applying the growth
  // eagerly would let a fire-and-forget populateModalFields() still see it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  lateGrowth = pendingGrowth;
  return { ok: true, status: 200, json: async () => ({ has_key: false }) };
});

const { cacheElements, openSettingsModal, setupAccordions } =
  await import("../../photomap/frontend/static/javascript/settings.js");

const SECTIONS = ["slideshow", "appearance", "autotagging", "api-integration"];

// Modal chrome that is there whether or not anything is expanded, plus what
// one expanded section costs. At viewportBottom 600 the fit budget is 568, so
// two sections fit (100 + 400) and three do not (100 + 600).
const CHROME_PX = 100;
const SECTION_PX = 200;

const header = (section) => document.querySelector(`.settings-accordion[data-section="${section}"] .accordion-header`);
const isOpen = (section) => header(section).getAttribute("aria-expanded") === "true";
const openSections = () => SECTIONS.filter(isOpen);

function buildModal() {
  document.body.innerHTML = `
    <div id="settingsOverlay" class="modal-overlay">
      <div class="modal-content settings-modal">
        <span id="delayValue">10</span>
        <input type="radio" id="modeChronological" name="mode" value="chronological" />
        <input type="radio" id="modeRandom" name="mode" value="random" />
        <input type="checkbox" id="showControlPanelTextCheckbox" />
        <input type="password" id="locationiqApiKeyInput" />
        ${SECTIONS.map(
          (section) => `
          <div class="settings-accordion" data-section="${section}">
            <button class="accordion-header" type="button" aria-expanded="false">${section}</button>
            <div class="accordion-body"></div>
          </div>`
        ).join("")}
      </div>
    </div>
  `;

  const modal = document.querySelector(".settings-modal");
  Object.defineProperty(modal, "scrollHeight", {
    configurable: true,
    get: () => CHROME_PX + document.querySelectorAll(".accordion-body.open").length * SECTION_PX + lateGrowth,
  });
}

describe("settings modal accordion fitting", () => {
  beforeEach(() => {
    localStorage.clear();
    viewportBottom = 600;
    viewportSettled = true;
    lateGrowth = 0;
    pendingGrowth = 0;
    buildModal();
    cacheElements();
    setupAccordions();
  });

  it("leaves the other sections alone while there is room", () => {
    header("slideshow").click();
    header("appearance").click();

    expect(openSections()).toEqual(["slideshow", "appearance"]);
  });

  it("collapses the oldest open section when a new one would overflow", () => {
    header("slideshow").click();
    header("appearance").click();
    header("autotagging").click();

    expect(openSections()).toEqual(["appearance", "autotagging"]);
    expect(localStorage.getItem("settings-accordion-slideshow")).toBe("false");
  });

  it("keeps collapsing until the dialog fits", () => {
    viewportBottom = 332; // budget 300 — room for one section only

    header("slideshow").click();
    header("appearance").click();
    header("autotagging").click();

    expect(openSections()).toEqual(["autotagging"]);
  });

  it("never collapses the section the user just opened, even alone", () => {
    // A section taller than the whole window: shutting it on the way in would
    // make it impossible to open. The modal's max-height scrolls instead.
    viewportBottom = 150;

    header("slideshow").click();

    expect(openSections()).toEqual(["slideshow"]);
  });

  it("does not collapse anything when a section is closed", () => {
    header("slideshow").click();
    header("appearance").click();
    header("appearance").click();

    expect(openSections()).toEqual(["slideshow"]);
  });

  it("collapses by age of opening, not document order", () => {
    header("appearance").click();
    header("slideshow").click();
    header("api-integration").click();

    // "appearance" was opened first, so it goes even though "slideshow" sits
    // above it in the dialog.
    expect(openSections()).toEqual(["slideshow", "api-integration"]);
  });

  it("re-opening a section refreshes its place in the queue", () => {
    header("slideshow").click();
    header("appearance").click();
    header("slideshow").click(); // close
    header("slideshow").click(); // and open again — now the newest
    header("autotagging").click();

    expect(openSections()).toEqual(["slideshow", "autotagging"]);
  });

  it("trims sections restored from a larger window when the modal opens", async () => {
    SECTIONS.forEach((section) => localStorage.setItem(`settings-accordion-${section}`, "true"));
    buildModal();
    cacheElements();
    setupAccordions();
    expect(openSections()).toEqual(SECTIONS);

    await openSettingsModal();

    // Restore order is document order, so the last two survive.
    expect(openSections()).toEqual(["autotagging", "api-integration"]);
  });

  it("measures only after the fields the modal grows with have loaded", async () => {
    // populateModalFields() reaches the network, and a reachable InvokeAI
    // backend reveals three more rows a round trip later. Measuring before
    // they land leaves the dialog over budget with nothing to re-check it.
    pendingGrowth = 200;
    ["slideshow", "appearance"].forEach((s) => localStorage.setItem(`settings-accordion-${s}`, "true"));
    buildModal();
    cacheElements();
    setupAccordions();

    await openSettingsModal();

    expect(openSections()).toEqual(["appearance"]);
  });

  it("collapses nothing while the viewport measurement is unsettled", () => {
    // A raised software keyboard shrinks the visible viewport exactly as a
    // stranded layout viewport does. Tapping a header blurs the field first,
    // so a section is opened while the keyboard is still up — collapsing on
    // that reading would persist a decision the keyboard caused.
    header("slideshow").click();
    viewportSettled = false;
    viewportBottom = 150; // what the keyboard makes it look like

    header("appearance").click();

    expect(openSections()).toEqual(["slideshow", "appearance"]);
    expect(localStorage.getItem("settings-accordion-slideshow")).toBe("true");
  });

  it("spends the whole budget, and not a pixel more", () => {
    // Pins MODAL_VIEWPORT_MARGIN: two sections measure exactly 500.
    viewportBottom = 532; // budget 500
    header("slideshow").click();
    header("appearance").click();
    expect(openSections()).toEqual(["slideshow", "appearance"]);

    localStorage.clear();
    buildModal();
    cacheElements();
    setupAccordions();
    viewportBottom = 531; // budget 499 — one pixel short
    header("slideshow").click();
    header("appearance").click();
    expect(openSections()).toEqual(["appearance"]);
  });

  it("toggles once per click when set up twice over the same dialog", () => {
    // A stacked click listener would open and immediately re-close the
    // section. setupAccordions is written to be re-runnable over a dialog that
    // is already wired up.
    setupAccordions();
    setupAccordions();

    header("slideshow").click();

    expect(isOpen("slideshow")).toBe(true);
  });
});
