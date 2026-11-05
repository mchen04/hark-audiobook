import { devices, expect, test, webkit, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  APP_ORIGIN,
  attachDriver,
  closeSql,
  commit,
  drainOutbox,
  goOffline,
  goOnline,
  openDevice,
  outbox,
  pull,
  replay,
  resetAccount,
  sharedSession,
  sql,
  type Account,
} from "./harness/app";
import { awaitSignInBudget } from "../shared/sign-in-budget";
import { buildDriverScript } from "./harness/driver-bundle";
import { readBookIds, readServerState } from "./harness/state";

const DEVICE = "device-durable-000001";
const DURATION_MS = 600_000;

let account: Account | null = null;

test.afterAll(async () => {
  await closeSql();
});

function importPayload(fingerprint: string, title: string) {
  return {
    fileName: encodeURIComponent("durable.mp3"),
    byteSize: 1_048_576,
    durationMs: DURATION_MS,
    fingerprint,
    fingerprintKind: "sha256-v1",
    title,
    author: "Durability Author",
    narrator: null,
    chapterDiagnostic: null,
    chapters: [{ position: 0, title: "Only", startMs: 0, endMs: DURATION_MS }],
  };
}

async function launch(userDataDir: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await webkit.launchPersistentContext(userDataDir, {
    ...devices["iPhone 15"],
    serviceWorkers: "allow",
  });
  const script = await buildDriverScript();
  await context.addInitScript(
    ([id, key]) => {
      try {
        localStorage.setItem(key as string, id as string);
      } catch {}
    },
    [DEVICE, "chapterline:device-id"] as const,
  );
  await context.addInitScript({ content: script });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

test("every queued mutation survives the app being closed and reopened", async ({ browser }) => {
  const session = await sharedSession(browser);
  account = session.account;
  await resetAccount(account.userId);

  const userDataDir = mkdtempSync(path.join(tmpdir(), "hark-sync-durable-"));
  let queuedBefore: Array<{ key: string; mutationId: string; kind: string }> = [];
  let sequenceBefore = 0;
  let bookId = "";
  let doomedId = "";

  try {
    const first = await launch(userDataDir);
    try {
      await awaitSignInBudget("sync");
      await first.page.goto(`${APP_ORIGIN}/login`, { waitUntil: "domcontentloaded" });
      await first.page.getByLabel("Email").fill(account.email);
      await first.page.getByLabel("Password").fill(account.password);
      await first.page.getByRole("button", { name: "Sign in" }).click();
      await first.page
        .waitForURL(/\/library/, { timeout: 60_000 })
        .catch(async (error: unknown) => {
          const message = await first.page
            .locator("body")
            .innerText()
            .catch(() => "");
          if (message.includes("Too many requests")) {
            throw new Error(
              "better-auth rate-limited this sign-in. That is the harness overspending the shared " +
                "window in tests/shared/sign-in-budget.ts, not a product failure.",
            );
          }
          throw error;
        });
      await first.page.waitForSelector("[data-launch-ready]", {
        state: "attached",
        timeout: 60_000,
      });
      await attachDriver(first.page, account, DEVICE);

      const keeper = "d".repeat(63) + "1";
      const doomed = "d".repeat(63) + "2";
      await commit(first.page, {
        kind: "import",
        fingerprint: keeper,
        payload: importPayload(keeper, "Durable Keeper"),
      });
      await commit(first.page, {
        kind: "import",
        fingerprint: doomed,
        payload: importPayload(doomed, "Durable Doomed"),
      });
      await drainOutbox(first.page);
      const ids = await readBookIds(account.userId);
      bookId = ids.get(keeper)!;
      doomedId = ids.get(doomed)!;
      expect(bookId && doomedId, "the durability subjects never reached the server").toBeTruthy();
      expect(await pull(first.page)).toBe("applied");

      await first.context.setOffline(true);
      const newFingerprint = "d".repeat(63) + "3";
      await commit(first.page, {
        kind: "import",
        fingerprint: newFingerprint,
        payload: importPayload(newFingerprint, "Queued While Offline"),
      });
      await commit(first.page, {
        kind: "rename",
        bookId,
        fields: { title: "Renamed While Offline" },
      });
      await commit(first.page, { kind: "archive", bookId, archived: true });
      await commit(first.page, {
        kind: "progress",
        bookId,
        positionMs: 123_000,
        playbackRate: 1,
        completed: false,
        eventOccurredAt: new Date().toISOString(),
      });
      await commit(first.page, {
        kind: "history",
        bookId,
        event: {
          action: "seek",
          positionMs: 123_000,
          previousPositionMs: 0,
          playbackRate: 1,
          description: "queued while offline",
          occurredAt: new Date().toISOString(),
        },
      });
      await commit(first.page, { kind: "delete", bookId: doomedId });

      queuedBefore = (await outbox(first.page))
        .map((row) => ({ key: row.key, mutationId: row.mutationId, kind: row.kind }))
        .sort((left, right) => left.key.localeCompare(right.key));
      expect(
        queuedBefore.map((row) => row.kind).sort(),
        "not every offline mutation was journalled, so the relaunch below would prove nothing",
      ).toStrictEqual(["archive", "delete", "history", "import", "metadata", "progress"]);

      sequenceBefore = await first.page.evaluate((id) => window.__harkSync.sequenceFor(id), bookId);
      expect(sequenceBefore, "no device sequence was claimed for the book").toBeGreaterThan(0);
    } finally {
      await first.context.close();
    }

    const second = await launch(userDataDir);
    try {
      await second.page.goto(`${APP_ORIGIN}/__hark_sync_probe__`, {
        waitUntil: "domcontentloaded",
      });
      await attachDriver(second.page, account, DEVICE);

      const queuedAfter = (await outbox(second.page))
        .map((row) => ({ key: row.key, mutationId: row.mutationId, kind: row.kind }))
        .sort((left, right) => left.key.localeCompare(right.key));

      expect(
        queuedAfter,
        "the outbox did not come through the relaunch intact. A row that vanished here is a " +
          "user write the server will never be told about.",
      ).toStrictEqual(queuedBefore);

      const sequenceAfter = await second.page.evaluate(
        (id) => window.__harkSync.sequenceFor(id),
        bookId,
      );
      expect(
        sequenceAfter,
        "the per-book device sequence was reset by the relaunch. Those high-water marks order " +
          "every future replay, and losing them lets a stale event overwrite a newer one " +
          "(design contract section 4).",
      ).toBeGreaterThanOrEqual(sequenceBefore);

      await second.page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
      await second.page.waitForSelector("[data-launch-ready]", {
        state: "attached",
        timeout: 60_000,
      });
      await attachDriver(second.page, account, DEVICE);
      await drainOutbox(second.page);
      expect(await pull(second.page)).toBe("applied");

      const server = await readServerState(account.userId);
      const keeper = server.booksByFingerprint.get("d".repeat(63) + "1");
      expect(keeper?.title, "the rename queued before the restart was lost").toBe(
        "Renamed While Offline",
      );
      expect(keeper?.archived, "the archive queued before the restart was lost").toBe(true);
      expect(
        server.progressByFingerprint.get("d".repeat(63) + "1")?.positionMs,
        "the progress queued before the restart was lost",
      ).toBe(123_000);
      expect(
        server.booksByFingerprint.has("d".repeat(63) + "3"),
        "the import queued before the restart was lost",
      ).toBe(true);
      expect(
        server.booksByFingerprint.has("d".repeat(63) + "2"),
        "the delete queued before the restart was lost",
      ).toBe(false);
      const [historyCount] = await sql()<{ total: number }[]>`
        SELECT count(*)::int AS total FROM playback_actions WHERE user_id = ${account.userId}
      `;
      expect(historyCount?.total, "the history event queued before the restart was lost").toBe(1);
    } finally {
      await second.context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("a replay that cannot reach the server leaves every row queued", async ({ browser }) => {
  const session = await sharedSession(browser);
  const { account: shared, storageState } = session;
  await resetAccount(shared.userId);

  const { context, page } = await openDevice(browser, "device-retain-0000001", storageState);
  try {
    await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await attachDriver(page, shared, "device-retain-0000001");

    const fingerprint = "e".repeat(63) + "1";
    await commit(page, {
      kind: "import",
      fingerprint,
      payload: importPayload(fingerprint, "Retention Subject"),
    });
    await drainOutbox(page);
    const bookId = (await readBookIds(shared.userId)).get(fingerprint);
    expect(bookId, "the retention subject never reached the server").toBeTruthy();

    await goOffline(context, page);
    await commit(page, { kind: "rename", bookId: bookId!, fields: { title: "Never Delivered" } });
    await commit(page, { kind: "archive", bookId: bookId!, archived: true });
    await commit(page, {
      kind: "progress",
      bookId: bookId!,
      positionMs: 77_000,
      playbackRate: 1,
      completed: false,
      eventOccurredAt: new Date().toISOString(),
    });
    const queued = (await outbox(page)).map((row) => row.mutationId).sort();
    expect(queued, "nothing was journalled while offline").toHaveLength(3);

    await replay(page);
    expect(
      (await outbox(page)).map((row) => row.mutationId).sort(),
      "a replay that never reached the server emptied the outbox. Those rows are the only " +
        "record of the user's writes and nothing else in the system holds them.",
    ).toStrictEqual(queued);

    const retained = await outbox(page);
    expect(retained.map((row) => row.kind).sort()).toStrictEqual([
      "archive",
      "metadata",
      "progress",
    ]);

    await goOnline(context, page);
    await drainOutbox(page);
    const server = await readServerState(shared.userId);
    expect(server.booksByFingerprint.get(fingerprint)).toMatchObject({
      title: "Never Delivered",
      archived: true,
    });
    expect(server.progressByFingerprint.get(fingerprint)?.positionMs).toBe(77_000);
  } finally {
    await context.close();
  }
});
