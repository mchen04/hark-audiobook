const CACHE_VERSION = "chapterline-shell-v7";
const SHELL_CACHE_PREFIX = "chapterline-shell-";
const STAGING_CACHE_PREFIX = "chapterline-staged-shell-";
const SHELL_METADATA_CACHE = "chapterline-runtime-shell-metadata-v1";
const SHELL_INTERNAL_PATH = "/_next/static/__chapterline_shell__/";
const STAGED_OFFLINE_URL = `${SHELL_INTERNAL_PATH}offline`;
const STAGED_LAUNCH_URL = `${SHELL_INTERNAL_PATH}launch`;
const STAGING_READY_URL = `${SHELL_INTERNAL_PATH}ready`;
const STAGING_PROMOTED_URL = `${SHELL_INTERNAL_PATH}promoted`;
const INSTALL_READY_URL = `${SHELL_INTERNAL_PATH}install-ready`;
const CLIENT_LEASE_URL_PREFIX = `${SHELL_INTERNAL_PATH}clients/`;
const SHELL_GENERATION_HEADER = "X-Chapterline-Shell-Generation";
const STAGING_ABANDONED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MEDIA_CACHE = "chapterline-media-v2";
const LEGACY_MEDIA_CACHE = "chapterline-media-v1";
const OFFLINE_URL = "/offline";
const LAUNCH_URL = "/library?source=pwa";
const RUNTIME_ASSETS = [
  "/models/kestrel/prosody-encode.627c1c1a7203c6fcc73013957aec8ef56aacfe20df1df6eda571a9c816387a0e.onnx",
  "/models/kestrel/prosody-frames.905339961e27ac99f948824d393ffd03cebf7c5477f32156c739e872016455eb.onnx",
  "/models/kestrel/decoder-head.e3b02863689de98635f42d5f568908b6bc6d43059856434f30b66e25633a379d.onnx",
  "/models/kestrel/kissfft.c1a03390ade32bcfc4c4143796f7510c0fec06b59d42840591ad4721fe93caf4.wasm",
  "/pdf.worker.51a2fd1ea47f1a9b0814e65e0c336c739c54957795ee774e8f93cb81e8028dd1.min.mjs",
];
const MODEL_RUNTIME_ASSETS = [
  "/models/kestrel/ort-wasm-simd-threaded.asyncify.7236653b8565da4046e459cd0e274123419a1d9f1f8f18fd36c28058346ca655.mjs",
  "/models/kestrel/ort-wasm-simd-threaded.asyncify.7e83cd6cee77e478bc96a7e91b198144fb5e4126287daf1f9b54bb195ebcd55a.wasm",
];
const KESTREL_BUNDLE_CACHE = "hark-kestrel-bundle-ebfe37d8a8771780";
const KESTREL_VERIFIED_URL =
  "/__hark/kestrel-bundle/ebfe37d8a87717801af2619f5dbb22901557028821aa22809ffdf20f4aae7ac4/verified";
const BUILD_RUNTIME_MANIFEST_URL = "/chapterline-runtime-assets.json";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon-512.png", ...RUNTIME_ASSETS];
const NAVIGATION_TIMEOUT_MS = 3000;

let shellRefreshTail = Promise.resolve();
function queueShellRefresh() {
  const refresh = shellRefreshTail.then(precacheShell);
  shellRefreshTail = refresh.catch(() => undefined);
  return refresh;
}

self.addEventListener("install", (event) => {
  event.waitUntil(prepareInstalledShell().then(() => self.skipWaiting()));
  declareLaunchRoute(event);
});

function declareLaunchRoute(event) {
  if (typeof event.addRoutes !== "function") return;
  try {
    const routed = event.addRoutes({
      condition: {
        urlPattern: { pathname: "/library", search: "source=pwa" },
        requestMode: "navigate",
      },
      source: { cacheName: CACHE_VERSION },
    });
    if (routed && typeof routed.catch === "function") routed.catch(() => undefined);
  } catch {}
}

