// umap.js
// This file handles the UMAP visualization and interaction logic.
import { albumManager } from "./album-manager.js";
import { backStack } from "./back-stack.js";
import {
  CLUSTER_PALETTE,
  getClusterLabelInfo,
  getImageLabelInfo,
  setClusterLabels,
  trackVocabBuildRequest,
} from "./cluster-utils.js";
import { exitSearchMode } from "./search-ui.js";
import { getImagePath, setSearchResults } from "./search.js";
import { switchAlbum } from "./settings.js";
import { getCurrentSlideIndex, slideState } from "./slide-state.js";
import {
  setUmapClickSelectsCluster,
  setUmapControlsVisible,
  setUmapExitFullscreenOnSelection,
  setUmapShowHoverThumbnails,
  setUmapShowLandmarks,
  state,
} from "./state.js";
import { findLandmarkClusterAt } from "./umap-helpers.js";
import { checkUmapReindexOngoing, initUmapReindexButton } from "./umap-reindex.js";
import { debounce, getPercentile, isColorLight, makeDraggable } from "./utils.js";

const UMAP_SIZES = {
  big: { width: 800, height: 590 },
  medium: { width: 520, height: 310 },
  small: { width: 440, height: 210 },
  fullscreen: { width: window.innerWidth, height: window.innerHeight },
};
const landmarkCount = 18; // Maximum number of non-overlapping landmarks to show at any time
const randomWalkMaxSize = 5000; // Max cluster size to use random walk ordering
const MARKER_UPDATE_IGNORE_WINDOW_MS = 1000; // Time window to ignore marker updates after manual navigation

// We drive UMAP zoom ourselves instead of via Plotly's built-in interactions,
// because Plotly's handling is inconsistent across the inputs we care about:
//   - Mouse wheel: Plotly's `scrollZoom` (disabled below) silently fails in Safari
//     for cartesian plots (it delivers `wheel` events in a form Plotly ignores).
//   - Trackpad pinch: arrives as a `wheel` event with `ctrlKey` set; Plotly doesn't
//     treat it as a plot zoom, so the browser grabs it for page zoom instead.
//   - Touchscreen pinch (iPad/iOS, Android): arrives as two-finger touch events.
//     Plotly's pan treats the two touches as independent drags, so the plot jumps
//     around instead of zooming. (Safari and Chrome on iOS are both WebKit, so they
//     misbehave identically.)
// enableWheelZoom + enableTouchZoom give consistent scroll- and pinch-to-zoom on
// every browser/device, always zooming around the gesture's focal point.

// zoomAround scales both axis ranges by `factor` about the screen point
// (clientX, clientY), keeping whatever is under that point fixed.
function zoomAround(gd, clientX, clientY, factor) {
  const fl = gd._fullLayout;
  if (!fl || !fl.xaxis || !fl.yaxis) {
    return;
  }
  const xa = fl.xaxis;
  const ya = fl.yaxis;
  const bb = gd.getBoundingClientRect();
  const xData = xa.p2d(clientX - bb.left - xa._offset);
  const yData = ya.p2d(clientY - bb.top - ya._offset);
  const [x0, x1] = xa.range;
  const [y0, y1] = ya.range;
  Plotly.relayout(gd, {
    "xaxis.range": [xData + (x0 - xData) * factor, xData + (x1 - xData) * factor],
    "yaxis.range": [yData + (y0 - yData) * factor, yData + (y1 - yData) * factor],
  });
}

function enableWheelZoom(gd) {
  if (gd._wheelZoomAttached) {
    return;
  }
  gd._wheelZoomAttached = true;
  gd.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault(); // also stops the browser page-zooming on ctrl+wheel (pinch)
      // Zoom out (deltaY > 0) grows the ranges, zoom in shrinks them. A trackpad
      // pinch (ctrlKey) sends small deltas, so give it a larger per-delta gain than
      // a mouse wheel for a responsive feel. Tune the gains here if needed.
      const gain = ev.ctrlKey ? 0.01 : 0.001;
      zoomAround(gd, ev.clientX, ev.clientY, Math.exp(ev.deltaY * gain));
    },
    { passive: false }
  );
}

const touchDistance = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

function enableTouchZoom(gd) {
  if (gd._touchZoomAttached) {
    return;
  }
  gd._touchZoomAttached = true;

  // Tell the browser we handle touch gestures on the plot ourselves, so it won't
  // intercept the pinch for its own page zoom and reliably delivers touchmove.
  gd.style.touchAction = "none";

  let lastDist = 0;

  // Two-finger pinch is handled here. We listen on `document` in the capture phase
  // (the earliest point in the event flow, before any Plotly listener regardless of
  // where it attached) and stopImmediatePropagation, so Plotly never sees the
  // gesture and can't pan-jump from it. gd-level capture wasn't early enough on iOS
  // Chrome (a WKWebView), where Plotly still received the touches. Single-finger
  // touches fall through to Plotly (pan, tap-to-select) since we only act on two.
  const inPlot = (ev) => gd.contains(ev.target);

  document.addEventListener(
    "touchstart",
    (ev) => {
      if (ev.touches.length === 2 && inPlot(ev)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        lastDist = touchDistance(ev.touches[0], ev.touches[1]);
        gd._lastPinchAt = Date.now();
      }
    },
    { passive: false, capture: true }
  );

  document.addEventListener(
    "touchmove",
    (ev) => {
      if (ev.touches.length !== 2 || !inPlot(ev)) {
        return;
      }
      ev.preventDefault();
      ev.stopImmediatePropagation();
      gd._lastPinchAt = Date.now();
      const newDist = touchDistance(ev.touches[0], ev.touches[1]);
      if (!lastDist || !newDist) {
        lastDist = newDist;
        return;
      }
      const midX = (ev.touches[0].clientX + ev.touches[1].clientX) / 2;
      const midY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
      // Fingers apart (newDist > lastDist) zooms in -> ranges shrink (factor < 1).
      zoomAround(gd, midX, midY, lastDist / newDist);
      lastDist = newDist;
    },
    { passive: false, capture: true }
  );

  const onEnd = (ev) => {
    if (ev.touches.length < 2 && lastDist) {
      // A pinch just ended; stamp the time so the plotly_click handler can ignore the
      // stray tap that lifting the fingers would otherwise fire as a point selection.
      gd._lastPinchAt = Date.now();
      lastDist = 0;
    }
  };
  document.addEventListener("touchend", onEnd, { capture: true });
  document.addEventListener("touchcancel", onEnd, { capture: true });
}

let externalClickCallback = null;
let updateMarkerTimer = null;
let ignoreUpdatesUntil = 0;
let isCurationModeActive = false; // Track if curation panel is open

export function setUmapClickCallback(callback) {
  externalClickCallback = callback;
}
// --------------------------------------------

let points = [];
let clusters = [];
let colors = [];
let mapExists = false;
let isShaded = false;
let umapWindowHasBeenShown = false; // Track if window has been shown at least once
let isFullscreen = true;
let lastUnshadedSize = "medium"; // Track last non-fullscreen size
const lastUnshadedPosition = { left: null, top: null }; // Track last position
let landmarksVisible = false;
let hoverThumbnailsEnabled = true; // default ON

// Helper to get current window size
function getCurrentWindowSize() {
  const win = document.getElementById("umapFloatingWindow");
  const width = parseInt(win.style.width, 10);
  if (isFullscreen) {
    return "fullscreen";
  }
  if (width >= UMAP_SIZES.big.width) {
    return "big";
  }
  if (width >= UMAP_SIZES.medium.width) {
    return "medium";
  }
  return "small";
}

// Helper to save current position
function saveCurrentPosition() {
  const win = document.getElementById("umapFloatingWindow");
  lastUnshadedPosition.left = win.style.left;
  lastUnshadedPosition.top = win.style.top;
}

// --- Utility ---
function getClusterColor(cluster) {
  if (cluster === -1) {
    return "#cccccc";
  }
  const idx = clusters.indexOf(cluster);
  return colors[idx % colors.length];
}

// --- Spinner UI ---
function showUmapSpinner() {
  document.getElementById("umapSpinner").style.display = "block";
}
function hideUmapSpinner() {
  document.getElementById("umapSpinner").style.display = "none";
}

// --- EPS Spinner Debounce ---
let epsUpdateTimer = null;
document.getElementById("umapEpsSpinner").oninput = async () => {
  const eps = parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;
  if (epsUpdateTimer) {
    clearTimeout(epsUpdateTimer);
  }
  epsUpdateTimer = setTimeout(async () => {
    await fetch("set_umap_eps/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ album: state.album, eps }),
    });
    state.dataChanged = true;
    await fetchUmapData();
  }, 1000);
};

