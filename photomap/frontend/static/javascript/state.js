// state.js
// This file manages the state of the application, including slide management and metadata handling.
import { albumManager } from "./album-manager.js";
import { setAutotaggingEnabledInLabels } from "./cluster-utils.js";
import { getIndexMetadata } from "./index.js";
import { flushPendingPatches, queuePreferencePatch } from "./preferences-client.js";
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
  minSearchScore: 0.1, // [0.0, 1.0]; matches the backend's OpenCLIP default
  maxSearchResults: 100, // positive integer
  useQueryOptimization: true, // SigLIP-only; ignored by other encoders
  albumEncoderSpec: null, // mirrored from the active album's config
  // persisted UMAP settings
  umapShowLandmarks: true, // Show landmarks in UMAP
  umapShowHoverThumbnails: true, // Show hover thumbnails in UMAP
  umapExitFullscreenOnSelection: true, // Exit fullscreen when cluster is selected
  umapClickSelectsCluster: true, // Whether click selects cluster or single image
  umapControlsVisible: true, // Whether the UMAP controls panel is visible
  mediaFilter: "both", // "both" | "images" | "videos" — applies to the map, the swiper, the grid and search
  umapWindowOpen: true, // Whether the UMAP window is showing (opened at startup when true)
  lastSlideIndex: {}, // album key -> global index of the slide last shown there
  showMetadataFields: true, // Whether the metadata-drawer fields table is shown
  invokeRefTarget: "image", // "image" | "video" — the InvokeAI tab the drawer's Send / Append Image feed
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
// inline in `restorePersistedSettings`.
//
// The server is the source of truth (per device, keyed by an HttpOnly cookie
// and re-linked by IP + User-Agent when iOS deletes that cookie). It embeds
// the device's record in the page as `window.initialPreferences`, so the app
// starts from it with no network round trip and nothing to reconcile after
// the UI is drawn. localStorage is only a fallback for keys the record lacks
// and for a device with no record yet. Every write sends just the keys that
// changed (`queuePreferencePatch` debounces and merges them), so a tab never
// pushes stale values for settings it didn't touch.
//
// `minSearchScore` / `maxSearchResults` / `useQueryOptimization` are also
// excluded — they live on the album config (not localStorage) and have
// clamp/coerce rules that don't fit the generic shape.

/**
 * @typedef {Object} SettingSpec
 * @property {string} key            State property name (also localStorage key).
 * @property {"bool"|"int"|"float"|"string"|"slideIndexMap"} type  How to parse / serialize.
 * @property {*} [default]           Fallback when nothing valid is in storage.
 * @property {() => any} [dynamicDefault]
 *                                   Called once when no stored value exists;
 *                                   wins over `default`. Used by
 *                                   `showControlPanelText` which derives its
 *                                   default from screen width.
 * @property {(value: any) => void} [onSet]
 *                                   Extra side-effect after assignment;
 *                                   fires from both `restorePersistedSettings`
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
  // "both" | "images" | "videos" — which media to show, everywhere (see
  // media-filter.js, which listens for the event dispatched here). An onSet
  // rather than a settingsUpdated listener so that a server-side preference
  // applied at boot — which runs onSet but dispatches nothing — is seen too.
  {
    key: "mediaFilter",
    type: "string",
    default: "both",
    onSet: (value) => window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value } })),
  },
  { key: "showMetadataFields", type: "bool", default: true },
  { key: "invokeRefTarget", type: "string", default: "image" },
  // Visual session state, written by umap.js (persistSettings) and
  // slide-state.js (persistSlidePosition) rather than by a generated setter.
  { key: "umapWindowOpen", type: "bool", default: true },
  { key: "lastSlideIndex", type: "slideIndexMap", default: {} },
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

// Keep only album -> non-negative integer entries; anything else becomes
// undefined so the caller falls back to the next source.
function _slideIndexMap(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const map = {};
  for (const [album, index] of Object.entries(value)) {
    if (Number.isInteger(index) && index >= 0) {
      map[album] = index;
    }
  }
  return map;
}

function _parseStored(raw, type) {
  if (raw === null) {
    return undefined;
  }
  if (type === "slideIndexMap") {
    try {
      return _slideIndexMap(JSON.parse(raw));
    } catch {
      return undefined;
    }
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
  if (type === "slideIndexMap") {
    return _slideIndexMap(value);
  }
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
  if (type === "slideIndexMap") {
    return JSON.stringify(value);
  }
  if (type === "bool") {
    return value ? "true" : "false";
  }
  return String(value);
}

document.addEventListener("DOMContentLoaded", async () => {
  await restorePersistedSettings();
  initializeFromServer();
  window.stateIsReady = true; // Flag for modules that may need to know if state is ready
  window.dispatchEvent(new Event("stateReady"));
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

// A coerced value that is safe to assign, or undefined if it is not.
function _validated(value, type) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const coerced = _coerce(value, type);
  if ((type === "int" || type === "float") && !Number.isFinite(coerced)) {
    return undefined;
  }
  return coerced;
}

function _readLocalStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // Storage blocked (private mode etc.) — treat as empty.
  }
}

// Restore persisted settings at boot.
//
// Source order per key: the device's server record embedded in the page
// (`window.initialPreferences`), then localStorage, then the in-memory
// default. A null field in the record (e.g. a mediaFilter the device never
// sent) falls through to localStorage like a missing one.
//
// A device with no server record yet — a first visit, or one whose
// fingerprint changed (new IP, iOS update) after its cookie was deleted —
// gets one seeded from whatever this resolves to, so the record starts with
// the same values the UI is about to show (including dynamic defaults such
// as showControlPanelText on a narrow screen).
export async function restorePersistedSettings() {
  const record = window.initialPreferences ?? null;

  // Keys the record lacks but localStorage has — a setting added to the
  // server model after this device's record was written — are sent up, or
  // they would be lost at the next iOS eviction.
  const migrate = [];
  for (const spec of PERSISTED_SETTINGS) {
    const raw = _readLocalStorage(spec.key);
    const fromRecord = _validated(record?.[spec.key], spec.type);
    const value = fromRecord ?? _parseStored(raw, spec.type);
    if (record && fromRecord === undefined && value !== undefined) {
      migrate.push(spec.key);
    }
    if (value !== undefined) {
      state[spec.key] = value;
    } else if (raw === null && spec.dynamicDefault) {
      state[spec.key] = spec.dynamicDefault();
    }
    // If parsing failed (corrupt value), the existing default on `state`
    // stays in place. Either way, surface the resolved value to onSet.
    if (spec.onSet) {
      spec.onSet(state[spec.key]);
    }
  }

  // Album is special: pick whichever saved key still exists in the live
  // album list, else fall back to the first available album.
  const albumList = await albumManager.fetchAvailableAlbums();
  if (albumList && albumList.length > 0) {
    const candidates = [record?.album, _readLocalStorage("album")];
    const validAlbum = candidates.find((key) => key && albumList.some((album) => album.key === key));
    state.album = validAlbum || albumList[0].key;
  }

  _writeAllToLocalStorage();
  if (!record) {
    queuePreferencePatch(_stateToPrefsPayload());
  } else if (migrate.length > 0) {
    queuePreferencePatch(_stateToPrefsPayload(migrate));
  }
}

// Build the payload the server expects from the current state, either for
// every persisted setting or just the named keys.
function _stateToPrefsPayload(keys = null) {
  const payload = {};
  for (const spec of PERSISTED_SETTINGS) {
    if (keys === null || keys.includes(spec.key)) {
      payload[spec.key] = state[spec.key];
    }
  }
  if ((keys === null || keys.includes("album")) && state.album !== null && state.album !== undefined) {
    payload.album = state.album;
  }
  return payload;
}

// Write persisted settings (plus album) to localStorage, all of them or just
// the named keys. Failure is logged; subsequent calls retry.
function _writeAllToLocalStorage(keys = null) {
  try {
    for (const spec of PERSISTED_SETTINGS) {
      if (keys === null || keys.includes(spec.key)) {
        localStorage.setItem(spec.key, _serialize(state[spec.key], spec.type));
      }
    }
    if ((keys === null || keys.includes("album")) && state.album !== null && state.album !== undefined) {
      localStorage.setItem("album", state.album);
    }
  } catch (err) {
    console.warn("Failed to persist settings to localStorage:", err);
  }
}

/**
 * Persist the named state keys, which the caller has already assigned.
 *
 * For code that writes `state` directly rather than through a generated
 * setter (usually to avoid dispatching `settingsUpdated`). Only these keys go
 * to localStorage and to the server, so a tab never overwrites a setting it
 * didn't change with its own possibly stale copy.
 *
 * @param {...string} keys  PERSISTED_SETTINGS keys, or "album".
 */
