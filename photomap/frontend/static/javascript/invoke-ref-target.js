// invoke-ref-target.js
// The drawer's "as a reference for <image generation|video generation>"
// pulldown, which picks the InvokeAI tab Send / Append Image feed. The choice
// is a persisted per-device setting (state.invokeRefTarget). Kept apart from
// invoke-recall.js so both drawer renderers (metadata-drawer.js and
// grid-view.js) can use it without pulling in the recall request code.

import { setInvokeRefTarget, state } from "./state.js";

const REF_TARGETS = ["image", "video"];

function currentRefTarget() {
  return REF_TARGETS.includes(state.invokeRefTarget) ? state.invokeRefTarget : "image";
}

// Show the remembered tab in a freshly rendered controls table. The drawer's
// HTML is rebuilt every slide, so both renderers call this after inserting it.
export function applyRefTarget(controls) {
  const select = controls?.querySelector(".invoke-ref-target-select");
  if (!select) {
    return;
  }
  const target = currentRefTarget();
  select.value = target;
  controls.dataset.refTarget = target;
}

// The tab a Send / Append click goes to. The pulldown is hidden on backends
// without InvokeAI 7's image placement route, so a remembered "video" must
// not apply there.
export function refTargetFor(button) {
  if (!document.body.classList.contains("invoke-video-image-supported")) {
    return "image";
  }
  return button.closest(".invoke-recall-controls")?.dataset.refTarget === "video" ? "video" : "image";
}

document.addEventListener("change", (e) => {
  const select = e.target.closest?.(".invoke-ref-target-select");
  if (!select || !REF_TARGETS.includes(select.value)) {
    return;
  }
  setInvokeRefTarget(select.value);
  const controls = select.closest(".invoke-recall-controls");
  if (controls) {
    controls.dataset.refTarget = select.value;
  }
  // Hand the keyboard back to the slideshow shortcuts, which ignore a
  // focused <select>.
  select.blur();
});