// --- Main UMAP Data Fetch and Plot ---
export async function fetchUmapData() {
  if (mapExists && !state.dataChanged) {
    return;
  }
  if (!state.album) {
    return;
  }
  showUmapSpinner();
  try {
    const eps = parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;
    const album = encodeURIComponent(state.album);
    // Fetch UMAP data and cluster labels in parallel. Labels are best-effort:
    // a failure leaves clusterLabels empty and the hover popup falls back to
    // the bare "Cluster N (size=K)" string. The endpoint compute itself can
    // be slow on first call (vocab build), but it runs in a thread pool on
    // the server side so the umap_data response isn't blocked.
    // When autotagging is disabled in settings, skip the labels fetch entirely
    // so the server-side vocab embedding index is never built.
    // trackVocabBuildRequest surfaces a sticky toast if the build keeps us
    // waiting more than a few seconds, so the UI doesn't look frozen.
    const labelsPromise = state.autotaggingEnabled
      ? trackVocabBuildRequest(
          fetch(`cluster_labels/${album}?cluster_eps=${eps}`).catch((err) => {
            console.warn("Cluster labels fetch failed:", err);
            return null;
          })
        )
      : Promise.resolve(null);
    const [response, labelsResponse] = await Promise.all([
      fetch(`umap_data/${album}?cluster_eps=${eps}`),
      labelsPromise,
    ]);
    points = await response.json();
    if (labelsResponse?.ok) {
      try {
        const body = await labelsResponse.json();
        setClusterLabels(body.labels || {});
      } catch (err) {
        console.warn("Cluster labels parse failed:", err);
        setClusterLabels({});
      }
    } else {
      setClusterLabels({});
    }

    // Compute clusters and colors
    clusters = [...new Set(points.map((p) => p.cluster))];
    colors = clusters.map((c, i) => CLUSTER_PALETTE[i % CLUSTER_PALETTE.length]);

    // Compute axis ranges (1st to 99th percentile)
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const xMin = getPercentile(xs, 1);
    const xMax = getPercentile(xs, 99);
    const yMin = getPercentile(ys, 1);
    const yMax = getPercentile(ys, 99);

    // Prepare marker arrays
    const markerColors = points.map((p) => getClusterColor(p.cluster));
    const markerAlphas = points.map((p) => (p.cluster === -1 ? 0.08 : 0.75));

    // Main trace: all points
    const allPointsTrace = {
      x: points.map((p) => p.x),
      y: points.map((p) => p.y),
      mode: "markers",
      type: "scattergl",
      marker: {
        color: markerColors,
        opacity: markerAlphas,
        size: 5,
      },
      customdata: points.map((p) => p.index),
      name: "All Points",
      hoverinfo: "none",
    };

    // Current image marker trace
    const [globalIndex] = getCurrentSlideIndex();
    const currentPoint = points.find((p) => p.index === globalIndex);
    const currentImageTrace = currentPoint
      ? {
          x: [currentPoint.x],
          y: [currentPoint.y],
          text: ["Current slide: " + (await getImagePath(state.album, currentPoint.index)).split("/").pop()],
          mode: "markers",
          type: "scattergl",
          marker: {
            color: "#FFD700",
            size: 18,
            symbol: "circle-dot",
            line: { color: "#000", width: 2 },
          },
          name: "Current Image",
          hoverinfo: "text",
        }
      : {
          x: [],
          y: [],
          text: [],
          mode: "markers",
          type: "scattergl",
          marker: {
            color: "#FFD700",
            size: 18,
            symbol: "circle-dot",
            line: { color: "#000", width: 2 },
          },
          name: "Current Image",
          hoverinfo: "none",
        };

    const layout = {
      showlegend: false,
      dragmode: "pan",
      height: UMAP_SIZES.medium.height,
      width: UMAP_SIZES.medium.width,
      plot_bgcolor: "rgba(0,0,0,0)", // transparent plot area
      paper_bgcolor: "rgba(0,0,0,0)", // transparent paper
      font: { color: "#eee" },
      xaxis: {
        gridcolor: "rgba(255,255,255,0.15)",
        zerolinecolor: "rgba(255,255,255,0.25)",
        color: "#eee",
        linecolor: "#888",
        tickcolor: "#888",
        range: [xMin, xMax],
        scaleanchor: "y",
      },
      yaxis: {
        gridcolor: "rgba(255,255,255,0.15)",
        zerolinecolor: "rgba(255,255,255,0.25)",
        color: "#eee",
        linecolor: "#888",
        tickcolor: "#888",
        range: [yMin, yMax],
      },
      margin: {
        t: 30,
        r: 0,
        b: 30,
        l: 30,
        pad: 0,
      },
    };

    const config = {
      modeBarButtons: [["zoom2d", "pan2d", "zoomIn2d", "zoomOut2d", "autoScale2d", "toImage"]],
      // Wheel/pinch zoom is handled by enableWheelZoom() for consistent cross-browser
      // behavior (Plotly's built-in scrollZoom fails in Safari and ignores pinch).
      scrollZoom: false,
    };

    const isFirstRender = !mapExists;
    // Save current plot dimensions before Plotly.newPlot resets them to the layout defaults.
    const umapPlotDiv = document.getElementById("umapPlot");
    const savedPlotWidth = parseInt(umapPlotDiv.style.width, 10);
    const savedPlotHeight = parseInt(umapPlotDiv.style.height, 10);
    Plotly.newPlot("umapPlot", [allPointsTrace, currentImageTrace], layout, config).then(async (gd) => {
      document.getElementById("umapContent").style.display = "block";
      applyUmapControlsVisibility();
      enableWheelZoom(gd);
      enableTouchZoom(gd);
      if (isFirstRender) {
        setUmapWindowSize("fullscreen");
      } else if (isShaded) {
        setUmapWindowSize(lastUnshadedSize);
      } else if (savedPlotWidth > 0 && savedPlotHeight > 0) {
        // Recalculation: only resize the Plotly plot back to its pre-newPlot dimensions,
        // leaving the window container size and position untouched.
        Plotly.relayout(gd, { width: savedPlotWidth, height: savedPlotHeight });
      } else {
        setUmapWindowSize(lastUnshadedSize);
      }
      hideUmapSpinner();

      window.dispatchEvent(new CustomEvent("umapRedrawn"));

      await setUmapColorMode();
      let hoverTimer = null;
      let isHovering = false;

      gd.on("plotly_hover", (eventData) => {
        if (!hoverThumbnailsEnabled) {
          return;
        }
        if (!eventData || !eventData.points || !eventData.points.length) {
          return;
        }
        const pt = eventData.points[0];
        // Use customdata to get the actual index, then find the point
        const ptIndex = pt.customdata;
        const point = points.find((p) => p.index === ptIndex);
        const hoverCluster = point?.cluster ?? -1;
        isHovering = true;
        hoverTimer = setTimeout(() => {
          if (isHovering) {
            const landmarkCluster = findLandmarkCluster(pt);
            let index, cluster;
            if (landmarkCluster !== null) {
              const clusterPoints = points.filter((p) => p.cluster === landmarkCluster);
              index = getLandmarkImageIndex(landmarkCluster, clusterPoints);
              cluster = landmarkCluster;
            } else {
              index = ptIndex;
              cluster = hoverCluster;
            }
            createUmapThumbnail({
              x: eventData.event.clientX,
              y: eventData.event.clientY,
              index: index,
              cluster: cluster,
            });
          }
        }, 150);
      });

      gd.on("plotly_unhover", () => {
        isHovering = false;
        if (hoverTimer) {
          clearTimeout(hoverTimer);
          hoverTimer = null;
        }
        removeUmapThumbnail();
      });

      gd.on("plotly_relayout", (eventData) => {
        if (suppressRelayoutEvent) {
          return;
        } // Prevent feedback loop

        // Auto-switch back to pan after zoom
        const isZoomEvent =
          eventData["xaxis.range[0]"] !== undefined ||
          eventData["yaxis.range[0]"] !== undefined ||
          eventData["xaxis.range"] !== undefined ||
          eventData["yaxis.range"] !== undefined;

        if (isZoomEvent && gd.layout.dragmode === "zoom") {
          // Small delay to avoid interfering with the zoom operation
          setTimeout(() => {
            Plotly.relayout(gd, { dragmode: "pan" });
          }, 100);
        }

        // Only update landmarks for actual user pan/zoom events, not our programmatic changes
        const isPanZoom =
          eventData["xaxis.range[0]"] !== undefined ||
          eventData["yaxis.range[0]"] !== undefined ||
          eventData["xaxis.range"] !== undefined ||
          eventData["yaxis.range"] !== undefined;

        const isResize = eventData.width !== undefined || eventData.height !== undefined;
        const isImageUpdate = eventData.images !== undefined;

        // Only update landmarks for pan/zoom, not for our own image updates or resizes
        if (isPanZoom && !isImageUpdate && !isResize) {
          debouncedUpdateLandmarkTrace();
        }
      });

      gd.on("plotly_redraw", () => {
        if (suppressRelayoutEvent) {
          return;
        }
        debouncedUpdateLandmarkTrace();
      });

      // Initial landmark update
      if (landmarksVisible) {
        setTimeout(updateLandmarkTrace, 500);
      }

      // Show the EPS spinner container now that the plot is ready
      const epsContainer = document.getElementById("umapEpsContainer");
      if (epsContainer) {
        epsContainer.style.display = "block";
      }

      // After adding traces (e.g., landmarks), move the marker trace to the end
      const plotDiv = document.getElementById("umapPlot");
      const markerTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "Current Image");
      if (markerTraceIndex !== -1 && markerTraceIndex !== plotDiv.data.length - 1) {
        Plotly.moveTraces(plotDiv, markerTraceIndex, plotDiv.data.length - 1);
      }
    });

    // Ensure the current image marker is visible after plot initialization
    setTimeout(() => updateCurrentImageMarker(), 0);

    // Cluster click: highlight cluster as search
    const clickPlotEl = document.getElementById("umapPlot");
    clickPlotEl.on("plotly_click", async (data) => {
      // Ignore the stray click Plotly synthesizes when a two-finger pinch ends (the
      // fingers lifting register as a tap). enableTouchZoom stamps _lastPinchAt on
      // this same element (the graph div passed to it).
      if (clickPlotEl._lastPinchAt && Date.now() - clickPlotEl._lastPinchAt < 500) {
        return;
      }
      // --- MODIFIED: Intercept click for Curation Lock Mode ---
      if (externalClickCallback) {
        const pt = data.points[0];
        let index = pt.customdata;
        if (index === undefined && points[pt.pointIndex]) {
          index = points[pt.pointIndex].index;
        }
        if (index !== undefined) {
          externalClickCallback(index);
          return; // Block normal search behavior
        }
      }
      // ---------------------------------------------------

      const clickedLandmarkCluster = findLandmarkCluster(data.points[0]);

      if (clickedLandmarkCluster !== null) {
        // Get all points in this cluster, then click through to whatever image
        // we showed as the landmark thumbnail (medoid when available, else the
        // 2D-position pick). Keeps display and navigation consistent.
        const clusterPoints = points.filter((p) => p.cluster === clickedLandmarkCluster);
        if (clusterPoints.length > 0) {
          const targetIndex = getLandmarkImageIndex(clickedLandmarkCluster, clusterPoints);
          if (state.umapClickSelectsCluster) {
            await handleClusterClick(targetIndex);
          } else {
            await handleImageClick(targetIndex);
          }
        }
      } else {
        const pt = data.points[0];
        const traceName = pt.data?.name;
        // Main points or highlighted points behave the same
        if (traceName === "All Points" || traceName === "HighlightedPoints") {
          // Check if we should select cluster or image
          if (state.umapClickSelectsCluster) {
            await handleClusterClick(pt.customdata);
          } else {
            await handleImageClick(pt.customdata);
          }
        }
      }
    });

    window.umapPoints = points;
    state.dataChanged = false;

    // Dispatch event to notify that UMAP data has been loaded
    window.dispatchEvent(new CustomEvent("umapDataLoaded"));

    await setUmapColorMode();
  } finally {
    hideUmapSpinner();
  }

  mapExists = true;
}

