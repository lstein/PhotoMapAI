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

export function setClusterLabels(labels) {
  clusterLabels = labels || {};
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

// Module-local mirror of state.autotaggingEnabled — pushed in from state.js's
// setAutotaggingEnabled() and on initial restore. Defaults to false to match
// the state default, so any call before state restores is also safely gated.
let autotaggingEnabled = false;

export function setAutotaggingEnabledInLabels(enabled) {
  autotaggingEnabled = !!enabled;
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
  const promise = trackVocabBuildRequest(
    (async () => {
      try {
        const body = await fetchJson(`image_label/${encodeURIComponent(album)}/${index}`).catch(() => null);
        const value = body && body.label ? body : null;
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
        imageLabelInFlight.delete(key);
      }
    })()
  );
  imageLabelInFlight.set(key, promise);
  return promise;
}

export function clearImageLabelCache() {
  imageLabelCache.clear();
  imageLabelInFlight.clear();
}

// ---------------------------------------------------------------------------
// Slow-vocab-build toast
// ---------------------------------------------------------------------------
//
// `/cluster_labels` and `/image_label` both trigger the server-side vocab
// embedding build the first time they're hit after startup or after the
// album's encoder changes. The build encodes a few thousand phrases through
// CLIP/SigLIP and can take 20-30s on CPU. Without feedback the UI just looks
// frozen. We track in-flight vocab-triggering requests with a counter and
// show a single sticky toast if any of them is still pending after a short
// grace period; the toast is dismissed as soon as the count returns to zero.
//
// Threshold is generous (3s) so a warm-cache call (sub-second) never flashes
// a toast. Exposed via `_setSlowVocabDelayMsForTests` so the Jest test can
// shorten it without depending on real timers.

const DEFAULT_SLOW_VOCAB_DELAY_MS = 3000;
const SLOW_VOCAB_MESSAGE = "Preparing autotagging vocabulary — this is usually a one-time operation.";

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
