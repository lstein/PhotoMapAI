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
//
// Callers send only the keys they changed, and the embedded record beats
// localStorage at the next boot — so a write that never lands would be
// silently undone by the next reload. Hence the retry below: a PATCH that
// fails for a transient reason (network, server restarting) goes back on
// the queue, and one a single bad value got refused is resent key by key so
// the good values still land.

const PREFS_URL = "preferences/";
const DEBOUNCE_MS = 500;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;

let _pending = {};
let _timer = null;
let _inFlight = Promise.resolve();
let _retryDelay = RETRY_BASE_MS;
let _closed = false;

function _isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Merge `partial` into `target`. Object values (the per-album slide map) are
// merged one level deep, so two albums' entries queued in one window both
// survive; the server merges them the same way.
function _mergeInto(target, partial) {
  for (const [key, value] of Object.entries(partial)) {
    target[key] = _isPlainObject(value) && _isPlainObject(target[key]) ? { ...target[key], ...value } : value;
  }
  return target;
}

function _schedule(delay) {
  if (_timer) {
    clearTimeout(_timer);
  }
  _timer = setTimeout(() => {
    _timer = null;
    _startFlush();
  }, delay);
}

// Flushes run one after another, never overlapping, so two PATCHes of the
// same key can't land out of order.
function _startFlush() {
  _inFlight = _inFlight.then(_flushNow);
  return _inFlight;
}

async function _send(body) {
  return fetch(PREFS_URL, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // The flush on visibilitychange:hidden must outlive the page: iOS
    // suspends a backgrounded tab right after that event.
    keepalive: true,
  });
}

// Put an unsent body back in front of anything queued since: newer values
// for the same key win.
function _requeue(body) {
  if (_closed) {
    return;
  }
  _pending = _mergeInto(_mergeInto({}, body), _pending);
  _schedule(_retryDelay);
  _retryDelay = Math.min(_retryDelay * 2, RETRY_MAX_MS);
}

async function _flushNow() {
  if (_closed || Object.keys(_pending).length === 0) {
    return;
  }
  const body = _pending;
  _pending = {};
  let response;
  try {
    response = await _send(body);
  } catch (err) {
    console.warn("Server prefs PATCH failed, will retry:", err);
    _requeue(body);
    return;
  }
  if (response.ok) {
    _retryDelay = RETRY_BASE_MS;
    return;
  }
  if (response.status === 422) {
    // One out-of-range value (a ?delay= from the URL, say) refuses the whole
    // batch. Resend each key on its own so only the bad one is dropped.
    const keys = Object.keys(body);
    if (keys.length > 1) {
      for (const key of keys) {
        try {
          const single = await _send({ [key]: body[key] });
          if (!single.ok) {
            console.warn(`Server refused preference ${key}:`, single.status);
          }
        } catch (err) {
          console.warn("Server prefs PATCH failed, will retry:", err);
          _requeue({ [key]: body[key] });
        }
      }
    } else {
      console.warn(`Server refused preference ${keys[0]}:`, response.status);
    }
    return;
  }
  console.warn("Server prefs PATCH failed, will retry:", response.status);
  _requeue(body);
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
  if (_closed) {
    return;
  }
  _mergeInto(_pending, partial);
  _schedule(DEBOUNCE_MS);
}

/**
 * Resolve after any pending or in-flight PATCH completes.
 *
 * Useful at unload time and in tests. If a debounce (or a retry) is pending
 * it fires immediately so callers don't have to wait for it.
 */
export async function flushPendingPatches() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
    _startFlush();
  }
  await _inFlight;
}

/**
 * Drop any queued partial and refuse all further ones, then resolve once a
 * PATCH already in the air has landed. Used by "Reset to Defaults", which
 * reloads the page afterwards: anything sent after its DELETE — a slide
 * change from a running slideshow, the unload flush — would recreate the
 * record the reset just removed.
 */
export async function closePreferencePatches() {
  _closed = true;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  _pending = {};
  await _inFlight;
}

/** Undo closePreferencePatches — for a reset whose DELETE failed. */
export function reopenPreferencePatches() {
  _closed = false;
}

/** Test-only: reset module state between cases. */
export function _resetPreferencesClientForTests() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  _pending = {};
  _inFlight = Promise.resolve();
  _retryDelay = RETRY_BASE_MS;
  _closed = false;
}

/** Return the keys currently queued for the next PATCH (test helper). */
export function _peekPendingKeys() {
  return Object.keys(_pending);
}

/** Return the queued partial itself (test helper). */
export function _peekPending() {
  return _pending;
}