function findLandmarkCluster(point) {
  const plotDiv = document.getElementById("umapPlot");
  const landmarkTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "LandmarkClickTargets");
  if (landmarkTraceIndex === -1) {
    return null;
  }

  const landmarkTrace = plotDiv.data[landmarkTraceIndex];
  const squareSize = Array.isArray(landmarkTrace.marker.size)
    ? landmarkTrace.marker.size[0]
    : landmarkTrace.marker.size;

  const plotWidthPx = plotDiv.offsetWidth || 800;
  const plotHeightPx = plotDiv.offsetHeight || 560;
  const xRange = plotDiv.layout.xaxis.range[1] - plotDiv.layout.xaxis.range[0];
  const yRange = plotDiv.layout.yaxis.range[1] - plotDiv.layout.yaxis.range[0];
  const halfSizeX = (squareSize / 2) * (xRange / plotWidthPx);
  const halfSizeY = (squareSize / 2) * (yRange / plotHeightPx);

  const landmarkXs = landmarkTrace.x;
  const landmarkYs = landmarkTrace.y;
  const landmarkClusters = landmarkTrace.customdata || [];

  return findLandmarkClusterAt(point, landmarkXs, landmarkYs, landmarkClusters, halfSizeX, halfSizeY);
}

const plotDiv = document.getElementById("umapPlot");
plotDiv.addEventListener("mouseleave", () => {
  removeUmapThumbnail();
});

// --- Dynamic Colorization ---
export async function colorizeUmap({ highlight = false, searchResults = [] } = {}) {
  if (!points.length) {
    return;
  }

  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.data) {
    return;
  }

  // Yield to the browser to allow spinner to render before heavy Plotly operations
  await new Promise((resolve) => setTimeout(resolve, 0));

  if (highlight && searchResults.length > 0) {
    const searchSet = new Set(searchResults.map((r) => r.index));

    // Split points into two groups
    const regularPoints = points.filter((p) => !searchSet.has(p.index));
    const highlightedPoints = points.filter((p) => searchSet.has(p.index));

    // Update main trace with only regular points
    await Plotly.restyle(
      "umapPlot",
      {
        x: [regularPoints.map((p) => p.x)],
        y: [regularPoints.map((p) => p.y)],
        "marker.color": [regularPoints.map((p) => getClusterColor(p.cluster))],
        "marker.opacity": [regularPoints.map((p) => (p.cluster === -1 ? 0.2 : 0.75))],
        "marker.size": [regularPoints.map(() => 5)],
        "marker.line.width": [0],
        customdata: [regularPoints.map((p) => p.index)],
      },
      [0]
    );

    // Add/update highlighted trace
    const highlightTraceIdx = plotDiv.data.findIndex((t) => t.name === "HighlightedPoints");
    const highlightTrace = {
      x: highlightedPoints.map((p) => p.x),
      y: highlightedPoints.map((p) => p.y),
      mode: "markers",
      type: "scattergl",
      marker: {
        color: highlightedPoints.map((p) => getClusterColor(p.cluster)),
        opacity: 1.0,
        size: 8,
        line: { width: 1, color: "#fff" },
      },
      customdata: highlightedPoints.map((p) => p.index),
      name: "HighlightedPoints",
      hoverinfo: "none",
    };

    if (highlightTraceIdx === -1) {
      await Plotly.addTraces(plotDiv, [highlightTrace]);
    } else {
      await Plotly.restyle(
        plotDiv,
        {
          x: [highlightTrace.x],
          y: [highlightTrace.y],
          "marker.color": [highlightTrace.marker.color],
          "marker.opacity": [highlightTrace.marker.opacity],
          "marker.size": [highlightTrace.marker.size],
          customdata: [highlightTrace.customdata],
        },
        highlightTraceIdx
      );
    }

    // Ensure Current Image marker stays on top
    const markerTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "Current Image");
    if (markerTraceIndex !== -1 && markerTraceIndex !== plotDiv.data.length - 1) {
      await Plotly.moveTraces(plotDiv, markerTraceIndex, plotDiv.data.length - 1);
    }
  } else {
    // Remove highlight trace if it exists
    const highlightTraceIdx = plotDiv.data?.findIndex((t) => t.name === "HighlightedPoints");
    if (highlightTraceIdx !== -1) {
      await Plotly.deleteTraces(plotDiv, highlightTraceIdx);
    }

    // Restore ALL points to main trace with normal coloring
    const markerColors = points.map((p) => getClusterColor(p.cluster));
    const markerAlphas = points.map((p) => (p.cluster === -1 ? 0.2 : 0.75));
    const markerSizes = points.map(() => 5);

    await Plotly.restyle(
      "umapPlot",
      {
        x: [points.map((p) => p.x)],
        y: [points.map((p) => p.y)],
        "marker.color": [markerColors],
        "marker.opacity": [markerAlphas],
        "marker.size": [markerSizes],
        "marker.line.width": [0],
        customdata: [points.map((p) => p.index)],
      },
      [0]
    );

    // Ensure Current Image marker stays on top after removing highlight
    const markerTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "Current Image");
    if (markerTraceIndex !== -1 && markerTraceIndex !== plotDiv.data.length - 1) {
      await Plotly.moveTraces(plotDiv, markerTraceIndex, plotDiv.data.length - 1);
    }
  }
}

// --- Checkbox event handler ---
// Wait for state to be ready before initializing checkboxes
window.addEventListener("stateReady", () => {
  const highlightCheckbox = document.getElementById("umapHighlightSelection");
  if (highlightCheckbox) {
    highlightCheckbox.checked = false;
    highlightCheckbox.addEventListener("change", async () => {
      await setUmapColorMode();
    });
  }

  // Clear selection link
  const clearSelectionLink = document.getElementById("umapClearSelectionLink");
  if (clearSelectionLink) {
    clearSelectionLink.addEventListener("click", (e) => {
      e.preventDefault();
      exitSearchMode();
    });
  }

  // Hover thumbnails checkbox - initialize from state
  const hoverThumbCheckbox = document.getElementById("umapShowHoverThumbnails");
  if (hoverThumbCheckbox) {
    hoverThumbCheckbox.checked = state.umapShowHoverThumbnails;
    hoverThumbnailsEnabled = state.umapShowHoverThumbnails;
    hoverThumbCheckbox.addEventListener("change", (e) => {
      hoverThumbnailsEnabled = e.target.checked;
      setUmapShowHoverThumbnails(e.target.checked);
      // Remove any popup if disabling
      if (!hoverThumbnailsEnabled) {
        removeUmapThumbnail();
      }
    });
  }

  // Landmarks checkbox - initialize from state
  const landmarkCheckbox = document.getElementById("umapShowLandmarks");
  if (landmarkCheckbox) {
    landmarkCheckbox.checked = state.umapShowLandmarks;
    landmarksVisible = state.umapShowLandmarks;
    landmarkCheckbox.addEventListener("change", (e) => {
      landmarksVisible = e.target.checked;
      setUmapShowLandmarks(e.target.checked);
      updateLandmarkTrace();
    });
  }

  // Exit fullscreen on selection checkbox - initialize from state
  const exitFullscreenCheckbox = document.getElementById("umapExitFullscreenOnSelection");
  if (exitFullscreenCheckbox) {
    exitFullscreenCheckbox.checked = state.umapExitFullscreenOnSelection;
    exitFullscreenCheckbox.addEventListener("change", (e) => {
      setUmapExitFullscreenOnSelection(e.target.checked);
    });

    // Update enabled state based on fullscreen mode
    updateExitFullscreenCheckboxState();
  }

  // Click behavior radio buttons - initialize from state
  const clickSelectsClusterRadio = document.getElementById("umapClickSelectsClusterRadio");
  const clickSelectsImageRadio = document.getElementById("umapClickSelectsImageRadio");
  if (clickSelectsClusterRadio && clickSelectsImageRadio) {
    // Set initial state
    if (state.umapClickSelectsCluster) {
      clickSelectsClusterRadio.checked = true;
    } else {
      clickSelectsImageRadio.checked = true;
    }

    // Add event listeners
    clickSelectsClusterRadio.addEventListener("change", (e) => {
      if (e.target.checked) {
        setUmapClickSelectsCluster(true);
      }
    });

    clickSelectsImageRadio.addEventListener("change", (e) => {
      if (e.target.checked) {
        setUmapClickSelectsCluster(false);
      }
    });
  }
});

