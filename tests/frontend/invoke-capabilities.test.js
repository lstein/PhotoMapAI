// Unit tests for invoke-capabilities.js — the body-class gating that reveals
// only the InvokeAI recall buttons the configured backend supports.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// Provide a real fetchJson implementation that delegates to global.fetch so
// the tests can stub global.fetch and control what the backend reports.
jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
  async fetchJson(url, options = {}) {
    const response = await global.fetch(url, options);
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`);
      err.name = "HttpError";
      err.status = response.status;
      throw err;
    }
    return await response.json();
  },
}));

const { refreshInvokeCapabilities } = await import("../../photomap/frontend/static/javascript/invoke-capabilities.js");

function mockCapabilities(caps) {
  const fetchMock = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(caps),
    })
  );
  global.fetch = fetchMock;
  return fetchMock;
}

describe("invoke-capabilities.js", () => {
  beforeEach(() => {
    document.body.className = "";
  });

  afterEach(() => {
    delete global.fetch;
    document.body.className = "";
  });

  it("sets both body classes when recall and append are supported", async () => {
    mockCapabilities({ configured: true, reachable: true, recall: true, append: true });

    await refreshInvokeCapabilities();

    expect(document.body.classList.contains("invoke-recall-supported")).toBe(true);
    expect(document.body.classList.contains("invoke-append-supported")).toBe(true);
  });

  it("sets only the recall class when append is unsupported", async () => {
    mockCapabilities({ configured: true, reachable: true, recall: true, append: false });

    await refreshInvokeCapabilities();

    expect(document.body.classList.contains("invoke-recall-supported")).toBe(true);
    expect(document.body.classList.contains("invoke-append-supported")).toBe(false);
  });

  it("removes previously-set classes when support disappears", async () => {
    document.body.classList.add("invoke-recall-supported", "invoke-append-supported");
    mockCapabilities({ configured: true, reachable: true, recall: false, append: false });

    await refreshInvokeCapabilities();

    expect(document.body.classList.contains("invoke-recall-supported")).toBe(false);
    expect(document.body.classList.contains("invoke-append-supported")).toBe(false);
  });

  it("treats a failed capabilities fetch as unsupported", async () => {
    document.body.classList.add("invoke-recall-supported", "invoke-append-supported");
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 502 }));

    const caps = await refreshInvokeCapabilities();

    expect(caps).toEqual({ recall: false, append: false });
    expect(document.body.classList.contains("invoke-recall-supported")).toBe(false);
    expect(document.body.classList.contains("invoke-append-supported")).toBe(false);
  });

  it("requests a forced re-probe with refresh: true", async () => {
    const fetchMock = mockCapabilities({ recall: true, append: true });

    await refreshInvokeCapabilities({ refresh: true });

    expect(fetchMock.mock.calls[0][0]).toBe("invokeai/capabilities?refresh=true");
  });

  it("hits the plain endpoint by default", async () => {
    const fetchMock = mockCapabilities({ recall: true, append: true });

    await refreshInvokeCapabilities();

    expect(fetchMock.mock.calls[0][0]).toBe("invokeai/capabilities");
  });
});
