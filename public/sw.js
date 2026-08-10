// Bumped whenever the meaning of what is stored changes, not merely its
// contents: v7 stores documents as pointers into immutable asset generations;
// v6 served a document and its mutable chunk set from one shared cache. `activate`
// deletes every other `chapterline-shell-` cache, and account-purge.ts keys off
// the same prefix, so the prefix is part of the contract.
const CACHE_VERSION = "chapterline-shell-v7";
const SHELL_CACHE_PREFIX = "chapterline-shell-";
// Each refresh owns an immutable asset generation. The prefix deliberately
// does not begin `chapterline-shell-`: an activating worker deletes old LIVE
// cache versions under that prefix, and must not erase a generation an older
// active worker is still promoting.
const STAGING_CACHE_PREFIX = "chapterline-staged-shell-";
// Kept outside the `chapterline-shell-` prefix so an older worker's activation
// sweep cannot erase a new install's ready pointer before that install activates.
const SHELL_METADATA_CACHE = "chapterline-runtime-shell-metadata-v1";
const SHELL_INTERNAL_PATH = "/_next/static/__chapterline_shell__/";
const STAGED_OFFLINE_URL = `${SHELL_INTERNAL_PATH}offline`;
const STAGED_LAUNCH_URL = `${SHELL_INTERNAL_PATH}launch`;
const STAGING_READY_URL = `${SHELL_INTERNAL_PATH}ready`;
const STAGING_PROMOTED_URL = `${SHELL_INTERNAL_PATH}promoted`;
const INSTALL_READY_URL = `${SHELL_INTERNAL_PATH}install-ready`;
const CLIENT_LEASE_URL_PREFIX = `${SHELL_INTERNAL_PATH}clients/`;
const SHELL_GENERATION_HEADER = "X-Chapterline-Shell-Generation";
// An extendable service-worker event cannot legitimately remain alive for a
// day. This only reclaims a generation whose worker died before promotion, and
// only when neither live document, install marker nor client lease names it.
const STAGING_ABANDONED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MEDIA_CACHE = "chapterline-media-v2";
const LEGACY_MEDIA_CACHE = "chapterline-media-v1";
/**
 * The launch shell.
 *
 * `/offline` is not a second screen: it renders the same `AppShell` and the
 * same `LibraryClient` as `/library`, reading the same local mirror, and it
 * renders no user identity and no book rows. That is what makes one cached copy
 * safe to serve to any account signed in on this device
 * (`docs/local-first.md` sections 8 and 11), and it is why `account-purge.ts`
 * lists this exact path as the entry a sign-in sweep may leave in place.
 */
const OFFLINE_URL = "/offline";
/**
 * The manifest's `start_url`, exactly — query string and all.
 *
 * This is the URL a home-screen tap asks for, and it is the ONLY navigation the
 * static route below claims. It has to be spelled out to the character because
 * a routing rule resolves against Cache Storage by request URL: `?source=pwa`
 * is part of the key, nothing reads it (grep: it is a marker and no code
 * branches on it), and a rule written for a bare `/library` would miss here and
 * fall through to the network. `src/app/manifest.ts` owns the other copy of
 * this string; the two must not drift, and `service-worker-shell.test.ts` pins
 * that they do not.
 */
const LAUNCH_URL = "/library?source=pwa";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png"];
/**
 * How long a navigation the shell cannot answer may wait on the network.
 *
 * `fetch(request).catch(...)` alone is not a fallback: `.catch()` fires only
 * when fetch REJECTS, and a weak-but-alive mobile connection does not reject —
 * it stalls, for tens of seconds, showing nothing. Racing a timeout is what
 * turns that blank screen into a bounded wait.
 */
const NAVIGATION_TIMEOUT_MS = 3000;

