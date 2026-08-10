import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const source = readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
const constants = source.match(/const CACHE_VERSION[\s\S]*?const PRECACHE = \[[\s\S]*?\];/)?.[0];
const routeSource = source.match(/function declareLaunchRoute\(event\) \{[\s\S]*?\n\}/)?.[0];

function extractFunction(name: string) {
  return source.match(new RegExp(`async function ${name}\\([^]*?\\n\\}`))?.[0];
}

const stageSource = extractFunction("stageShell");
const installSource = extractFunction("prepareInstalledShell");
const precacheSource = extractFunction("precacheShell");
const promoteSource = extractFunction("promoteShell");
const leaseSource = extractFunction("leaseUntrackedClients");
const retainedSource = extractFunction("retainedClientGenerations");
const preserveLegacySource = extractFunction("preserveLegacyShellAssets");
const sweepSource = extractFunction("dropSupersededShellStages");
const legacySweepSource = extractFunction("dropLegacyShellCaches");
const activateSource = extractFunction("activateWorker");
const queueSource = source.match(
  /let shellRefreshTail = Promise\.resolve\(\);[\s\S]*?function queueShellRefresh\(\) \{[\s\S]*?\n\}/,
)?.[0];

if (
  !constants ||
  !routeSource ||
  !stageSource ||
  !installSource ||
  !precacheSource ||
  !promoteSource ||
  !leaseSource ||
  !retainedSource ||
  !preserveLegacySource ||
  !sweepSource ||
  !legacySweepSource ||
  !activateSource ||
  !queueSource
) {
  throw new Error("The service-worker shell contract moved.");
}

type WorkerLike = {
  clients: {
    claim: ReturnType<typeof vi.fn>;
    matchAll: ReturnType<typeof vi.fn>;
  };
};

type ShellFunctions = {
  activateWorker: () => Promise<void>;
  dropSupersededShellStages: () => Promise<void>;
  precacheShell: () => Promise<void>;
  prepareInstalledShell: () => Promise<string>;
  promoteShell: (stageName: string) => Promise<boolean>;
  queueShellRefresh: () => Promise<void>;
  stageShell: () => Promise<string>;
};

function createShellFunctions(
  cacheStorage: unknown,
  fetchFn: typeof fetch,
  worker: WorkerLike = {
    clients: {
      claim: vi.fn().mockResolvedValue(undefined),
      matchAll: vi.fn().mockResolvedValue([]),
    },
  },
) {
  return new Function(
    "caches",
    "fetch",
    "self",
    `${constants}; ${stageSource}; ${installSource}; ${precacheSource}; ${promoteSource}; ` +
      `${leaseSource}; ${retainedSource}; ${preserveLegacySource}; ${sweepSource}; ` +
      `${legacySweepSource}; ${activateSource}; ${queueSource}; ` +
      "return { activateWorker, " +
      "dropSupersededShellStages, precacheShell, prepareInstalledShell, promoteShell, " +
      "queueShellRefresh, stageShell };",
  )(cacheStorage, fetchFn, worker) as ShellFunctions;
}

