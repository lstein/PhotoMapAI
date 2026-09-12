// Unit tests for back-button.js
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// Mock state.js (transitively touches album-manager and others). We only need
// state.album to build the thumbnail URL.
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: { album: "test-album" },
}));

const { backStack } = await import("../../photomap/frontend/static/javascript/back-stack.js");
const { initializeBackButton } = await import("../../photomap/frontend/static/javascript/back-button.js");

function emitSlideChanged(globalIndex) {
  window.dispatchEvent(
    new CustomEvent("slideChanged", {
      detail: { globalIndex, searchIndex: null, isSearchMode: false },
    })
  );
}

function setupDom() {
  // Mirrors control-panel.html: the chevron is a sibling of the Back button,
  // inside the shared .icon-with-chevron wrapper.
  document.body.innerHTML = `
    <div class="icon-with-chevron">
      <button id="backNavBtn" class="back-nav-disabled" title="Back"></button>
      <button id="backNavMenuBtn" class="menu-chevron" title="Recent positions" disabled></button>
    </div>
  `;
}

describe("back-button.js", () => {
  let navigator;

  beforeEach(() => {
    setupDom();
    backStack._reset();
    navigator = jest.fn();
    backStack.setNavigator(navigator);
    initializeBackButton();
  });

  describe("enabled / disabled state", () => {
    it("starts disabled when the stack is empty", () => {
      const btn = document.getElementById("backNavBtn");
      expect(btn.classList.contains("back-nav-disabled")).toBe(true);
    });

    it("remains disabled with only one entry", () => {
      emitSlideChanged(0);
      const btn = document.getElementById("backNavBtn");
      expect(btn.classList.contains("back-nav-disabled")).toBe(true);
    });

    it("enables once two or more entries are pushed", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      const btn = document.getElementById("backNavBtn");
      expect(btn.classList.contains("back-nav-disabled")).toBe(false);
    });

    it("re-disables after popping back down to a single entry", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      const btn = document.getElementById("backNavBtn");
      btn.click();
      // popOne emits backStackChanged synchronously — no need to wait for the
      // swiper to echo slideChanged (which it suppresses for in-place jumps).
      expect(btn.classList.contains("back-nav-disabled")).toBe(true);
    });
  });

  describe("click behavior", () => {
    it("pops one entry on left-click when enabled", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      emitSlideChanged(2);
      document.getElementById("backNavBtn").click();
      expect(navigator).toHaveBeenCalledWith(expect.objectContaining({ globalIndex: 1 }));
    });

    it("is a no-op while disabled", () => {
      emitSlideChanged(0);
      document.getElementById("backNavBtn").click();
      expect(navigator).not.toHaveBeenCalled();
    });
  });

  describe("contextmenu flyout", () => {
    function openFlyout(btn) {
      const ev = new MouseEvent("contextmenu", { clientX: 100, clientY: 100, bubbles: true, cancelable: true });
      btn.dispatchEvent(ev);
    }

    it("does not open a flyout when there's nothing to go back to", () => {
      emitSlideChanged(0);
      openFlyout(document.getElementById("backNavBtn"));
      expect(document.getElementById("backNavFlyout")).toBeNull();
    });

    it("opens a flyout with up to 12 recent thumbnails on right-click", () => {
      for (let i = 0; i < 14; i++) {
        emitSlideChanged(i);
      }
      openFlyout(document.getElementById("backNavBtn"));
      const flyout = document.getElementById("backNavFlyout");
      expect(flyout).not.toBeNull();
      const thumbs = flyout.querySelectorAll("img.back-nav-thumb");
      expect(thumbs.length).toBe(12);
      // Oldest of the 12 (globalIndex 1) pinned to bottom-right;
      // newest (globalIndex 12) lands top-left.
      expect(thumbs[0].src).toContain("/test-album/1?");
      expect(thumbs[0].style.gridColumn).toBe("4");
      expect(thumbs[0].style.gridRow).toBe("3");
      expect(thumbs[11].src).toContain("/test-album/12?");
      expect(thumbs[11].style.gridColumn).toBe("1");
      expect(thumbs[11].style.gridRow).toBe("1");
    });

    it("anchors a partial fill to the bottom-right corner with oldest in the corner", () => {
      // 3 previous positions — should occupy the rightmost column, bottom-up,
      // with the oldest pinned to the bottom-right.
      emitSlideChanged(0);
      emitSlideChanged(1);
      emitSlideChanged(2);
      emitSlideChanged(3);
      openFlyout(document.getElementById("backNavBtn"));
      const thumbs = document.querySelectorAll("#backNavFlyout img.back-nav-thumb");
      expect(thumbs.length).toBe(3);
      // Oldest (globalIndex 0) at bottom-right; newest of the three (globalIndex 2)
      // sits at the top of the same column.
      expect(thumbs[0].src).toContain("/test-album/0?");
      expect(thumbs[0].style.gridColumn).toBe("4");
      expect(thumbs[0].style.gridRow).toBe("3");
      expect(thumbs[2].src).toContain("/test-album/2?");
      expect(thumbs[2].style.gridColumn).toBe("4");
      expect(thumbs[2].style.gridRow).toBe("1");
    });

    it("refreshes thumbnails live when the back stack changes while open", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      emitSlideChanged(2);
      openFlyout(document.getElementById("backNavBtn"));
      let thumbs = document.querySelectorAll("#backNavFlyout img.back-nav-thumb");
      expect(thumbs.length).toBe(2);
      // Oldest (globalIndex 0) anchors the bottom-right corner.
      expect(thumbs[0].src).toContain("/test-album/0?");
      expect(thumbs[0].style.gridColumn).toBe("4");
      expect(thumbs[0].style.gridRow).toBe("3");

      // Simulate keyboard / scrollwheel navigation while the flyout stays open.
      emitSlideChanged(3);

      thumbs = document.querySelectorAll("#backNavFlyout img.back-nav-thumb");
      expect(thumbs.length).toBe(3);
      // Oldest still anchored to the bottom-right; newest now at the top of
      // the column.
      expect(thumbs[0].src).toContain("/test-album/0?");
      expect(thumbs[0].style.gridColumn).toBe("4");
      expect(thumbs[0].style.gridRow).toBe("3");
      expect(thumbs[2].src).toContain("/test-album/2?");
      expect(thumbs[2].style.gridColumn).toBe("4");
      expect(thumbs[2].style.gridRow).toBe("1");
    });

    it("clicking a thumbnail truncates the stack to that entry and navigates", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      emitSlideChanged(2);
      emitSlideChanged(3);
      openFlyout(document.getElementById("backNavBtn"));
      const thumbs = document.querySelectorAll("#backNavFlyout img.back-nav-thumb");
      // Click the thumbnail that maps to globalIndex 1 (oldest of the three shown).
      const target = Array.from(thumbs).find((img) => img.src.includes("/test-album/1?"));
      target.click();
      expect(navigator).toHaveBeenCalledWith(expect.objectContaining({ globalIndex: 1 }));
      expect(backStack.size()).toBe(2);
      expect(document.getElementById("backNavFlyout")).toBeNull();
    });
  });

  describe("the chevron pulldown", () => {
    const chevron = () => document.getElementById("backNavMenuBtn");

    it("starts disabled and tracks the Back button's own enabled state", () => {
      expect(chevron().disabled).toBe(true);
      emitSlideChanged(0);
      expect(chevron().disabled).toBe(true);
      emitSlideChanged(1);
      expect(chevron().disabled).toBe(false);
      document.getElementById("backNavBtn").click();
      expect(chevron().disabled).toBe(true);
    });

    it("opens the flyout on a plain left-click", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      chevron().click();
      expect(document.getElementById("backNavFlyout")).not.toBeNull();
    });

    it("closes the flyout when clicked a second time", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      chevron().click();
      chevron().click();
      expect(document.getElementById("backNavFlyout")).toBeNull();
    });

    it("does not open a flyout when there is nothing to go back to", () => {
      emitSlideChanged(0);
      expect(chevron().disabled).toBe(true);
      // dispatchEvent, not .click(): jsdom (like a browser) suppresses
      // synthetic activation on a disabled button, so .click() here would
      // pass even with the size guard deleted and no listener bound at all.
      chevron().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(document.getElementById("backNavFlyout")).toBeNull();
    });

    it("places the flyout clear of the chevron that opened it", () => {
      // The control panel is pinned to the bottom of the window, so a flyout
      // merely clamped into view lands on top of the chevron — and the click
      // meant to close it hits a thumbnail and navigates away instead. jsdom
      // has no layout, so the geometry has to be supplied.
      emitSlideChanged(0);
      emitSlideChanged(1);
      const chevronRect = { top: 727, bottom: 767, left: 300, right: 324, width: 24, height: 40 };
      // #backNavFlyout is a fixed 4x3 grid of 72px cells whatever the entry count.
      const FLYOUT_HEIGHT = 246;
      // Without this jsdom reports clientHeight 0, which makes the *unfixed*
      // clamp shove the flyout to the top of the screen — passing this test
      // for entirely the wrong reason.
      const heightSpy = jest.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
      const real = Element.prototype.getBoundingClientRect;
      jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function mocked() {
        if (this.id === "backNavMenuBtn") {
          return chevronRect;
        }
        if (this.id === "backNavFlyout") {
          return { top: 0, bottom: FLYOUT_HEIGHT, left: 0, right: 324, width: 324, height: FLYOUT_HEIGHT };
        }
        return real.call(this);
      });

      chevron().click();
      const top = parseFloat(document.getElementById("backNavFlyout").style.top);
      Element.prototype.getBoundingClientRect.mockRestore();
      heightSpy.mockRestore();

      expect(top + FLYOUT_HEIGHT).toBeLessThanOrEqual(chevronRect.top);
    });

    it("lets the click reach document so other popups can close themselves", () => {
      // Every other popup in the app (bookmarks menu, slideshow mode menu)
      // closes from its own listener on document. A stopPropagation() here
      // would strand them open behind the flyout.
      emitSlideChanged(0);
      emitSlideChanged(1);
      const onDocClick = jest.fn();
      document.addEventListener("click", onDocClick);
      chevron().click();
      document.removeEventListener("click", onDocClick);
      expect(onDocClick).toHaveBeenCalled();
    });

    it("opens the flyout on long-press rather than the browser's own menu", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      chevron().dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(document.getElementById("backNavFlyout")).not.toBeNull();
    });

    it("leaves right-click on the Back button itself working", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      const ev = new MouseEvent("contextmenu", { clientX: 100, clientY: 100, bubbles: true, cancelable: true });
      document.getElementById("backNavBtn").dispatchEvent(ev);
      expect(document.getElementById("backNavFlyout")).not.toBeNull();
    });
  });
});
