// umap-reindex.js
// The 🔄 button in the semantic-map titlebar, and its twin in the album badge
// at the top left of the swiper/grid view: a shortcut for "Update Index" on
// the current album without opening Album Management. One poller drives
// every button/ring pair listed in TARGETS, so both show the same state.
// While an index update runs, the button is swapped for a small progress ring whose fill
// tracks progress_percentage, whose colour tracks the phase (matching the
// Album Manager's status colours), and whose hover title carries the live
// status text. Clicking the ring does nothing — cancellation stays in the
// Album Manager. On completion an "albumIndexUpdated" event is dispatched
// so the map can reload itself, and an albumChanged/"refresh" event so the
// slideshow picks up the new image set without losing its place. The ring
// also animates for runs started elsewhere: it listens for the
// "albumIndexStarted" event fired when the Album Manager (Update Index /
// Update All) kicks off or attaches to an update of the current album.

import { getIndexMetadata, updateIndex } from "./index.js";
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

// Button / ring-container / ring-arc element ids, one triple per place the
// control appears. Missing elements (e.g. a test DOM with only the titlebar
// ids, or the badge in a page variant without it) are skipped.
const TARGETS = [
  { btn: "umapReindexBtn", progress: "umapReindexProgress", ring: "umapReindexRing" },
  { btn: "albumReindexBtn", progress: "albumReindexProgress", ring: "albumReindexRing" },
];

function elements() {
  const byId = (id) => document.getElementById(id);
  return {
    btns: TARGETS.map((t) => byId(t.btn)).filter(Boolean),
    progresses: TARGETS.map((t) => byId(t.progress)).filter(Boolean),
    // Ring arcs paired with their container so a partial DOM can't mismatch them.
    rings: TARGETS.map((t) => ({ progress: byId(t.progress), ring: byId(t.ring) })).filter(
      (pair) => pair.progress && pair.ring
    ),
  };
}

function showRing() {
  const { btns, progresses } = elements();
  for (const btn of btns) {
    btn.style.display = "none";
  }
  for (const progress of progresses) {
    progress.style.display = "inline-flex";
  }
}

function showButton() {
  const { btns, progresses } = elements();
  for (const btn of btns) {
    btn.style.display = "";
  }
  for (const progress of progresses) {
    progress.style.display = "none";
  }
}

function updateRing(progressData) {
  const { rings } = elements();
  if (rings.length === 0) {
    return;
  }

  const status = progressData.status;
  const stroke = PHASE_COLORS[status] || "#ff9800";

  // The traversal phase reports counts, not a completion fraction — show a
  // spinning quarter arc there and a real fill everywhere else.
  const indeterminate = status === "scanning";
  let percentage = Number(progressData.progress_percentage);
  if (!Number.isFinite(percentage)) {
    percentage = 0;
  }
  percentage = Math.min(100, Math.max(0, percentage));
  const fraction = indeterminate ? 0.25 : percentage / 100;
  const dashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));

  // Native title tooltip: shows the live status text on hover.
  const step = progressData.current_step || "Indexing in progress...";
  const suffix = indeterminate ? "" : ` (${Math.round(percentage)}%)`;
  const title = `${step}${suffix}`;

  for (const { progress, ring } of rings) {
    ring.style.stroke = stroke;
    progress.classList.toggle("indeterminate", indeterminate);
    ring.style.strokeDashoffset = dashoffset;
    progress.title = title;
  }
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
        await refreshAlbumImageData(albumKey);
      } else if (progress.status === "error") {
        for (const btn of elements().btns) {
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

// The index the swiper and grid are browsing changed underneath them:
// fetch the fresh image count and fire an albumChanged with
// changeType "refresh", which rebuilds the slides while slideState keeps
// the current position and any active search results.
async function refreshAlbumImageData(albumKey) {
  if (albumKey !== state.album) {
    return;
  }
  let metadata = null;
  try {
    metadata = await getIndexMetadata(albumKey);
  } catch (error) {
    console.error(`Failed to refresh index metadata for album ${albumKey}:`, error);
    return;
  }
  window.dispatchEvent(
    new CustomEvent("albumChanged", {
      detail: {
        album: albumKey,
        totalImages: metadata?.filename_count || 0,
        changeType: "refresh",
      },
    })
  );
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

// Wires every button/ring pair in TARGETS (the titlebar one and the album
// badge one). Name kept from when only the titlebar had the button.
export function initUmapReindexButton() {
  const { btns, progresses } = elements();
  if (btns.length === 0) {
    return;
  }
  // The titlebar is draggable; keep pointer-down and double-click on the
  // buttons (and rings) from reaching it, the same way the album select
  // does. The badge's click handler ignores its album row on its own.
  for (const el of [...btns, ...progresses]) {
    for (const evt of ["mousedown", "touchstart", "dblclick"]) {
      el.addEventListener(evt, (e) => e.stopPropagation());
    }
  }
  for (const btn of btns) {
    btn.addEventListener("click", () => {
      for (const b of elements().btns) {
        b.title = "Update this album's index";
      }
      // Let the click bubble (document-level handlers close open menus on
      // it) but drop focus so a later Enter/Space doesn't start another run.
      btn.blur();
      startUmapReindex();
    });
  }

  window.addEventListener("albumChanged", (e) => {
    // "refresh" is dispatched by this module when a run completes — the
    // ring is already down and the album hasn't changed, so nothing to do.
    if (e.detail?.changeType !== "refresh") {
      checkUmapReindexOngoing();
    }
  });

  // An index update was started elsewhere (Album Manager's "Update Index",
  // "Update All", auto-indexing). If it's for the album being viewed, raise
  // the ring and track that run; beginProgress is a no-op if the ring is
  // already polling (e.g. the run was started by this button).
  window.addEventListener("albumIndexStarted", (e) => {
    const albumKey = e.detail?.albumKey;
    if (albumKey && albumKey === state.album) {
      beginProgress(albumKey);
    }
  });
}