// The tail avoids redundant overlap inside ONE worker global. Correctness does
// not depend on it: an old active worker and a new installing worker have
// separate globals, so `precacheShell` also isolates every candidate in its own
// immutable generation before changing the live launch pointer.
let shellRefreshTail = Promise.resolve();
function queueShellRefresh() {
  const refresh = shellRefreshTail.then(precacheShell);
  shellRefreshTail = refresh.catch(() => undefined);
  return refresh;
}

self.addEventListener("install", (event) => {
  // Installing must not change the document an older active worker serves: it
  // only knows the legacy shared cache and cannot find chunks in this worker's
  // generation. Persist the ready generation, then promote it from `activate`
  // after this worker has claimed the clients and its fetch handler is in use.
  event.waitUntil(prepareInstalledShell().then(() => self.skipWaiting()));
  declareLaunchRoute(event);
});

/**
 * Answer the cold launch without waking this worker at all.
 *
 * Serving `/library` from Cache Storage in `fetch` below is not the whole job.
 * When a navigation arrives and the worker is not running — which on a real
 * home-screen tap is nearly always — the browser must boot it before it can
 * ask, and Chromium hedges that wait by speculatively fetching the same
 * document from the network (`ServiceWorkerAutoPreload`). The paint never waits
 * for that request and the page still comes from the cache, so it costs the
 * user nothing; it costs the SERVER a full `/library` render and its Postgres
 * queries on every cold launch, and the response is thrown away. Measured: six
 * discarded renders and 24 queries per benchmark run.
 *
 * A static route states the answer declaratively, so the browser satisfies the
 * navigation from the cache without starting the worker and has nothing left to
 * hedge against.
 *
 * TWO THINGS HERE ARE LOAD-BEARING, and getting either wrong is worse than not
 * doing this at all — a routing MISS goes straight to the network rather than
 * falling back to the `fetch` handler below, which would put the entire launch
 * document back on the wire:
 *
 *  - the condition matches the start_url EXACTLY, pathname and search. Every
 *    other navigation (`/library`, `/library?device=1`, `/books/:id`) is
 *    deliberately left to `serveNavigation`, which handles them correctly and
 *    is not query-sensitive. A rule written as a bare pathname would claim
 *    those too and miss on all of them.
 *  - `precacheShell` stores the shell under this exact key, so the lookup this
 *    rule performs is guaranteed to hit.
 *
 * `addRoutes` is Chromium-only and rejects a malformed rule, so it is guarded:
 * where it is unsupported nothing changes and the `fetch` handler stays
 * authoritative. This only ever changes WHO answers, never WHAT is answered.
 */
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
  } catch {
    // An unsupported rule shape must never fail the install. The worker then
    // answers the same navigation itself, one speculative request later.
  }
}