export function persistSettings(...keys) {
  _writeAllToLocalStorage(keys);
  queuePreferencePatch(_stateToPrefsPayload(keys));
}

/**
 * Remember `index` as the slide last shown in `album`.
 *
 * Sends just this album's entry: the server merges the map per album, so a
 * second tab's stale copy of the other albums can't overwrite them.
 */
export function persistSlidePosition(album, index) {
  state.lastSlideIndex = { ...state.lastSlideIndex, [album]: index };
  _writeAllToLocalStorage(["lastSlideIndex"]);
  queuePreferencePatch({ lastSlideIndex: { [album]: index } });
}

// Drop every localStorage key this module owns. Called by the "Reset to
// Defaults" flow after a successful DELETE /preferences/ so the next page
// load doesn't read the old values back into state and seed the freshly
// minted device's record with them. Bookmarks, the version-dismissed cache
// and accordion open/closed state are owned by other modules and are
// intentionally left in place.
export function clearPersistedSettingsCache() {
  try {
    for (const spec of PERSISTED_SETTINGS) {
      localStorage.removeItem(spec.key);
    }
    localStorage.removeItem("album");
    // Written by builds before the page embedded the server record.
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
    persistSettings(spec.key);
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
export const setMediaFilter = _setters.mediaFilter;
export const setShowMetadataFields = _setters.showMetadataFields;
export const setInvokeRefTarget = _setters.invokeRefTarget;
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
    persistSettings("album");

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
// the active album, and after an album edit that can have changed them
// server-side (see refreshActiveAlbumSearchSettings).
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

// Reload the active album's search settings from the backend.
//
// Needed after an album edit, because the backend can change these without
// being asked to: changing an album's encoder *band* re-resolves
// min_search_score, and the three bands are far apart — 0.2 for OpenAI CLIP,
// 0.1 for OpenCLIP, 0.005 for SigLIP — so one band's floor matches almost
// nothing under another. Without this, state keeps the old album's floor,
// and the next search-dialog edit persists it straight back over the
// re-resolved one — where it now survives, because an update keeps every
// field its payload carries.
export async function refreshActiveAlbumSearchSettings(albumKey) {
  if (!albumKey || albumKey !== state.album) {
    return;
  }
  await applyAlbumSearchSettings(albumKey).catch((err) => console.warn("Failed to reload album search settings:", err));
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
