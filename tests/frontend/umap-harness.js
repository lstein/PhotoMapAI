// Test harness for umap.js.
//
// umap.js is the one frontend module with no unit tests, because it does DOM
// work at *module scope* — it wires `onclick` handlers onto a dozen elements
// the moment it is imported, and throws if any of them is missing. (This is
// why umap-helpers.js exists at all: its header says the pure helpers were
// split out "so they can be unit-tested without pulling in the full UMAP
// module".) That left everything interesting in umap.js — trace ordering,
// landmark rendering, the highlight split — reachable only through a browser.
//
// This harness makes the module importable under jsdom:
//
//   * `loadUmapDom()` installs the **real** template markup, read straight
//     from umap-floating-window.html. The template contains no Jinja tags, so
//     it can be used verbatim — which means the fixture cannot drift out of
//     sync with the markup the app actually ships, the usual failure mode for
//     a hand-copied DOM fixture.
//
//   * `installPlotlyMock()` provides the six Plotly calls umap.js makes, with
//     enough real behaviour that trace bookkeeping works: traces are actually
//     added, deleted and moved on `div.data`, and `relayout` merges into
//     `div.layout`. Plotly's own methods return promises and umap.js chains
//     off them, so these do too.
//
// Usage (the module mocks stay in the test file, since they are test-specific
// and must be registered before the dynamic import):
//
//   loadUmapDom();
//   const plotly = installPlotlyMock();
//   const umap = await import(".../umap.js");

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(
  HERE,
  "..",
  "..",
  "photomap",
  "frontend",
  "templates",
  "modules",
  "umap-floating-window.html"
);

/**
 * Install the real semantic-map markup into the document.
 *
 * `#showUmapBtn` is stubbed because it lives in the control panel rather than
 * this template, and umap.js assigns to its `.onclick` at import time.
 */
export function loadUmapDom() {
  const markup = readFileSync(TEMPLATE, "utf8");
  document.body.innerHTML = `<button id="showUmapBtn"></button>${markup}`;
}

/** Minimal stand-in for a Plotly graph div's event emitter. */
function attachEmitter(div) {
  const listeners = new Map();
  div.on = (event, cb) => {
    if (!listeners.has(event)) {
      listeners.set(event, []);
    }
    listeners.get(event).push(cb);
  };
  div.emit = (event, payload) => {
    (listeners.get(event) || []).forEach((cb) => cb(payload));
  };
  div.removeAllListeners = () => listeners.clear();
  return div;
}

function resolveDiv(target) {
  return typeof target === "string" ? document.getElementById(target) : target;
}

/**
 * Install a fake `window.Plotly` and return it for assertions.
 *
 * Every method records its arguments on `.calls` and returns a resolved
 * promise, matching the shape umap.js chains off.
 */
export function installPlotlyMock() {
  const calls = { newPlot: [], restyle: [], addTraces: [], deleteTraces: [], relayout: [], moveTraces: [] };

  const Plotly = {
    calls,

    newPlot(target, data, layout = {}, config = {}) {
      const div = resolveDiv(target);
      // Deep-ish copy so a later restyle can't retroactively change what the
      // test believes was plotted.
      div.data = data.map((t) => ({ ...t }));
      div.layout = {
        ...layout,
        xaxis: { range: [-10, 10], ...(layout.xaxis || {}) },
        yaxis: { range: [-10, 10], ...(layout.yaxis || {}) },
        images: layout.images || [],
      };
      attachEmitter(div);
      calls.newPlot.push({ data: div.data, layout: div.layout, config });
      return Promise.resolve(div);
    },

    restyle(target, update, traceIndices) {
      const div = resolveDiv(target);
      const indices = traceIndices === undefined ? div.data.map((_, i) => i) : [traceIndices].flat();
      indices.forEach((i) => {
        const trace = div.data[i];
        if (!trace) {
          return;
        }
        // Plotly's restyle takes each value wrapped in an array, one entry per
        // targeted trace; unwrap the single-trace case the way it would.
        Object.entries(update).forEach(([key, value]) => {
          const unwrapped = Array.isArray(value) ? value[0] : value;
          if (key.includes(".")) {
            const [head, ...rest] = key.split(".");
            trace[head] = trace[head] || {};
            let node = trace[head];
            while (rest.length > 1) {
              const part = rest.shift();
              node[part] = node[part] || {};
              node = node[part];
            }
            node[rest[0]] = unwrapped;
          } else {
            trace[key] = unwrapped;
          }
        });
      });
      calls.restyle.push({ update, traceIndices });
      return Promise.resolve(div);
    },

    addTraces(target, traces) {
      const div = resolveDiv(target);
      [traces].flat().forEach((t) => div.data.push({ ...t }));
      calls.addTraces.push([traces].flat());
      return Promise.resolve(div);
    },

    deleteTraces(target, indices) {
      const div = resolveDiv(target);
      // Descending, so earlier removals don't shift later indices.
      [indices]
        .flat()
        .sort((a, b) => b - a)
        .forEach((i) => div.data.splice(i, 1));
      calls.deleteTraces.push([indices].flat());
      return Promise.resolve(div);
    },

    moveTraces(target, from, to) {
      const div = resolveDiv(target);
      const [moved] = div.data.splice(from, 1);
      div.data.splice(to, 0, moved);
      calls.moveTraces.push({ from, to });
      return Promise.resolve(div);
    },

    relayout(target, update) {
      const div = resolveDiv(target);
      div.layout = { ...div.layout, ...update };
      calls.relayout.push(update);
      return Promise.resolve(div);
    },
  };

  global.Plotly = Plotly;
  window.Plotly = Plotly;
  return Plotly;
}

export function removePlotlyMock() {
  delete global.Plotly;
  delete window.Plotly;
}

/** The landmark thumbnails currently on the plot. */
export function currentLandmarkImages(plotId = "umapPlot") {
  return document.getElementById(plotId)?.layout?.images || [];
}

/** The landmark triangle trace, if one is currently plotted. */
export function currentLandmarkTrace(plotId = "umapPlot") {
  return (document.getElementById(plotId)?.data || []).find((t) => t.name === "Landmarks") || null;
}

/**
 * A `fetch` stub that answers the two endpoints `fetchUmapData` calls.
 *
 * Cluster labels are answered as "not ok" so the caller falls back to the
 * bare cluster string, which keeps tests independent of the labels feature.
 */
export function installFetchMock(points) {
  const fetchMock = (url) => {
    if (String(url).startsWith("umap_data/")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(points) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  };
  global.fetch = fetchMock;
  return fetchMock;
}
