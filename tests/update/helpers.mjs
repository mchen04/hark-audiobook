import assert from "node:assert/strict";
import postgres from "postgres";

import { testEnvironment } from "../../scripts/bench/build.mjs";
import { sha256, sleep, storedAudioReady } from "../../scripts/bench/runtime.mjs";

export async function until(read, message, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(message);
}

export function observe(page) {
  const evidence = {
    errors: [],
    failedStatic: [],
    staticResponses: [],
    mediaResponses: [],
    responses: [],
    redirects: [],
    streamingFailures: [],
    readiness:
      "Content, shell, and progress assertions plus settled requests; audio and successful RSC response streams are recorded without waiting for their bodies",
  };
  const pending = new Set();
  const streamingMedia = new Set();
  const streamingRsc = new Set();
  const bodies = new Set();
  let changedAt = Date.now();
  page.on("pageerror", (error) => evidence.errors.push(error.message));
  page.on("request", (request) => {
    const redirected = request.redirectedFrom();
    if (redirected) {
      pending.delete(redirected);
      evidence.redirects.push({ from: redirected.url(), to: request.url() });
    }
    if (new URL(request.url()).pathname.startsWith("/offline-media/")) {
      streamingMedia.add(request);
      return;
    }
    pending.add(request);
    changedAt = Date.now();
  });
  for (const event of ["requestfinished", "requestfailed"])
    page.on(event, (request) => {
      if (streamingRsc.delete(request)) {
        if (event === "requestfailed")
          evidence.streamingFailures.push({ url: request.url(), failure: request.failure() });
        return;
      }
      if (new URL(request.url()).pathname.startsWith("/offline-media/")) {
        streamingMedia.delete(request);
        return;
      }
      pending.delete(request);
      changedAt = Date.now();
      if (event === "requestfailed" && new URL(request.url()).pathname.startsWith("/_next/static/"))
        evidence.failedStatic.push({ url: request.url(), failure: request.failure() });
    });
  page.on("response", (response) => {
    evidence.responses.push({
      url: response.url(),
      status: response.status(),
      contentType: response.headers()["content-type"] ?? null,
      fromServiceWorker: response.fromServiceWorker(),
    });
    if (
      new URL(response.url()).searchParams.has("_rsc") &&
      response.headers()["content-type"]?.startsWith("text/x-component") &&
      response.status() === 200
    ) {
      pending.delete(response.request());
      streamingRsc.add(response.request());
      changedAt = Date.now();
    }
    if (response.status() >= 300 && response.status() < 400) {
      pending.delete(response.request());
      changedAt = Date.now();
    }
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith("/offline-media/"))
      evidence.mediaResponses.push({
        pathname,
        status: response.status(),
        range: response.request().headers().range ?? null,
        contentRange: response.headers()["content-range"] ?? null,
        fromServiceWorker: response.fromServiceWorker(),
      });
    if (!pathname.startsWith("/_next/static/")) return;
    const entry = {
      url: response.url(),
      pathname,
      status: response.status(),
      sha256: null,
      fromServiceWorker: response.fromServiceWorker(),
    };
    evidence.staticResponses.push(entry);
    const body = response
      .body()
      .then((bytes) => {
        entry.sha256 = sha256(bytes);
      })
      .catch((error) => {
        entry.bodyFailure = String(error);
      });
    bodies.add(body);
    void body.finally(() => bodies.delete(body));
  });
  return {
    evidence,
    async quiet() {
      await until(() => {
        evidence.pendingNetworkRequests = [...pending].map((request) => ({
          url: request.url(),
          method: request.method(),
        }));
        evidence.streamingMediaRequests = [...streamingMedia].map((request) => ({
          url: request.url(),
          range: request.headers().range ?? null,
        }));
        evidence.streamingRscRequests = [...streamingRsc].map((request) => ({
          url: request.url(),
          method: request.method(),
        }));
        return pending.size === 0 && Date.now() - changedAt >= 3000;
      }, "Requests did not settle before navigation.");
      await Promise.all([...bodies]);
      for (const entry of evidence.staticResponses)
        if (entry.bodyFailure && entry.fromServiceWorker && !entry.sha256) {
          entry.sha256 = await page.evaluate(async (url) => {
            const response = await caches.match(url);
            if (!response) return null;
            const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
            return [...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
          }, entry.url);
          entry.bodyWitness = "Cache Storage bytes; browser protocol response body unavailable";
        }
    },
    async clean() {
      await Promise.all([...bodies]);
      assert.deepEqual(evidence.errors, [], "Page errors");
      assert.deepEqual(evidence.failedStatic, [], "Failed /_next/static requests");
      assert.equal(
        evidence.staticResponses.filter((response) => response.status >= 400 || !response.sha256)
          .length,
        0,
        "Static responses must complete successfully",
      );
    },
  };
}

