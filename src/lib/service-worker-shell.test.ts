import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const source = readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
const constants = source.match(/const CACHE_VERSION[\s\S]*?const PRECACHE = \[[\s\S]*?\];/)?.[0];
const functionSource = source.match(/async function precacheShell\(\) \{[\s\S]*?\n\}/)?.[0];
// `precacheShell` calls this, so the extracted source does not run without it.
// Pulled separately and asserted separately, so a rename shows up as "the
// contract moved" rather than as a ReferenceError from inside a `new Function`.
const sweepSource = source.match(
  /async function dropSupersededChunks\(cache, assets\) \{[\s\S]*?\n\}/,
)?.[0];
if (!constants || !functionSource || !sweepSource) {
  throw new Error("The service-worker shell contract moved.");
}

const createPrecacheShell = new Function(
  "caches",
  "fetch",
  `${constants}; ${functionSource}; ${sweepSource}; return precacheShell;`,
) as (cacheStorage: unknown, fetchFn: typeof fetch) => () => Promise<void>;

// Before serialization existed the shipping message handler called
// `precacheShell` directly. The fallback models that exact old entrypoint so
// this concurrency test fails against the old worker and switches to the
// production queue once it exists.
const queueSource = source.match(
  /let shellRefreshTail = Promise\.resolve\(\);[\s\S]*?function queueShellRefresh\(\) \{[\s\S]*?\n\}/,
)?.[0];
const createShellRefresh = new Function(
  "caches",
  "fetch",
  `${constants}; ${functionSource}; ${sweepSource}; ${
    queueSource || "const queueShellRefresh = precacheShell;"
  }; return queueShellRefresh;`,
) as (cacheStorage: unknown, fetchFn: typeof fetch) => () => Promise<void>;

