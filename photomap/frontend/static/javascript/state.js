// state.js
// This file manages the state of the application, including slide management and metadata handling.
import { albumManager } from "./album-manager.js";
import { setAutotaggingEnabledInLabels } from "./cluster-utils.js";
import { getIndexMetadata } from "./index.js";
import {
  fetchPreferences,
  flushPendingPatches,
  loadServerTimestamp,
  queuePreferencePatch,
} from "./preferences-client.js";
import { fetchJson } from "./utils.js";

// TO DO - CONVERT THIS INTO A CLASS
export const state = {
  single_swiper: null, // Will be initialized in swiper.js
  grid_swiper: null, // Will be initialized in grid-view.js
  gridViewActive: false, // Whether the grid view is active
  currentDelay: 5, // Delay in seconds for slide transitions
  showControlPanelText: true, // Whether to show text in control panels
  mode: "chronological", // next slide selection when no search is active ("random", "chronological")
  highWaterMark: 20, // Maximum number of slides to load at once
  album: null, // Default album to use
  availableAlbums: [], // List of available albums
  dataChanged: true, // Flag to indicate if umap data has changed (TO DO - REVISIT THIS)
  suppressDeleteConfirm: false, // Flag to suppress delete confirmation dialogs
  moveToTrash: true, // Move deleted images to Trash/Recycle Bin instead of permanently deleting
  wrapNavigation: false, // Whether scrolling past first/last image wraps to the other end
  gridThumbSizeFactor: 1.0, // Scaling factor for grid thumbnails
  swiper: null, // backwards compatibility hack; contains the single_swiper.swiper instance
  albumLocked: false, // Whether album management is locked
  // Per-album search settings — values are loaded from the album's config on
  // album switch and persisted back via /update_album/ when the user edits
  // them in the search dialog. Initial values are placeholders before the
  // first album is loaded.
  minSearchScore: 0.2, // [0.0, 1.0]
  maxSearchResults: 100, // positive integer
  useQueryOptimization: true, // SigLIP-only; ignored by other encoders
  albumEncoderSpec: null, // mirrored from the active album's config
  // persisted UMAP settings
  umapShowLandmarks: true, // Show landmarks in UMAP
  umapShowHoverThumbnails: true, // Show hover thumbnails in UMAP
  umapExitFullscreenOnSelection: true, // Exit fullscreen when cluster is selected
  umapClickSelectsCluster: true, // Whether click selects cluster or single image
  umapControlsVisible: true, // Whether the UMAP controls panel is visible
  showMetadataFields: true, // Whether the metadata-drawer fields table is shown
  autotaggingEnabled: false, // Whether to build the vocab index and show cluster/image labels
  // Dataset Curator panel state. The curator panel reads these on open and
  // writes them through the standard PERSISTED_SETTINGS setters on every
  // input change, so the next visit reopens the panel with the same values.
  curationTargetCount: 80, // [10, 1000]
  curationIterations: 20, // [1, 30]
  curationMethod: "fps", // "fps" (Diversity) or "kmeans" (Blocks)
  curationExcludeThreshold: 90, // [1, 100] — the % match threshold for "Exclude Matches"
  curationExportPath: "", // last-used export folder
};

// ---------------------------------------------------------------------------
// Persisted-setting registry
// ---------------------------------------------------------------------------
// Each entry is the source of truth for: how to parse the stored string back
// into a state value, how to serialize it again, and which side-effects fire
// on change. The auto-generated setter and the restore/save loops both
// consult this table — there's deliberately no second source of truth.
//
// `album` is *not* listed here. Its restore needs an async server roundtrip
// (the dropdown must be validated against the current album list) and its
// setter does much more than store-and-dispatch (loads per-album search
// settings, fetches index metadata, fires `albumChanged`). It stays as the
// hand-written `setAlbum` below, and its persistence round trip is handled
// inline in `restoreFromLocalStorage` / `saveSettings`.
//
// Persistence is hybrid: localStorage acts as a synchronous paint cache so
// the first frame after page load uses the last-known values without
// awaiting the network. The server (per-device, keyed by an HttpOnly cookie)
// is the source of truth; `reconcileWithServer` runs asynchronously after
// boot and either pulls newer server state down or pushes locally-newer
// values up. The setters fire-and-forget via `queuePreferencePatch`, which
// debounces and merges concurrent updates into one PATCH.
//
// `minSearchScore` / `maxSearchResults` / `useQueryOptimization` are also
// excluded — they live on the album config (not localStorage) and have
// clamp/coerce rules that don't fit the generic shape.

