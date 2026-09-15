// cluster-utils.js
// Shared utilities for cluster color management and calculations
//
// Note: the only dependency here is on utils.js (for fetchJson, which has no
// further imports), so this module stays cheap to pull into tests. The
// autotagging-enabled flag is pushed in from state.js via
// setAutotaggingEnabledInLabels() rather than read from state directly.

import { fetchJson, showToast } from "./utils.js";

// Feature flag: when false, the cluster vocabulary label is shown ONLY in the
// UMAP hover popup (the original opt-in surface). When true, the label is also
// spliced into the score-display pill and the metadata-drawer badge. Flip to
// false to back out the score-display + metadata-drawer additions without
// touching their call sites.
export const SHOW_CLUSTER_LABELS_IN_BADGES = true;

// Module-level cache of {cluster_id: {label, alternates, score, medoid_index}}
// populated by umap.js's fetchUmapData. Other modules read it via
// getClusterLabelInfo() — they shouldn't import the umap module directly.
let clusterLabels = {};

// Announce a change to anything already on screen. Consumers that render a
// label (the metadata drawer, in particular) listen rather than poll: labels
// arrive asynchronously and the autotagging setting can be flipped while a
// drawer is open, and neither has a slide change to hang a re-render off.
// Guarded so importing this module outside a browser stays harmless.
function dispatchLabelEvent(name, detail) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function setClusterLabels(labels) {
  clusterLabels = labels || {};
  dispatchLabelEvent("clusterLabelsUpdated", { count: Object.keys(clusterLabels).length });
}

export function getClusterLabelInfo(cluster) {
  // JSON keys are strings; the rest of the app passes ints. Coerce here.
  return clusterLabels[String(cluster)] || null;
}

// Per-image label cache + in-flight deduper for the /image_label endpoint.
// Bounded LRU so navigating large albums doesn't grow unboundedly. The
// backend also caches; this is a session-local layer so repeated drawer
// opens for the same image don't even do a network round trip.
const imageLabelCache = new Map();
const imageLabelInFlight = new Map();
const IMAGE_LABEL_CACHE_MAX = 1024;

// Bumped by clearImageLabelCache(). A request that was already in the air when
// the cache was dropped must not write its answer into the fresh one: the
// clear happens precisely because the old answers can no longer be trusted
// (the album may have been reindexed, which shifts what an index refers to),
// and a slow /image_label response outliving the clear would reinstate exactly
// one stale entry — permanently, since a cache hit never refetches.
let imageLabelGeneration = 0;

// Module-local mirror of state.autotaggingEnabled — pushed in from state.js's
// setAutotaggingEnabled() and on initial restore. Defaults to false to match
// the state default, so any call before state restores is also safely gated.
let autotaggingEnabled = false;

export function setAutotaggingEnabledInLabels(enabled) {
  const next = !!enabled;
  // Called on every restore path (localStorage, then the server reconcile)
  // as well as from the settings checkbox, so most calls carry the value we
  // already hold. Only an actual change may drop caches or fire the event —
  // otherwise a boot that merely confirms the setting would throw away
  // labels the map fetch just installed.
  if (next === autotaggingEnabled) {
    return;
  }
  autotaggingEnabled = next;
  // Both caches describe the world as it was under the previous setting.
  // Turning autotagging off must stop the labels being displayed at all;
  // turning it back on cannot trust what was cached before, since the album
  // may have been reindexed while it was off. umap.js refetches the cluster
  // labels from its `autotaggingChanged` listener.
  clearImageLabelCache();
  setClusterLabels({});
  dispatchLabelEvent("autotaggingChanged", { enabled: next });
}

export function getImageLabelInfo(album, index) {
  // When autotagging is disabled, never hit the endpoint — the first request
  // would trigger the vocab embedding build server-side, which is the exact
  // thing the toggle exists to prevent. Don't cache the null either, so
  // turning the setting back on works without a manual cache reset.
  if (!autotaggingEnabled) {
    return Promise.resolve(null);
  }
  const key = `${album}:${index}`;
  if (imageLabelCache.has(key)) {
    const val = imageLabelCache.get(key);
    imageLabelCache.delete(key);
    imageLabelCache.set(key, val); // LRU bump
    return Promise.resolve(val);
  }
  if (imageLabelInFlight.has(key)) {
    return imageLabelInFlight.get(key);
  }
  const generation = imageLabelGeneration;
  const promise = trackVocabBuildRequest(
    (async () => {
      try {
        const body = await fetchJson(`image_label/${encodeURIComponent(album)}/${index}`).catch(() => null);
        const value = body && body.label ? body : null;
        // Still the cache this request was issued against? If not, the answer
        // is returned to whoever is awaiting it but never stored.
        if (generation !== imageLabelGeneration) {
          return value;
        }
        imageLabelCache.set(key, value);
        while (imageLabelCache.size > IMAGE_LABEL_CACHE_MAX) {
          const firstKey = imageLabelCache.keys().next().value;
          imageLabelCache.delete(firstKey);
        }
        return value;
      } catch (err) {
        console.warn("image_label fetch failed:", err);
        return null;
      } finally {
        // Only if it is still ours: a clear drops the whole map, and a later
        // request for the same key may already have registered itself. An
        // unconditional delete would evict that one and let a third caller
        // issue a duplicate request.
        if (imageLabelInFlight.get(key) === promise) {
          imageLabelInFlight.delete(key);
        }
      }
    })()
  );
  imageLabelInFlight.set(key, promise);
  return promise;
}