async function stageShell(candidate) {
  const stageName = `${STAGING_CACHE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stage = await caches.open(stageName);

  try {
    const { offlinePage, html, assets } = candidate || (await loadShellCandidate());
    await addShellAssets(stage, assets);

    const headers = new Headers(offlinePage.headers);
    headers.delete("Content-Encoding");
    headers.delete("Content-Length");
    headers.set(SHELL_GENERATION_HEADER, stageName);
    const stagedResponse = () =>
      new Response(html, {
        status: offlinePage.status,
        statusText: offlinePage.statusText,
        headers,
      });
    await stage.put(STAGED_OFFLINE_URL, stagedResponse());
    await stage.put(STAGED_LAUNCH_URL, stagedResponse());
    await stage.put(STAGING_READY_URL, new Response(String(Date.now())));
    return stageName;
  } catch (error) {
    await caches.delete(stageName).catch(() => undefined);
    throw error;
  }
}

async function loadShellCandidate() {
  const offlinePage = await fetch(OFFLINE_URL, { cache: "no-store" });
  if (!offlinePage.ok) throw new Error("The required offline page could not be fetched.");
  const html = await offlinePage.clone().text();
  const documentAssets = [...new Set(html.match(/\/_next\/static\/[^"'\s\\]+/g) || [])];
  const [buildRuntime, hasKestrelBundle] = await Promise.all([
    loadBuildRuntimeAssets(),
    hasVerifiedKestrelBundle(),
  ]);
  const buildRuntimeAssets = hasKestrelBundle
    ? buildRuntime.assets
    : buildRuntime.assets.filter((asset) => !buildRuntime.deferredUntilModel.includes(asset));
  const supportingAssets = PRECACHE.filter((asset) => asset !== OFFLINE_URL);
  return {
    offlinePage,
    html,
    assets: [
      ...new Set([
        ...supportingAssets,
        ...documentAssets,
        ...buildRuntimeAssets,
        ...(hasKestrelBundle ? MODEL_RUNTIME_ASSETS : []),
      ]),
    ],
  };
}

async function liveShellMatches(candidate) {
  const live = await caches.open(CACHE_VERSION);
  const [offlineDocument, launchDocument] = await Promise.all([
    live.match(OFFLINE_URL),
    live.match(LAUNCH_URL),
  ]);
  if (!offlineDocument || !launchDocument) return false;

  const generation = launchDocument.headers.get(SHELL_GENERATION_HEADER);
  if (
    !generation?.startsWith(STAGING_CACHE_PREFIX) ||
    offlineDocument.headers.get(SHELL_GENERATION_HEADER) !== generation
  ) {
    return false;
  }

  const [offlineHtml, launchHtml] = await Promise.all([
    offlineDocument.text(),
    launchDocument.text(),
  ]);
  if (offlineHtml !== candidate.html || launchHtml !== candidate.html) return false;

  const generationCache = await caches.open(generation);
  const cachedPaths = new Set(
    (await generationCache.keys()).map((request) => {
      const url = new URL(request.url);
      return `${url.pathname}${url.search}`;
    }),
  );
  return candidate.assets.every((asset) => cachedPaths.has(asset));
}

async function loadBuildRuntimeAssets() {
  const response = await fetch(BUILD_RUNTIME_MANIFEST_URL, { cache: "no-store" });
  if (!response.ok) throw new Error("The document runtime manifest could not be fetched.");
  const manifest = await response.json();
  if (manifest?.version !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error("The document runtime manifest is invalid.");
  }
  const assets = [...new Set(manifest.assets)];
  if (
    assets.length === 0 ||
    assets.some(
      (asset) =>
        typeof asset !== "string" ||
        !/^\/_next\/static\/chunks\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(asset),
    )
  ) {
    throw new Error("The document runtime manifest contains an invalid asset.");
  }
  const deferredUntilModel = Array.isArray(manifest.deferredUntilModel)
    ? manifest.deferredUntilModel
    : [];
  return { assets, deferredUntilModel };
}

async function hasVerifiedKestrelBundle() {
  if (!(await caches.keys()).includes(KESTREL_BUNDLE_CACHE)) return false;
  const bundle = await caches.open(KESTREL_BUNDLE_CACHE);
  return Boolean(await bundle.match(KESTREL_VERIFIED_URL));
}

async function addShellAssets(cache, candidates) {
  const assets = [...new Set(candidates)];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, assets.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= assets.length) return;
        await cache.add(assets[index]);
      }
    }),
  );
}

async function prepareInstalledShell() {
  const stageName = await stageShell();
  const metadata = await caches.open(SHELL_METADATA_CACHE);
  await metadata.put(INSTALL_READY_URL, new Response(stageName));
  return stageName;
}

async function precacheShell() {
  const candidate = await loadShellCandidate();
  if (await liveShellMatches(candidate)) {
    await Promise.allSettled([dropSupersededShellStages(), dropLegacyShellCaches()]);
    return;
  }
  const stageName = await stageShell(candidate);
  const cleanupSafe = await promoteShell(stageName);
  if (cleanupSafe) {
    await Promise.allSettled([dropSupersededShellStages(), dropLegacyShellCaches()]);
  }
}

async function promoteShell(stageName) {
  if (!stageName.startsWith(STAGING_CACHE_PREFIX)) {
    throw new Error("The staged shell generation name is invalid.");
  }
  const stage = await caches.open(stageName);
  const [ready, offlineDocument, launchDocument] = await Promise.all([
    stage.match(STAGING_READY_URL),
    stage.match(STAGED_OFFLINE_URL),
    stage.match(STAGED_LAUNCH_URL),
  ]);
  if (!ready || !offlineDocument || !launchDocument) {
    throw new Error("The staged shell generation is incomplete.");
  }

  const live = await caches.open(CACHE_VERSION);
  await live.put(OFFLINE_URL, offlineDocument);
  const previousLaunch = await live.match(LAUNCH_URL);
  const previousGeneration = previousLaunch?.headers.get(SHELL_GENERATION_HEADER);
  await leaseUntrackedClients([previousGeneration]);
  await live.put(LAUNCH_URL, launchDocument);
  let cleanupSafe = true;
  try {
    await leaseUntrackedClients([previousGeneration, stageName]);
  } catch {
    cleanupSafe = false;
  }

  await Promise.allSettled([
    stage.put(STAGING_PROMOTED_URL, new Response(String(Date.now()))),
    (async () => {
      const metadata = await caches.open(SHELL_METADATA_CACHE);
      const installReady = await metadata.match(INSTALL_READY_URL);
      if (installReady && (await installReady.text()) === stageName) {
        await metadata.delete(INSTALL_READY_URL);
      }
    })(),
  ]);
  return cleanupSafe;
}

async function leaseUntrackedClients(generations) {
  const candidates = [
    ...new Set(generations.filter((name) => name?.startsWith(STAGING_CACHE_PREFIX))),
  ];
  if (candidates.length === 0) return;

  const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  const leases = await caches.open(SHELL_METADATA_CACHE);
  await Promise.all(
    windows.map(async ({ id }) => {
      const clientRoot = `${CLIENT_LEASE_URL_PREFIX}${encodeURIComponent(id)}/`;
      if (await leases.match(`${clientRoot}tracked`)) return;
      await Promise.all(
        candidates.map((name) =>
          leases.put(`${clientRoot}generations/${encodeURIComponent(name)}`, new Response("")),
        ),
      );
      await leases.put(`${clientRoot}tracked`, new Response(""));
    }),
  );
}

async function retainedClientGenerations() {
  const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  const liveClientIds = new Set(windows.map(({ id }) => id));
  const leases = await caches.open(SHELL_METADATA_CACHE);
  const retained = new Set();

  await Promise.all(
    (await leases.keys()).map(async (request) => {
      const pathname = new URL(request.url).pathname;
      if (!pathname.startsWith(CLIENT_LEASE_URL_PREFIX)) return;
      const [encodedClientId, kind, encodedGeneration] = pathname
        .slice(CLIENT_LEASE_URL_PREFIX.length)
        .split("/");
      const clientId = decodeURIComponent(encodedClientId);
      if (!liveClientIds.has(clientId)) {
        await leases.delete(request);
        return;
      }
      if (kind === "generations" && encodedGeneration) {
        const generation = decodeURIComponent(encodedGeneration);
        if (generation.startsWith(STAGING_CACHE_PREFIX)) retained.add(generation);
      }
    }),
  );
  return retained;
}

async function preserveLegacyShellAssets(cacheNames) {
  const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  if (windows.length === 0 || cacheNames.length === 0) return;

  const stageName = `${STAGING_CACHE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stage = await caches.open(stageName);
  for (const cacheName of cacheNames) {
    const legacy = await caches.open(cacheName);
    for (const request of await legacy.keys()) {
      const { pathname } = new URL(request.url);
      if (
        !pathname.startsWith("/_next/static/") &&
        !pathname.startsWith("/icons/") &&
        !RUNTIME_ASSETS.includes(pathname) &&
        !MODEL_RUNTIME_ASSETS.includes(pathname)
      )
        continue;
      const response = await legacy.match(request);
      if (response) await stage.put(request, response);
    }
  }
  await stage.put(STAGING_READY_URL, new Response(String(Date.now())));

  const leases = await caches.open(SHELL_METADATA_CACHE);
  await Promise.all(
    windows.map(async ({ id }) => {
      const clientRoot = `${CLIENT_LEASE_URL_PREFIX}${encodeURIComponent(id)}/`;
      await leases.put(
        `${clientRoot}generations/${encodeURIComponent(stageName)}`,
        new Response(""),
      );
      await leases.put(`${clientRoot}tracked`, new Response(""));
    }),
  );
  await stage.put(STAGING_PROMOTED_URL, new Response(String(Date.now())));
}

async function dropSupersededShellStages() {
  const live = await caches.open(CACHE_VERSION);
  const metadata = await caches.open(SHELL_METADATA_CACHE);
  const [offlineDocument, launchDocument, installReady, clientGenerations] = await Promise.all([
    live.match(OFFLINE_URL),
    live.match(LAUNCH_URL),
    metadata.match(INSTALL_READY_URL),
    retainedClientGenerations(),
  ]);
  const retained = new Set(
    [offlineDocument, launchDocument]
      .map((response) => response?.headers.get(SHELL_GENERATION_HEADER))
      .filter((name) => name?.startsWith(STAGING_CACHE_PREFIX)),
  );
  const installGeneration = installReady && (await installReady.text());
  if (installGeneration?.startsWith(STAGING_CACHE_PREFIX)) retained.add(installGeneration);
  clientGenerations.forEach((name) => retained.add(name));

  const now = Date.now();
  const names = (await caches.keys()).filter((name) => name.startsWith(STAGING_CACHE_PREFIX));
  const generations = await Promise.all(
    names.map(async (name) => {
      const promoted = await caches.match(STAGING_PROMOTED_URL, { cacheName: name });
      return { name, promotedAt: promoted ? Number(await promoted.text()) : null };
    }),
  );

  await Promise.all(
    generations.map(async ({ name, promotedAt }) => {
      if (retained.has(name)) return;
      const createdAt = Number(name.slice(STAGING_CACHE_PREFIX.length).split("-", 1)[0]);
      const abandoned =
        Number.isFinite(createdAt) && now - createdAt > STAGING_ABANDONED_MAX_AGE_MS;
      if (Number.isFinite(promotedAt) || abandoned) await caches.delete(name);
    }),
  );
}

async function dropLegacyShellCaches() {
  const names = (await caches.keys()).filter(
    (key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== CACHE_VERSION,
  );
  await Promise.all(names.map((name) => caches.delete(name)));
}

self.addEventListener("activate", (event) => {
  event.waitUntil(activateWorker());
});

async function activateWorker() {
  await self.clients.claim();
  const metadata = await caches.open(SHELL_METADATA_CACHE);
  const ready = await metadata.match(INSTALL_READY_URL);
  if (!ready) {
    await dropSupersededShellStages();
    await caches.delete(LEGACY_MEDIA_CACHE);
    return;
  }

  const keys = await caches.keys();
  const legacyShellCaches = keys.filter(
    (key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== CACHE_VERSION,
  );
  await preserveLegacyShellAssets(legacyShellCaches);
  const cleanupSafe = await promoteShell(await ready.text());

  await Promise.allSettled([
    ...legacyShellCaches.map((key) => caches.delete(key)),
    caches.delete(LEGACY_MEDIA_CACHE),
  ]);
  if (cleanupSafe) {
    await Promise.allSettled([dropSupersededShellStages(), dropLegacyShellCaches()]);
  }
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "REFRESH_SHELL") {
    event.waitUntil(queueShellRefresh().catch(() => undefined));
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/offline-media/")) {
    event.respondWith(serveOfflineMedia(request, url.pathname));
    return;
  }

  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(serveNavigation(request, url.pathname));
    return;
  }

  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    RUNTIME_ASSETS.includes(url.pathname) ||
    MODEL_RUNTIME_ASSETS.includes(url.pathname)
  ) {
    event.respondWith(serveShellAsset(request, url.pathname));
  }
});