// Helper function to update the "Exit fullscreen on selection" checkbox state
function updateExitFullscreenCheckboxState() {
  const exitFullscreenCheckbox = document.getElementById("umapExitFullscreenOnSelection");
  const exitFullscreenLabel = document.getElementById("umapExitFullscreenLabel");

  if (exitFullscreenCheckbox && exitFullscreenLabel) {
    const shouldEnable = isFullscreen;
    exitFullscreenCheckbox.disabled = !shouldEnable;
    exitFullscreenLabel.style.opacity = shouldEnable ? "1" : "0.5";
  }
}

// --- Update colorization after search or cluster selection ---
window.addEventListener("searchResultsChanged", async (e) => {
  updateUmapColorModeAvailability(e.detail.results);
  await setUmapColorMode();
  // Hide spinner after colorization completes
  hideUmapSpinner();
  // deactivate fullscreen mode when search results have come in (if enabled)
  if (state.searchResults.length > 0 && isFullscreen && state.umapExitFullscreenOnSelection) {
    setTimeout(() => toggleFullscreen(false), 100); // slight delay to avoid flicker
  }
});

window.addEventListener("slideChanged", async () => {
  // Clear any existing pending update
  if (updateMarkerTimer) {
    clearTimeout(updateMarkerTimer);
  }

  updateMarkerTimer = setTimeout(() => {
    // If we are currently inside the "Ignore Window" triggered by Clear, skip this update.
    if (Date.now() < ignoreUpdatesUntil) {
      return;
    }
    updateCurrentImageMarker();
  }, 500);
});

// --- Update Current Image Marker ---
export async function updateCurrentImageMarker() {
  if (!points.length) {
    return;
  }
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.data) {
    return;
  }

  // Find the trace index for the current image marker
  const markerTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "Current Image");
  if (markerTraceIndex === -1) {
    return;
  }

  const [globalIndex] = await getCurrentSlideIndex();
  if (globalIndex === -1) {
    return;
  } // No current image
  const currentPoint = points.find((p) => p.index === globalIndex);
  if (!currentPoint) {
    return;
  }

  // Always show the marker trace regardless of curation panel state
  Plotly.restyle(
    "umapPlot",
    {
      x: [[currentPoint.x]],
      y: [[currentPoint.y]],
      "marker.opacity": 1,
    },
    markerTraceIndex // Use the found index
  );
  ensureCurrentMarkerInView(0.1);
}

// --- Ensure Current Marker in View ---
export async function ensureCurrentMarkerInView(padFraction = 0.1) {
  if (!points.length) {
    return;
  }
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.layout) {
    return;
  }

  const [globalIndex] = await getCurrentSlideIndex();
  const currentPoint = points.find((p) => p.index === globalIndex);
  if (!currentPoint) {
    return;
  }

  const x = currentPoint.x;
  const y = currentPoint.y;
  let [xMin, xMax] = plotDiv.layout.xaxis.range;
  let [yMin, yMax] = plotDiv.layout.yaxis.range;

  let changed = false;
  // Add a small padding so the marker isn't right at the edge
  const xPad = (xMax - xMin) * padFraction;
  const yPad = (yMax - yMin) * padFraction;

  if (x < xMin + xPad || x > xMax - xPad) {
    const xCenter = x;
    const halfWidth = (xMax - xMin) / 2;
    xMin = xCenter - halfWidth;
    xMax = xCenter + halfWidth;
    changed = true;
  }
  if (y < yMin + yPad || y > yMax - yPad) {
    const yCenter = y;
    const halfHeight = (yMax - yMin) / 2;
    yMin = yCenter - halfHeight;
    yMax = yCenter + halfHeight;
    changed = true;
  }

  if (changed) {
    Plotly.relayout(plotDiv, {
      "xaxis.range": [xMin, xMax],
      "yaxis.range": [yMin, yMax],
    });
  }
}

function ensureUmapWindowInView() {
  const win = document.getElementById("umapFloatingWindow");
  if (!win) {
    return;
  }
  const rect = win.getBoundingClientRect();
  const left = rect.left;
  const top = rect.top;

  // Ensure left/top are not negative
  if (left < 0) {
    win.style.left = "0px";
  }
  if (top < 0) {
    win.style.top = "0px";
  }

  // Ensure top/left are not off-screen
  const maxLeft = window.innerWidth - rect.width;
  const maxTop = window.innerHeight - rect.height;
  if (left > maxLeft) {
    win.style.left = Math.max(0, maxLeft) + "px";
  }
  if (top > maxTop) {
    win.style.top = Math.max(0, maxTop) + "px";
  }
}

async function initializeUmapWindow() {
  // Fetch the album's default EPS value and update the spinner
  if (!state.album) {
    return;
  }
  const result = await fetch("get_umap_eps/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ album: state.album }),
  });
  const data = await result.json();
  if (data.success) {
    const epsSpinner = document.getElementById("umapEpsSpinner");
    if (epsSpinner) {
      epsSpinner.value = data.eps;
    }
  }
  state.dataChanged = true;
  lastUnshadedSize = "medium"; // Reset to medium on album change
  populateSemanticMapAlbumSelect();
  fetchUmapData();
  toggleFullscreen(true); // Force fullscreen on album change
}

// --- Thumbnail Preview on Hover ---
let umapThumbnailDiv = null;

async function createUmapThumbnail({ x, y, index, cluster }) {
  // Always remove any existing thumbnail before creating a new one
  removeUmapThumbnail();

  const filename = await getImagePath(state.album, index);
  if (!filename) {
    return;
  } // No valid filename, exit early

  // Find cluster color and calculate cluster size
  const clusterColor = getClusterColor(cluster);
  const clusterSize = points.filter((p) => p.cluster === cluster).length;
  const sizeStr = cluster === -1 ? "Unclustered" : `Cluster ${cluster} (size=${clusterSize})`;
  // Falls back gracefully when the labels endpoint hasn't populated this
  // cluster (or is unavailable).
  const labelInfo = getClusterLabelInfo(cluster);
  const textIsDark = isColorLight(clusterColor) ? "#222" : "#fff";
  const textShadow = isColorLight(clusterColor) ? "0 1px 2px #fff, 0 0px 8px #fff" : "0 1px 2px #000, 0 0px 8px #000";

  // Build image URL (use thumbnail endpoint)
  const imgUrl = `thumbnails/${state.album}/${index}?size=256`;

  // Create the thumbnail div
  umapThumbnailDiv = document.createElement("div");
  umapThumbnailDiv.className = "umap-thumbnail";
  umapThumbnailDiv.style.background = clusterColor; // keep dynamic color

  // Thumbnail image
  const img = document.createElement("img");
  img.src = imgUrl;
  img.alt = filename.split("/").pop();
  umapThumbnailDiv.appendChild(img);

  // Filename
  const fnameDiv = document.createElement("div");
  fnameDiv.className = "umap-thumbnail-filename";
  fnameDiv.textContent = filename.split("/").pop();
  fnameDiv.style.color = textIsDark;
  fnameDiv.style.textShadow = textShadow;
  umapThumbnailDiv.appendChild(fnameDiv);

  // Cluster line: identifier + size only. Tag phrases moved to their own row.
  const clusterDiv = document.createElement("div");
  clusterDiv.className = "umap-thumbnail-cluster";
  clusterDiv.textContent = sizeStr;
  clusterDiv.style.color = textIsDark;
  clusterDiv.style.textShadow = textShadow;
  umapThumbnailDiv.appendChild(clusterDiv);

  // Tags rows, only when the labels endpoint has populated them. Inline rather
  // than title= since the popup disappears on mouse move. The image-tags row is
  // fetched async and appended once it resolves (see below).
  const appendTagsRow = (prefix, tags) => {
    if (!umapThumbnailDiv) {
      return;
    }
    const tagsDiv = document.createElement("div");
    tagsDiv.className = "umap-thumbnail-tags";
    tagsDiv.style.color = textIsDark;
    tagsDiv.style.textShadow = textShadow;
    tagsDiv.appendChild(document.createTextNode(prefix));
    tags.forEach((tag, idx) => {
      if (idx > 0) {
        tagsDiv.appendChild(document.createTextNode(", "));
      }
      const span = document.createElement("span");
      span.className = "tag-value";
      span.textContent = tag;
      tagsDiv.appendChild(span);
    });
    umapThumbnailDiv.appendChild(tagsDiv);
  };

  if (labelInfo) {
    appendTagsRow("Cluster tags: ", [labelInfo.label, ...(labelInfo.alternates || [])].slice(0, 3));
  }

  document.body.appendChild(umapThumbnailDiv);

  // Position the window near the mouse pointer, but not off-screen. Factored
  // out so we can recompute after the async image-tags row is appended.
  const pad = 12;
  const repositionThumbnail = () => {
    if (!umapThumbnailDiv || !document.body.contains(umapThumbnailDiv)) {
      return;
    }
    let rect = null;
    try {
      rect = umapThumbnailDiv.getBoundingClientRect();
    } catch (e) {
      console.warn("Error getting thumbnail div dimensions:", e);
      return;
    }
    let left = x + pad;
    let top = y + pad;
    if (left + rect.width > window.innerWidth - 10) {
      left = x - rect.width - pad;
    }
    if (top + rect.height > window.innerHeight - 10) {
      top = y - rect.height - pad;
    }
    umapThumbnailDiv.style.left = `${Math.max(0, left)}px`;
    umapThumbnailDiv.style.top = `${Math.max(0, top)}px`;
  };

  // Wait for the image to load before showing the div
  img.onload = () => {
    // Make sure the thumbnail div is still present in the DOM
    if (!umapThumbnailDiv || !document.body.contains(umapThumbnailDiv)) {
      return;
    }
    repositionThumbnail();
    umapThumbnailDiv.style.visibility = "visible"; // <-- Show after loaded
  };

  // Handle image load error
  img.onerror = () => {
    if (!umapThumbnailDiv || !document.body.contains(umapThumbnailDiv)) {
      return;
    }
    umapThumbnailDiv.style.visibility = "visible";
    img.alt = "Thumbnail not available";
  };

  // Per-image tags: fetched async (network round-trip on first hit; cached
  // thereafter). When the user moves off before it resolves, removeUmapThumbnail
  // has already nulled/replaced umapThumbnailDiv — the identity check drops the
  // stale append. When the autotagging setting is off, getImageLabelInfo
  // returns null and we skip the row entirely.
  const myDiv = umapThumbnailDiv;
  getImageLabelInfo(state.album, index).then((info) => {
    if (!info || myDiv !== umapThumbnailDiv || !document.body.contains(myDiv)) {
      return;
    }
    appendTagsRow("Image tags: ", [info.label, ...(info.alternates || [])].slice(0, 3));
    repositionThumbnail();
  });
}

