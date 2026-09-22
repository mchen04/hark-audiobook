import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { PullBatch } from "@/lib/offline/sync-protocol";

import { ACCOUNT_A, ensureAccount, network, sessionFor } from "../parity/harness/app";
import {
  APP_ORIGIN,
  attachDriver,
  closeSql,
  importThroughUi,
  openDevice,
  outbox,
  sharedSession,
  sql,
  waitForServiceWorker,
} from "./harness/app";

test.afterAll(async () => {
  await closeSql();
  await (await network()).close();
});

/** Page errors are evidence: keep the message and stack, not just the name. */
function recordPageErrors(page: Page, errors: string[]): void {
  page.on("pageerror", (error) =>
    errors.push(`${error.name}: ${error.message}\n${error.stack ?? ""}`),
  );
}

function registration(bookId: string) {
  return {
    bookId,
    fileName: "contention-fixture.mp3",
    byteSize: 1_000,
    durationMs: 600_000,
    fingerprint: createHash("sha256").update(bookId).digest("hex"),
    fingerprintKind: "sha256-v1",
    title: "Disposable contention fixture",
    author: "Fixture",
    narrator: null,
    chapterDiagnostic: null,
    chapters: [{ position: 0, title: "Fixture", startMs: 0, endMs: 600_000 }],
  };
}

function progress(deviceId: string, deviceSequence = 1, positionMs = 12_000) {
  return {
    deviceId,
    deviceSequence,
    positionMs,
    playbackRate: 1,
    completed: false,
    eventOccurredAt: new Date().toISOString(),
  };
}

async function call(api: APIRequestContext, method: string, path: string, data?: unknown) {
  const started = performance.now();
  const response = await api.fetch(APP_ORIGIN + path, {
    method,
    data,
    headers: { Origin: APP_ORIGIN },
    timeout: 20_000,
  });
  return {
    status: response.status(),
    retryAfter: response.headers()["retry-after"] ?? null,
    body: await response.json(),
    elapsedMs: performance.now() - started,
  };
}

/** Hold a REAL HTTP import after receipt allocation, on only its new fixture PK.
 * Rolling back the uncommitted fixture lets the import finish normally. No
 * trigger, clock change, global lock or response stub participates.
 */
async function heldImport(api: APIRequestContext, userId: string, bookId: string) {
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let blockerPid = 0;
  const rollback = new Error("rollback this uncommitted fixture only");
  const barrier = sql()
    .begin(async (tx) => {
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      blockerPid = row!.pid;
      await tx`insert into books (id, owner_id, title, author)
      values (${bookId}::uuid, ${userId}, 'Uncommitted contention fixture', 'Fixture')`;
      ready();
      await gate;
      throw rollback;
    })
    .catch((error: unknown) => {
      if (error !== rollback) throw error;
    });
  await Promise.race([acquired, barrier]);
  const response = call(api, "POST", "/api/books/local", registration(bookId));
  let writerPid = 0;
  try {
    await Promise.race([
      expect
        .poll(
          async () => {
            const [row] = await sql()<{ pid: number }[]>`select pid from pg_stat_activity
        where ${blockerPid} = any(pg_blocking_pids(pid))`;
            writerPid = row?.pid ?? 0;
            return writerPid;
          },
          { timeout: 5_000 },
        )
        .toBeGreaterThan(0),
      response.then((result) => {
        throw new Error(`Held import completed before blocking: ${JSON.stringify(result)}`);
      }),
    ]);
  } catch (error) {
    release();
    await Promise.allSettled([barrier, response]);
    throw error;
  }
  const done = Promise.all([barrier, response]).then(([, result]) => result);
  // A later UI failure must not turn the barrier request timeout into an
  // unhandled rejection before the case reaches its finally/await done.
  void done.catch(() => undefined);
  return { writerPid, release, done };
}