// The shell has to render with no network at all — it is what a warm launch is
// served — so its static chunks are captured here at install time rather than
// left to lazy runtime caching. Installation fails if any of them is missing,
// because a shell whose chunks are absent is a blank screen with extra steps.
async function stageShell() {
  const stageName = `${STAGING_CACHE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stage = await caches.open(stageName);

  try {
    // Fetch and validate the whole candidate without exposing it at a live
    // navigation key. Required chunks and both document copies land in the
    // candidate's immutable cache before promotion starts.
    const offlinePage = await fetch(OFFLINE_URL, { cache: "no-store" });
    if (!offlinePage.ok) throw new Error("The required offline page could not be fetched.");
    const html = await offlinePage.clone().text();
    const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s\\]+/g) || [])];
    const supportingAssets = PRECACHE.filter((asset) => asset !== OFFLINE_URL);
    await Promise.all([...supportingAssets, ...assets].map((asset) => stage.add(asset)));

    // `text()` decoded any content encoding. Reusing Content-Encoding or the
    // encoded Content-Length on this new response would make the cached HTML
    // unreadable on compressed deployments, so those transport headers go.
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
    // No live key can name an incomplete stage.
    await caches.delete(stageName).catch(() => undefined);
    throw error;
  }
}

/** Stage an install without making its document visible to the old worker. */
async function prepareInstalledShell() {
  const stageName = await stageShell();
  const metadata = await caches.open(SHELL_METADATA_CACHE);
  await metadata.put(INSTALL_READY_URL, new Response(stageName));
  return stageName;
}

/** Active-worker refreshes can stage and promote under the same event. */
async function precacheShell() {
  const stageName = await stageShell();
  const cleanupSafe = await promoteShell(stageName);
  if (cleanupSafe) {
    await Promise.allSettled([dropSupersededShellStages(), dropLegacyShellCaches()]);
  }
}

/**
 * Publish one complete immutable generation.
 *
 * The launch key is the sole commit point: both `serveNavigation` and the
 * declarative launch route read it. A failure before that put leaves the old
 * shell live; a failure afterward leaves a complete named generation live.
 */
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
  // A client can receive the old launch document until the next put. Pin that
  // generation to every currently untracked window before changing the key.
  const previousLaunch = await live.match(LAUNCH_URL);
  const previousGeneration = previousLaunch?.headers.get(SHELL_GENERATION_HEADER);
  await leaseUntrackedClients([previousGeneration]);
  await live.put(LAUNCH_URL, launchDocument);
  // Include both sides for a client created between the pre-commit snapshot and
  // the launch-key put. Distinct lease keys make concurrent workers union their
  // conservative answers instead of overwriting one another.
  let cleanupSafe = true;
  try {
    await leaseUntrackedClients([previousGeneration, stageName]);
  } catch {
    // The candidate is already canonical and complete. Skipping collection is
    // safer than rejecting the event and guessing which racing client saw it.
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

/** Pin an untracked live window to every generation it could have received. */
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

/** Return live client leases and discard leases whose window has closed. */
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

/**
 * Preserve chunks already-loaded clients may request from a pre-v7 document.
 *
 * The old worker can finish a refresh after v7 activates. Its Cache object is
 * therefore deleted after these bytes are copied: late writes stay attached to
 * the detached object and cannot overwrite v7's canonical launch key.
 */
async function preserveLegacyShellAssets(cacheNames) {
  const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  if (windows.length === 0 || cacheNames.length === 0) return;

  const stageName = `${STAGING_CACHE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stage = await caches.open(stageName);
  for (const cacheName of cacheNames) {
    const legacy = await caches.open(cacheName);
    for (const request of await legacy.keys()) {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith("/_next/static/") && !pathname.startsWith("/icons/")) continue;
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

/**
 * Forget immutable generations no live document can reference.
 *
 * Every deployment gives the build new `/_next/static` names. Deleting files
 * one by one from a shared cache was unsafe across worker globals; deleting a
 * completed, unreferenced generation is all-or-nothing and cannot strand a
 * document. The sweep still bounds storage to the generations named by the two
 * live keys, plus young interrupted candidates. That matters because shell
 * caches and irreplaceable downloaded audio compete for the same origin quota.
 *
 * Deliberately conservative: a young ready generation is a peer worker, not
 * garbage. A promoted generation stays while either live document, a pending
 * install, or a live client lease can name it; closing the client makes its
 * lease reclaimable on the next sweep. Storage is therefore bounded by live
 * clients and in-flight workers, not by an arbitrary deployment count.
 */
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
      // A promoted generation cannot publish again. A young unpromoted one may
      // be a peer worker between staging and commit, so only age can reclaim it.
      if (Number.isFinite(promotedAt) || abandoned) await caches.delete(name);
    }),
  );
}

/** Retryable cleanup for pre-v7 live caches after v7 is canonical. */
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
  // Install never exposes its document. Claim first so every request for a
  // newly promoted chunk reaches the handler that searches generation caches.
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
  // The shell is a cached copy of a built document, and every deployment gives
  // the build new `/_next/static` chunk names. Without this the device would
  // keep launching into the old build until `sw.js` itself changed bytes, which
  // it does not do per build. The page asks for the refresh once it has gone
  // idle after launch, so the round trip is never on the paint path.
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

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(serveShellAsset(request, url.pathname));
  }
});