function removeUmapThumbnail() {
  // Remove all elements with the umap-thumbnail class
  document.querySelectorAll(".umap-thumbnail").forEach((div) => div.remove());
  umapThumbnailDiv = null;
}

export async function setUmapColorMode() {
  await colorizeUmap({
    highlight: document.getElementById("umapHighlightSelection")?.checked,
    searchResults: state.searchResults,
  });
}

// Ensure color mode is respected after search or cluster selection
window.addEventListener("searchResultsChanged", (e) => {
  updateUmapColorModeAvailability(e.detail.results);
});

function updateUmapColorModeAvailability(searchResults = []) {
  const highlightCheckbox = document.getElementById("umapHighlightSelection");
  if (searchResults.length > 0) {
    highlightCheckbox.disabled = false;
    highlightCheckbox.parentElement.style.opacity = "1";
    highlightCheckbox.checked = true; // Enable checkbox if there are search results
  } else {
    highlightCheckbox.checked = false; // Uncheck if no results
    highlightCheckbox.disabled = true;
    highlightCheckbox.parentElement.style.opacity = "0.5";
  }
  // Note: setUmapColorMode is called by the searchResultsChanged event handler
}

// ------------- Handling Landmark Thumbnails -------------

// Picks the image index to display (and navigate to) for a cluster's landmark.
// The cluster's medoid — the real image whose CLIP embedding is closest to the
// cluster centroid — is more semantically representative than the 2D-position
// pick from getLandmarkForCluster, so prefer it when /cluster_labels supplied
// one. Position of the landmark (the triangle marker) is unaffected; only the
// thumbnail and click target change.
function getLandmarkImageIndex(cluster, clusterPoints) {
  const labelInfo = getClusterLabelInfo(cluster);
  if (labelInfo && typeof labelInfo.medoid_index === "number") {
    return labelInfo.medoid_index;
  }
  return getLandmarkForCluster(clusterPoints).index;
}

// Landmark placement algorithm
function getLandmarkForCluster(pts) {
  // 1. Find X center
  const centerX = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;

  // 2. Compute X spread (standard deviation and range)
  const xs = pts.map((p) => p.x);
  const xMean = centerX;
  const xStd = Math.sqrt(xs.reduce((sum, x) => sum + Math.pow(x - xMean, 2), 0) / xs.length);
  const xRange = Math.max(...xs) - Math.min(...xs);

  // 3. Filter points near centerX (within 0.5 * std or 0.2 * range)
  const threshold = Math.max(xStd * 0.5, xRange * 0.2);
  const candidates = pts.filter((p) => Math.abs(p.x - centerX) <= threshold);

  // 4. Pick highest Y among candidates
  let best = candidates[0] || pts[0];
  for (const p of candidates) {
    if (p.y > best.y) {
      best = p;
    }
  }
  return best;
}

// Helper: get cluster centers and representatives
function getLargestClustersInView(maxLandmarks = 10) {
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.layout) {
    return [];
  }
  const [xMin, xMax] = plotDiv.layout.xaxis.range;
  const [yMin, yMax] = plotDiv.layout.yaxis.range;

  // Group points by cluster
  const clusterMap = new Map();
  points.forEach((p) => {
    if (p.cluster === -1) {
      return;
    }
    if (!clusterMap.has(p.cluster)) {
      clusterMap.set(p.cluster, []);
    }
    clusterMap.get(p.cluster).push(p);
  });

  const clustersInView = [];
  for (const [cluster, pts] of clusterMap.entries()) {
    const landmark = getLandmarkForCluster(pts);
    // Only include if landmark is in view
    if (landmark.x >= xMin && landmark.x <= xMax && landmark.y >= yMin && landmark.y <= yMax) {
      clustersInView.push({
        cluster,
        center: { x: landmark.x, y: landmark.y },
        // Position from the 2D landmark algorithm; image from the medoid when
        // the labels endpoint provided one (semantically more representative).
        representative: getLandmarkImageIndex(cluster, pts),
        color: getClusterColor(cluster),
        size: pts.length,
      });
    }
  }

  clustersInView.sort((a, b) => b.size - a.size);
  return clustersInView.slice(0, maxLandmarks);
}

// --- Update Landmark Trace ---
let isRenderingLandmarks = false;
let lastImagesJSON = null;
let suppressRelayoutEvent = false; // Add this flag

function updateLandmarkTrace() {
  if (isRenderingLandmarks) {
    return;
  }
  isRenderingLandmarks = true;

  try {
    const plotDiv = document.getElementById("umapPlot");
    if (!plotDiv || !plotDiv.layout) {
      return;
    }

    // Remove previous landmark traces (both triangles and click targets)
    const landmarkTraceIdx = plotDiv.data?.findIndex((t) => t.name === "Landmarks");
    let clickTargetTraceIdx = plotDiv.data?.findIndex((t) => t.name === "LandmarkClickTargets");

    // Only delete if index is valid
    if (typeof landmarkTraceIdx === "number" && landmarkTraceIdx >= 0 && landmarkTraceIdx < plotDiv.data.length) {
      suppressRelayoutEvent = true;
      Plotly.deleteTraces(plotDiv, landmarkTraceIdx).then(() => {
        suppressRelayoutEvent = false;
      });
    }

    // Recompute clickTargetTraceIdx after possible deletion above
    clickTargetTraceIdx = plotDiv.data?.findIndex((t) => t.name === "LandmarkClickTargets");
    if (
      typeof clickTargetTraceIdx === "number" &&
      clickTargetTraceIdx >= 0 &&
      clickTargetTraceIdx < plotDiv.data.length
    ) {
      suppressRelayoutEvent = true;
      Plotly.deleteTraces(plotDiv, clickTargetTraceIdx).then(() => {
        suppressRelayoutEvent = false;
      });
    }

    if (!landmarksVisible) {
      if (lastImagesJSON !== null) {
        suppressRelayoutEvent = true;
        Plotly.relayout(plotDiv, { images: [] }).then(() => {
          suppressRelayoutEvent = false;
          lastImagesJSON = null;
        });
      }
      return;
    }

    // Get clusters in view
    const clusters = getLargestClustersInView(100);
    if (!clusters.length) {
      return;
    }

    // Get current axis ranges
    const [xMin, xMax] = plotDiv.layout.xaxis.range;
    const xRange = xMax - xMin;

    // Calculate thumbnail size in data units (adjust multiplier as needed)
    const imageSize = Math.max(0.2, Math.min(2.0, xRange / 10));

    // Estimate thumbnail size in pixels based on plot width and zoom
    const plotWidthPx = plotDiv.offsetWidth || 800;
    const thumbPx = Math.round((imageSize / xRange) * plotWidthPx);

    // Cap thumbnail size at 256 pixels maximum (and keep 64 minimum)
    const thumbSize = Math.max(64, Math.min(256, thumbPx));

    // Triangle marker size in pixels (constant)
    const triangleSize = 32;

    // Calculate offset in data units to move up by 24 pixels
    const plotHeightPx = plotDiv.offsetHeight || 560;
    const yRange = plotDiv.layout.yaxis.range[1] - plotDiv.layout.yaxis.range[0];
    const pixelToData = yRange / plotHeightPx;
    const verticalOffset = 24 * pixelToData;

    // Prepare trace data
    const clustersInView = getNonOverlappingLandmarks(clusters, imageSize, landmarkCount);
    const x = clustersInView.map((c) => c.center.x);
    const y = clustersInView.map((c) => c.center.y + verticalOffset);
    const markerColors = clustersInView.map((c) => c.color);

    // Triangle-down markers at bottom of thumbnails.
    // Rendered with scattergl (WebGL) to match the main point traces. The main
    // points use scattergl, so an SVG `scatter` trace here was the only visible
    // element on the SVG layer. During a touch pan, Plotly translates the SVG
    // layer immediately but only repaints the WebGL scene once the gesture
    // settles, so on tablets a touch-and-immediately-drag made the triangles
    // slide alone while the dots stayed frozen. Keeping the triangles in the
    // same WebGL pipeline makes them freeze-and-snap together with the points.
    const landmarkTrace = {
      x,
      y,
      mode: "markers",
      type: "scattergl",
      marker: {
        size: triangleSize,
        color: markerColors,
        symbol: "triangle-down",
        line: { width: 2, color: "#000" },
      },
      hoverinfo: "none",
      showlegend: false,
      name: "Landmarks",
    };

    // Invisible clickable points over thumbnails
    const clickableTrace = {
      x: clustersInView.map((c, i) => x[i]),
      y: clustersInView.map((c, i) => y[i] + imageSize / 2), // center of image
      mode: "markers",
      type: "scatter",
      marker: {
        color: "rgba(0, 0, 0, 0.0)", // invisible but clickable
        symbol: "square",
        size: thumbSize,
        line: { width: 0 },
      },
      customdata: clustersInView.map((c) => c.cluster), // <-- store cluster ID, not representative index
      hoverinfo: "none",
      showlegend: false,
      name: "LandmarkClickTargets",
    };

    // Add thumbnail images
    const images = clustersInView.map((c, i) => ({
      source: `thumbnails/${state.album}/${c.representative}?size=${thumbSize}&color=${encodeURIComponent(c.color)}`,
      x: x[i],
      y: y[i],
      xref: "x",
      yref: "y",
      sizex: imageSize,
      sizey: imageSize,
      xanchor: "center",
      yanchor: "bottom",
      layer: "above",
    }));

    // Only update if images changed, and set suppressRelayoutEvent properly
    const imagesJSON = JSON.stringify(images);
    if (imagesJSON !== lastImagesJSON) {
      suppressRelayoutEvent = true;
      Plotly.addTraces(plotDiv, [landmarkTrace, clickableTrace])
        .then(() => {
          return Plotly.relayout(plotDiv, { images });
        })
        .then(() => {
          suppressRelayoutEvent = false;
          lastImagesJSON = imagesJSON;
        });
    } else {
      suppressRelayoutEvent = true;
      Plotly.addTraces(plotDiv, [landmarkTrace, clickableTrace]).then(() => {
        suppressRelayoutEvent = false;
      });
    }
  } finally {
    isRenderingLandmarks = false;
  }

  // Move the clickableTrace to the top to ensure it captures clicks
  const plotDiv = document.getElementById("umapPlot");
  const clickableTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "LandmarkClickTargets");
  if (clickableTraceIndex !== -1 && clickableTraceIndex !== plotDiv.data.length - 1) {
    Plotly.moveTraces(plotDiv, clickableTraceIndex, plotDiv.data.length - 1);
  }
}