test("a held import bounds contending progress without starving another account", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const { account, storageState } = await sharedSession(browser);
  const peer = await ensureAccount(browser, ACCOUNT_A);
  const a = await browser.newContext({ storageState });
  const b = await browser.newContext({ storageState: await sessionFor(browser, peer) });
  const bookId = randomUUID();
  const peerBook = randomUUID();
  const importing = randomUUID();
  const missing = randomUUID();
  const observations: Record<string, unknown> = {};
  const pending: Promise<unknown>[] = [];
  let held: Awaited<ReturnType<typeof heldImport>> | undefined;
  try {
    // Validate identities before touching either clearly disposable fixture.
    expect((await call(a.request, "GET", "/api/auth/get-session")).body.user.id).toBe(
      account.userId,
    );
    expect((await call(b.request, "GET", "/api/auth/get-session")).body.user.id).toBe(peer.userId);
    expect(peer.userId).not.toBe(account.userId);
    expect((await call(a.request, "POST", "/api/books/local", registration(bookId))).status).toBe(
      201,
    );
    expect((await call(b.request, "POST", "/api/books/local", registration(peerBook))).status).toBe(
      201,
    );
    const duplicate = progress("contention-duplicate-0001");
    expect(
      (await call(a.request, "PATCH", `/api/books/${bookId}/progress`, duplicate)).status,
    ).toBe(200);
    const cursor = ((await call(a.request, "GET", "/api/sync/pull")).body as PullBatch).cursor;
    held = await heldImport(a.request, account.userId, importing);

    const started = performance.now();
    const completed: Array<{ group: string; atMs: number; status: number }> = [];
    const jobs = Array.from({ length: 32 }, (_, index) => {
      const kind = ["save", "duplicate", "missing", "foreign"][index % 4]!;
      const id = kind === "missing" ? missing : kind === "foreign" ? peerBook : bookId;
      const body = kind === "duplicate" ? duplicate : progress(`contention-device-${index}`);
      const result = call(a.request, "PATCH", `/api/books/${id}/progress`, body).then((value) => {
        completed.push({ group: kind, atMs: performance.now() - started, status: value.status });
        return { kind, id, request: body, ...value };
      });
      pending.push(result);
      return result;
    });
    // Eight unrelated-account requests (including a write) compete in the SAME
    // production pool. Only one peer write avoids its own admission contention.
    const peers = Array.from({ length: 8 }, (_, index) => {
      const result = (
        index === 0
          ? call(
              b.request,
              "PATCH",
              `/api/books/${peerBook}/progress`,
              progress("contention-peer-0001", 1, 24_000),
            )
          : call(b.request, "GET", index % 2 ? `/api/books/${peerBook}` : "/api/sync/pull")
      ).then((value) => {
        completed.push({ group: "peer", atMs: performance.now() - started, status: value.status });
        return { index, ...value };
      });
      pending.push(result);
      return result;
    });
    const samples = [];
    // Fixed observation window, NOT a wait/retry-until-green. On the red server
    // the barrier is still released after 2s, so the whole experiment is bounded.
    while (performance.now() - started < 2_000) {
      const [row] = await sql()<
        { waiters: number; oldestWaitMs: number }[]
      >`select count(*)::int as waiters,
        coalesce(max(extract(epoch from (clock_timestamp() - query_start)) * 1000), 0)::float8 as "oldestWaitMs"
        from pg_stat_activity where ${held.writerPid} = any(pg_blocking_pids(pid))`;
      samples.push({
        atMs: performance.now() - started,
        waiters: row!.waiters,
        oldestWaitMs: row!.oldestWaitMs,
        completed: completed.length,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const beforeRelease = [...completed];
    observations.window = {
      heldMs: performance.now() - started,
      writerPid: held.writerPid,
      samples,
      beforeRelease,
    };
    held.release();
    expect((await held.done).status).toBe(201);
    const results = await Promise.all(jobs);
    const peerResults = await Promise.all(peers);
    observations.results = results;
    observations.peerResults = peerResults;
    expect.soft(beforeRelease.filter((row) => row.group !== "peer")).toHaveLength(32);
    expect.soft(results.map((row) => row.status)).toEqual(Array(32).fill(503));
    expect.soft(results.every((row) => row.retryAfter === "1")).toBe(true);
    expect.soft(Math.max(...results.map((row) => row.elapsedMs))).toBeLessThan(1_500);
    expect.soft(peerResults.map((row) => row.status)).toEqual(Array(8).fill(200));
    expect.soft(Math.max(...peerResults.map((row) => row.elapsedMs))).toBeLessThan(1_000);
    // Samples can miss a brief wait (including a valid fail-fast admission).
    // The held writer and 32 real busy responses above are the positive control;
    // sampled ages and the quiet final sample do not prove an absolute bound.
    expect.soft(Math.max(...samples.map((row) => row.oldestWaitMs))).toBeLessThan(200);
    expect.soft(samples.at(-1)!.waiters).toBe(0);

    // A bounded, explicit retry of each failed intent after release. These are
    // API probes; genuine UI/outbox recovery is the separate case below.
    const recovery = [];
    for (const row of results) {
      const next = await call(a.request, "PATCH", `/api/books/${row.id}/progress`, row.request);
      recovery.push({ kind: row.kind, ...next });
      expect(next.status).toBe(row.kind === "missing" || row.kind === "foreign" ? 404 : 200);
    }
    observations.recovery = recovery;
    const batch = (
      await call(a.request, "GET", `/api/sync/pull?since=${encodeURIComponent(cursor)}`)
    ).body as PullBatch;
    observations.after = batch;
    expect(batch.books.some((book) => book.id === importing)).toBe(true);
    expect(
      batch.playbackStates.some((state) => state.bookId === bookId && state.positionMs === 12_000),
    ).toBe(true);
    expect(batch.books.some((book) => book.id === peerBook)).toBe(false);
    const [state] = await sql()<{ own: boolean; peer: boolean }[]>`select
      exists(select 1 from playback_states where user_id=${account.userId} and book_id=${peerBook}::uuid) as own,
      exists(select 1 from playback_states where user_id=${peer.userId} and book_id=${peerBook}::uuid) as peer`;
    expect(state).toEqual({ own: false, peer: true });
    const [peerState] = await sql()<{ position: number }[]>`select position_ms::int as position
      from playback_states where user_id=${peer.userId} and book_id=${peerBook}::uuid`;
    expect(peerState?.position).toBe(24_000);
  } finally {
    held?.release();
    await Promise.allSettled([...(held ? [held.done] : []), ...pending]);
    writeFileSync(info.outputPath("contention.json"), JSON.stringify(observations, null, 2));
    // Only this case's new IDs, through the shipping owner-scoped API.
    for (const id of [bookId, importing]) await call(a.request, "DELETE", `/api/books/${id}`);
    await call(b.request, "DELETE", `/api/books/${peerBook}`);
    await a.close();
    await b.close();
  }
});

test("the real player retains a busy progress write and replays it on relaunch", async ({
  browser,
}, info) => {
  test.setTimeout(60_000);
  const { account, storageState } = await sharedSession(browser);
  const device = "contention-player-0001";
  const { context, page } = await openDevice(browser, device, storageState);
  const importing = randomUUID();
  let bookId: string | undefined;
  let held: Awaited<ReturnType<typeof heldImport>> | undefined;
  const observations: Record<string, unknown> = {};
  const errors: string[] = [];
  recordPageErrors(page, errors);
  try {
    await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached" });
    await waitForServiceWorker(page);
    const fixture = info.outputPath("contention-player.mp3");
    const title = `Contention player ${randomUUID()}`;
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=30",
      "-metadata",
      `title=${title}`,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      fixture,
    ]);
    await importThroughUi(page, "Contention-player.mp3", readFileSync(fixture));
    await page.getByRole("link", { name: title, exact: true }).click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    bookId = page.url().split("/").at(-1)!;
    await attachDriver(page, account, device);
    const cursor = ((await call(context.request, "GET", "/api/sync/pull")).body as PullBatch)
      .cursor;
    held = await heldImport(context.request, account.userId, importing);
    const response = page.waitForResponse((res) =>
      res.url().endsWith(`/api/books/${bookId}/progress`),
    );
    // Real slider -> persister -> fetch -> real 503 -> real IndexedDB outbox.
    await page.getByRole("slider", { name: "Audiobook position" }).fill("5000");
    const busy = await response;
    observations.busy = { status: busy.status(), body: await busy.json() };
    expect(busy.status()).toBe(503);
    await expect
      .poll(async () => (await outbox(page)).filter((row) => row.entityId === bookId).length)
      .toBe(1);
    const before = (await outbox(page)).find((row) => row.entityId === bookId)!;
    observations.queued = before;
    expect(before.payload.positionMs).toBe(5_000);
    const [notSaved] = await sql()<
      { count: number }[]
    >`select count(*)::int as count from playback_states
      where user_id=${account.userId} and book_id=${bookId}::uuid`;
    expect(notSaved!.count).toBe(0);
    const during = (
      await call(context.request, "GET", `/api/sync/pull?since=${encodeURIComponent(cursor)}`)
    ).body as PullBatch;
    observations.during = during;
    expect(during.books).toEqual([]);
    expect(during.playbackStates).toEqual([]);
    await page.screenshot({ path: info.outputPath("busy-player.png") });
    // The held transaction rejects any departing pagehide keepalive too. Keep
    // the socket up: this recovery is from a real SERVER busy response.
    await page.close();
    const reopened = await context.newPage();
    recordPageErrors(reopened, errors);
    // Same-origin 404 has no app/replay hook. Inspect what survived BEFORE mount.
    await reopened.goto(`${APP_ORIGIN}/__hark_sync_probe__`, { waitUntil: "domcontentloaded" });
    await attachDriver(reopened, account, device);
    const retained = (await outbox(reopened)).find((row) => row.entityId === bookId)!;
    observations.retainedAfterClose = retained;
    expect(retained.payload).toEqual(before.payload);
    expect(retained.deviceSequence).toBeGreaterThanOrEqual(before.deviceSequence);
    held.release();
    expect((await held.done).status).toBe(201);
    // Mount the shipping replay hook. No driver.replay(), queue edits,
    // synthetic online event or test retry loop causes this delivery.
    const accepted = reopened.waitForResponse(
      (res) => res.url().endsWith(`/api/books/${bookId}/progress`) && res.status() === 200,
    );
    await reopened.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    observations.accepted = await (await accepted).json();
    await attachDriver(reopened, account, device);
    await expect
      .poll(async () => (await outbox(reopened)).filter((row) => row.entityId === bookId).length)
      .toBe(0);
    const after = (
      await call(
        context.request,
        "GET",
        `/api/sync/pull?since=${encodeURIComponent(during.cursor)}`,
      )
    ).body as PullBatch;
    observations.after = after;
    expect(after.books.some((book) => book.id === importing)).toBe(true);
    expect(after.playbackStates.find((state) => state.bookId === bookId)).toMatchObject({
      positionMs: 5_000,
      deviceSequence: retained.deviceSequence,
    });
    const [ordering] = await sql()<
      { ordered: boolean }[]
    >`select b.updated_at < p.updated_at as ordered
      from books b cross join playback_states p where b.id=${importing}::uuid
      and p.user_id=${account.userId} and p.book_id=${bookId}::uuid`;
    observations.ordering = ordering;
    expect(ordering?.ordered).toBe(true);
    // Real decoder and preserved local bytes remain usable after retry.
    await reopened.getByRole("link", { name: title, exact: true }).click();
    await reopened.getByRole("button", { name: "Play", exact: true }).click();
    const sampled = await reopened
      .locator("audio")
      .evaluate((audio: HTMLAudioElement) => audio.currentTime);
    await expect
      .poll(() =>
        reopened.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime),
      )
      .toBeGreaterThan(sampled + 0.1);
    observations.sampled = sampled;
    observations.advanced = await reopened
      .locator("audio")
      .evaluate((audio: HTMLAudioElement) => audio.currentTime);
    const range = await reopened.locator("audio").evaluate(async (audio: HTMLAudioElement) => {
      const response = await fetch(audio.currentSrc, { headers: { Range: "bytes=0-1023" } });
      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    });
    observations.range = range;
    expect(range).toEqual({ status: 206, bytes: 1024 });
    expect(errors).toEqual([]);
    await reopened.screenshot({ path: info.outputPath("recovered-player.png") });
  } finally {
    held?.release();
    if (held) await Promise.allSettled([held.done]);
    observations.pageErrors = errors;
    writeFileSync(info.outputPath("player-recovery.json"), JSON.stringify(observations, null, 2));
    await context.close();
    const api = await browser.newContext({ storageState });
    if (bookId) await call(api.request, "DELETE", `/api/books/${bookId}`);
    await call(api.request, "DELETE", `/api/books/${importing}`);
    await api.close();
  }
});