async function serveShellAsset(request, pathname) {
  if (isTurbopackWorkerBootstrap(pathname)) {
    return serveTurbopackWorkerBootstrap(request);
  }

  const cache = await currentShellAssetCache();
  const cached = (await cache.match(request)) || (await caches.match(request));
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function serveTurbopackWorkerBootstrap(request) {
  const cache = await currentShellAssetCache();
  const cached = (await cache.match(request)) || (await caches.match(request));
  if (cached) return detachResponseUrl(cached);

  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return detachResponseUrl(response);
}

async function detachResponseUrl(response) {
  const headers = new Headers(response.headers);
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isTurbopackWorkerBootstrap(pathname) {
  return /^\/_next\/static\/chunks\/turbopack-worker-[^/]+\.js$/.test(pathname);
}

async function currentShellAssetCache() {
  const live = await caches.open(CACHE_VERSION);
  const launch = await live.match(LAUNCH_URL);
  const generation = launch?.headers.get(SHELL_GENERATION_HEADER);
  return generation?.startsWith(STAGING_CACHE_PREFIX) ? caches.open(generation) : live;
}

async function serveNavigation(request, pathname) {
  const cache = await caches.open(CACHE_VERSION);

  if (pathname === "/library") {
    const shell = await cache.match(LAUNCH_URL);
    if (shell) return shell;
  }

  const live = await fetchWithinBudget(request);
  if (live) return live;

  if (rendersFromLocalData(pathname)) {
    const shell = await cache.match(LAUNCH_URL);
    if (shell) return shell;
  }
  return unreachableDocument();
}

function rendersFromLocalData(pathname) {
  return (
    pathname === "/" ||
    pathname === "/library" ||
    pathname === OFFLINE_URL ||
    pathname.startsWith("/books/")
  );
}

function fetchWithinBudget(request) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
    const settle = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    fetch(request).then(
      (response) => settle(response),
      () => settle(null),
    );
  });
}