describe("service-worker shell generations", () => {
  it("keeps the purge and launch-key contracts pinned", () => {
    expect(constants).toContain('const CACHE_VERSION = "chapterline-shell-');
    expect(constants).toContain('const OFFLINE_URL = "/offline"');
    expect(constants).toContain("const PRECACHE = [OFFLINE_URL");
    expect(constants).toContain('const SHELL_GENERATION_HEADER = "X-Chapterline-');
    expect(source).not.toContain("__hark_shell");
    expect(source).not.toContain("X-Hark-");

    const manifest = readFileSync(path.resolve(__dirname, "../app/manifest.ts"), "utf8");
    const startUrl = manifest.match(/start_url:\s*"([^"]+)"/)?.[1];
    expect(startUrl, "the manifest's start_url moved or changed shape").toBeTruthy();
    expect(constants).toContain(`const LAUNCH_URL = "${startUrl}"`);
  });

  it("binds the declarative launch route to the canonical v7 cache", () => {
    const declareLaunchRoute = new Function(
      `${constants}; ${routeSource}; return declareLaunchRoute;`,
    )() as (event: { addRoutes: ReturnType<typeof vi.fn> }) => void;
    const event = { addRoutes: vi.fn().mockResolvedValue(undefined) };

    declareLaunchRoute(event);

    expect(event.addRoutes).toHaveBeenCalledWith(
      expect.objectContaining({ source: { cacheName: CACHE_VERSION } }),
    );
  });

  it("stages an install completely without exposing it to the old active worker", async () => {
    const storage = namedShellStorage({ initialDocument: shellDocument("working-old.js") });
    const shell = createShellFunctions(storage.cacheStorage, shellFetch("install.js"));

    const stageName = await shell.prepareInstalledShell();

    expect(storage.stageNames()).toStrictEqual([stageName]);
    expect(await storage.document(LAUNCH_URL)).toContain("working-old.js");
    expect(await storage.document(OFFLINE_URL)).toContain("working-old.js");
    expect(storage.has(stageName, "/_next/static/chunks/install.js")).toBe(true);
    expect(storage.has(stageName, "/icons/icon-192.png")).toBe(true);
    expect(await storage.text(SHELL_METADATA_CACHE, INSTALL_READY_URL)).toBe(stageName);
  });

  it("promotes only after every required chunk is cached", async () => {
    const storage = namedShellStorage({ initialDocument: shellDocument("working-old.js") });
    const shell = createShellFunctions(storage.cacheStorage, shellFetch("candidate.js"));

    await shell.precacheShell();

    const generation = await storage.liveGeneration();
    expect(generation).toMatch(/^chapterline-staged-shell-/);
    expect(storage.has(generation!, "/_next/static/chunks/candidate.js")).toBe(true);
    expect(await storage.document(LAUNCH_URL)).toContain("candidate.js");
    expect(await storage.document(OFFLINE_URL)).toContain("candidate.js");
  });

  it("claims clients before an installed generation becomes live", async () => {
    let claimed = false;
    let promotedAfterClaim = false;
    const storage = namedShellStorage({
      initialDocument: shellDocument("working-old.js"),
      beforePut: async ({ key, body }) => {
        if (key === LAUNCH_URL && body.includes("install.js")) promotedAfterClaim = claimed;
      },
    });
    const shell = createShellFunctions(storage.cacheStorage, shellFetch("install.js"), {
      clients: {
        claim: vi.fn(async () => {
          claimed = true;
        }),
        matchAll: vi.fn().mockResolvedValue([]),
      },
    });

    await shell.prepareInstalledShell();
    expect(await storage.document(LAUNCH_URL)).toContain("working-old.js");
    await shell.activateWorker();

    expect(promotedAfterClaim).toBe(true);
    expect(await storage.document(LAUNCH_URL)).toContain("install.js");
    await expectLiveDocumentsHaveAssets(storage);
  });

  it("keeps an install marker outside a pre-generation worker's static sweep", async () => {
    const storage = namedShellStorage({
      initialCacheName: LEGACY_SHELL_CACHE,
      initialDocument: shellDocument("working-old.js"),
    });
    const shell = createShellFunctions(storage.cacheStorage, shellFetch("install.js"));
    const installGeneration = await shell.prepareInstalledShell();

    // The shipping predecessor swept every /_next/static entry from the shared
    // live cache that its own document did not name. The install marker must be
    // in a different cache so that old code cannot erase the handoff.
    storage.legacyLiveStaticSweep(LEGACY_SHELL_CACHE);

    expect(await storage.text(SHELL_METADATA_CACHE, INSTALL_READY_URL)).toBe(installGeneration);
    await shell.activateWorker();
    expect(await storage.document(LAUNCH_URL)).toContain("install.js");
    await expectLiveDocumentsHaveAssets(storage);
  });

  it("rejects an incomplete candidate without changing the current generation", async () => {
    let blocked = false;
    const storage = namedShellStorage({
      failAsset: (asset) => blocked && asset.includes("candidate-b.js"),
    });
    const fetchShell = alternatingShellFetch("candidate-a.js", "candidate-b.js");
    const shell = createShellFunctions(storage.cacheStorage, fetchShell);
    await shell.precacheShell();
    const workingGeneration = await storage.liveGeneration();
    blocked = true;

    await expect(shell.precacheShell()).rejects.toThrow("chunk unavailable");

    expect(await storage.liveGeneration()).toBe(workingGeneration);
    expect(await storage.document(LAUNCH_URL)).toContain("candidate-a.js");
    expect(storage.stageNames()).toStrictEqual([workingGeneration]);
  });

  it("bounds repeated refreshes while every live document keeps its chunks", async () => {
    const storage = namedShellStorage();
    let build = 0;
    const fetchShell = vi.fn(async () => {
      build += 1;
      return new Response(shellDocument(`candidate-${build}.js`));
    }) as unknown as typeof fetch;
    const shell = createShellFunctions(storage.cacheStorage, fetchShell);

    for (let refresh = 0; refresh < 7; refresh += 1) await shell.precacheShell();

    expect(storage.stageNames()).toHaveLength(1);
    await expectLiveDocumentsHaveAssets(storage);
  });

  it("keeps a long-lived client's generation through more than three refreshes", async () => {
    const windows: Array<{ id: string }> = [];
    const storage = namedShellStorage();
    let build = 0;
    const shell = createShellFunctions(
      storage.cacheStorage,
      vi.fn(async () => {
        build += 1;
        return new Response(shellDocument(`candidate-${build}.js`));
      }) as unknown as typeof fetch,
      {
        clients: {
          claim: vi.fn().mockResolvedValue(undefined),
          matchAll: vi.fn(async () => windows),
        },
      },
    );
    await shell.precacheShell();
    const oldGeneration = await storage.liveGeneration();
    windows.push({ id: "long-lived-offline-tab" });

    for (let refresh = 0; refresh < 6; refresh += 1) await shell.precacheShell();

    expect(storage.stageNames()).toContain(oldGeneration);
    expect(storage.has(oldGeneration!, "/_next/static/chunks/candidate-1.js")).toBe(true);

    windows.length = 0;
    await shell.precacheShell();
    expect(storage.stageNames()).not.toContain(oldGeneration);
    expect(storage.stageNames()).toHaveLength(1);
  });

  it("does not sweep a new install generation during an active-worker refresh", async () => {
    const storage = namedShellStorage({ initialDocument: shellDocument("working-old.js") });
    const installing = createShellFunctions(storage.cacheStorage, shellFetch("install.js"));
    const active = createShellFunctions(storage.cacheStorage, shellFetch("refresh.js"));
    const installGeneration = await installing.prepareInstalledShell();

    await active.precacheShell();

    expect(storage.stageNames()).toContain(installGeneration);
    expect(storage.has(installGeneration, "/_next/static/chunks/install.js")).toBe(true);
    expect(await storage.text(SHELL_METADATA_CACHE, INSTALL_READY_URL)).toBe(installGeneration);
  });

  it("queues overlapping refresh messages inside one worker global", async () => {
    const gate = firstCandidateLaunchGate();
    const storage = namedShellStorage({ beforePut: gate.beforePut });
    const fetchShell = alternatingShellFetch("candidate-a.js", "candidate-b.js");
    const shell = createShellFunctions(storage.cacheStorage, fetchShell);

    const first = shell.queueShellRefresh();
    await gate.reached;
    const second = shell.queueShellRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchShell).toHaveBeenCalledTimes(1);
    gate.release();
    await Promise.all([first, second]);

    expect(fetchShell).toHaveBeenCalledTimes(2);
    await expectLiveDocumentsHaveAssets(storage);
  });

  it("keeps old-active and new-install generations complete across two worker globals", async () => {
    const gate = firstCandidateLaunchGate();
    let claimed = false;
    let installPromotedAfterClaim = false;
    const storage = namedShellStorage({
      initialDocument: shellDocument("working-old.js"),
      beforePut: async (operation) => {
        await gate.beforePut(operation);
        if (operation.key === LAUNCH_URL && operation.body.includes("candidate-b.js")) {
          installPromotedAfterClaim = claimed;
        }
      },
    });
    const fetchShell = alternatingShellFetch("candidate-a.js", "candidate-b.js");
    // Separate factories model separate service-worker JS globals and therefore
    // separate module-local refresh tails. Cache names remain shared, but each
    // stage name maps to a genuinely distinct Cache instance.
    const activeWorker = createShellFunctions(storage.cacheStorage, fetchShell);
    const installingWorker = createShellFunctions(storage.cacheStorage, fetchShell, {
      clients: {
        claim: vi.fn(async () => {
          claimed = true;
        }),
        matchAll: vi.fn().mockResolvedValue([]),
      },
    });

    const activeRefresh = activeWorker.precacheShell();
    await gate.reached;
    const installGeneration = await installingWorker.prepareInstalledShell();
    expect(storage.stageNames()).toHaveLength(2);
    expect(new Set(storage.stageNames()).size).toBe(2);

    // Activation promotes only after the new handler owns the clients. Let the
    // older worker finish afterward to exercise the harshest legal ordering.
    await installingWorker.activateWorker();
    gate.release();
    await activeRefresh;

    expect(installPromotedAfterClaim).toBe(true);
    expect(storage.stageNames()).toContain(installGeneration);
    await expectLiveDocumentsHaveAssets(storage);
  });

  it("keeps v7 canonical when the deployed v6 refresh finishes after activation", async () => {
    const gate = firstCandidateLaunchGate();
    const windows = [{ id: "tab-still-running-v6" }];
    const storage = namedShellStorage({
      beforePut: gate.beforePut,
      initialCacheName: LEGACY_SHELL_CACHE,
      initialDocument: shellDocument("working-old.js"),
    });
    const fetchShell = alternatingShellFetch("candidate-a.js", "candidate-b.js");
    const installingWorker = createShellFunctions(storage.cacheStorage, fetchShell, {
      clients: {
        claim: vi.fn().mockResolvedValue(undefined),
        matchAll: vi.fn(async () => windows),
      },
    });

    // This helper is the a3270cd shared-v6 algorithm, not another copy of the
    // generation implementation under test.
    const oldRefresh = legacyPrecacheShell(storage.cacheStorage, fetchShell);
    await gate.reached;
    const installGeneration = await installingWorker.prepareInstalledShell();
    await installingWorker.activateWorker();
    gate.release();
    await oldRefresh;

    expect(await storage.document(LAUNCH_URL)).toContain("candidate-b.js");
    expect(await storage.document(OFFLINE_URL)).toContain("candidate-b.js");
    expect(await storage.liveGeneration()).toBe(installGeneration);
    expect(storage.cacheNames()).not.toContain(LEGACY_SHELL_CACHE);
    // The old tab can still lazy-load both the document it had and the chunk
    // fetched by its late refresh, but neither old document can become canonical.
    expect(storage.hasAsset("/_next/static/chunks/working-old.js")).toBe(true);
    expect(storage.hasAsset("/_next/static/chunks/candidate-a.js")).toBe(true);
    await expectLiveDocumentsHaveAssets(storage);
  });

  it("keeps v6 intact when activation fails before the v7 launch commit", async () => {
    let failPromotion = false;
    const storage = namedShellStorage({
      beforePut: async ({ cacheName, key, body }) => {
        if (
          failPromotion &&
          cacheName === CACHE_VERSION &&
          key === LAUNCH_URL &&
          body.includes("candidate-b.js")
        ) {
          throw new Error("launch promotion failed");
        }
      },
      initialCacheName: LEGACY_SHELL_CACHE,
      initialDocument: shellDocument("working-old.js"),
    });
    const shell = createShellFunctions(storage.cacheStorage, shellFetch("candidate-b.js"));
    await shell.prepareInstalledShell();
    failPromotion = true;

    await expect(shell.activateWorker()).rejects.toThrow("launch promotion failed");

    expect(storage.cacheNames()).toContain(LEGACY_SHELL_CACHE);
    expect(await storage.text(LEGACY_SHELL_CACHE, LAUNCH_URL)).toContain("working-old.js");
    expect(await storage.document(LAUNCH_URL)).toBe("");
  });

  it("keeps v7 usable when post-commit legacy cleanup fails", async () => {
    const storage = namedShellStorage({
      failDelete: (cacheName) => cacheName === LEGACY_SHELL_CACHE,
      initialCacheName: LEGACY_SHELL_CACHE,
      initialDocument: shellDocument("working-old.js"),
    });
    const shell = createShellFunctions(storage.cacheStorage, shellFetch("candidate-b.js"));
    await shell.prepareInstalledShell();

    await expect(shell.activateWorker()).resolves.toBeUndefined();

    expect(storage.cacheNames()).toContain(LEGACY_SHELL_CACHE);
    expect(await storage.document(LAUNCH_URL)).toContain("candidate-b.js");
    expect(await storage.document(OFFLINE_URL)).toContain("candidate-b.js");
    await expectLiveDocumentsHaveAssets(storage);
  });
});

