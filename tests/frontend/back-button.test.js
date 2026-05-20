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
  document.body.innerHTML = `
    <button id="backNavBtn" class="back-nav-disabled" title="Back"></button>
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

    it("opens a flyout with up to 10 recent thumbnails on right-click", () => {
      for (let i = 0; i < 12; i++) {
        emitSlideChanged(i);
      }
      openFlyout(document.getElementById("backNavBtn"));
      const flyout = document.getElementById("backNavFlyout");
      expect(flyout).not.toBeNull();
      const thumbs = flyout.querySelectorAll("img.back-nav-thumb");
      expect(thumbs.length).toBe(10);
      // Newest first: the entry just below the current one (globalIndex 10).
      expect(thumbs[0].src).toContain("/test-album/10?");
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
});
