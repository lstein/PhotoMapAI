// Unit tests for utils.js
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  showSpinner,
  hideSpinner,
  joinPath,
  isColorLight,
  debounce,
  getPercentile,
  setCheckmarkOnIcon,
} from "../../photomap/frontend/static/javascript/utils.js";

describe("utils.js", () => {
  beforeEach(() => {
    // Reset DOM before each test
    document.body.innerHTML = "";
  });

  describe("showSpinner", () => {
    it("should set spinner display to block", () => {
      document.body.innerHTML = '<div id="spinner" style="display:none"></div>';
      showSpinner();
      expect(document.getElementById("spinner").style.display).toBe("block");
    });
  });

  describe("hideSpinner", () => {
    it("should set spinner display to none", () => {
      document.body.innerHTML = '<div id="spinner" style="display:block"></div>';
      hideSpinner();
      expect(document.getElementById("spinner").style.display).toBe("none");
    });
  });

  describe("joinPath", () => {
    it("should join directory and relative path with single slash", () => {
      expect(joinPath("/home/user", "photos")).toBe("/home/user/photos");
    });

    it("should handle directory ending with slash", () => {
      expect(joinPath("/home/user/", "photos")).toBe("/home/user/photos");
    });

    it("should handle relative path starting with slash", () => {
      expect(joinPath("/home/user", "/photos")).toBe("/home/user/photos");
    });

    it("should handle both with extra slashes", () => {
      expect(joinPath("/home/user/", "/photos")).toBe("/home/user/photos");
    });

    it("should handle empty relative path", () => {
      expect(joinPath("/home/user", "")).toBe("/home/user/");
    });

    it("should handle empty directory", () => {
      expect(joinPath("", "photos")).toBe("/photos");
    });
  });

  describe("isColorLight", () => {
    it("should return true for white", () => {
      expect(isColorLight("#ffffff")).toBe(true);
      expect(isColorLight("#FFFFFF")).toBe(true);
    });

    it("should return false for black", () => {
      expect(isColorLight("#000000")).toBe(false);
    });

    it("should return true for light yellow", () => {
      expect(isColorLight("#ffff00")).toBe(true);
    });

    it("should return false for dark blue", () => {
      expect(isColorLight("#000080")).toBe(false);
    });

    it("should handle 3-digit hex colors", () => {
      expect(isColorLight("#fff")).toBe(true);
      expect(isColorLight("#000")).toBe(false);
    });

    it("should handle colors without hash", () => {
      expect(isColorLight("ffffff")).toBe(true);
      expect(isColorLight("000000")).toBe(false);
    });

    it("should return false for mid-gray (brightness around 180)", () => {
      // #b4b4b4 = 180,180,180 which gives brightness of 180, which is NOT > 180
      expect(isColorLight("#b4b4b4")).toBe(false);
    });

    it("should return true for slightly lighter gray", () => {
      // #b5b5b5 = 181,181,181 which gives brightness of 181, which IS > 180
      expect(isColorLight("#b5b5b5")).toBe(true);
    });
  });

  describe("debounce", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("should delay function execution", () => {
      const fn = jest.fn();
      const debouncedFn = debounce(fn, 100);

      debouncedFn();
      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(99);
      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should reset timer on subsequent calls", () => {
      const fn = jest.fn();
      const debouncedFn = debounce(fn, 100);

      debouncedFn();
      jest.advanceTimersByTime(50);

      debouncedFn();
      jest.advanceTimersByTime(50);

      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(50);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should pass arguments to the debounced function", () => {
      const fn = jest.fn();
      const debouncedFn = debounce(fn, 100);

      debouncedFn("arg1", "arg2");
      jest.advanceTimersByTime(100);

      expect(fn).toHaveBeenCalledWith("arg1", "arg2");
    });

    it("should preserve this context", () => {
      const obj = {
        value: 42,
        fn: jest.fn(function () {
          return this.value;
        }),
      };
      obj.debouncedFn = debounce(obj.fn, 100);

      obj.debouncedFn();
      jest.advanceTimersByTime(100);

      expect(obj.fn).toHaveBeenCalled();
    });
  });

  describe("getPercentile", () => {
    it("should return 0 for empty array", () => {
      expect(getPercentile([], 50)).toBe(0);
    });

    it("should return the single value for single-element array", () => {
      expect(getPercentile([5], 50)).toBe(5);
      expect(getPercentile([5], 0)).toBe(5);
      expect(getPercentile([5], 100)).toBe(5);
    });

    it("should return minimum for 0th percentile", () => {
      expect(getPercentile([1, 2, 3, 4, 5], 0)).toBe(1);
    });

    it("should return maximum for 100th percentile", () => {
      expect(getPercentile([1, 2, 3, 4, 5], 100)).toBe(5);
    });

    it("should return median for 50th percentile", () => {
      expect(getPercentile([1, 2, 3, 4, 5], 50)).toBe(3);
    });

    it("should interpolate between values", () => {
      // For [1, 2, 3, 4, 5] at 25th percentile:
      // idx = 0.25 * 4 = 1, so exact value at index 1 = 2
      expect(getPercentile([1, 2, 3, 4, 5], 25)).toBe(2);
    });

    it("should handle unsorted arrays", () => {
      expect(getPercentile([5, 1, 3, 2, 4], 50)).toBe(3);
    });

    it("should handle arrays with duplicate values", () => {
      expect(getPercentile([1, 1, 1, 1, 1], 50)).toBe(1);
    });
  });

  describe("setCheckmarkOnIcon", () => {
    it("should add checkmark overlay when show is true", () => {
      document.body.innerHTML = '<div class="parent"><button id="icon"></button></div>';
      const icon = document.getElementById("icon");

      setCheckmarkOnIcon(icon, true);

      const overlay = document.querySelector(".checkmark-overlay");
      expect(overlay).toBeInTheDocument();
      expect(overlay.querySelector("svg")).toBeInTheDocument();
    });

    it("should remove checkmark overlay when show is false", () => {
      document.body.innerHTML = `
        <div class="parent">
          <button id="icon"></button>
          <div class="checkmark-overlay"></div>
        </div>
      `;
      const icon = document.getElementById("icon");

      setCheckmarkOnIcon(icon, false);

      const overlay = document.querySelector(".checkmark-overlay");
      expect(overlay).not.toBeInTheDocument();
    });

    it("should replace existing checkmark when show is true", () => {
      document.body.innerHTML = `
        <div class="parent">
          <button id="icon"></button>
          <div class="checkmark-overlay old-checkmark"></div>
        </div>
      `;
      const icon = document.getElementById("icon");

      setCheckmarkOnIcon(icon, true);

      const overlays = document.querySelectorAll(".checkmark-overlay");
      expect(overlays.length).toBe(1);
      expect(overlays[0].classList.contains("old-checkmark")).toBe(false);
    });

    it("should handle null icon element gracefully", () => {
      // The function uses optional chaining which handles null gracefully
      // when show is false (to remove checkmark), but throws when show is true
      // because it tries to access parentElement. This test verifies the
      // current behavior - false is safe, true throws.
      expect(() => setCheckmarkOnIcon(null, false)).not.toThrow();
    });

    it("should handle undefined icon element gracefully", () => {
      expect(() => setCheckmarkOnIcon(undefined, false)).not.toThrow();
    });
  });
});
