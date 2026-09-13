// Unit tests for settings.js — the slideshow-mode radios in the settings modal.
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
const mockSetSlideshowMode = jest.fn();
jest.unstable_mockModule("../../photomap/frontend/static/javascript/slideshow.js", () => ({
  setSlideshowMode: mockSetSlideshowMode,
}));
const mockState = { mode: "chronological" };
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  clearPersistedSettingsCache: jest.fn(),
  saveSettingsToLocalStorage: jest.fn(),
  setAlbum: jest.fn(),
  setAutotaggingEnabled: jest.fn(),
  setWrapNavigation: jest.fn(),
  state: mockState,
}));

const { cacheElements, setupModeControls } = await import("../../photomap/frontend/static/javascript/settings.js");

const radio = (id) => document.getElementById(id);

describe("settings modal slideshow-mode radios", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Mirrors templates/modules/settings.html.
    document.body.innerHTML = `
      <div id="modeRadioGroup">
        <label><input type="radio" id="modeChronological" name="mode" value="chronological" checked /> Sequential</label>
        <label><input type="radio" id="modeRandom" name="mode" value="random" /> Shuffle</label>
      </div>
    `;
    mockState.mode = "chronological";
    cacheElements();
    setupModeControls();
  });

  it("reflects the current mode when set up", () => {
    expect(radio("modeChronological").checked).toBe(true);
    expect(radio("modeRandom").checked).toBe(false);
  });

  it("switches mode through the shared slideshow switch when a radio is picked", () => {
    // Regression: the radios used to write state.mode directly and then call
    // a swiper method that no longer exists, so the change threw and the
    // control-panel icon and buffer were never updated. They now go through
    // the same setSlideshowMode() as the Play button's menu.
    radio("modeRandom").checked = true;
    radio("modeRandom").dispatchEvent(new Event("change", { bubbles: true }));

    expect(mockSetSlideshowMode).toHaveBeenCalledTimes(1);
    expect(mockSetSlideshowMode).toHaveBeenCalledWith("random");
  });

  it("mirrors a mode change made from the Play button's menu", () => {
    mockState.mode = "random";
    window.dispatchEvent(new CustomEvent("slideshowModeChanged", { detail: { mode: "random" } }));

    expect(radio("modeRandom").checked).toBe(true);
    expect(radio("modeChronological").checked).toBe(false);
  });

  it("switches the mode once per click even after re-initialisation", () => {
    // initializeSettings re-runs on every settingsUpdated. Stacked change
    // listeners would call the switch once per re-run for a single click.
    setupModeControls();
    setupModeControls();

    radio("modeRandom").checked = true;
    radio("modeRandom").dispatchEvent(new Event("change", { bubbles: true }));

    expect(mockSetSlideshowMode).toHaveBeenCalledTimes(1);
  });
});
