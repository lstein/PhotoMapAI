// Unit tests for showToast() in utils.js.
//
// The toast utility creates a top-right container lazily on first call,
// stacks multiple toasts inside it, applies level-specific classes, and
// auto-dismisses after a configurable duration. These tests cover the
// contract that other modules rely on; styling is verified through class
// names rather than computed styles (jsdom doesn't run CSS).

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

import { showToast } from "../../photomap/frontend/static/javascript/utils.js";

describe("showToast", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    jest.useFakeTimers();
  });

  it("creates the container lazily on first call", () => {
    expect(document.getElementById("appToastContainer")).toBeNull();
    showToast("hello");
    expect(document.getElementById("appToastContainer")).not.toBeNull();
  });

  it("reuses the existing container on subsequent calls", () => {
    showToast("first");
    const containerAfterFirst = document.getElementById("appToastContainer");
    showToast("second");
    const containerAfterSecond = document.getElementById("appToastContainer");
    expect(containerAfterSecond).toBe(containerAfterFirst);
    expect(containerAfterSecond.children).toHaveLength(2);
  });

  it("renders the message as text content (HTML is escaped)", () => {
    showToast("<script>alert('xss')</script>");
    const toast = document.querySelector(".app-toast__message");
    // textContent assignment means the literal text shows, no script runs.
    expect(toast.textContent).toBe("<script>alert('xss')</script>");
    expect(document.querySelector("script")).toBeNull();
  });

  it("applies the level-specific class", () => {
    showToast("oh no", { level: "error" });
    expect(document.querySelector(".app-toast--error")).not.toBeNull();
    expect(document.querySelector(".app-toast--info")).toBeNull();
  });

  it("defaults to info when no level is given", () => {
    showToast("note");
    expect(document.querySelector(".app-toast--info")).not.toBeNull();
  });

  it("sets aria-live=assertive for error level", () => {
    showToast("oh no", { level: "error" });
    const toast = document.querySelector(".app-toast");
    expect(toast.getAttribute("role")).toBe("alert");
    expect(toast.getAttribute("aria-live")).toBe("assertive");
  });

  it("sets aria-live=polite for non-error level", () => {
    showToast("note", { level: "info" });
    const toast = document.querySelector(".app-toast");
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.getAttribute("aria-live")).toBe("polite");
  });

  it("auto-dismisses after the duration plus the leave-animation delay", () => {
    showToast("temporary", { duration: 3000 });
    expect(document.querySelectorAll(".app-toast")).toHaveLength(1);

    jest.advanceTimersByTime(3000);
    // After the duration the toast enters the "leaving" state but the
    // remove() call is queued behind the 200ms transition.
    expect(document.querySelector(".app-toast--leaving")).not.toBeNull();

    jest.advanceTimersByTime(200);
    expect(document.querySelectorAll(".app-toast")).toHaveLength(0);
  });

  it("does not auto-dismiss when duration is 0", () => {
    showToast("sticky", { duration: 0 });
    jest.advanceTimersByTime(60_000);
    expect(document.querySelectorAll(".app-toast")).toHaveLength(1);
  });

  it("renders a dismissible close button by default", () => {
    showToast("with x");
    const closeBtn = document.querySelector(".app-toast__close");
    expect(closeBtn).not.toBeNull();
    expect(closeBtn.getAttribute("aria-label")).toBe("Dismiss notification");
  });

  it("omits the close button when dismissible=false", () => {
    showToast("no x", { dismissible: false });
    expect(document.querySelector(".app-toast__close")).toBeNull();
  });

  it("dismisses when the close button is clicked", () => {
    showToast("click me", { duration: 0 });
    document.querySelector(".app-toast__close").click();
    // Click triggers the leave animation; advance past it.
    jest.advanceTimersByTime(200);
    expect(document.querySelectorAll(".app-toast")).toHaveLength(0);
  });

  it("returns a dismiss handle that removes the toast programmatically", () => {
    const { dismiss } = showToast("from code", { duration: 0 });
    expect(document.querySelectorAll(".app-toast")).toHaveLength(1);
    dismiss();
    jest.advanceTimersByTime(200);
    expect(document.querySelectorAll(".app-toast")).toHaveLength(0);
  });

  it("stacks multiple toasts in the container", () => {
    showToast("one");
    showToast("two");
    showToast("three");
    expect(document.querySelectorAll(".app-toast")).toHaveLength(3);
  });
});
