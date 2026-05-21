// utils.js
// This file contains utility functions for the application, such as showing and hiding a spinner.

// ShowSpinner and hideSpinner functions
export function showSpinner() {
  document.getElementById("spinner").style.display = "block";
}
export function hideSpinner() {
  document.getElementById("spinner").style.display = "none";
}

/**
 * Error thrown by ``fetchJson`` when the server returns a non-2xx status.
 * Carries ``status`` and ``url`` so call sites can branch on specific codes
 * (e.g. ``err.status === 404``) without re-parsing the message.
 *
 * ``body`` holds the parsed response body when the server sent JSON (FastAPI
 * surfaces validation / HTTPException details as ``{"detail": "..."}``),
 * else the raw text. Either may be ``undefined`` if reading the body failed.
 */
export class HttpError extends Error {
  constructor(status, statusText, url, body) {
    super(`HTTP ${status}${statusText ? " " + statusText : ""} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.body = body;
  }
}

/**
 * Thin wrapper around ``fetch`` + ``response.json()`` that throws
 * :class:`HttpError` on non-2xx and returns the parsed body on 2xx.
 *
 * ``options.json`` is a shorthand for the most common POST shape — pass an
 * object and the helper sets ``method: "POST"``, the JSON Content-Type
 * header, and ``JSON.stringify(body)`` for you. ``options.method`` and
 * ``options.headers`` still override if specified explicitly.
 *
 * Callers that want "null on failure" should append ``.catch(() => null)`` —
 * keep the conversion explicit at the call site so silent fallbacks are
 * visible in code review. AbortError propagates through unchanged so
 * AbortController-based cancellation still works.
 */
export async function fetchJson(url, options = {}) {
  const { json, headers, ...rest } = options;
  const init = { ...rest };
  if (json !== undefined) {
    init.method = init.method || "POST";
    init.headers = { "Content-Type": "application/json", ...(headers || {}) };
    init.body = JSON.stringify(json);
  } else if (headers) {
    init.headers = headers;
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    // Try to surface the server's error body to callers — FastAPI sends
    // ``{"detail": "..."}`` for HTTPException, which downstream UIs show
    // in error alerts. Tolerate non-JSON bodies (plain text, empty).
    let body;
    try {
      const text = await response.text();
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
    } catch {
      body = undefined;
    }
    throw new HttpError(response.status, response.statusText, url, body);
  }
  return await response.json();
}

export function joinPath(dir, relpath) {
  if (dir.endsWith("/")) {
    dir = dir.slice(0, -1);
  }
  if (relpath.startsWith("/")) {
    relpath = relpath.slice(1);
  }
  return dir + "/" + relpath;
}

export function setCheckmarkOnIcon(iconElement, show) {
  // Remove any existing checkmark
  const checkOverlay = iconElement?.parentElement?.querySelector(".checkmark-overlay");
  if (checkOverlay) {
    checkOverlay.remove();
  }

  if (show) {
    const check = document.createElement("div");
    check.className = "checkmark-overlay";
    check.innerHTML = `
            <svg width="38" height="38" viewBox="0 0 32 32" style="position:absolute;top:-8px;left:-8px;pointer-events:none;">
                <circle cx="16" cy="16" r="15" fill="limegreen" opacity="0.8"/>
                <polyline points="10,17 15,22 23,12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;
    check.style.position = "absolute";
    check.style.top = "0";
    check.style.left = "0";
    check.style.width = "100%";
    check.style.height = "100%";
    check.style.display = "flex";
    check.style.alignItems = "center";
    check.style.justifyContent = "center";
    check.style.pointerEvents = "none";
    iconElement.parentElement.style.position = "relative";
    iconElement.parentElement.appendChild(check);
  }
}

export function getPercentile(arr, p) {
  if (arr.length === 0) {
    return 0;
  }
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

export function isColorLight(hex) {
  // Remove hash if present
  hex = hex.replace("#", "");
  // Convert 3-digit to 6-digit
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((x) => x + x)
      .join("");
  }
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  // Perceived brightness formula
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 180;
}

// Utility debounce function
export function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Make ``target`` draggable by mousedown/touchstart on ``handle``.
 *
 * Handles both mouse and touch, captures the initial pointer offset, and
 * registers document-level move/end listeners only while a drag is active
 * (so listeners don't outlive detached nodes the way ``window``-scoped
 * ones did in the per-module copies this replaces).
 *
 * ``options``:
 *
 * - ``shouldDrag(event)`` — return ``false`` to skip starting a drag for
 *   the current pointer event (e.g. clicks on a close button inside the
 *   handle). Defaults to always-true.
 *
 * - ``setPosition(left, top)`` — override the default
 *   ``target.style.left/top = '${n}px'`` writer. Use when the target
 *   needs additional CSS resets (``transform: none``, ``right: auto``,
 *   ``bottom: auto``) or has to flow through a setter that also
 *   notifies other code.
 *
 * - ``onDragStart()`` / ``onDragEnd()`` — fire after a drag begins / ends.
 *   Useful for ``classList.add('dragging')`` and toggling
 *   ``document.body.style.userSelect``.
 *
 * Returns a teardown function that removes the handle listeners and any
 * still-attached document listeners.
 */
export function makeDraggable(handle, target, options = {}) {
  const { shouldDrag = () => true, setPosition = null, onDragStart = null, onDragEnd = null } = options;

  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  function getCoords(e) {
    if (e.touches && e.touches.length > 0) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
  }

  function writePosition(left, top) {
    if (setPosition) {
      setPosition(left, top);
    } else {
      target.style.left = `${left}px`;
      target.style.top = `${top}px`;
    }
  }

  function onMove(e) {
    const { x, y } = getCoords(e);
    writePosition(initialLeft + (x - startX), initialTop + (y - startY));
    e.preventDefault();
  }

  function onEnd() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onEnd);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onEnd);
    document.removeEventListener("touchcancel", onEnd);
    if (onDragEnd) {
      onDragEnd();
    }
  }

  function onStart(e) {
    if (!shouldDrag(e)) {
      return;
    }
    const { x, y } = getCoords(e);
    startX = x;
    startY = y;
    const rect = target.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    if (e.type === "touchstart") {
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onEnd);
      document.addEventListener("touchcancel", onEnd);
    } else {
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onEnd);
    }

    if (onDragStart) {
      onDragStart();
    }
    e.preventDefault();
  }

  handle.addEventListener("mousedown", onStart);
  handle.addEventListener("touchstart", onStart, { passive: false });

  return function teardown() {
    handle.removeEventListener("mousedown", onStart);
    handle.removeEventListener("touchstart", onStart);
    // Drop any in-flight document listeners (no-op if no drag is active).
    onEnd();
  };
}
