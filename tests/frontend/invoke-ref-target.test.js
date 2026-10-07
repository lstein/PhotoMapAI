// Unit tests for invoke-ref-target.js — the drawer's "as a reference for
// <image generation|video generation>" pulldown.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// The choice is a persisted setting in state.js; stub the setter so the test
// sees what is persisted without the preferences PATCH machinery.
const mockState = { invokeRefTarget: "image" };
const setInvokeRefTarget = jest.fn((value) => {
  mockState.invokeRefTarget = value;
});
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  state: mockState,
  setInvokeRefTarget,
}));

const { applyRefTarget, refTargetFor } = await import("../../photomap/frontend/static/javascript/invoke-ref-target.js");

function renderControls() {
  document.body.innerHTML = `
    <table class="invoke-recall-controls"><tr><td>
      <button type="button" class="invoke-recall-btn" data-recall-mode="use_ref"></button>
      <select class="invoke-ref-target-select">
        <option value="image">image generation</option>
        <option value="video">video generation</option>
      </select>
    </td></tr></table>`;
  return document.querySelector(".invoke-recall-controls");
}

function choose(controls, value) {
  const select = controls.querySelector("select");
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("invoke-ref-target.js", () => {
  beforeEach(() => {
    mockState.invokeRefTarget = "image";
    setInvokeRefTarget.mockClear();
    document.body.classList.add("invoke-video-image-supported");
  });

  afterEach(() => {
    document.body.className = "";
    document.body.innerHTML = "";
  });

  it("defaults to image generation", () => {
    const controls = renderControls();
    applyRefTarget(controls);

    expect(controls.querySelector("select").value).toBe("image");
    expect(refTargetFor(controls.querySelector("button"))).toBe("image");
  });

  it("remembers a choice across the drawer re-rendering for the next slide", () => {
    choose(renderControls(), "video");
    expect(setInvokeRefTarget).toHaveBeenCalledWith("video");

    const next = renderControls();
    applyRefTarget(next);

    expect(next.querySelector("select").value).toBe("video");
    expect(refTargetFor(next.querySelector("button"))).toBe("video");
  });

  it("takes effect on the current slide immediately", () => {
    const controls = renderControls();
    applyRefTarget(controls);
    choose(controls, "video");

    expect(refTargetFor(controls.querySelector("button"))).toBe("video");
  });

  it("ignores a stored value it does not know", () => {
    mockState.invokeRefTarget = "audio";
    const controls = renderControls();
    applyRefTarget(controls);

    expect(controls.querySelector("select").value).toBe("image");
  });

  it("does nothing for a controls table without the pulldown (videos)", () => {
    document.body.innerHTML = `<table class="invoke-recall-controls invoke-video-controls"></table>`;
    const controls = document.querySelector(".invoke-recall-controls");

    applyRefTarget(controls);

    expect(controls.dataset.refTarget).toBeUndefined();
  });
});