/**
 * @typedef {Object} SettingSpec
 * @property {string} key            State property name (also localStorage key).
 * @property {"bool"|"int"|"float"|"string"} type  How to parse / serialize.
 * @property {*} [default]           Fallback when nothing valid is in storage.
 * @property {() => any} [dynamicDefault]
 *                                   Called once when no stored value exists;
 *                                   wins over `default`. Used by
 *                                   `showControlPanelText` which derives its
 *                                   default from screen width.
 * @property {(value: any) => void} [onSet]
 *                                   Extra side-effect after assignment;
 *                                   fires from both `restoreFromLocalStorage`
 *                                   and the generated setter so the side-effect
 *                                   matches the in-memory state.
 */

/** @type {SettingSpec[]} */
const PERSISTED_SETTINGS = [
  { key: "currentDelay", type: "int", default: 5 },
  { key: "mode", type: "string", default: "chronological" },
  {
    key: "showControlPanelText",
    type: "bool",
    default: true,
    dynamicDefault: () => window.innerWidth >= 600,
  },
  { key: "gridViewActive", type: "bool", default: false },
  { key: "suppressDeleteConfirm", type: "bool", default: false },
  { key: "moveToTrash", type: "bool", default: true },
  { key: "wrapNavigation", type: "bool", default: false },
  { key: "gridThumbSizeFactor", type: "float", default: 1.0 },
  { key: "umapShowLandmarks", type: "bool", default: true },
  { key: "umapShowHoverThumbnails", type: "bool", default: true },
  { key: "umapExitFullscreenOnSelection", type: "bool", default: true },
  { key: "umapClickSelectsCluster", type: "bool", default: true },
  { key: "umapControlsVisible", type: "bool", default: true },
  { key: "showMetadataFields", type: "bool", default: true },
  {
    key: "autotaggingEnabled",
    type: "bool",
    default: false,
    onSet: (value) => setAutotaggingEnabledInLabels(value),
  },
  // Dataset Curator
  { key: "curationTargetCount", type: "int", default: 80 },
  { key: "curationIterations", type: "int", default: 20 },
  { key: "curationMethod", type: "string", default: "fps" },
  { key: "curationExcludeThreshold", type: "int", default: 90 },
  { key: "curationExportPath", type: "string", default: "" },
];

function _parseStored(raw, type) {
  if (raw === null) {
    return undefined;
  }
  if (type === "bool") {
    return raw === "true";
  }
  if (type === "int") {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "float") {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return raw;
}

function _coerce(value, type) {
  if (type === "bool") {
    return !!value;
  }
  if (type === "int") {
    return parseInt(value, 10);
  }
  if (type === "float") {
    return parseFloat(value);
  }
  return String(value);
}

function _serialize(value, type) {
  if (type === "bool") {
    return value ? "true" : "false";
  }
  return String(value);
}

document.addEventListener("DOMContentLoaded", async () => {
  await restoreFromLocalStorage();
  initializeFromServer();
  window.stateIsReady = true; // Flag for modules that may need to know if state is ready
  window.dispatchEvent(new Event("stateReady"));
  // Reconcile with the server in the background. We don't block stateReady
  // on this — the LS paint-cache values are good enough to start the app,
  // and pulling fresh server values can happen as the user interacts.
  reconcileWithServer().catch((err) => console.warn("Server preferences reconciliation failed:", err));
});

// Flush any queued PATCH on page hide / unload so a quick "change a setting
// then close the tab" sequence doesn't lose the change. ``visibilitychange``
// is what iOS Safari actually fires reliably; ``beforeunload`` covers
// desktop closes. The flush is fire-and-forget — browsers don't guarantee
// async work completes during unload, but on mobile backgrounding the
// debounce window is short enough that the in-flight request usually wins.
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushPendingPatches();
  }
});
window.addEventListener("beforeunload", () => {
  flushPendingPatches();
});

// Initialize the state from the initial URL.
export function initializeFromServer() {
  if (window.slideshowConfig?.currentDelay > 0) {
    setDelay(window.slideshowConfig.currentDelay);
  }

  if (window.slideshowConfig?.mode !== null) {
    setMode(window.slideshowConfig.mode);
  }

  if (window.slideshowConfig?.album !== null) {
    setAlbum(window.slideshowConfig.album);
  }

  if (window.slideshowConfig?.albumLocked !== undefined) {
    state.albumLocked = window.slideshowConfig.albumLocked;
  }
}

