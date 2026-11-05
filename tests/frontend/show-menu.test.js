// show-menu.js: the Search panel's images/videos/both control.
//
// It owns no filter logic, so these cover what it does own: the choice reaching
// setMediaFilter, the icon and disabled state following the album, and a menu
// that closes in every way the app's other popups expect it to.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const JS = "../../photomap/frontend/static/javascript";

const mockState = { album: "alb", mediaFilter: "both" };
const fetchJson = jest.fn();
const setMediaFilter = jest.fn((value) => {
  mockState.mediaFilter = value;
  window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value } }));
});

jest.unstable_mockModule(`${JS}/state.js`, () => ({ state: mockState, setMediaFilter }));
jest.unstable_mockModule(`${JS}/utils.js`, () => ({ fetchJson }));

const mf = await import(`${JS}/media-filter.js`);
const { initializeShowMenu } = await import(`${JS}/show-menu.js`);

const MIXED = { album: "alb", total: 6, videoIndices: [1, 4] };
const ALL_PHOTOS = { album: "alb", total: 6, videoIndices: [] };
const ALL_VIDEOS = { album: "alb", total: 2, videoIndices: [0, 1] };

const button = () => document.getElementById("showMediaBtn");
const menu = () => document.getElementById("showMediaMenu");
const item = (value) => menu().querySelector(`[data-value="${value}"]`);
const iconHtml = () => document.getElementById("showMediaIcon").innerHTML;

function loadAlbum(mix) {
  mf._setMediaIndicesForTest(mix);
  window.dispatchEvent(new CustomEvent("mediaIndicesUpdated"));
}

function iconFor(value) {
  // The menu renders the same artwork the button adopts.
  button().click();
  const html = item(value).querySelector("svg").outerHTML;
  button().click();
  return html;
}

beforeEach(() => {
  mockState.mediaFilter = "both";
  setMediaFilter.mockClear();
  document.body.innerHTML = `
    <div class="search-icon-container">
      <button id="bookmarkMenuBtn"></button>
    </div>
    <div id="showContainer">
      <button id="showMediaBtn" aria-expanded="false" disabled><span id="showMediaIcon"></span></button>
    </div>`;
  mf._setMediaIndicesForTest(MIXED);
  initializeShowMenu();
});

afterEach(() => {
  // Closes any open menu, which removes its document and window listeners.
  window.dispatchEvent(new CustomEvent("mediaIndicesUpdated"));
});

describe("choosing", () => {
  it("offers images, videos and both, marking the active one", () => {
    button().click();
    expect([...menu().children].map((el) => el.dataset.value)).toEqual(["images", "videos", "both"]);
    expect(item("both").getAttribute("aria-current")).toBe("true");
    expect(item("images").hasAttribute("aria-current")).toBe(false);
    expect(button().getAttribute("aria-expanded")).toBe("true");
  });

  it("records the choice through the shared setter and closes", () => {
    button().click();
    item("videos").click();
    expect(setMediaFilter).toHaveBeenCalledWith("videos");
    expect(menu()).toBeNull();
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  it("changes the icon to match the mode", () => {
    const icons = Object.fromEntries(["images", "videos", "both"].map((v) => [v, iconFor(v)]));
    expect(new Set(Object.values(icons)).size).toBe(3);
    for (const value of ["images", "videos", "both"]) {
      button().click();
      item(value).click();
      expect(iconHtml()).toBe(icons[value]);
    }
  });

  it("follows a change made elsewhere, such as the server's copy arriving after boot", () => {
    const videosIcon = iconFor("videos");
    mockState.mediaFilter = "videos";
    window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value: "videos" } }));
    expect(iconHtml()).toBe(videosIcon);
    expect(document.getElementById("showContainer").title).toBe("Show: Videos only");
  });
});