test("sign-out retries a busy edit within its existing drain budget before purging", async ({
  browser,
}, info) => {
  // Reauthenticating the fixture for teardown may need the real limiter's
  // bounded 61s idle window. The application's drain assertions stay at 8s.
  test.setTimeout(90_000);
  const account = await ensureAccount(browser, ACCOUNT_A);
  const { context, page } = await openDevice(
    browser,
    "contention-signout-0001",
    await sessionFor(browser, account),
  );
  const bookId = randomUUID();
  const importing = randomUUID();
  const renamed = `Edit before busy sign-out ${randomUUID()}`;
  const responses: Array<{ atMs: number; status: number; retryAfter: string | undefined }> = [];
  const observations: Record<string, unknown> = { bookId, importing, responses };
  let held: Awaited<ReturnType<typeof heldImport>> | undefined;
  const started = performance.now();
  page.on("response", (response) => {
    if (
      response.url().endsWith(`/api/books/${bookId}`) &&
      response.request().method() === "PATCH"
    ) {
      responses.push({
        atMs: performance.now() - started,
        status: response.status(),
        retryAfter: response.headers()["retry-after"],
      });
    }
  });
  try {
    expect(
      (await call(context.request, "POST", "/api/books/local", registration(bookId))).status,
    ).toBe(201);
    await page.goto(`${APP_ORIGIN}/settings`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: /Sign out/ })).toBeVisible();
    await attachDriver(page, account, "contention-signout-0001");
    held = await heldImport(context.request, account.userId, importing);
    await page.evaluate(
      async ({ bookId, renamed }) => {
        await window.__harkSync.commit({ kind: "rename", bookId, fields: { title: renamed } });
      },
      { bookId, renamed },
    );
    expect(
      (await outbox(page)).some((row) => row.entityId === bookId && row.payload.title === renamed),
    ).toBe(true);
    const beforeSignOut = responses.length;
    await page.getByRole("button", { name: /Sign out/ }).click();
    // Two real busy responses pin a production retry; no driver replay, mocked
    // fetch, synthetic online event, or test retry sends this write.
    await expect
      .poll(() => responses.slice(beforeSignOut).filter((row) => row.status === 503).length, {
        timeout: 4_000,
      })
      .toBeGreaterThanOrEqual(2);
    const busy = responses.slice(beforeSignOut).filter((row) => row.status === 503);
    expect(busy.every((row) => row.retryAfter === "1")).toBe(true);
    expect(busy[1]!.atMs - busy[0]!.atMs).toBeGreaterThanOrEqual(950);
    observations.queuedDuringDrain = await outbox(page);
    expect(
      (await outbox(page)).some((row) => row.entityId === bookId && row.payload.title === renamed),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("signout-busy.png") });
    held.release();
    expect((await held.done).status).toBe(201);
    await page.waitForURL(/\/login/, { timeout: 8_000 });
    expect(responses.some((row) => row.status === 200)).toBe(true);
    const [saved] = await sql()<
      { title: string }[]
    >`select title from books where owner_id=${account.userId} and id=${bookId}::uuid`;
    observations.saved = saved;
    expect(saved?.title).toBe(renamed);
    await attachDriver(page, account, "contention-signout-0001");
    expect(await outbox(page)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem("chapterline:active-user"))).toBe(null);
    await page.screenshot({ path: info.outputPath("signout-delivered.png") });
  } finally {
    held?.release();
    if (held) await Promise.allSettled([held.done]);
    observations.finalUrl = page.url();
    writeFileSync(info.outputPath("signout-recovery.json"), JSON.stringify(observations, null, 2));
    await context.close();
    // The UI invalidated its session. Reauthenticate the reusable disposable
    // fixture normally, then delete only this case's two new IDs.
    const api = await browser.newContext({ storageState: await sessionFor(browser, account) });
    for (const id of [bookId, importing]) await call(api.request, "DELETE", `/api/books/${id}`);
    await api.close();
  }
});