export async function storage(page, userId, bookId) {
  return page.evaluate(
    async ({ userId, bookId }) => {
      const names = await caches.keys();
      const records = await Promise.all(
        names.map(async (name) => {
          const cache = await caches.open(name);
          const keys = (await cache.keys()).map(
            (request) => new URL(request.url).pathname + new URL(request.url).search,
          );
          const launch = await cache.match("/library?source=pwa");
          return {
            name,
            keys,
            generation: launch?.headers.get("X-Chapterline-Shell-Generation") ?? null,
            launchHtml: launch ? await launch.text() : null,
          };
        }),
      );
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === "chapterline-offline-v1"))
        throw new Error("The app's IndexedDB mirror is absent.");
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("chapterline-offline-v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const read = (name) =>
        new Promise((resolve, reject) => {
          const request = database.transaction(name).objectStore(name).get(`${userId}:${bookId}`);
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => reject(request.error);
        });
      const [download, progress] = await Promise.all([read("downloads"), read("playbackStates")]);
      database.close();
      const registration = await navigator.serviceWorker.getRegistration();
      return {
        caches: records,
        databases,
        download,
        progress,
        localProgress: JSON.parse(
          localStorage.getItem(`chapterline:position:${userId}:${bookId}`) || "null",
        ),
        serviceWorker: {
          controlling: !!navigator.serviceWorker.controller,
          active: registration?.active?.state ?? null,
          waiting: registration?.waiting?.state ?? null,
          installing: registration?.installing?.state ?? null,
        },
      };
    },
    { userId, bookId },
  );
}

export async function serverPosition(bookId) {
  const sql = postgres(testEnvironment().DATABASE_URL, { max: 1 });
  try {
    const [row] = await sql`select position_ms from playback_states where book_id = ${bookId}`;
    return row ? Number(row.position_ms) / 1000 : null;
  } finally {
    await sql.end();
  }
}

export async function position(page) {
  return page.locator("audio").evaluate((audio) => audio.currentTime);
}

export async function persisted(page, userId, bookId, expected, online = true) {
  return until(async () => {
    const snapshot = await storage(page, userId, bookId);
    const serverSeconds = online ? await serverPosition(bookId) : null;
    const localSeconds = snapshot.progress?.positionMs / 1000;
    return Number.isFinite(localSeconds) &&
      Math.abs(localSeconds - expected) <= 0.25 &&
      (!online || (serverSeconds !== null && Math.abs(serverSeconds - expected) <= 0.25))
      ? { ...snapshot, serverSeconds, localSeconds, expectedSeconds: expected }
      : null;
  }, `Persisted progress differs from audio ${expected}s by more than 0.25s.`);
}

export async function rangeEvidence(page, mediaUrl) {
  const evidence = await page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { Range: "bytes=4194280-4194350" } });
    return {
      status: response.status,
      contentRange: response.headers.get("content-range"),
      byteSize: (await response.arrayBuffer()).byteLength,
    };
  }, mediaUrl);
  assert.equal(evidence.status, 206, "Local audio range status");
  assert.match(
    evidence.contentRange ?? "",
    /^bytes 4194280-4194350\/\d+$/,
    "Local audio Content-Range",
  );
  assert.equal(evidence.byteSize, 71, "Cross-chunk range length");
  assert.equal(await page.evaluate(storedAudioReady), true, "Both audio chunks remain saved");
  return evidence;
}

export function offlineRanges(evidence, start) {
  const responses = evidence.mediaResponses.slice(start);
  assert(
    responses.some(
      (response) =>
        response.range &&
        response.range !== "bytes=4194280-4194350" &&
        response.status === 206 &&
        response.fromServiceWorker,
    ),
    "The audio element must receive a local 206 response while offline",
  );
  for (const response of responses.filter((response) => response.range)) {
    assert.equal(response.status, 206, "Offline media range status");
    assert.match(response.contentRange ?? "", /^bytes \d+-\d+\/\d+$/, "Offline media range header");
  }
  return responses;
}