function unreachableDocument() {
  return new Response(
    "<!doctype html><html lang=en><meta charset=utf-8>" +
      '<meta name=viewport content="width=device-width,initial-scale=1">' +
      "<title>Hark is offline</title>" +
      "<style>body{font:16px/1.5 system-ui;margin:0;display:grid;place-items:center;" +
      "min-height:100dvh;padding:2rem;text-align:center}</style>" +
      "<h1>Hark can&rsquo;t reach the network</h1>" +
      "<p>Your library and your audiobooks are still on this device. " +
      "Reopen Hark once you have a connection.</p>" +
      '<p><a href="/library">Try again</a></p>',
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

async function serveOfflineMedia(request, pathname) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(pathname);
  if (!cached) return new Response("Download unavailable", { status: 404 });
  const format = cached.headers.get("X-Chapterline-Media-Format");
  if (!format) return cached;
  if (format !== "chunked-v1") {
    return new Response("Unsupported saved media format", { status: 410 });
  }
  const manifest = await cached.json();
  if (manifest.format !== "chapterline-chunked-media-v1") {
    return new Response("Unsupported saved media format", { status: 410 });
  }
  const rangeHeader = request.headers.get("range");
  if (!rangeHeader) return streamWholeMedia(cache, pathname, manifest);

  const range = parseRange(rangeHeader, manifest.byteSize);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${manifest.byteSize}` },
    });
  }
  return new Response(streamMediaRange(cache, pathname, manifest, range.start, range.end), {
    status: 206,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${manifest.byteSize}`,
      "Accept-Ranges": "bytes",
    },
  });
}