export function clearImageLabelCache() {
  imageLabelGeneration += 1;
  imageLabelCache.clear();
  imageLabelInFlight.clear();
}

// ---------------------------------------------------------------------------
// Slow-vocab-build toast
// ---------------------------------------------------------------------------
//
// `/cluster_labels` and `/image_label` can both be slow for two different
// server-side reasons: the vocab embedding build (first hit after startup or
// after the album's encoder changes — a few thousand phrases through
// CLIP/SigLIP, 20-30s on CPU) and the label recompute after the index
// changes (deleting an image invalidates umap.npz and the labels cache, so
// the next request refits UMAP over the whole album). The toast can't tell
// which is happening — it fires on any tracked request still pending after
// the grace period — so the message must stay generic; don't reword it to
// promise a "one-time" operation. We track in-flight requests with a counter
// and show a single sticky toast, dismissed as soon as the count returns to
// zero.
//
// Threshold is generous (3s) so a warm-cache call (sub-second) never flashes
// a toast. Exposed via `_setSlowVocabDelayMsForTests` so the Jest test can
// shorten it without depending on real timers.

const DEFAULT_SLOW_VOCAB_DELAY_MS = 3000;
const SLOW_VOCAB_MESSAGE = "Computing autotag labels — this can take a while on large albums.";

let slowVocabDelayMs = DEFAULT_SLOW_VOCAB_DELAY_MS;
let slowVocabInFlight = 0;
let slowVocabTimer = null;
let slowVocabToast = null;

export function _setSlowVocabDelayMsForTests(ms) {
  slowVocabDelayMs = ms;
}

function _maybeShowSlowVocabToast() {
  if (slowVocabToast || slowVocabTimer) {
    return;
  }
  slowVocabTimer = setTimeout(() => {
    slowVocabTimer = null;
    if (slowVocabInFlight > 0 && !slowVocabToast) {
      slowVocabToast = showToast(SLOW_VOCAB_MESSAGE, { level: "info", duration: 0 });
    }
  }, slowVocabDelayMs);
}

function _maybeDismissSlowVocabToast() {
  if (slowVocabInFlight > 0) {
    return;
  }
  if (slowVocabTimer) {
    clearTimeout(slowVocabTimer);
    slowVocabTimer = null;
  }
  if (slowVocabToast) {
    slowVocabToast.dismiss();
    slowVocabToast = null;
  }
}

/**
 * Wrap a vocab-triggering fetch so a sticky toast appears if the request
 * takes longer than the slow-vocab threshold. The toast is shared across all
 * concurrently tracked requests and dismissed once the last one settles.
 * Returns the same promise (resolved value and rejection propagate
 * unchanged).
 */
export function trackVocabBuildRequest(promise) {
  slowVocabInFlight += 1;
  _maybeShowSlowVocabToast();
  const settle = () => {
    slowVocabInFlight = Math.max(0, slowVocabInFlight - 1);
    _maybeDismissSlowVocabToast();
  };
  promise.then(settle, settle);
  return promise;
}

// Standard cluster color palette used across the application
export const CLUSTER_PALETTE = [
  "#e41a1c",
  "#377eb8",
  "#4daf4a",
  "#984ea3",
  "#ff7f00",
  "#ffff33",
  "#a65628",
  "#f781bf",
  "#999999",
  "#66c2a5",
  "#fc8d62",
  "#8da0cb",
  "#e78ac3",
  "#a6d854",
  "#ffd92f",
  "#e5c494",
  "#b3b3b3",
];

// Color for unclustered images
export const UNCLUSTERED_COLOR = "#cccccc";

/**
 * Get the color for a specific cluster based on UMAP points
 * @param {number} cluster - The cluster number (-1 for unclustered)
 * @param {Array} umapPoints - Array of UMAP points with cluster information
 * @returns {string} - Hex color code for the cluster
 */
export function getClusterColorFromPoints(cluster, umapPoints) {
  if (cluster === -1) {
    return UNCLUSTERED_COLOR;
  }

  if (!umapPoints || umapPoints.length === 0) {
    return UNCLUSTERED_COLOR;
  }

  // Get all unique clusters and find the index of the target cluster
  const uniqueClusters = [...new Set(umapPoints.map((p) => p.cluster))];
  const clusterIdx = uniqueClusters.indexOf(cluster);

  if (clusterIdx === -1) {
    return UNCLUSTERED_COLOR;
  }

  return CLUSTER_PALETTE[clusterIdx % CLUSTER_PALETTE.length];
}

/**
 * Get the size of a cluster based on UMAP points
 * @param {number} cluster - The cluster number
 * @param {Array} umapPoints - Array of UMAP points with cluster information
 * @returns {number} - Number of points in the cluster
 */
export function getClusterSize(cluster, umapPoints) {
  if (!umapPoints || umapPoints.length === 0) {
    return 0;
  }

  return umapPoints.filter((p) => p.cluster === cluster).length;
}

/**
 * Get cluster information for a specific image index
 * @param {number} globalIndex - The global index of the image
 * @param {Array} umapPoints - Array of UMAP points with cluster information
 * @returns {Object|null} - Object with cluster, color, and size, or null if not found
 */
export function getClusterInfoForImage(globalIndex, umapPoints) {
  if (!umapPoints || umapPoints.length === 0) {
    return null;
  }

  const point = umapPoints.find((p) => p.index === globalIndex);
  if (!point) {
    return null;
  }

  const cluster = point.cluster;
  const color = getClusterColorFromPoints(cluster, umapPoints);
  const size = getClusterSize(cluster, umapPoints);

  return { cluster, color, size };
}
