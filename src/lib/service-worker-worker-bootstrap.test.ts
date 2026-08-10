import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const source = readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
const bootstrapPredicate = source.match(/function isTurbopackWorkerBootstrap\([^]*?\n\}/)?.[0];
const assetHandler = source.match(/async function serveShellAsset\([^]*?\n\}/)?.[0];
const bootstrapHandler = source.match(
  /async function serveTurbopackWorkerBootstrap\([^]*?\n\}/,
)?.[0];
const detachResponseUrl = source.match(/async function detachResponseUrl\([^]*?\n\}/)?.[0];

describe("service-worker module-worker bootstrap", () => {
  it("detaches a cached response URL so each worker keeps its own fragment selector", async () => {
    expect(bootstrapPredicate, "the worker-bootstrap cache guard is missing").toBeTruthy();
    expect(assetHandler, "the static-asset handler cannot be exercised").toBeTruthy();
    expect(bootstrapHandler, "the worker-bootstrap handler is missing").toBeTruthy();
    expect(detachResponseUrl, "cached response URLs are not detached").toBeTruthy();
    if (!bootstrapPredicate || !assetHandler || !bootstrapHandler || !detachResponseUrl) return;

    const canonical = {
      match: vi.fn(
        async () =>
          new Response("shared Turbopack bootstrap", {
            headers: { "Content-Encoding": "gzip", "Content-Length": "99" },
          }),
      ),
      put: vi.fn(async () => undefined),
    };
    const cacheStorage = {
      match: vi.fn(async () => undefined),
    };
    const fetchMock = vi.fn(async () => new Response("fresh Kestrel worker"));
    const serveShellAsset = new Function(
      "fetch",
      "caches",
      "currentShellAssetCache",
      `${bootstrapPredicate}\n${detachResponseUrl}\n${bootstrapHandler}\n${assetHandler}\n` +
        "return serveShellAsset;",
    )(fetchMock, cacheStorage, async () => canonical) as (
      request: Request,
      pathname: string,
    ) => Promise<Response>;
    const request = new Request(
      "https://hark.test/_next/static/chunks/turbopack-worker-build.js#params=kestrel",
    );

    const response = await serveShellAsset(request, new URL(request.url).pathname);

    expect(await response.text()).toBe("shared Turbopack bootstrap");
    expect(response.url).toBe("");
    expect(response.headers.has("Content-Encoding")).toBe(false);
    expect(response.headers.has("Content-Length")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(canonical.match).toHaveBeenCalledWith(request);
    expect(cacheStorage.match).not.toHaveBeenCalled();
    expect(canonical.put).not.toHaveBeenCalled();
  });
});
