// umap-reindex.js
// The 🔄 button in the semantic-map titlebar: a shortcut for "Update Index"
// on the current album without opening Album Management. While an index
// update runs, the button is swapped for a small progress ring whose fill
// tracks progress_percentage, whose colour tracks the phase (matching the
// Album Manager's status colours), and whose hover title carries the live
// status text. Clicking the ring does nothing — cancellation stays in the
// Album Manager. On completion an "albumIndexUpdated" event is dispatched
// so the map can reload itself.

import { updateIndex } from "./index.js";
import { state } from "./state.js";
import { fetchJson } from "./utils.js";

// Mutable so tests can shorten the poll cadence.
export const reindexConfig = {
  pollInterval: 1000,
  maxPollFailures: 5,
};

const RUNNING_STATUSES = ["scanning", "downloading", "indexing", "mapping"];

// Same palette as the Album Manager's status lines.
const PHASE_COLORS = {
  scanning: "#ff9800",
  indexing: "#ff9800",
  downloading: "#9c27b0",
  mapping: "#2196f3",
};

const RING_CIRCUMFERENCE = 50.27; // 2πr for the r=8 ring in the template

let pollTimer = null;

function elements() {
  return {
    btn: document.getElementById("umapReindexBtn"),
    progress: document.getElementById("umapReindexProgress"),
    ring: document.getElementById("umapReindexRing"),
  };
}

function showRing() {
  const { btn, progress } = elements();
  if (btn) {
    btn.style.display = "none";
  }
  if (progress) {
    progress.style.display = "inline-flex";
  }
}

function showButton() {
  const { btn, progress } = elements();
  if (btn) {
    btn.style.display = "";
  }
  if (progress) {
    progress.style.display = "none";
  }
}

function updateRing(progressData) {
  const { progress, ring } = elements();
  if (!progress || !ring) {
    return;
  }

  const status = progressData.status;
  ring.style.stroke = PHASE_COLORS[status] || "#ff9800";

  // The traversal phase reports counts, not a completion fraction — show a
  // spinning quarter arc there and a real fill everywhere else.
  const indeterminate = status === "scanning";
  progress.classList.toggle("indeterminate", indeterminate);
  let percentage = Number(progressData.progress_percentage);
  if (!Number.isFinite(percentage)) {
    percentage = 0;
  }
  percentage = Math.min(100, Math.max(0, percentage));
  const fraction = indeterminate ? 0.25 : percentage / 100;
  ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));

  // Native title tooltip: shows the live status text on hover.
  const step = progressData.current_step || "Indexing in progress...";
  const suffix = indeterminate ? "" : ` (${Math.round(percentage)}%)`;
  progress.title = `${step}${suffix}`;
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  showButton();
}

// Poll the backend for this run's progress until it leaves a running state.
// Mirrors the Album Manager's card polling, but scoped to the titlebar ring.
function beginProgress(albumKey, initialProgress = null) {
  if (pollTimer) {
    return;
  }
  showRing();
  if (initialProgress) {
    updateRing(initialProgress);
  }

  let consecutiveFailures = 0;
  pollTimer = setInterval(async () => {
    try {
      const progress = await fetchJson(`index_progress/${albumKey}`);
      consecutiveFailures = 0;
      if (RUNNING_STATUSES.includes(progress.status)) {
        updateRing(progress);
        return;
      }
      stopPolling();
      if (progress.status === "completed") {
        window.dispatchEvent(new CustomEvent("albumIndexUpdated", { detail: { albumKey } }));
      } else if (progress.status === "error") {
        const { btn } = elements();
        if (btn) {
          btn.title = `Index update failed: ${progress.error_message || "unknown error"} — click to retry`;
        }
      }
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= reindexConfig.maxPollFailures) {
        console.error(`Giving up polling index progress for album ${albumKey}:`, error);
        stopPolling();
      }
    }
  }, reindexConfig.pollInterval);
}

export async function startUmapReindex() {
  const albumKey = state.album;
  if (!albumKey || pollTimer) {
    return;
  }

  // If an update is already running (Album Manager, Update All, another
  // tab), attach the ring to that run instead of starting a duplicate.
  try {
    const progress = await fetchJson(`index_progress/${albumKey}`);
    if (RUNNING_STATUSES.includes(progress.status)) {
      beginProgress(albumKey, progress);
      return;
    }
  } catch {
    // Progress endpoint unreachable — fall through and let updateIndex()
    // surface any real error to the user.
  }

  const response = await updateIndex(albumKey); // alerts + returns null on failure
  if (!response) {
    return;
  }
  beginProgress(albumKey);
}

// Attach the ring to an already-running update for the current album (e.g.
// one started from Album Management before this window was opened). Called
// when the semantic map is shown and when the album changes.
export async function checkUmapReindexOngoing() {
  const albumKey = state.album;
  if (!albumKey) {
    return;
  }
  if (pollTimer) {
    // A poller from a previous album may still be running after an album
    // switch; restart cleanly against the current album.
    stopPolling();
  }
  try {
    const progress = await fetchJson(`index_progress/${albumKey}`);
    if (RUNNING_STATUSES.includes(progress.status)) {
      beginProgress(albumKey, progress);
    }
  } catch {
    // No progress info — leave the plain button in place.
  }
}

export function initUmapReindexButton() {
  const { btn, progress } = elements();
  if (!btn) {
    return;
  }
  // The titlebar is draggable; keep pointer events on the button (and the
  // ring) from starting a drag, the same way the album select does.
  for (const el of [btn, progress]) {
    if (!el) {
      continue;
    }
    for (const evt of ["mousedown", "touchstart", "dblclick"]) {
      el.addEventListener(evt, (e) => e.stopPropagation());
    }
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    btn.title = "Update this album's index";
    startUmapReindex();
  });

  window.addEventListener("albumChanged", () => {
    checkUmapReindexOngoing();
  });
}
