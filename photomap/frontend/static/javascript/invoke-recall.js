// invoke-recall.js
// Wires up the Recall / Remix buttons emitted by the InvokeAI metadata
// formatter at the bottom of the metadata drawer. Pressing a button sends a
// request to the PhotoMap backend which in turn proxies a recall payload to
// the configured InvokeAI backend. Videos get their own group (Initial Video,
// Ref Video, and Recall / Remix for InvokeAI-generated videos), whose modes
// are prefixed ``video_``. Send / Append Image go to InvokeAI's image or video
// generation tab, as chosen in the drawer's "as a reference for" pulldown.

import { refTargetFor } from "./invoke-ref-target.js";
import { state } from "./state.js";
import { fetchJson } from "./utils.js";

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

function showErrorMessage(button, message, { note = false } = {}) {
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
  banner.className = note ? "invoke-recall-error invoke-recall-note" : "invoke-recall-error";
  banner.textContent = message;
  controls.insertAdjacentElement("afterend", banner);
  setTimeout(() => banner.remove(), STATUS_RESET_MS * 3);
}

// Rewrap an HttpError so ``err.message`` is the backend's ``detail`` string
// (what the drawer's error banner shows). Other error types pass through.
function _withDetailMessage(err) {
  if (err && err.name === "HttpError") {
    const detail = err.body?.detail;
    if (detail) {
      const wrapped = new Error(String(detail));
      wrapped.status = err.status;
      wrapped.body = err.body;
      return wrapped;
    }
  }
  return err;
}

export async function sendRecall({ albumKey, index, includeSeed }) {
  try {
    return await fetchJson("invokeai/recall", {
      json: { album_key: albumKey, index, include_seed: includeSeed },
    });
  } catch (err) {
    throw _withDetailMessage(err);
  }
}

export async function sendUseRefImage({ albumKey, index, append = false, target = "image" }) {
  try {
    return await fetchJson("invokeai/use_ref_image", {
      json: { album_key: albumKey, index, append, target },
    });
  } catch (err) {
    throw _withDetailMessage(err);
  }
}

export async function sendVideoRecall({ albumKey, index, includeSeed }) {
  try {
    return await fetchJson("invokeai/video/recall", {
      json: { album_key: albumKey, index, include_seed: includeSeed },
    });
  } catch (err) {
    throw _withDetailMessage(err);
  }
}

// ``target`` is "initial" (the Initial Video slot) or "reference" (appended
// to the reference videos).
export async function sendVideoMedia({ albumKey, index, target }) {
  try {
    return await fetchJson("invokeai/video/use_media", {
      json: { album_key: albumKey, index, target },
    });
  } catch (err) {
    throw _withDetailMessage(err);
  }
}

const FAILURE_MESSAGES = {
  use_ref: "Send to InvokeAI failed",
  append_ref: "Append to InvokeAI failed",
  video_initial: "Sending the initial video to InvokeAI failed",
  video_ref: "Sending the reference video to InvokeAI failed",
};

async function dispatch(mode, albumKey, index, button) {
  switch (mode) {
    case "use_ref":
    case "append_ref":
      // append_ref adds the image to InvokeAI's existing reference-image
      // list; use_ref replaces it.
      return sendUseRefImage({
        albumKey,
        index,
        append: mode === "append_ref",
        target: refTargetFor(button),
      });
    case "video_initial":
      return sendVideoMedia({ albumKey, index, target: "initial" });
    case "video_ref":
      return sendVideoMedia({ albumKey, index, target: "reference" });
    case "video_recall":
    case "video_remix":
      return sendVideoRecall({ albumKey, index, includeSeed: mode === "video_recall" });
    default:
      return sendRecall({ albumKey, index, includeSeed: mode !== "remix" });
  }
}

// A caveat worth showing on an otherwise successful request, or null.
function resultNote(result) {
  if (!result) {
    return null;
  }
  const notes = [];
  if (Array.isArray(result.skipped) && result.skipped.length > 0) {
    notes.push(`Not found on InvokeAI, so not recalled: ${result.skipped.join(", ")}`);
  }
  if (result.warning) {
    notes.push(result.warning);
  }
  return notes.length > 0 ? notes.join(" ") : null;
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
    const result = await dispatch(mode, albumKey, parsed.index, button);
    if (result && result.success === false) {
      // InvokeAI answered, but recalled nothing (e.g. no model installed).
      showStatus(button, "error");
      showErrorMessage(button, result.message || "InvokeAI recalled nothing");
      return;
    }
    showStatus(button, "success");
    const note = resultNote(result);
    showErrorMessage(button, note, { note: true });
  } catch (err) {
    console.error("InvokeAI recall failed:", err);
    showStatus(button, "error");
    const fallback = FAILURE_MESSAGES[mode] || "Recall failed";
    showErrorMessage(button, err && err.message ? err.message : fallback);
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