describe("service-worker shell installation", () => {
  it("precaches the document a warm launch is served, under a purgeable name", async () => {
    // Two other places key off these exact strings and would silently stop
    // matching if they drifted: the `activate` sweep deletes every other
    // `chapterline-shell-` cache, and `offline/account-purge.ts` keeps only
    // `/offline` and the static shell when an account switches.
    expect(constants).toContain('const CACHE_VERSION = "chapterline-shell-');
    expect(constants).toContain('const OFFLINE_URL = "/offline"');
    expect(constants).toContain("const PRECACHE = [OFFLINE_URL");
  });

  it("caches every required chunk before installation succeeds", async () => {
    const cache = shellCache();
    const precacheShell = createPrecacheShell(
      { open: vi.fn().mockResolvedValue(cache) },
      shellFetch(),
    );

    await precacheShell();

    expect(cache.add).toHaveBeenCalledWith("/icons/icon-192.png");
    expect(cache.add).toHaveBeenCalledWith("/_next/static/chunks/offline.js");
  });

  it("forgets chunks the refreshed shell no longer references", async () => {
    // Every deployment renames /_next/static, and this runs again on each
    // REFRESH_SHELL. Without the sweep the shell cache grows by a full chunk
    // set per deploy, against the same origin quota the downloaded audio
    // competes for — and that audio is the only copy in existence.
    const cache = shellCacheWithStaleChunk();
    const precacheShell = createPrecacheShell(
      { open: vi.fn().mockResolvedValue(cache) },
      shellFetch(),
    );

    await precacheShell();

    const deleted = cache.delete.mock.calls.map(([request]) => new URL(request.url).pathname);
    expect(deleted).toStrictEqual(["/_next/static/chunks/from-last-deploy.js"]);
  });

  it("never sweeps the shell document, the launch key or the icons", async () => {
    const cache = shellCacheWithStaleChunk();
    const precacheShell = createPrecacheShell(
      { open: vi.fn().mockResolvedValue(cache) },
      shellFetch(),
    );

    await precacheShell();

    const deleted = cache.delete.mock.calls.map(([request]) => new URL(request.url).pathname);
    expect(deleted).not.toContain("/offline");
    expect(deleted).not.toContain("/library");
    expect(deleted).not.toContain("/icons/icon-192.png");
  });

  it("stores the shell under the manifest's start_url, character for character", async () => {
    // The service worker's static route resolves against Cache Storage BY
    // REQUEST URL, and a routing miss goes to the network rather than falling
    // back to the fetch handler — so a drift of one character between the
    // manifest and this key silently puts the whole launch document back on the
    // wire. That regression has happened once; this is the pin against it.
    const manifest = readFileSync(path.resolve(__dirname, "../app/manifest.ts"), "utf8");
    const startUrl = manifest.match(/start_url:\s*"([^"]+)"/)?.[1];
    expect(startUrl, "the manifest's start_url moved or changed shape").toBeTruthy();
    expect(constants).toContain(`const LAUNCH_URL = "${startUrl}"`);

    const cache = shellCache();
    const precacheShell = createPrecacheShell(
      { open: vi.fn().mockResolvedValue(cache) },
      shellFetch(),
    );

    await precacheShell();

    expect(cache.put).toHaveBeenCalledWith(startUrl, expect.any(Response));
  });

  it("rejects installation when a required chunk cannot be cached", async () => {
    const cache = shellCache();
    cache.add.mockImplementation(async (asset: string) => {
      if (asset.includes("offline.js")) throw new Error("chunk unavailable");
    });
    const precacheShell = createPrecacheShell(
      { open: vi.fn().mockResolvedValue(cache) },
      shellFetch(),
    );

    await expect(precacheShell()).rejects.toThrow("chunk unavailable");
  });

  it("keeps the previous working document when a refreshed chunk is unavailable", async () => {
    let offlineDocument = new Response(
      '<script src="/_next/static/chunks/working-old.js"></script>',
    );
    const cache = shellCache();
    cache.match.mockImplementation(async (url: string) =>
      url === "/offline" ? offlineDocument.clone() : undefined,
    );
    cache.add.mockImplementation(async (asset: string) => {
      if (asset.includes("unavailable-new.js")) throw new Error("new chunk unavailable");
    });
    cache.put.mockImplementation(async (url: string, response: Response) => {
      if (url === "/offline") offlineDocument = response.clone();
    });
    const precacheShell = createPrecacheShell(
      { open: vi.fn().mockResolvedValue(cache) },
      vi
        .fn()
        .mockResolvedValue(
          new Response('<script src="/_next/static/chunks/unavailable-new.js"></script>'),
        ) as typeof fetch,
    );

    await expect(precacheShell()).rejects.toThrow("new chunk unavailable");

    expect(await (await cache.match("/offline"))!.text()).toContain("working-old.js");
  });

  it("serializes overlapping refresh messages into complete document and chunk sets", async () => {
    expect(source).toContain("event.waitUntil(queueShellRefresh().catch");
    const race = interleavingShellCache();
    const fetchShell = alternatingShellFetch();
    const refreshShell = createShellRefresh(
      { open: vi.fn().mockResolvedValue(race.cache) },
      fetchShell,
    );

    const first = refreshShell();
    await race.firstLaunchPutReached;
    const second = refreshShell();
    // Give an unqueued second refresh enough microtasks to promote B and sweep
    // A while A is paused between its two document puts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (fetchShell.mock.calls.length === 2) await second;
    race.releaseFirstLaunchPut();
    await Promise.all([first, second]);

    expect(fetchShell).toHaveBeenCalledTimes(2);
    for (const document of [race.offlineDocument(), race.launchDocument()]) {
      const chunk = document.match(/\/_next\/static\/chunks\/[^"']+/)?.[0];
      if (!chunk) throw new Error("The promoted shell named no static chunk.");
      expect(race.hasAsset(chunk), `${chunk} was swept while its document stayed live`).toBe(true);
    }
  });
});

/** A cache already holding one superseded chunk from an earlier deployment. */
function shellCacheWithStaleChunk() {
  const cache = shellCache();
  cache.keys.mockResolvedValue([
    new Request("https://hark.test/_next/static/chunks/offline.js"),
    new Request("https://hark.test/_next/static/chunks/from-last-deploy.js"),
    new Request("https://hark.test/offline"),
    new Request("https://hark.test/icons/icon-192.png"),
  ]);
  return cache;
}

function shellCache() {
  return {
    addAll: vi.fn().mockResolvedValue(undefined),
    match: vi
      .fn()
      .mockResolvedValue(new Response('<script src="/_next/static/chunks/offline.js"></script>')),
    add: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
  };
}

function shellFetch() {
  return vi
    .fn()
    .mockResolvedValue(
      new Response('<script src="/_next/static/chunks/offline.js"></script>'),
    ) as typeof fetch;
}

function alternatingShellFetch() {
  let call = 0;
  return vi.fn(async () => {
    call += 1;
    const chunk = call === 1 ? "candidate-a.js" : "candidate-b.js";
    return new Response(`<script src="/_next/static/chunks/${chunk}"></script>`);
  }) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}

function interleavingShellCache() {
  const assets = new Set<string>();
  let offlineDocument = "";
  let launchDocument = "";
  let releaseFirst!: () => void;
  let reachedFirst!: () => void;
  const firstLaunchPutReached = new Promise<void>((resolve) => {
    reachedFirst = resolve;
  });
  const firstLaunchGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const cache = {
    add: vi.fn(async (asset: string) => {
      assets.add(asset);
    }),
    put: vi.fn(async (url: string, response: Response) => {
      const document = await response.clone().text();
      if (url === "/library?source=pwa" && document.includes("candidate-a.js")) {
        reachedFirst();
        await firstLaunchGate;
      }
      if (url === "/offline") offlineDocument = document;
      else if (url === "/library?source=pwa") launchDocument = document;
    }),
    keys: vi.fn(async () =>
      [...assets]
        .filter((asset) => asset.startsWith("/_next/static/"))
        .map((asset) => new Request(`https://hark.test${asset}`)),
    ),
    delete: vi.fn(async (request: Request) => {
      assets.delete(new URL(request.url).pathname);
      return true;
    }),
  };

  return {
    cache,
    firstLaunchPutReached,
    releaseFirstLaunchPut: releaseFirst,
    offlineDocument: () => offlineDocument,
    launchDocument: () => launchDocument,
    hasAsset: (asset: string) => assets.has(asset),
  };
}
