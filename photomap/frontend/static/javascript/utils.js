// utils.js
// This file contains utility functions for the application, such as showing and hiding a spinner.

// ShowSpinner and hideSpinner functions
export function showSpinner() {
  document.getElementById("spinner").style.display = "block";
}
export function hideSpinner() {
  document.getElementById("spinner").style.display = "none";
}

export function joinPath(dir, relpath) {
  if (dir.endsWith("/")) dir = dir.slice(0, -1);
  if (relpath.startsWith("/")) relpath = relpath.slice(1);
  return dir + "/" + relpath;
}

export function setCheckmarkOnIcon(iconElement, show) {
  // Remove any existing checkmark
  let checkOverlay =
    iconElement?.parentElement?.querySelector(".checkmark-overlay");
  if (checkOverlay) checkOverlay.remove();

  if (show) {
    const check = document.createElement("div");
    check.className = "checkmark-overlay";
    check.innerHTML = `
            <svg width="38" height="38" viewBox="0 0 32 32" style="position:absolute;top:-8px;left:-8px;pointer-events:none;">
                <circle cx="16" cy="16" r="15" fill="limegreen" opacity="0.8"/>
                <polyline points="10,17 15,22 23,12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;
    check.style.position = "absolute";
    check.style.top = "0";
    check.style.left = "0";
    check.style.width = "100%";
    check.style.height = "100%";
    check.style.display = "flex";
    check.style.alignItems = "center";
    check.style.justifyContent = "center";
    check.style.pointerEvents = "none";
    iconElement.parentElement.style.position = "relative";
    iconElement.parentElement.appendChild(check);
  }
}

export function getPercentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

export function isColorLight(hex) {
  // Remove hash if present
  hex = hex.replace("#", "");
  // Convert 3-digit to 6-digit
  if (hex.length === 3) hex = hex.split("").map((x) => x + x).join("");
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  // Perceived brightness formula
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 180;
}

// Utility debounce function
export function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Used by swiper and grid-view as a semaphore for loading state
// Wait helper: poll until batchLoading becomes false (with timeout)
let batchLoading = false;
export function setBatchLoading(isLoading) {
  batchLoading = isLoading;
}
export async function waitForBatchLoadingToFinish(timeoutMs = 10000, intervalMs = 50) {
  const start =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  while (batchLoading) {
    const now =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    if (now - start > timeoutMs) {
      console.warn(
        "waitForBatchLoadingToFinish: timeout after",
        timeoutMs,
        "ms"
      );
      break;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