// Restore state from local storage (the synchronous paint cache).
//
// The server is the durable source of truth — `reconcileWithServer` runs
// after this and may overwrite some of these values — but localStorage is
// what we read on every boot so the first frame doesn't flicker waiting
// for the network. On iOS where LS can be evicted, this restore is a
// no-op and the app boots from in-memory defaults until reconciliation
// pulls the server copy down.
export async function restoreFromLocalStorage() {
  // Generic specs: parse-or-default, then run any onSet side-effects so the
  // app boots in a consistent state.
  for (const spec of PERSISTED_SETTINGS) {
    const raw = localStorage.getItem(spec.key);
    const parsed = _parseStored(raw, spec.type);
    if (parsed !== undefined) {
      state[spec.key] = parsed;
    } else if (raw === null && spec.dynamicDefault) {
      state[spec.key] = spec.dynamicDefault();
    }
    // If parsing failed (corrupt value), the existing default on `state`
    // stays in place. Either way, surface the resolved value to onSet.
    if (spec.onSet) {
      spec.onSet(state[spec.key]);
    }
  }

  // Album is special: pick whichever stored key still exists in the live
  // album list, else fall back to the first available album.
  const storedAlbum = localStorage.getItem("album");
  const albumList = await albumManager.fetchAvailableAlbums();
  if (!albumList || albumList.length === 0) {
    return;
  }
  const validAlbum = storedAlbum && albumList.find((album) => album.key === storedAlbum) ? storedAlbum : null;
  state.album = validAlbum || albumList[0].key;
}

// Build the partial payload the server expects from the current state.
// Used both by reconciliation (to compare against server values) and by
// saveSettings (to ship a single PATCH per debounce window).
function _stateToPrefsPayload() {
  const payload = {};
  for (const spec of PERSISTED_SETTINGS) {
    payload[spec.key] = state[spec.key];
  }
  if (state.album !== null && state.album !== undefined) {
    payload.album = state.album;
  }
  return payload;
}

// Pull the server's view of preferences and reconcile with what we just
// loaded from localStorage. Three cases:
//
//   1. Server has a newer record than our cached server timestamp — server
//      values win; overwrite state + LS and re-run onSet side-effects.
//   2. We have local values that differ from the server (migration from a
//      pre-server-prefs build, or offline edits since the last successful
//      PATCH) — push them up.
//   3. We're in sync — record the server timestamp and exit.
//
// If the GET fails (server down, network error, etc.), we keep using the
// LS-cached values. The next setter call will trigger a PATCH and naturally
// re-establish the relationship once the server is reachable.
async function reconcileWithServer() {
  const serverPrefs = await fetchPreferences();
  if (serverPrefs === null) {
    return; // Network/server failure — keep LS values, no further action.
  }

  const localServerTs = loadServerTimestamp();
  const serverTs = typeof serverPrefs.updatedAt === "number" ? serverPrefs.updatedAt : 0;

  if (serverTs > 0 && serverTs > localServerTs) {
    // Case 1: server is authoritative.
    _applyServerPrefs(serverPrefs);
    return;
  }

  // Case 2 / 3: figure out whether to push anything up. Build the payload
  // from current state and diff against the server. Any field that differs
  // is queued for PATCH; if nothing differs we just record the server
  // timestamp so future boots short-circuit cleanly.
  const local = _stateToPrefsPayload();
  const partial = {};
  for (const key of Object.keys(local)) {
    if (!_valuesEqual(local[key], serverPrefs[key])) {
      partial[key] = local[key];
    }
  }
  if (Object.keys(partial).length > 0) {
    queuePreferencePatch(partial);
  } else {
    // Already in sync — record the timestamp so subsequent boots don't
    // re-PATCH on every page load.
    try {
      localStorage.setItem("_prefServerUpdatedAt", String(serverTs));
    } catch {
      // Non-fatal — same behavior as any other LS write failure.
    }
  }
}