/** Exact pre-existing WebKit/Next login-RSC error reproduced on 33f4ccd and
 * 095ed406 (historical sign-out follow-up receipts). Keep it in raw evidence;
 * reject all other page errors. This fixture does not certify error-free Next
 * navigation or fix that framework fetch path.
 */
function assertDrainPageErrors(errors: string[], origin: string): void {
  const knownLoginRsc = (error: string) =>
    error.includes(`Fetch API cannot load ${origin}/login?_rsc=`) &&
    error.includes("due to access control checks.") &&
    error.includes(`at T (${origin}/_next/static/chunks/12czkog7d-pir.js:1:99505)`);
  expect(errors.filter((error) => !knownLoginRsc(error))).toEqual([]);
}

test("sign-out joins a held ambient replay then retries real server contention", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const net = await network();
  const account = await ensureAccount(browser, ACCOUNT_A);
  const device = "contention-ambient-0001";
  const { context, page } = await openDevice(browser, device, await sessionFor(browser, account));
  const bookId = randomUUID();
  const importing = randomUUID();
  const title = `Ambient sign-out ${randomUUID()}`;
  let held: Awaited<ReturnType<typeof heldImport>> | undefined;
  let buffered: ReturnType<typeof net.holdNextResponse> | undefined;
  const responses: Array<{ atMs: number; status: number }> = [];
  const errors: string[] = [];
  const observations: Record<string, unknown> = { responses, errors };
  recordPageErrors(page, errors);
  page.on("response", (response) => {
    if (
      response.url().endsWith(`/api/books/${bookId}`) &&
      response.request().method() === "PATCH"
    ) {
      responses.push({ atMs: performance.now(), status: response.status() });
    }
  });
  try {
    expect(
      (await call(context.request, "POST", "/api/books/local", registration(bookId))).status,
    ).toBe(201);
    await page.goto(`${net.origin}/library`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached" });
    await waitForServiceWorker(page);
    // The 404 page has no replay effect. Seed one real outbox row, then mount
    // the SHIPPING replay on Settings (the bundled driver has a different map).
    await page.goto(`${net.origin}/__hark_sync_probe__`, { waitUntil: "domcontentloaded" });
    await attachDriver(page, account, device);
    await page.evaluate(
      async ({ bookId, title, userId }) => {
        localStorage.setItem("chapterline:active-user", userId);
        await window.__harkSync.commit({ kind: "rename", bookId, fields: { title } });
      },
      { bookId, title, userId: account.userId },
    );
    held = await heldImport(context.request, account.userId, importing);
    buffered = net.holdNextResponse("PATCH", `/api/books/${bookId}`);
    await page.goto(`${net.origin}/settings`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: /Sign out/ })).toBeVisible();
    expect(await buffered.upstreamStatus).toBe(503);
    // Observe (delegate unchanged) BOTH initial drain reads. The next task runs
    // after their promise continuations, making the overlap deterministic without
    // sleeping or invoking a second copy of the app replay in the driver.
    await page.evaluate(() => {
      const original = IDBIndex.prototype.getAll;
      const completed = new Set<string>();
      IDBIndex.prototype.getAll = function (...args) {
        const request = original.apply(this, args);
        const store = this.objectStore.name;
        const db = this.objectStore.transaction.db.name;
        if (
          (db === "chapterline-sync-v1" && store === "mutations") ||
          (db === "hark-playback-history-v1" && store === "actions")
        ) {
          request.addEventListener("success", () => {
            completed.add(store);
            if (completed.size === 2)
              setTimeout(() => {
                document.documentElement.dataset.drainRead = "complete";
                IDBIndex.prototype.getAll = original;
              }, 0);
          });
        }
        return request;
      };
    });
    const signOutAt = performance.now();
    await page.getByRole("button", { name: /Sign out/ }).click();
    await page.waitForFunction(() => document.documentElement.dataset.drainRead === "complete");
    expect(
      net.hits().filter((hit) => hit.method === "PATCH" && hit.path === `/api/books/${bookId}`),
    ).toHaveLength(1);
    observations.joinedBeforeReply = true;
    buffered.release();
    // The ambient 503 alone cannot drain this edit. A fresh own pass must run.
    await expect
      .poll(() => responses.filter((row) => row.status === 503).length, { timeout: 3_000 })
      .toBe(2);
    await attachDriver(page, account, device);
    expect((await outbox(page)).some((row) => row.payload.title === title)).toBe(true);
    await page.screenshot({ path: info.outputPath("ambient-busy-drain.png") });
    held.release();
    expect((await held.done).status).toBe(201);
    await page.waitForURL(/\/login/, { timeout: 8_000 });
    observations.drainElapsedMs = performance.now() - signOutAt;
    expect(observations.drainElapsedMs).toBeLessThan(8_000);
    expect(responses.map((row) => row.status)).toEqual([503, 503, 200]);
    expect(responses[2]!.atMs - responses[1]!.atMs).toBeGreaterThanOrEqual(950);
    const [saved] = await sql()<
      { title: string }[]
    >`select title from books where owner_id=${account.userId} and id=${bookId}::uuid`;
    expect(saved?.title).toBe(title);
    observations.saved = saved;
    await attachDriver(page, account, device);
    expect(await outbox(page)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem("chapterline:active-user"))).toBe(null);
    assertDrainPageErrors(errors, net.origin);
    observations.assertionsPassed = true;
    await page.screenshot({ path: info.outputPath("ambient-signout-delivered.png") });
  } finally {
    buffered?.release();
    held?.release();
    if (held) await Promise.allSettled([held.done]);
    observations.finalUrl = page.url();
    writeFileSync(info.outputPath("ambient-signout.json"), JSON.stringify(observations, null, 2));
    await context.close();
    const api = await browser.newContext({ storageState: await sessionFor(browser, account) });
    for (const id of [bookId, importing]) await call(api.request, "DELETE", `/api/books/${id}`);
    await api.close();
  }
});

