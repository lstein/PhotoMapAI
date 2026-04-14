// invoke-recall.js
// Wires up the Recall / Remix buttons emitted by the InvokeAI metadata
// formatter at the bottom of the metadata drawer. Pressing a button sends a
// request to the PhotoMap backend which in turn proxies a recall payload to
// the configured InvokeAI backend.

import { state } from "./state.js";

const STATUS_RESET_MS = 2000;

// Pull the sorted-album index out of the drawer's metadata_url, which is of
// the form ``get_metadata/{album_key}/{index}``. We deliberately parse the
// URL stored on the slide's dataset (via the drawer) rather than trusting
// state.album — metadata_url is what the server will honor.
export function parseMetadataUrl(metadataUrl) {
  if (!metadataUrl) {
    return null;
  }
  // Handles both relative and absolute forms.
  const cleaned = metadataUrl.replace(/^.*get_metadata\//, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const index = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(index)) {
    return null;
  }
  const albumKey = decodeURIComponent(parts.slice(0, -1).join("/"));
  return { albumKey, index };
}

function showStatus(button, kind) {
  const statusEl = button.querySelector(".invoke-recall-status");
  if (!statusEl) {
    return;
  }
  statusEl.classList.remove("success", "error");
  statusEl.innerHTML = "";
  if (kind === "success") {
    statusEl.classList.add("success");
    statusEl.textContent = "✓";
  } else if (kind === "error") {
    statusEl.classList.add("error");
    statusEl.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">' +
      '<path d="M3.5 2.4L7 5.9l3.5-3.5 1.1 1.1L8.1 7l3.5 3.5-1.1 1.1L7 8.1l-3.5 3.5-1.1-1.1L5.9 7 2.4 3.5z"/>' +
      "</svg>";
  }
  if (kind) {
    setTimeout(() => {
      statusEl.classList.remove("success", "error");
      statusEl.innerHTML = "";
    }, STATUS_RESET_MS);
  }
}

function showErrorMessage(button, message) {
  const controls = button.closest(".invoke-recall-controls");
  if (!controls) {
    return;
  }
  // Remove any existing error banner
  const existing = controls.parentElement.querySelector(".invoke-recall-error");
  if (existing) {
    existing.remove();
  }
  if (!message) {
    return;
  }
  const banner = document.createElement("div");
  banner.className = "invoke-recall-error";
  banner.textContent = message;
  controls.insertAdjacentElement("afterend", banner);
  setTimeout(() => banner.remove(), STATUS_RESET_MS * 3);
}

export async function sendRecall({ albumKey, index, includeSeed }) {
  const response = await fetch("invokeai/recall", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      album_key: albumKey,
      index,
      include_seed: includeSeed,
    }),
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body && body.detail) {
        message = body.detail;
      }
    } catch {
      // ignore JSON parse errors — fall back to the generic message
    }
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

function getMetadataUrlFromDrawer() {
  // Prefer the actual anchor element so we stay in sync with what the drawer
  // is currently displaying.
  const metadataLink = document.getElementById("metadataLink");
  if (metadataLink && metadataLink.getAttribute("href")) {
    return metadataLink.getAttribute("href");
  }
  return null;
}

async function handleRecallClick(button) {
  if (button.disabled) {
    return;
  }
  const mode = button.dataset.recallMode;
  const metadataUrl = getMetadataUrlFromDrawer();
  const parsed = parseMetadataUrl(metadataUrl);
  if (!parsed) {
    showStatus(button, "error");
    console.warn("Could not determine album/index for recall from metadataUrl", metadataUrl);
    return;
  }
  // Fall back to the live album if we couldn't recover one from the URL.
  const albumKey = parsed.albumKey || state.album;

  button.disabled = true;
  try {
    await sendRecall({
      albumKey,
      index: parsed.index,
      includeSeed: mode !== "remix",
    });
    showStatus(button, "success");
  } catch (err) {
    console.error("InvokeAI recall failed:", err);
    showStatus(button, "error");
    showErrorMessage(button, err && err.message ? err.message : "Recall failed");
  } finally {
    button.disabled = false;
  }
}

// Event delegation — the drawer's HTML is rebuilt every slide, so we can't
// attach listeners directly to the buttons. Listening on the document once
// is both simpler and reliable across re-renders.
document.addEventListener("click", (e) => {
  const button = e.target.closest(".invoke-recall-btn");
  if (!button) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  handleRecallClick(button);
});