function streamMediaRange(cache, pathname, manifest, start, end) {
  let index = Math.floor(start / manifest.chunkSize);
  const last = Math.floor(end / manifest.chunkSize);
  return new ReadableStream({
    async pull(controller) {
      if (index > last) {
        controller.close();
        return;
      }
      const response = await cache.match(`${pathname}/chunk/${index}`);
      if (!response) {
        controller.error(new Error("Download unavailable"));
        return;
      }
      const blob = await response.blob();
      const chunkStart = index * manifest.chunkSize;
      const slice = blob.slice(
        Math.max(0, start - chunkStart),
        Math.min(blob.size, end - chunkStart + 1),
      );
      controller.enqueue(new Uint8Array(await slice.arrayBuffer()));
      index += 1;
    },
  });
}

function streamWholeMedia(cache, pathname, manifest) {
  let index = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (index >= manifest.chunkCount) {
        controller.close();
        return;
      }
      const response = await cache.match(`${pathname}/chunk/${index}`);
      if (!response) {
        controller.error(new Error("Download unavailable"));
        return;
      }
      controller.enqueue(new Uint8Array(await response.arrayBuffer()));
      index += 1;
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(manifest.byteSize),
      "Accept-Ranges": "bytes",
    },
  });
}

function parseRange(header, totalSize) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || totalSize === 0) return null;
  if (!match[1]) {
    const suffixLength = Math.min(Number(match[2]), totalSize);
    return suffixLength > 0 ? { start: totalSize - suffixLength, end: totalSize - 1 } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), totalSize - 1) : totalSize - 1;
  return start < totalSize && start <= end ? { start, end } : null;
}