test("terminal progress journals while busy sign-out waits and its fresh intent reaches the server", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const account = await ensureAccount(browser, ACCOUNT_A);
  const device = "contention-terminal-0001";
  const { context, page } = await openDevice(browser, device, await sessionFor(browser, account));
  const importing = randomUUID();
  let bookId: string | undefined;
  let held: Awaited<ReturnType<typeof heldImport>> | undefined;
  const responses: Array<{
    atMs: number;
    status: number;
    positionMs: number;
    deviceSequence: number;
  }> = [];
  const errors: string[] = [];
  const observations: Record<string, unknown> = { responses, errors };
  recordPageErrors(page, errors);
  page.on("response", (response) => {
    if (bookId && response.url().endsWith(`/api/books/${bookId}/progress`)) {
      const body = response.request().postDataJSON();
      responses.push({
        atMs: performance.now(),
        status: response.status(),
        positionMs: body.positionMs,
        deviceSequence: body.deviceSequence,
      });
    }
  });
  try {
    await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached" });
    await waitForServiceWorker(page);
    const fixture = info.outputPath("terminal-progress.mp3");
    const title = `Terminal sign-out ${randomUUID()}`;
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:duration=30",
      "-metadata",
      `title=${title}`,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      fixture,
    ]);
    await importThroughUi(page, "Terminal-progress.mp3", readFileSync(fixture));
    await page.getByRole("link", { name: title, exact: true }).click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    bookId = page.url().split("/").at(-1)!;
    await attachDriver(page, account, device);
    await expect.poll(async () => (await outbox(page)).length).toBe(0);
    held = await heldImport(context.request, account.userId, importing);
    await page.getByRole("slider", { name: "Audiobook position" }).fill("5000");
    await expect
      .poll(
        async () => (await outbox(page)).find((row) => row.entityId === bookId)?.payload.positionMs,
      )
      .toBe(5_000);
    const initial = (await outbox(page)).find((row) => row.entityId === bookId)!;
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("button", { name: /Sign out/ })).toBeVisible();
    const before = responses.length;
    const signOutAt = performance.now();
    await page.getByRole("button", { name: /Sign out/ }).click();
    await expect.poll(() => responses.length).toBe(before + 1);
    expect(responses.at(-1)?.status).toBe(503);
    const terminalAt = performance.now();
    // Synthetic lifecycle stimulus, real installed terminal handler/persister,
    // real SQL 503 and real IDB journal. This is not a physical OS-kill claim.
    await page.locator("audio").evaluate((audio: HTMLAudioElement) => {
      audio.currentTime = 7;
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
    });
    await expect
      .poll(
        async () => (await outbox(page)).find((row) => row.entityId === bookId)?.payload.positionMs,
        { timeout: 600, intervals: [20, 50] },
      )
      .toBe(7_000);
    observations.terminalJournalMs = performance.now() - terminalAt;
    const terminal = (await outbox(page)).find((row) => row.entityId === bookId)!;
    observations.terminal = terminal;
    expect(terminal.deviceSequence).toBeGreaterThan(initial.deviceSequence);
    expect(responses.some((row) => row.status === 503 && row.positionMs === 7_000)).toBe(true);
    await page.screenshot({ path: info.outputPath("terminal-during-drain.png") });
    held.release();
    expect((await held.done).status).toBe(201);
    await page.waitForURL(/\/login/, { timeout: 8_000 });
    observations.drainElapsedMs = performance.now() - signOutAt;
    expect(observations.drainElapsedMs).toBeLessThan(8_000);
    const accepted = responses.filter((row) => row.status === 200);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      positionMs: 7_000,
      deviceSequence: terminal.deviceSequence,
    });
    const [saved] = await sql()<
      { positionMs: number; deviceSequence: number }[]
    >`select position_ms::int as "positionMs", device_sequence::int as "deviceSequence" from playback_states where user_id=${account.userId} and book_id=${bookId}::uuid`;
    observations.saved = saved;
    expect(saved).toEqual({ positionMs: 7_000, deviceSequence: terminal.deviceSequence });
    await attachDriver(page, account, device);
    expect(await outbox(page)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem("chapterline:active-user"))).toBe(null);
    assertDrainPageErrors(errors, APP_ORIGIN);
    observations.assertionsPassed = true;
    await page.screenshot({ path: info.outputPath("terminal-signout-delivered.png") });
  } finally {
    held?.release();
    if (held) await Promise.allSettled([held.done]);
    observations.finalUrl = page.url();
    writeFileSync(info.outputPath("terminal-signout.json"), JSON.stringify(observations, null, 2));
    await context.close();
    const api = await browser.newContext({ storageState: await sessionFor(browser, account) });
    for (const id of [bookId, importing].filter((id): id is string => !!id))
      await call(api.request, "DELETE", `/api/books/${id}`);
    await api.close();
  }
});