// Debounced version for event handlers
const debouncedUpdateLandmarkTrace = debounce(updateLandmarkTrace, 500);

// Helper function to get non-overlapping landmarks
function getNonOverlappingLandmarks(clusters, imageSize, landmarkCount = landmarkCount) {
  const placed = [];
  let i = 0;
  while (i < clusters.length && placed.length < landmarkCount) {
    const c = clusters[i];
    const { x, y } = c.center;
    // Check overlap with already placed landmarks
    let overlaps = false;
    for (const p of placed) {
      const dx = Math.abs(x - p.x);
      const dy = Math.abs(y - p.y);
      if (dx < imageSize && dy < imageSize) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) {
      placed.push({ ...c, x, y });
    }
    i++;
  }
  return placed;
}

// --- Greedy random walk ordering for cluster points ---
function randomWalkClusterOrder(clusterIndices, points, startIndex) {
  const indexToPoint = Object.fromEntries(points.map((p) => [p.index, p]));
  const unvisited = new Set(clusterIndices);
  const walk = [startIndex];
  unvisited.delete(startIndex);
  let current = startIndex;

  while (unvisited.size > 0) {
    let nearest = null;
    let nearestDist = Infinity;
    const currentPoint = indexToPoint[current];
    for (const idx of unvisited) {
      const pt = indexToPoint[idx];
      const dist = Math.hypot(pt.x - currentPoint.x, pt.y - currentPoint.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = idx;
      }
    }
    if (nearest !== null) {
      walk.push(nearest);
      unvisited.delete(nearest);
      current = nearest;
    } else {
      break;
    }
  }
  return walk;
}

// -- Fallback ordering of cluster points by proximity to clicked point ---
function proximityClusterOrder(clusterIndices, points, startIndex) {
  const indexToPoint = Object.fromEntries(points.map((p) => [p.index, p]));
  const startPoint = indexToPoint[startIndex];
  return clusterIndices
    .map((idx) => ({
      index: idx,
      dist: Math.hypot(indexToPoint[idx].x - startPoint.x, indexToPoint[idx].y - startPoint.y),
    }))
    .sort((a, b) => a.dist - b.dist)
    .map((item) => item.index);
}

// Shared function for cluster clicks
async function handleClusterClick(clickedIndex) {
  const clickedPoint = points.find((p) => p.index === clickedIndex);
  if (!clickedPoint) {
    return;
  }

  // Show spinner immediately to provide visual feedback
  showUmapSpinner();

  // Yield to the browser to allow spinner to render before heavy computation
  await new Promise((resolve) => setTimeout(resolve, 0));

  const clickedCluster = clickedPoint.cluster;
  const clusterColor = getClusterColor(clickedCluster);
  let clusterIndices = points.filter((p) => p.cluster === clickedCluster).map((p) => p.index);

  // Remove clickedFilename from the list
  clusterIndices = clusterIndices.filter((fn) => fn !== clickedIndex);

  // --- Greedy random walk order from clicked point ---
  const sort_algorithm = clusterIndices.length > randomWalkMaxSize ? proximityClusterOrder : randomWalkClusterOrder;
  const sortedClusterIndices = sort_algorithm([clickedIndex, ...clusterIndices], points, clickedIndex);

  const clusterMembers = sortedClusterIndices.map((index) => ({
    index: index,
    cluster: clickedCluster === -1 ? "unclustered" : clickedCluster,
    color: clusterColor,
  }));

  setSearchResults(clusterMembers, "cluster");
  // Note: spinner is hidden by searchResultsChanged event handler after colorization completes
}

// Handle single image selection (navigate to clicked image)
async function handleImageClick(clickedIndex) {
  const clickedPoint = points.find((p) => p.index === clickedIndex);
  if (!clickedPoint) {
    return;
  }

  // Show spinner immediately to provide visual feedback
  showUmapSpinner();

  // Yield to the browser to allow spinner to render before heavy computation
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Clear any existing search selection
  exitSearchMode();

  // Navigate directly to the clicked image without entering search mode
  backStack.markNextAsJump("cluster");
  slideState.navigateToIndex(clickedIndex, false);

  // Exit fullscreen mode if enabled
  if (isFullscreen && state.umapExitFullscreenOnSelection) {
    setTimeout(() => toggleFullscreen(false), 100); // slight delay to avoid flicker
  }
  // Note: spinner is hidden by searchResultsChanged event handler after colorization completes
}

// -------------------- Window Management --------------------

function applyUmapControlsVisibility() {
  const controls = document.getElementById("umapControls");
  const btn = document.getElementById("umapToggleControlsBtn");
  const visible = state.umapControlsVisible;
  if (controls) {
    controls.style.display = visible ? "" : "none";
  }
  if (btn) {
    btn.style.opacity = visible ? "1" : "0.35";
    btn.title = visible ? "Hide controls" : "Show controls";
  }
}

// --- Show/Hide UMAP Window ---
export async function toggleUmapWindow(show = null) {
  const umapWindow = document.getElementById("umapFloatingWindow");

  if (show === null) {
    show = document.getElementById("umapFloatingWindow").style.display !== "block";
  }

  if (show === false) {
    umapWindow.style.display = "none";
  } else {
    umapWindow.style.display = "block";
    applyUmapControlsVisibility();
    ensureUmapWindowInView();
    if (!umapWindowHasBeenShown) {
      umapWindowHasBeenShown = true;
      setUmapWindowSize("fullscreen");
    }

    if (state.album === null) {
      return;
    }

    // If an index update is already running for this album (e.g. started
    // from Album Management), show the titlebar progress ring for it.
    checkUmapReindexOngoing();

    // Fetch configured eps value from server
    const result = await fetch("get_umap_eps/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ album: state.album }),
    });
    const data = await result.json();
    if (!data.success) {
      console.error("Failed to fetch UMAP EPS value:", data.message);
      return;
    }
    const epsSpinner = document.getElementById("umapEpsSpinner");
    if (epsSpinner) {
      epsSpinner.value = data.eps;
    }
    await fetchUmapData();
  }
}

document.getElementById("showUmapBtn").onclick = () => toggleUmapWindow();
document.getElementById("umapCloseBtn").onclick = () => {
  document.getElementById("umapFloatingWindow").style.display = "none";
};
document.getElementById("umapToggleControlsBtn").onclick = () => {
  setUmapControlsVisible(!state.umapControlsVisible);
  applyUmapControlsVisibility();
  if (!isShaded) {
    saveCurrentPosition(); // anchor to current position before resizing
    setUmapWindowSize(getCurrentWindowSize());
  }
};