const CACHE_VERSION = "chapterline-shell-v7";
const LEGACY_SHELL_CACHE = "chapterline-shell-v6";
const STAGING_CACHE_PREFIX = "chapterline-staged-shell-";
const SHELL_METADATA_CACHE = "chapterline-runtime-shell-metadata-v1";
const OFFLINE_URL = "/offline";
const LAUNCH_URL = "/library?source=pwa";
const INSTALL_READY_URL = "/_next/static/__chapterline_shell__/install-ready";
const GENERATION_HEADER = "X-Chapterline-Shell-Generation";
const ORIGIN = "https://hark.test";

type CachePut = {
  body: string;
  cacheName: string;
  key: string;
};

type StorageOptions = {
  beforePut?: (operation: CachePut) => Promise<void>;
  failAsset?: (asset: string, cacheName: string) => boolean;
  failDelete?: (cacheName: string) => boolean;
  initialCacheName?: string;
  initialDocument?: string;
};

function namedShellStorage(options: StorageOptions = {}) {
  const entries = new Map<string, Map<string, Response>>();
  const cacheObjects = new Map<string, ReturnType<typeof makeCache>>();
  const deletedNames: string[] = [];

  function normalize(input: RequestInfo | URL) {
    const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(value, ORIGIN);
    return `${url.pathname}${url.search}`;
  }

  function makeCache(cacheName: string) {
    const records = entries.get(cacheName)!;
    return {
      add: vi.fn(async (asset: string) => {
        if (options.failAsset?.(asset, cacheName)) throw new Error("chunk unavailable");
        records.set(normalize(asset), new Response(`asset:${asset}`));
      }),
      delete: vi.fn(async (input: RequestInfo | URL) => records.delete(normalize(input))),
      keys: vi.fn(async () => [...records.keys()].map((key) => new Request(new URL(key, ORIGIN)))),
      match: vi.fn(async (input: RequestInfo | URL) => records.get(normalize(input))?.clone()),
      put: vi.fn(async (input: RequestInfo | URL, response: Response) => {
        const key = normalize(input);
        const copy = response.clone();
        await options.beforePut?.({
          body: await response.clone().text(),
          cacheName,
          key,
        });
        records.set(key, copy);
      }),
    };
  }

  function cache(cacheName: string) {
    let result = cacheObjects.get(cacheName);
    if (result) return result;
    entries.set(cacheName, new Map());
    result = makeCache(cacheName);
    cacheObjects.set(cacheName, result);
    return result;
  }

  const cacheStorage = {
    delete: vi.fn(async (cacheName: string) => {
      if (options.failDelete?.(cacheName)) throw new Error(`cleanup failed for ${cacheName}`);
      deletedNames.push(cacheName);
      cacheObjects.delete(cacheName);
      return entries.delete(cacheName);
    }),
    keys: vi.fn(async () => [...entries.keys()]),
    match: vi.fn(async (input: RequestInfo | URL, matchOptions?: { cacheName?: string }) => {
      if (matchOptions?.cacheName) {
        return entries.get(matchOptions.cacheName)?.get(normalize(input))?.clone();
      }
      for (const records of entries.values()) {
        const response = records.get(normalize(input));
        if (response) return response.clone();
      }
      return undefined;
    }),
    open: vi.fn(async (cacheName: string) => cache(cacheName)),
  };

  cache(CACHE_VERSION);
  if (options.initialDocument) {
    const initialCacheName = options.initialCacheName ?? CACHE_VERSION;
    cache(initialCacheName);
    const live = entries.get(initialCacheName)!;
    live.set(OFFLINE_URL, new Response(options.initialDocument));
    live.set(LAUNCH_URL, new Response(options.initialDocument));
    const asset = options.initialDocument.match(/\/_next\/static\/chunks\/[^"']+/)?.[0];
    if (asset) live.set(asset, new Response(`asset:${asset}`));
  }

  return {
    cacheStorage,
    cacheNames: () => [...entries.keys()],
    deletedNames,
    document: async (key: string) => (await cache(CACHE_VERSION).match(key))?.text() ?? "",
    has: (cacheName: string, key: string) => entries.get(cacheName)?.has(normalize(key)) ?? false,
    hasAsset: (key: string) => [...entries.values()].some((records) => records.has(normalize(key))),
    legacyLiveStaticSweep: (cacheName = CACHE_VERSION) => {
      const live = entries.get(cacheName)!;
      for (const key of live.keys()) if (key.startsWith("/_next/static/")) live.delete(key);
    },
    liveGeneration: async () =>
      (await cache(CACHE_VERSION).match(LAUNCH_URL))?.headers.get(GENERATION_HEADER),
    stageNames: () => [...entries.keys()].filter((name) => name.startsWith(STAGING_CACHE_PREFIX)),
    text: async (cacheName: string, key: string) =>
      (await cache(cacheName).match(key))?.text() ?? "",
  };
}

function shellDocument(chunk: string) {
  return `<script src="/_next/static/chunks/${chunk}"></script>`;
}

function shellFetch(chunk: string) {
  return vi.fn().mockResolvedValue(new Response(shellDocument(chunk))) as typeof fetch;
}

function alternatingShellFetch(...chunks: string[]) {
  let call = 0;
  return vi.fn(async () => {
    const chunk = chunks[Math.min(call, chunks.length - 1)];
    if (!chunk) throw new Error("alternatingShellFetch requires at least one chunk");
    call += 1;
    return new Response(shellDocument(chunk));
  }) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}

/** The shared-cache refresh implementation deployed at a3270cd. */
async function legacyPrecacheShell(
  cacheStorage: ReturnType<typeof namedShellStorage>["cacheStorage"],
  fetchFn: typeof fetch,
) {
  const cache = await cacheStorage.open(LEGACY_SHELL_CACHE);
  const offlinePage = await fetchFn(OFFLINE_URL, { cache: "no-store" });
  if (!offlinePage.ok) throw new Error("The required offline page could not be fetched.");
  const html = await offlinePage.clone().text();
  const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s\\]+/g) || [])];
  await Promise.all(["/icons/icon-192.png", ...assets].map((asset) => cache.add(asset)));
  await cache.put(OFFLINE_URL, offlinePage.clone());
  await cache.put(LAUNCH_URL, offlinePage.clone());

  const keep = new Set(assets);
  const stale = (await cache.keys()).filter((request) => {
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/_next/static/") && !keep.has(pathname);
  });
  await Promise.all(stale.map((request) => cache.delete(request)));
}

function firstCandidateLaunchGate() {
  let release!: () => void;
  let reached!: () => void;
  let used = false;
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    beforePut: async ({ key, body }: CachePut) => {
      if (!used && key === LAUNCH_URL && body.includes("candidate-a.js")) {
        used = true;
        reached();
        await releasePromise;
      }
    },
    reached: reachedPromise,
    release,
  };
}

async function expectLiveDocumentsHaveAssets(storage: ReturnType<typeof namedShellStorage>) {
  for (const key of [OFFLINE_URL, LAUNCH_URL]) {
    const document = await storage.document(key);
    const chunk = document.match(/\/_next\/static\/chunks\/[^"']+/)?.[0];
    if (!chunk) throw new Error(`${key} named no static chunk.`);
    expect(storage.hasAsset(chunk), `${chunk} was deleted while ${key} stayed live`).toBe(true);
  }
}
