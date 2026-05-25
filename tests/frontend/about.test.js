// Unit tests for about.js — version check caching and badge behavior
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

function setupDom() {
  document.body.innerHTML = `
    <button id="aboutBtn" title="About"></button>
    <div id="aboutModal" style="display:none;">
      <button id="closeAboutBtn">x</button>
      <div class="about-links-row"></div>
    </div>
  `;
}

// The module instantiates a singleton at import time, so we must ensure the
// DOM and fetch are set up before the first dynamic import.
setupDom();
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        current_version: "1.0.5",
        latest_version: "1.0.5",
        update_available: false,
      }),
  })
);

const aboutModule = await import("../../photomap/frontend/static/javascript/about.js");
const { AboutManager, VERSION_CACHE_KEY, VERSION_DISMISSED_KEY, VERSION_CACHE_TTL_MS } = aboutModule;

function mockFetchResponse(body, ok = true) {
  global.fetch.mockImplementationOnce(() => Promise.resolve({ ok, json: () => Promise.resolve(body) }));
}

describe("AboutManager version check badge", () => {
  beforeEach(() => {
    setupDom();
    localStorage.clear();
    global.fetch.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows the badge when cached check reports an update", async () => {
    localStorage.setItem(
      VERSION_CACHE_KEY,
      JSON.stringify({
        updateAvailable: true,
        latestVersion: "2.0.0",
        currentVersion: "1.0.5",
        checkedAt: Date.now(),
      })
    );

    new AboutManager();

    expect(document.getElementById("aboutBtn").classList.contains("has-update")).toBe(true);
    // Fresh cache means no network request.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not show the badge when cached check reports no update", async () => {
    localStorage.setItem(
      VERSION_CACHE_KEY,
      JSON.stringify({
        updateAvailable: false,
        latestVersion: "1.0.5",
        currentVersion: "1.0.5",
        checkedAt: Date.now(),
      })
    );

    new AboutManager();

    expect(document.getElementById("aboutBtn").classList.contains("has-update")).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("hides the badge when the cached latestVersion was already dismissed", async () => {
    localStorage.setItem(
      VERSION_CACHE_KEY,
      JSON.stringify({
        updateAvailable: true,
        latestVersion: "2.0.0",
        currentVersion: "1.0.5",
        checkedAt: Date.now(),
      })
    );
    localStorage.setItem(VERSION_DISMISSED_KEY, "2.0.0");

    new AboutManager();

    expect(document.getElementById("aboutBtn").classList.contains("has-update")).toBe(false);
  });

  it("re-shows the badge when a newer version arrives after a dismissal", async () => {
    localStorage.setItem(VERSION_DISMISSED_KEY, "2.0.0");
    localStorage.setItem(
      VERSION_CACHE_KEY,
      JSON.stringify({
        updateAvailable: true,
        latestVersion: "2.1.0",
        currentVersion: "1.0.5",
        checkedAt: Date.now(),
      })
    );

    new AboutManager();

    expect(document.getElementById("aboutBtn").classList.contains("has-update")).toBe(true);
  });

  it("refreshes via fetch when no cache exists, and caches the result", async () => {
    mockFetchResponse({
      current_version: "1.0.5",
      latest_version: "2.0.0",
      update_available: true,
    });

    new AboutManager();

    // Let the background refresh promise settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(global.fetch).toHaveBeenCalledWith("version/check");
    const cached = JSON.parse(localStorage.getItem(VERSION_CACHE_KEY));
    expect(cached.updateAvailable).toBe(true);
    expect(cached.latestVersion).toBe("2.0.0");
    expect(document.getElementById("aboutBtn").classList.contains("has-update")).toBe(true);
  });

  it("refetches when the cache has expired", async () => {
    localStorage.setItem(
      VERSION_CACHE_KEY,
      JSON.stringify({
        updateAvailable: false,
        latestVersion: "1.0.5",
        currentVersion: "1.0.5",
        checkedAt: Date.now() - VERSION_CACHE_TTL_MS - 1000,
      })
    );

    mockFetchResponse({
      current_version: "1.0.5",
      latest_version: "2.0.0",
      update_available: true,
    });

    new AboutManager();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(global.fetch).toHaveBeenCalledWith("version/check");
    expect(document.getElementById("aboutBtn").classList.contains("has-update")).toBe(true);
  });

  it("clears the badge and records the dismissed version when the modal opens", async () => {
    localStorage.setItem(
      VERSION_CACHE_KEY,
      JSON.stringify({
        updateAvailable: true,
        latestVersion: "2.0.0",
        currentVersion: "1.0.5",
        checkedAt: Date.now(),
      })
    );

    const manager = new AboutManager();
    expect(document.getElementById("aboutBtn").classList.contains("has-update")).toBe(true);

    // The modal's checkForUpdates() will fire on open; satisfy it.
    mockFetchResponse({
      current_version: "1.0.5",
      latest_version: "2.0.0",
      update_available: true,
    });

    manager.showModal();

    expect(document.getElementById("aboutBtn").classList.contains("has-update")).toBe(false);
    expect(localStorage.getItem(VERSION_DISMISSED_KEY)).toBe("2.0.0");
  });

  it("keeps the badge hidden on the next load after dismissal (same latest version)", async () => {
    // Simulate: user dismissed 2.0.0 earlier; cache still says 2.0.0 is latest.
    localStorage.setItem(VERSION_DISMISSED_KEY, "2.0.0");
    localStorage.setItem(
      VERSION_CACHE_KEY,
      JSON.stringify({
        updateAvailable: true,
        latestVersion: "2.0.0",
        currentVersion: "1.0.5",
        checkedAt: Date.now(),
      })
    );

    new AboutManager();

    expect(document.getElementById("aboutBtn").classList.contains("has-update")).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not crash when fetch fails during refresh", async () => {
    global.fetch.mockImplementationOnce(() => Promise.reject(new Error("network down")));

    new AboutManager();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById("aboutBtn").classList.contains("has-update")).toBe(false);
    expect(localStorage.getItem(VERSION_CACHE_KEY)).toBeNull();
  });
});