async function serveShellAsset(request, pathname) {
  // Turbopack uses one bootstrap pathname for every module worker and puts the
  // actual entry chunks in the URL fragment. Fragments never reach HTTP or
  // Cache Storage. A cached Response retains the first worker's response URL;
  // returning it directly can therefore make a later worker boot that entry.
  if (isTurbopackWorkerBootstrap(pathname)) {
    return serveTurbopackWorkerBootstrap(request);
  }

  const cache = await currentShellAssetCache();
  // Prefer the canonical generation. The cross-cache fallback is for a
  // retained older client lazily requesting one of its own chunks.
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
  // `arrayBuffer()` exposes decoded bytes. Reusing transport encoding or the
  // encoded length would corrupt the reconstructed JavaScript response.
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

/** Runtime-warmed chunks join the generation the canonical launch key names. */
async function currentShellAssetCache() {
  const live = await caches.open(CACHE_VERSION);
  const launch = await live.match(LAUNCH_URL);
  const generation = launch?.headers.get(SHELL_GENERATION_HEADER);
  return generation?.startsWith(STAGING_CACHE_PREFIX) ? caches.open(generation) : live;
}

/**
 * The launch path (`docs/local-first.md` section 8).
 *
 * `/library` is answered from Cache Storage without consulting the network at
 * all, because the document it needs holds no book data and no user identity —
 * the books come from this device's IndexedDB mirror once the shell is running.
 * That is the whole point: a cold database and airplane mode cost exactly what
 * wifi costs, because none of them are on this path.
 *
 * Everything else goes to the network first, because it has something the
 * device does not (the player page's chapters and history, the auth pages), but
 * bounded: a stalled connection falls back to whatever this device can render
 * for itself instead of showing nothing for a minute.
 */
async function serveNavigation(request, pathname) {
  const cache = await caches.open(CACHE_VERSION);

  if (pathname === "/library") {
    const shell = await cache.match(LAUNCH_URL);
    if (shell) return shell;
  }

  const live = await fetchWithinBudget(request);
  if (live) return live;

  // The network did not answer in time. Anything the device can render from its
  // own mirror gets the shell. An auth page cannot be rendered from local data,
  // and handing it the library shell would bounce a signed-out visitor between
  // /login and the shell forever, so it gets an honest notice instead.
  if (rendersFromLocalData(pathname)) {
    const shell = await cache.match(LAUNCH_URL);
    if (shell) return shell;
  }
  return unreachableDocument();
}

/**
 * Routes the shell can stand in for. `/books/:id` is included because the
 * shell's `LibraryClient` reads the book id out of the URL and plays this
 * device's own copy — which is why opening a book needs no "am I online?"
 * question anywhere in the app.
 */
function rendersFromLocalData(pathname) {
  return (
    pathname === "/" ||
    pathname === "/library" ||
    pathname === OFFLINE_URL ||
    pathname.startsWith("/books/")
  );
}

/** Resolves with the response, or with null once the budget is spent. */
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

/** Last resort: no cached shell and no reachable server. */
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

// Streams ranges from independently cached chunks. This avoids turning a
// multi-gigabyte audiobook into one Blob in the memory-constrained iOS process.
async function serveOfflineMedia(request, pathname) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(pathname);
  if (!cached) return new Response("Download unavailable", { status: 404 });
  const format = cached.headers.get("X-Chapterline-Media-Format");
  // Entries without a format header are stored whole (cover art) and are
  // served as-is; only chunked manifests need range assembly below.
  if (!format) return cached;
  if (format !== "chunked-v1") {
    return new Response("Unsupported saved media format", { status: 410 });
  }
  const manifest = await cached.json();
  // The body's format field and the header are written together at import;
  // asserting both keeps the two representations from silently diverging.
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
