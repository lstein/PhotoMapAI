// preferences-client.js
//
// Thin REST wrapper around /preferences/. The server is the source of truth
// for user preferences; the page arrives with this device's record already
// embedded (window.initialPreferences), so only writes go through here.
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

let _pending = {};
let _timer = null;
let _inFlight = Promise.resolve();

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
      // The flush on visibilitychange:hidden must outlive the page: iOS
      // suspends a backgrounded tab right after that event.
      keepalive: true,
    });
    if (!response.ok) {
      console.warn("Server prefs PATCH failed:", response.status);
    }
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
