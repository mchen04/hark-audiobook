import { afterEach, describe, expect, it, vi } from "vitest";

import { checkLemonade, describeLemonadeStatus, loopbackBlockedByHttps } from "./lemonade-status";

afterEach(() => {
  vi.unstubAllGlobals();
});

function modelsResponse(models: unknown) {
  return new Response(JSON.stringify({ data: models }), { status: 200 });
}

describe("loopbackBlockedByHttps", () => {
  it("blocks a loopback origin reached from an https page", () => {
    expect(loopbackBlockedByHttps("http://localhost:13305", "https:")).toBe(true);
  });

  it("allows it from a page served over plain http, which is the local build", () => {
    expect(loopbackBlockedByHttps("http://localhost:13305", "http:")).toBe(false);
  });

  it("allows an https Lemonade, which the browser has no reason to refuse", () => {
    expect(loopbackBlockedByHttps("https://lemonade.local", "https:")).toBe(false);
  });

  it("treats an unparseable origin as something else's problem", () => {
    expect(loopbackBlockedByHttps("not a url", "https:")).toBe(false);
  });
});

describe("checkLemonade", () => {
  it("reports ready when the voice is downloaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(modelsResponse([{ id: "kokoro-v1", downloaded: true }])),
    );
    await expect(checkLemonade("http://localhost:13305", "http:")).resolves.toMatchObject({
      kind: "ready",
    });
  });

  it("separates a downloaded voice from a merely registered one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(modelsResponse([{ id: "kokoro-v1", downloaded: false }])),
    );
    await expect(checkLemonade("http://localhost:13305", "http:")).resolves.toMatchObject({
      kind: "model-missing",
    });
  });

  it("names the https block instead of blaming the port", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkLemonade("http://localhost:13305", "https:")).resolves.toMatchObject({
      kind: "blocked-by-https",
    });
    // The point of detecting it is not attempting a request that cannot work.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an address that is not a URL before trying to reach it", async () => {
    await expect(checkLemonade("13305", "http:")).resolves.toMatchObject({ kind: "bad-origin" });
  });

  it("reports nothing listening rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(checkLemonade("http://localhost:9999", "http:")).resolves.toMatchObject({
      kind: "unreachable",
    });
  });

  it("reports a stranger on the port as unreachable, not ready", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    await expect(checkLemonade("http://localhost:13305", "http:")).resolves.toMatchObject({
      kind: "unreachable",
    });
  });
});

describe("describeLemonadeStatus", () => {
  it("tells an https visitor to run Hark locally, not to fix the port", () => {
    const message = describeLemonadeStatus({
      kind: "blocked-by-https",
      origin: "http://localhost:13305",
    });
    expect(message).toMatch(/run hark locally/i);
    expect(message).not.toMatch(/port/i);
  });

  it("names the command that downloads the missing voice", () => {
    expect(describeLemonadeStatus({ kind: "model-missing", origin: "x" })).toContain(
      "lemonade pull kokoro-v1",
    );
  });
});