// Apply a server-authoritative preferences record to state + LS, running
// onSet side-effects so the UI (e.g. cluster-label visibility) reflects
// the new values.
function _applyServerPrefs(prefs) {
  for (const spec of PERSISTED_SETTINGS) {
    if (prefs[spec.key] === undefined || prefs[spec.key] === null) {
      continue;
    }
    const coerced = _coerce(prefs[spec.key], spec.type);
    if ((spec.type === "int" || spec.type === "float") && !Number.isFinite(coerced)) {
      continue;
    }
    state[spec.key] = coerced;
    if (spec.onSet) {
      spec.onSet(coerced);
    }
  }
  // Album: trust the server only if it points at an album we know about.
  // Avoids landing on a dropdown value the local config doesn't have (the
  // album lock list, for instance, may exclude what the server has saved).
  if (typeof prefs.album === "string" && prefs.album !== state.album) {
    const known = (state.availableAlbums || []).some((a) => a.key === prefs.album);
    if (known) {
      // Don't call setAlbum here — we're inside the boot path and don't
      // want to fire albumChanged for a value the rest of the app may
      // already have wired up. The straight assignment + LS write is
      // enough; the next setAlbum call from user action will re-sync.
      state.album = prefs.album;
    }
  }
  _writeAllToLocalStorage();
  try {
    localStorage.setItem("_prefServerUpdatedAt", String(prefs.updatedAt || 0));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("preferencesReconciled", { detail: prefs }));
}

function _valuesEqual(a, b) {
  // null/undefined treated as equivalent so a server null doesn't force
  // an unnecessary PATCH when the client has no value either.
  if (a === undefined || a === null) {
    return b === undefined || b === null;
  }
  return a === b;
}

// Write the full PERSISTED_SETTINGS set (plus album) to LS in one pass.
// Used by both `saveSettings` and `_applyServerPrefs`. Failure is logged
// once; subsequent calls retry.
function _writeAllToLocalStorage() {
  try {
    for (const spec of PERSISTED_SETTINGS) {
      localStorage.setItem(spec.key, _serialize(state[spec.key], spec.type));
    }
    if (state.album !== null && state.album !== undefined) {
      localStorage.setItem("album", state.album);
    }
  } catch (err) {
    console.warn("Failed to persist settings to localStorage:", err);
  }
}

// Persist the current state to both localStorage (immediate, synchronous)
// and the server (debounced PATCH via the preferences client). Either
// layer can fail without breaking the other — LS exceptions are caught in
// `_writeAllToLocalStorage`, server errors are logged inside the client.
export function saveSettingsToLocalStorage() {
  _writeAllToLocalStorage();
  queuePreferencePatch(_stateToPrefsPayload());
}

// Drop every localStorage key this module owns. Called by the "Reset to
// Defaults" flow after a successful DELETE /preferences/ so the next page
// load doesn't read the old paint cache back into state and PATCH it up
// to the freshly-minted device. Bookmarks, the version-dismissed cache,
// the curation export path, and accordion open/closed state are owned by
// other modules and are intentionally left in place.
export function clearPersistedSettingsCache() {
  try {
    for (const spec of PERSISTED_SETTINGS) {
      localStorage.removeItem(spec.key);
    }
    localStorage.removeItem("album");
    localStorage.removeItem("_prefServerUpdatedAt");
  } catch (err) {
    console.warn("Failed to clear persisted-settings cache:", err);
  }
}

// Generate a setter for a persisted setting. The setter compares, assigns,
// runs the spec's onSet side-effect, saves, and dispatches `settingsUpdated`
// — the same five-step shape that the 11 hand-written setters used to repeat.
function _makeSetter(spec) {
  return function (value) {
    const coerced = _coerce(value, spec.type);
    if ((spec.type === "int" || spec.type === "float") && !Number.isFinite(coerced)) {
      // Refuse NaN / Infinity rather than clobbering a valid state value.
      return;
    }
    if (state[spec.key] === coerced) {
      return;
    }
    state[spec.key] = coerced;
    if (spec.onSet) {
      spec.onSet(coerced);
    }
    saveSettingsToLocalStorage();
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { [spec.key]: coerced } }));
  };
}

// Build setters once and re-export under the names the rest of the app
// already imports. ESM can't emit `export const set${name}` from a loop, so
// the export list stays explicit — but each body is the same one-liner, so
// adding a new persisted setting needs only one new line in
// PERSISTED_SETTINGS plus one new export here.
const _setters = Object.fromEntries(PERSISTED_SETTINGS.map((spec) => [spec.key, _makeSetter(spec)]));

export const setDelay = _setters.currentDelay;
export const setMode = _setters.mode;
export const setShowControlPanelText = _setters.showControlPanelText;
export const setWrapNavigation = _setters.wrapNavigation;
export const setUmapShowLandmarks = _setters.umapShowLandmarks;
export const setUmapShowHoverThumbnails = _setters.umapShowHoverThumbnails;
export const setUmapExitFullscreenOnSelection = _setters.umapExitFullscreenOnSelection;
export const setUmapClickSelectsCluster = _setters.umapClickSelectsCluster;
export const setUmapControlsVisible = _setters.umapControlsVisible;
export const setShowMetadataFields = _setters.showMetadataFields;
export const setAutotaggingEnabled = _setters.autotaggingEnabled;
export const setCurationTargetCount = _setters.curationTargetCount;
export const setCurationIterations = _setters.curationIterations;
export const setCurationMethod = _setters.curationMethod;
export const setCurationExcludeThreshold = _setters.curationExcludeThreshold;
export const setCurationExportPath = _setters.curationExportPath;