describe("closing", () => {
  it("toggles shut from its own button", () => {
    button().click();
    button().click();
    expect(menu()).toBeNull();
  });

  it("closes on a click elsewhere", () => {
    button().click();
    document.body.click();
    expect(menu()).toBeNull();
  });

  it("closes even when the click stops propagating, as the bookmarks button's does", () => {
    const bookmarks = document.getElementById("bookmarkMenuBtn");
    bookmarks.addEventListener("click", (e) => e.stopPropagation());
    button().click();
    bookmarks.click();
    expect(menu()).toBeNull();
  });

  it("keeps Escape from reaching the app's shortcuts", () => {
    const shortcut = jest.fn();
    document.addEventListener("keydown", shortcut);
    button().click();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.removeEventListener("keydown", shortcut);
    expect(menu()).toBeNull();
    expect(shortcut).not.toHaveBeenCalled();
  });

  it("leaves no listeners behind to swallow later clicks or Escape", () => {
    const shortcut = jest.fn();
    document.addEventListener("keydown", shortcut);
    button().click();
    button().click();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.removeEventListener("keydown", shortcut);
    expect(shortcut).toHaveBeenCalledTimes(1);
  });

  it("closes when the album changes underneath it", () => {
    button().click();
    loadAlbum(ALL_PHOTOS);
    expect(menu()).toBeNull();
  });

  it("closes as soon as an album switch starts, before its media list lands", () => {
    button().click();
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: "other" } }));
    expect(menu()).toBeNull();
  });

  it("closes on a pointerdown that no click follows, as on the map's titlebar", () => {
    button().click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu()).toBeNull();
  });

  it("stays open for a pointerdown on itself, so that the click can land", () => {
    button().click();
    item("videos").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu()).not.toBeNull();
    button().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu()).not.toBeNull();
  });

  it.each([
    ["resize", window],
    ["fullscreenchange", document],
  ])("closes on %s, which moves or hides the panel it was placed against", (type, target) => {
    button().click();
    target.dispatchEvent(new Event(type));
    expect(menu()).toBeNull();
  });
});

describe("an album whose media list could not be read", () => {
  async function failLoad() {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fetchJson.mockRejectedValueOnce(new Error("500"));
    await mf.loadMediaIndices("alb");
    warn.mockRestore();
  }

  it("stays usable, reads the stored filter, and makes no claim about the album", async () => {
    // The map classifies its own points, so it can still be filtered, and this
    // is the only control that can change that.
    const videosIcon = iconFor("videos");
    mockState.mediaFilter = "videos";
    await failLoad();
    expect(button().disabled).toBe(false);
    expect(iconHtml()).toBe(videosIcon);
    const tooltip = document.getElementById("showContainer").title;
    expect(tooltip).toMatch(/could not read/);
    expect(tooltip).not.toMatch(/no videos/);

    button().click();
    item("both").click();
    expect(setMediaFilter).toHaveBeenCalledWith("both");
  });
});

describe("albums with nothing to filter", () => {
  it("disables on an all-photo album and says why", () => {
    loadAlbum(ALL_PHOTOS);
    expect(button().disabled).toBe(true);
    expect(document.getElementById("showContainer").title).toBe("This album contains no videos");
  });

  it("disables on an all-video album and says why", () => {
    loadAlbum(ALL_VIDEOS);
    expect(button().disabled).toBe(true);
    expect(document.getElementById("showContainer").title).toBe("This album contains only videos");
  });

  it("shows Both, not a stored filter the album cannot honour, and keeps the preference", () => {
    const bothIcon = iconFor("both");
    mockState.mediaFilter = "videos";
    loadAlbum(ALL_PHOTOS);
    expect(iconHtml()).toBe(bothIcon);
    expect(setMediaFilter).not.toHaveBeenCalled();
    expect(mockState.mediaFilter).toBe("videos");
  });

  it("comes back on a mixed album reading the stored filter", () => {
    const videosIcon = iconFor("videos");
    mockState.mediaFilter = "videos";
    loadAlbum(ALL_PHOTOS);
    loadAlbum(MIXED);
    expect(button().disabled).toBe(false);
    expect(iconHtml()).toBe(videosIcon);
  });
});
