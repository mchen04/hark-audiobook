import { expect, test, type APIRequestContext } from "@playwright/test";
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
    await expect
      .poll(
        async () => {
          const [row] = await sql()<{ pid: number }[]>`select pid from pg_stat_activity
        where ${blockerPid} = any(pg_blocking_pids(pid))`;
          writerPid = row?.pid ?? 0;
          return writerPid;
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);
  } catch (error) {
    release();
    await Promise.allSettled([barrier, response]);
    throw error;
  }
  return {
    writerPid,
    release,
    done: Promise.all([barrier, response]).then(([, result]) => result),
  };
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
      const [row] = await sql()<{ waiters: number }[]>`select count(*)::int as waiters
        from pg_stat_activity where ${held.writerPid} = any(pg_blocking_pids(pid))`;
      samples.push({
        atMs: performance.now() - started,
        waiters: row!.waiters,
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
    expect.soft(Math.max(...samples.map((row) => row.waiters))).toBe(0);

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
  page.on("pageerror", (error) => errors.push(error.name));
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
    reopened.on("pageerror", (error) => errors.push(error.name));
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