export async function setAlbum(newAlbumKey, force = false) {
  if (force || state.album !== newAlbumKey) {
    state.album = newAlbumKey;

    const metadata = await getIndexMetadata(state.album);

    state.dataChanged = true;
    saveSettingsToLocalStorage();

    // Reload per-album search settings (min score / max results /
    // SigLIP query optimization). Don't fail the album switch if this errors
    // — just keep the previous values and log.
    await applyAlbumSearchSettings(newAlbumKey).catch((err) =>
      console.warn("Failed to load per-album search settings:", err)
    );

    // dispatch an album changed event to system
    window.dispatchEvent(
      new CustomEvent("albumChanged", {
        detail: {
          album: newAlbumKey,
          totalImages: metadata.filename_count || 0, // Pass this to SlideStateManager
        },
      })
    );
  }
}

// Pulls per-album search settings from the backend and copies them into
// state. Called on every album switch so the search dialog always reflects
// the active album.
async function applyAlbumSearchSettings(albumKey) {
  const album = await fetchJson(`album/${encodeURIComponent(albumKey)}/`).catch(() => null);
  if (!album) {
    return;
  }
  if (typeof album.min_search_score === "number") {
    state.minSearchScore = album.min_search_score;
  }
  if (typeof album.max_search_results === "number") {
    state.maxSearchResults = album.max_search_results;
  }
  if (typeof album.use_query_optimization === "boolean") {
    state.useQueryOptimization = album.use_query_optimization;
  }
  if (typeof album.encoder_spec === "string") {
    state.albumEncoderSpec = album.encoder_spec;
  }
  // Notify listeners (the search dialog) that values changed.
  window.dispatchEvent(
    new CustomEvent("albumSearchSettingsLoaded", {
      detail: {
        encoder_spec: album.encoder_spec,
        min_search_score: album.min_search_score,
        max_search_results: album.max_search_results,
        use_query_optimization: album.use_query_optimization,
      },
    })
  );
}

// Persist the current state's per-album search settings back to the active
// album via /update_album/. Called from the search dialog onChange handlers.
// Errors are logged but not surfaced — the in-memory state stays correct
// even if the persistence write fails, and the next album switch will
// reload from the backend.
let _persistTimer = null;
export function persistCurrentAlbumSearchSettings() {
  if (!state.album) {
    return;
  }
  // Debounce so rapid edits (slider drags, keystrokes) collapse to one
  // network write at the end.
  if (_persistTimer) {
    clearTimeout(_persistTimer);
  }
  _persistTimer = setTimeout(async () => {
    _persistTimer = null;
    const albumKey = state.album;
    try {
      const album = await fetchJson(`album/${encodeURIComponent(albumKey)}/`);
      const payload = {
        ...album,
        min_search_score: state.minSearchScore,
        max_search_results: state.maxSearchResults,
        use_query_optimization: state.useQueryOptimization,
      };
      await fetchJson("update_album/", { json: payload });
    } catch (err) {
      console.warn("Failed to persist album search settings:", err);
    }
  }, 400);
}

// Per-album search-setting setters. The search dialog calls these on user
// edit, then persists the change back to the active album via
// /update_album/. Album switches overwrite these via setAlbum above.
export function setMinSearchScore(newScore) {
  const clamped = Math.max(0.0, Math.min(1.0, parseFloat(newScore)));
  if (!Number.isNaN(clamped) && state.minSearchScore !== clamped) {
    state.minSearchScore = clamped;
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { minSearchScore: clamped } }));
  }
}

export function setMaxSearchResults(newMax) {
  const clamped = Math.max(1, parseInt(newMax, 10));
  if (!Number.isNaN(clamped) && state.maxSearchResults !== clamped) {
    state.maxSearchResults = clamped;
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { maxSearchResults: clamped } }));
  }
}

export function setUseQueryOptimization(value) {
  const bool = !!value;
  if (state.useQueryOptimization !== bool) {
    state.useQueryOptimization = bool;
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { useQueryOptimization: bool } }));
  }
}