// --- Draggable Window ---
// Wire the UMAP floating window's titlebar to the shared `makeDraggable` helper.
// The right/bottom/position overrides keep the win element from snapping back
// to its CSS-defined corner when its layout was originally anchored that way.
function setupUmapWindowDrag(dragHandleId, windowId) {
  const dragHandle = document.getElementById(dragHandleId);
  const win = document.getElementById(windowId);
  if (!dragHandle || !win) {
    return;
  }
  makeDraggable(dragHandle, win, {
    shouldDrag: (e) => !e.target.closest(".icon-btn") && e.target.id !== "umapCloseBtn",
    setPosition: (left, top) => {
      win.style.left = `${left}px`;
      win.style.top = `${top}px`;
      win.style.right = "auto";
      win.style.bottom = "auto";
      win.style.position = "fixed";
    },
  });
}

function setActiveResizeIcon(sizeKey) {
  // Remove 'active' from all resize icons
  document.getElementById("umapResizeBig").classList.remove("active");
  document.getElementById("umapResizeMedium").classList.remove("active");
  document.getElementById("umapResizeSmall").classList.remove("active");
  document.getElementById("umapResizeFullscreen").classList.remove("active");
  document.getElementById("umapResizeShaded").classList.remove("active");

  // Add 'active' to the current icon
  if (sizeKey === "big") {
    document.getElementById("umapResizeBig").classList.add("active");
  } else if (sizeKey === "medium") {
    document.getElementById("umapResizeMedium").classList.add("active");
  } else if (sizeKey === "small") {
    document.getElementById("umapResizeSmall").classList.add("active");
  } else if (sizeKey === "fullscreen") {
    document.getElementById("umapResizeFullscreen").classList.add("active");
  } else if (sizeKey === "shaded") {
    document.getElementById("umapResizeShaded").classList.add("active");
  }
}

// Call setActiveResizeIcon whenever you change the window size
// For example, at the end of setUmapWindowSize:
function setUmapWindowSize(sizeKey) {
  const win = document.getElementById("umapFloatingWindow");
  const plotDiv = document.getElementById("umapPlot");
  const contentDiv = document.getElementById("umapContent");
  const landmarkCheckbox = document.getElementById("umapShowLandmarks");
  const controlsDiv = document.getElementById("umapControls");

  win.style.opacity = "0.75"; // default opacity for all sizes
  contentDiv.style.position = "relative";
  controlsDiv.style.position = "";
  controlsDiv.style.bottom = "";
  controlsDiv.style.height = "";

  if (sizeKey === "shaded") {
    // Do not change landmarksVisible or checkbox
    if (contentDiv) {
      contentDiv.style.display = "none";
    }
    // Preserve current width
    const currentWidth = win.style.width || win.getBoundingClientRect().width + "px";
    win.style.width = currentWidth;
    win.style.height = "48px"; // Just enough for titlebar (adjust as needed)
    win.style.minHeight = "0";
    plotDiv.style.width = currentWidth;
    plotDiv.style.height = "0px";
  } else if (sizeKey === "fullscreen") {
    const narrowScreen = window.innerWidth <= 600;
    if (contentDiv) {
      contentDiv.style.display = "block";
    }
    // controlsHeight: space reserved below the plot for UMAP controls
    const controlsHeight = state.umapControlsVisible ? 110 : 40;
    // Measure how much vertical space the bottom Control/Search panels occupy.
    // The window covers the full viewport; its dark background fills the dead zone behind the panels.
    const bottomPanel = document.getElementById("controlPanel");
    const panelReservedHeight = bottomPanel
      ? Math.round(window.innerHeight - bottomPanel.getBoundingClientRect().top) + 16
      : 96; // +16 ≈ 1em gap above the panels
    const windowHeight = window.innerHeight;
    win.style.left = "0px";
    win.style.top = "0px";
    win.style.width = window.innerWidth + "px";
    win.style.height = windowHeight + "px";
    win.style.minHeight = "200px";
    win.style.maxWidth = "100vw";
    win.style.maxHeight = "100vh";
    win.style.opacity = "1";
    const plotHeight = windowHeight - controlsHeight - panelReservedHeight;
    plotDiv.style.width = window.innerWidth - 32 + "px";
    plotDiv.style.height = plotHeight + "px";
    if (narrowScreen) {
      // Change positioning of the controls
      contentDiv.style.position = "relative";
      controlsDiv.style.position = "absolute";
      controlsDiv.style.bottom = "60px";
      controlsDiv.style.height = "60px";
    }

    if (plotDiv.data && plotDiv.data.length > 0) {
      Plotly.relayout(plotDiv, {
        width: window.innerWidth - 32,
        height: plotHeight,
        "xaxis.scaleanchor": "y",
      });
    }
  } else {
    if (contentDiv) {
      contentDiv.style.display = "block";
    }
    const { width, height } = UMAP_SIZES[sizeKey];
    const bottomPadding = 8; // add breathing room under plot
    const extraWindowHeight = state.umapControlsVisible ? 130 : 60;
    const desiredWindowHeight = height + extraWindowHeight + bottomPadding;
    win.style.width = width + 60 + "px";
    win.style.height = Math.min(desiredWindowHeight, window.innerHeight - 20) + "px"; // window taller, capped at viewport
    win.style.minHeight = "200px";
    plotDiv.style.width = width + "px";
    plotDiv.style.height = height - bottomPadding + "px"; // plot area shorter
    Plotly.relayout(plotDiv, { width, height: height - bottomPadding });

    // Turn landmarks OFF in small
    if (sizeKey === "small" && landmarkCheckbox) {
      landmarkCheckbox.checked = false;
      landmarksVisible = false;
      updateLandmarkTrace();
    }
  }

  // Only update position if not shading
  if (sizeKey !== "shaded") {
    if (lastUnshadedPosition.left === null || lastUnshadedPosition.top === null) {
      // Place near top-right with 8px gap
      const winRect = win.getBoundingClientRect();
      const width = winRect.width || win.offsetWidth || 600;
      win.style.top = "8px";
      win.style.left = `${window.innerWidth - width - 8}px`;
    } else {
      win.style.left = lastUnshadedPosition.left;
      win.style.top = lastUnshadedPosition.top;
    }
  }

  if (sizeKey !== "fullscreen") {
    saveCurrentPosition();
  }
  setActiveResizeIcon(sizeKey);
  ensureUmapWindowInView();
  removeUmapThumbnail(); // just in case
}

// Titlebar resizing/dragging code is here.
// Initialize draggable UMAP window a fter DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  updateUmapColorModeAvailability();
  setupUmapWindowDrag("umapTitlebar", "umapFloatingWindow");
  toggleUmapWindow();
});

// Shading/restoring
function toggleShade() {
  if (isShaded) {
    setUmapWindowSize(lastUnshadedSize);
    isShaded = false;
  } else {
    lastUnshadedSize = getCurrentWindowSize();
    setUmapWindowSize("shaded");
    isShaded = true;
  }
}

// Double-click titlebar to toggle shaded mode
document.getElementById("umapTitlebar").ondblclick = toggleShade;

// Shade icon toggles shaded/unshaded
document.getElementById("umapResizeShaded").onclick = toggleShade;

// Resize buttons
function addButtonHandlers(id, handler) {
  const btn = document.getElementById(id);
  btn.onclick = handler;
  btn.ontouchend = function (e) {
    e.preventDefault();
    handler(e);
  };
}

addButtonHandlers("umapResizeBig", () => {
  setUmapWindowSize("big");
  lastUnshadedSize = "big";
  saveCurrentPosition();
  isFullscreen = false;
  updateExitFullscreenCheckboxState();
});
export function setUmapMediumSize() {
  setUmapWindowSize("medium");
  lastUnshadedSize = "medium";
  saveCurrentPosition();
  isFullscreen = false;
  updateExitFullscreenCheckboxState();
}
addButtonHandlers("umapResizeMedium", setUmapMediumSize);
addButtonHandlers("umapResizeSmall", () => {
  setUmapWindowSize("small");
  lastUnshadedSize = "small";
  saveCurrentPosition();
  isFullscreen = false;
  updateExitFullscreenCheckboxState();
});
function toggleFullscreen(turnOn = null) {
  const win = document.getElementById("umapFloatingWindow");
  if (turnOn === null) {
    turnOn = !isFullscreen;
  }
  if (turnOn && isFullscreen) {
    return;
  } // already in fullscreen

  if (turnOn) {
    lastUnshadedSize = getCurrentWindowSize();
    lastUnshadedPosition.left = win.style.left;
    lastUnshadedPosition.top = win.style.top;
    setUmapWindowSize("fullscreen");
    win.style.left = "0px";
    win.style.top = "0px";
    isFullscreen = true;
  } else {
    setUmapWindowSize(lastUnshadedSize);
    isFullscreen = false;
  }
  // if any hover thumbnail is visible, remove it
  removeUmapThumbnail();
  // Update checkbox state when fullscreen mode changes
  updateExitFullscreenCheckboxState();
}

addButtonHandlers("umapResizeFullscreen", toggleFullscreen);
addButtonHandlers("umapCloseBtn", () => {
  document.getElementById("umapFloatingWindow").style.display = "none";
});

