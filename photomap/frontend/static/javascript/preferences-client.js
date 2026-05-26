// preferences-client.js
//
// Thin REST wrapper around /preferences/. The server is the source of truth
// for user preferences; localStorage is a paint-cache so the first frame
// after page load doesn't flicker while we await the server response.
//
// All requests go same-origin, so the HttpOnly photomap_device cookie set by
// the server flows automatically — the client never reads or sets it.
//
// PATCH is debounced and accumulated: rapid setter calls (slider drags,
// keyboard shortcuts) collapse to one network write at the end. Pending
// fields are merged client-side before sending so the server sees a single
// merged payload regardless of how many setters fired.

const PREFS_URL = "preferences/";
const DEBOUNCE_MS = 500;

// localStorage key holding the server-stamped updatedAt of our last known
// server state. Used during boot to decide whether the cached LS values are
// stale relative to the server.
export const SERVER_TIMESTAMP_KEY = "_prefServerUpdatedAt";

let _pending = {};
let _timer = null;
let _inFlight = Promise.resolve();

/** GET /preferences/ — returns the full record, or null if the request failed. */
export async function fetchPreferences() {
  try {
    const response = await fetch(PREFS_URL, { credentials: "same-origin" });
    if (!response.ok) {
      console.warn("Failed to load server preferences:", response.status);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn("Failed to load server preferences:", err);
    return null;
  }
}

function _recordServerTimestamp(updatedAt) {
  if (typeof updatedAt !== "number") {
    return;
  }
  try {
    localStorage.setItem(SERVER_TIMESTAMP_KEY, String(updatedAt));
  } catch {
    // localStorage unavailable (private mode etc.) — non-fatal.
  }
}

/** Read the last-known server timestamp from localStorage (0 if absent). */
export function loadServerTimestamp() {
  try {
    const raw = localStorage.getItem(SERVER_TIMESTAMP_KEY);
    if (raw === null) {
      return 0;
    }
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function _flushNow() {
  if (Object.keys(_pending).length === 0) {
    return;
  }
  const body = _pending;
  _pending = {};
  try {
    const response = await fetch(PREFS_URL, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn("Server prefs PATCH failed:", response.status);
      return;
    }
    const updated = await response.json();
    _recordServerTimestamp(updated.updatedAt);
  } catch (err) {
    console.warn("Server prefs PATCH failed:", err);
  }
}

/**
 * Queue a partial preference update for the server.
 *
 * Multiple calls within the debounce window merge into one PATCH. Later
 * values for the same key overwrite earlier ones, which matches the
 * "last write wins" semantics of the in-memory state setters that drive
 * this function.
 */
export function queuePreferencePatch(partial) {
  Object.assign(_pending, partial);
  if (_timer) {
    clearTimeout(_timer);
  }
  _timer = setTimeout(() => {
    _timer = null;
    _inFlight = _flushNow();
  }, DEBOUNCE_MS);
}

/**
 * Resolve after any pending or in-flight PATCH completes.
 *
 * Useful at unload time and in tests. If a debounce is pending it fires
 * immediately so callers don't have to wait the full debounce window.
 */
export async function flushPendingPatches() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
    _inFlight = _flushNow();
  }
  await _inFlight;
}

/**
 * Drop any queued partial without sending it. Used by "Reset to Defaults":
 * if the user just changed a setting then immediately clicked reset, we
 * don't want the in-flight debounce to fire a PATCH against the newly
 * minted device after the DELETE has already cleared things.
 */
export function cancelPendingPatches() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  _pending = {};
}

/** Test-only: reset module state between cases. */
export function _resetPreferencesClientForTests() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  _pending = {};
  _inFlight = Promise.resolve();
}

/** Return the keys currently queued for the next PATCH (test helper). */
export function _peekPendingKeys() {
  return Object.keys(_pending);
}