// --- Cluster Info Modal ---
function showClusterInfoModal() {
  const modal = document.getElementById("umapClusterInfoModal");
  if (!modal) {
    return;
  }

  // Compute stats from the module-level points array
  const eps = parseFloat(document.getElementById("umapEpsSpinner").value);
  const clustered = points.filter((p) => p.cluster !== -1);
  const clusterIds = [...new Set(clustered.map((p) => p.cluster))];
  const clusterCount = clusterIds.length;
  const unclusteredCount = points.length - clustered.length;

  let largestSize = 0;
  let smallestSize = Infinity;
  for (const id of clusterIds) {
    const size = points.filter((p) => p.cluster === id).length;
    if (size > largestSize) {
      largestSize = size;
    }
    if (size < smallestSize) {
      smallestSize = size;
    }
  }
  if (clusterCount === 0) {
    largestSize = 0;
    smallestSize = 0;
  }

  document.getElementById("umapInfoEps").textContent = isNaN(eps) ? "—" : eps.toFixed(2);
  document.getElementById("umapInfoClusterCount").textContent =
    clusterCount === 1 ? "1 cluster" : `${clusterCount} clusters`;
  document.getElementById("umapInfoLargest").textContent = largestSize === 1 ? "1 image" : `${largestSize} images`;
  document.getElementById("umapInfoSmallest").textContent = smallestSize === 1 ? "1 image" : `${smallestSize} images`;
  document.getElementById("umapInfoUnclustered").textContent =
    unclusteredCount === 1 ? "1 image" : `${unclusteredCount} images`;
  document.getElementById("umapInfoTotal").textContent = points.length === 1 ? "1 image" : `${points.length} images`;

  modal.classList.add("visible");
}

function hideClusterInfoModal() {
  const modal = document.getElementById("umapClusterInfoModal");
  if (modal) {
    modal.classList.remove("visible");
  }
}

document.getElementById("umapClusterInfoBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  showClusterInfoModal();
});

document.getElementById("umapClusterInfoClose").addEventListener("click", hideClusterInfoModal);

document.getElementById("umapClusterInfoModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    hideClusterInfoModal();
  }
});

window.addEventListener("resize", () => {
  // Only resize if UMAP window is in fullscreen mode
  const win = document.getElementById("umapFloatingWindow");
  if (!win || win.style.display !== "block") {
    return;
  }
  if (isFullscreen) {
    setUmapWindowSize("fullscreen");
    // Optionally, update landmarks and current image marker
    updateLandmarkTrace();
    updateCurrentImageMarker();
  }
});

window.addEventListener("slideshowStartRequested", () => {
  toggleUmapWindow(false);
});

// Populate the album dropdown in the semantic-map titlebar and select the
// current album. The change listener is attached once in
// setupSemanticMapAlbumSelect(); this only refreshes the options.
async function populateSemanticMapAlbumSelect() {
  const select = document.getElementById("semanticMapAlbumSelect");
  if (!select) {
    return;
  }
  let albums;
  try {
    albums = await albumManager.fetchAvailableAlbums();
  } catch (err) {
    console.error("Failed to load albums for semantic map dropdown:", err);
    return;
  }
  select.innerHTML = "";
  if (!albums || albums.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Semantic Map";
    option.disabled = true;
    option.selected = true;
    select.appendChild(option);
    return;
  }
  for (const album of albums) {
    const option = document.createElement("option");
    option.value = album.key;
    option.textContent = album.name;
    select.appendChild(option);
  }
  if (state.album) {
    select.value = state.album;
  }
}

function setupSemanticMapAlbumSelect() {
  const select = document.getElementById("semanticMapAlbumSelect");
  if (!select || select.dataset.listenerAttached === "true") {
    return;
  }
  select.dataset.listenerAttached = "true";
  // Block titlebar drag/double-click from hijacking native dropdown behavior.
  ["mousedown", "touchstart", "click", "dblclick"].forEach((evt) => {
    select.addEventListener(evt, (e) => e.stopPropagation());
  });
  select.addEventListener("change", () => {
    const newAlbum = select.value;
    if (newAlbum && newAlbum !== state.album) {
      switchAlbum(newAlbum);
    }
  });
}

// Expose function to check if UMAP is in fullscreen mode.
export function isUmapFullscreen() {
  return isFullscreen;
}

// Set initial title on DOMContentLoaded
document.addEventListener("DOMContentLoaded", () => {
  setupSemanticMapAlbumSelect();
  populateSemanticMapAlbumSelect();
  initUmapReindexButton();
  initializeUmapWindow();
});

// An index update of the current album finished (titlebar reindex button or
// Album Management): the map data is stale. Reload right away if the window
// is showing; otherwise the dataChanged flag makes toggleUmapWindow's show
// path refetch, without rendering Plotly into a hidden container here.
window.addEventListener("albumIndexUpdated", (e) => {
  if (e.detail?.albumKey === state.album) {
    state.dataChanged = true;
    const umapWindow = document.getElementById("umapFloatingWindow");
    if (umapWindow?.style.display === "block") {
      fetchUmapData();
    }
  }
});
window.addEventListener("albumChanged", (e) => {
  // A "refresh" is the same album re-indexed in place: the map reload is
  // handled by the albumIndexUpdated listener above, and re-initializing
  // here would refetch a second time and force the window fullscreen.
  if (e.detail?.changeType !== "refresh") {
    initializeUmapWindow();
  }
});

// ========================================================
// Toggle Curation Mode (Grey out all points)
// ========================================================
export function setCurationMode(isActive) {
  isCurationModeActive = isActive;
  updateUmapColors();
}

function updateUmapColors() {
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.data || !points || points.length === 0) {
    return;
  }

  // Find the "All Points" trace
  const allPointsTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "All Points");
  if (allPointsTraceIndex === -1) {
    return;
  }

  // Set colors and opacity based on curation mode
  let markerColors;
  let markerOpacity;

  if (isCurationModeActive) {
    // Grey out all points when in curation mode
    markerColors = points.map(() => "#888888");
    // Increase opacity of unclustered points to match clustered ones
    markerOpacity = points.map(() => 0.75);
  } else {
    // Use cluster colors
    markerColors = points.map((p) => getClusterColor(p.cluster));
    // Default opacity: unclustered = 0.08, clustered = 0.75
    markerOpacity = points.map((p) => (p.cluster === -1 ? 0.08 : 0.75));
  }

  Plotly.restyle(
    "umapPlot",
    {
      "marker.color": [markerColors],
      "marker.opacity": [markerOpacity],
    },
    allPointsTraceIndex
  );
}

// ========================================================
// Curation Highlighting (Heatmap + Locks)
// ========================================================
export function highlightCurationSelection(highIndices, medIndices, lowIndices, lockedIndices) {
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !points || points.length === 0) {
    return;
  }

  // 1. Remove old curation traces
  const tracesToRemove = [];
  if (plotDiv.data) {
    plotDiv.data.forEach((t, i) => {
      if (t.name.startsWith("Curation")) {
        tracesToRemove.push(i);
      }
    });
  }
  if (tracesToRemove.length > 0) {
    Plotly.deleteTraces(plotDiv, tracesToRemove);
  }

  const newTraces = [];
  const lockedSet = new Set(lockedIndices || []);

  // Helper to build trace
  const createTrace = (indices, color, name, size = 8) => {
    if (!indices || indices.length === 0) {
      return null;
    }

    // STRICT FILTER: Never draw a dot in this trace if it is also Locked
    // This prevents Cyan/Magenta from painting over Red
    const validIndices = indices.filter((i) => !lockedSet.has(i));
    if (validIndices.length === 0) {
      return null;
    }

    const idxSet = new Set(validIndices);
    const pts = points.filter((p) => idxSet.has(p.index));

    return {
      x: pts.map((p) => p.x),
      y: pts.map((p) => p.y),
      mode: "markers",
      type: "scattergl",
      name: name,
      marker: {
        color: color,
        size: size,
        symbol: "circle",
        opacity: 1,
        line: { color: "#ffffff", width: 1 },
      },
      hoverinfo: "none",
    };
  };

  // Draw Heatmap Layers FIRST (Bottom)
  const tLow = createTrace(lowIndices, "#00ff00", "CurationLow");
  if (tLow) {
    newTraces.push(tLow);
  }

  const tMed = createTrace(medIndices, "#00ffff", "CurationMed");
  if (tMed) {
    newTraces.push(tMed);
  }

  const tHigh = createTrace(highIndices, "#ff00ff", "CurationHigh");
  if (tHigh) {
    newTraces.push(tHigh);
  }

  // Draw Locked Layer LAST (Top) - No filtering needed here
  if (lockedIndices && lockedIndices.length > 0) {
    const lockedPts = points.filter((p) => lockedSet.has(p.index));
    if (lockedPts.length > 0) {
      newTraces.push({
        x: lockedPts.map((p) => p.x),
        y: lockedPts.map((p) => p.y),
        mode: "markers",
        type: "scattergl",
        name: "CurationLocked",
        marker: {
          color: "#ff0000", // Red
          size: 8,
          symbol: "circle",
          opacity: 1,
          line: { color: "#ffffff", width: 1 },
        },
        hoverinfo: "none",
      });
    }
  }

  if (newTraces.length > 0) {
    Plotly.addTraces(plotDiv, newTraces);
  }
}

// ========================================================
// Clear the Yellow "Current Image" Dot
// ========================================================
export function hideCurrentImageMarker() {
  // 1. Stop any pending updates from the race condition
  if (updateMarkerTimer) {
    clearTimeout(updateMarkerTimer);
  }

  // 2. Set a "Dead Zone" to ignore updates during manual navigation.
  // Any slideChange events occurring in the next period will be ignored.
  ignoreUpdatesUntil = Date.now() + MARKER_UPDATE_IGNORE_WINDOW_MS;

  // 3. Force hide the dot immediately
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.data) {
    return;
  }

  const markerTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "Current Image");

  if (markerTraceIndex !== -1) {
    Plotly.restyle("umapPlot", { x: [[]], y: [[]] }, markerTraceIndex);
  }
}
