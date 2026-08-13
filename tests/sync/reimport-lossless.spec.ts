import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  APP_ORIGIN,
  attachDriver,
  closeSql,
  commit,
  createCollection,
  drainOutbox,
  evictAudio,
  goOnline,
  importThroughUi,
  mediaCacheEntries,
  mirror,
  openDevice,
  outbox,
  playable,
  pull,
  resetAccount,
  sharedSession,
  sql,
  type Account,
  type StorageState,
} from "./harness/app";
import { readServerState, toDeviceState } from "./harness/state";

/**
 * Design contract section 10: re-importing an evicted book must be LOSSLESS.
 *
 * The mechanism is the fingerprint. `media_assets` is unique on
 * (owner, fingerprintKind, fingerprint), a duplicate registration answers 409
 * with `existingBookId`, and `local-import.ts` reattaches the bytes to that
 * book. So the same MP3 chosen a second time must land on the SAME book, with
 * the position, chapters, tags and collection membership it already had — not a
 * second copy of the book and not a reset to zero.
 *
 * Everything here is end to end: the file goes through the real file input, the
 * real parser, the real registration route and the real media store. The audio
 * never leaves the device on that path.
 */

const FIXTURE = path.join(process.cwd(), "tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3");
const FIXTURE_TITLE = "iPhone Downloads Test";
const DEVICE = "device-reimport-00001";
const OFFLINE_DEVICE = "device-reimport-00002";
const DELETE_REIMPORT_DEVICE = "device-reimport-00003";
const STALE_ATTACH_DEVICE = "device-reimport-00004";
const CRASH_DELETE_DEVICE = "device-reimport-00005";
const SAVED_POSITION_MS = 4_500;

let session: { account: Account; storageState: StorageState } | null = null;

test.afterAll(async () => {
  await closeSql();
});

test("re-importing an evicted book reconnects to the same book and restores everything", async ({
  browser,
}) => {
  session ??= await sharedSession(browser);
  const { account, storageState } = session;
  await resetAccount(account.userId);

  const { context, page } = await openDevice(browser, DEVICE, storageState);
  try {
    await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await attachDriver(page, account, DEVICE);

    // ---------------------------------------------------------------- import
    const bytes = readFileSync(FIXTURE);
    await importThroughUi(page, path.basename(FIXTURE), bytes);
    await expect(page.getByRole("link", { name: FIXTURE_TITLE, exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await attachDriver(page, account, DEVICE);
    expect(await pull(page)).toBe("applied");

    const before = await readServerState(account.userId);
    expect(before.booksByFingerprint.size, "the import did not create exactly one book").toBe(1);
    const [fingerprint, originalRow] = [...before.booksByFingerprint.entries()][0]!;
    const bookId = originalRow.bookId;
    const chapterCount = originalRow.chapterCount;
    expect(chapterCount, "the import stored no chapters").toBeGreaterThan(0);

    // --------------------------------------------- everything worth losing
    const collectionId = await createCollection(page, "Re-import Shelf");
    await commit(page, { kind: "rename", bookId, fields: { tags: ["keepme", "second"] } });
    await commit(page, { kind: "collection", collectionId, bookId, include: true });
    await commit(page, {
      kind: "progress",
      bookId,
      positionMs: SAVED_POSITION_MS,
      playbackRate: 1.25,
      completed: false,
      eventOccurredAt: new Date().toISOString(),
    });
    await drainOutbox(page);
    expect(await pull(page)).toBe("applied");

    const armed = await readServerState(account.userId);
    expect([...(armed.tagsByFingerprint.get(fingerprint) || [])].sort()).toStrictEqual([
      "keepme",
      "second",
    ]);
    expect([...(armed.collectionMembers.get("Re-import Shelf") || [])]).toStrictEqual([
      fingerprint,
    ]);
    expect(armed.progressByFingerprint.get(fingerprint)?.positionMs).toBe(SAVED_POSITION_MS);

    // ----------------------------------------------------------- eviction
    const removed = await evictAudio(page);
    expect(removed.removedCaches.length).toBeGreaterThan(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await expect(
      page.locator(".book-item", { hasText: FIXTURE_TITLE }).getByText(/attach its original file/),
      "the evicted book does not tell the user to re-import it, so nothing here would be " +
        "testing the recovery the product actually offers",
    ).toBeVisible({ timeout: 30_000 });

    // ---------------------------------------------------------- re-import
    // The same bytes, chosen again. `local-import.ts` fingerprints them, the
    // route answers 409 with `existingBookId`, and the media reattaches.
    await importThroughUi(page, path.basename(FIXTURE), bytes);
    await expect(
      page
        .locator(".book-item", { hasText: FIXTURE_TITLE })
        .getByText(/^[\d.]+ (B|KB|MB|GB) on this device$/),
      "the re-import did not reattach the audio to this device",
    ).toBeVisible({ timeout: 60_000 });

    await attachDriver(page, account, DEVICE);
    expect(await pull(page)).toBe("applied");
    expect(await mediaCacheEntries(page)).toBeGreaterThan(0);

    // ------------------------------------------------------------ verdict
    const after = await readServerState(account.userId);

    expect(
      after.booksByFingerprint.size,
      "the re-import created a SECOND book. `media_assets` is unique on " +
        "(owner, fingerprintKind, fingerprint) and a duplicate registration must be treated as " +
        "a merge, never a new book.",
    ).toBe(1);
    expect(
      after.booksByFingerprint.get(fingerprint)?.bookId,
      "the re-imported file landed on a different book id, so every reference to the old one " +
        "(progress, tags, collections, history) is now orphaned",
    ).toBe(bookId);
    expect(
      after.booksByFingerprint.get(fingerprint)?.chapterCount,
      "the chapter list changed across the re-import",
    ).toBe(chapterCount);
    expect(
      after.progressByFingerprint.get(fingerprint)?.positionMs,
      "the saved position was reset by the re-import",
    ).toBe(SAVED_POSITION_MS);
    expect(
      [...(after.tagsByFingerprint.get(fingerprint) || [])].sort(),
      "the tags were lost across the re-import",
    ).toStrictEqual(["keepme", "second"]);
    expect(
      [...(after.collectionMembers.get("Re-import Shelf") || [])],
      "the collection membership was lost across the re-import",
    ).toStrictEqual([fingerprint]);

    // The database itself, with no room for a second row hiding behind a join.
    const [counts] = await sql()<{ books: number; assets: number }[]>`
      SELECT
        (SELECT count(*)::int FROM books WHERE owner_id = ${account.userId}) AS books,
        (SELECT count(*)::int FROM media_assets WHERE owner_id = ${account.userId}) AS assets
    `;
    expect(counts, "a duplicate row was created somewhere").toMatchObject({ books: 1, assets: 1 });

    // And the device agrees, so the user sees one book with its place kept.
    const device = toDeviceState(await mirror(page));
    expect(device.booksByFingerprint.size).toBe(1);
    expect(device.progressByFingerprint.get(fingerprint)?.positionMs).toBe(SAVED_POSITION_MS);
    expect([...(device.tagsByFingerprint.get(fingerprint) || [])].sort()).toStrictEqual([
      "keepme",
      "second",
    ]);
    expect([...(device.collectionMembers.get("Re-import Shelf") || [])]).toStrictEqual([
      fingerprint,
    ]);
    // The download record the library reads for "is this playable here" is back.
    expect(
      (await mirror(page)).downloads.map((record) => record.bookId),
      "the re-import did not restore this device's download record",
    ).toStrictEqual([bookId]);
  } finally {
    await context.close();
  }
});

test("re-importing while its predecessor delete is in flight keeps the replacement audio", async ({
  browser,
}) => {
  session ??= await sharedSession(browser);
  const { account, storageState } = session;
  await resetAccount(account.userId);

  const { context, page } = await openDevice(browser, DELETE_REIMPORT_DEVICE, storageState);
  try {
    await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await attachDriver(page, account, DELETE_REIMPORT_DEVICE);

    const bytes = readFileSync(FIXTURE);
    await importThroughUi(page, path.basename(FIXTURE), bytes);
    const originalCard = page.getByRole("link", { name: FIXTURE_TITLE, exact: true });
    await expect(originalCard).toBeVisible({ timeout: 60_000 });
    await drainOutbox(page);
    expect(await pull(page)).toBe("applied");
    const initial = await readServerState(account.userId);
    expect(initial.booksByFingerprint.size).toBe(1);
    const [fingerprint, original] = [...initial.booksByFingerprint.entries()][0]!;

    // Hold the shipping replay request after it has started. The old book is
    // still present on the server, so an unguarded live registration gets a
    // 409 for exactly the id this DELETE will remove.
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      let releaseDelete!: () => void;
      const deleteGate = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      const state = {
        deleteStarted: false,
        deleteFinished: false,
        registrationPosts: 0,
        releaseDelete: () => releaseDelete(),
      };
      const targetWindow = window as typeof window & { __heldBookDelete?: typeof state };
      targetWindow.__heldBookDelete = state;
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        const rawUrl = input instanceof Request ? input.url : String(input);
        const pathname = new URL(rawUrl, window.location.href).pathname;
        if (method === "POST" && pathname === "/api/books/local") {
          state.registrationPosts += 1;
        }
        if (method === "DELETE" && pathname.startsWith("/api/books/") && !state.deleteStarted) {
          state.deleteStarted = true;
          await deleteGate;
          const response = await originalFetch(input, init);
          state.deleteFinished = true;
          return response;
        }
        return originalFetch(input, init);
      };
    });

    await originalCard.click();
    await page.waitForURL(/\/books\//, { timeout: 30_000 });
    await page.getByRole("button", { name: "Details" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Delete this book" }).click();
    await dialog.getByRole("button", { name: "Tap again to permanently delete" }).click();
    await page.waitForURL(/\/library$/, { timeout: 30_000 });
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as typeof window & {
                  __heldBookDelete?: { deleteStarted: boolean };
                }
              ).__heldBookDelete?.deleteStarted ?? false,
          ),
        { timeout: 30_000, message: "the queued DELETE never reached the held fetch" },
      )
      .toBe(true);

    await importThroughUi(page, path.basename(FIXTURE), bytes);
    await expect
      .poll(async () => (await mirror(page)).downloads.map((record) => record.bookId), {
        timeout: 60_000,
        message: "the replacement bytes were not saved while DELETE remained in flight",
      })
      .toHaveLength(1);

    const beforeRelease = await mirror(page);
    expect(beforeRelease.downloads[0]?.bookId).not.toBe(original.bookId);
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              __heldBookDelete?: { registrationPosts: number };
            }
          ).__heldBookDelete?.registrationPosts ?? -1,
      ),
      "live registration bypassed the queued same-rendition delete and could accept its old id",
    ).toBe(0);
    expect((await outbox(page)).map((row) => row.kind).sort()).toStrictEqual(["delete", "import"]);

    await page.evaluate(() => {
      (
        window as typeof window & {
          __heldBookDelete?: { releaseDelete: () => void };
        }
      ).__heldBookDelete?.releaseDelete();
    });
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as typeof window & {
                  __heldBookDelete?: { deleteFinished: boolean };
                }
              ).__heldBookDelete?.deleteFinished ?? false,
          ),
        { timeout: 30_000, message: "the held DELETE did not settle after release" },
      )
      .toBe(true);
    await drainOutbox(page);
    expect(await pull(page)).toBe("applied");

    const server = await readServerState(account.userId);
    expect(server.booksByFingerprint.size).toBe(1);
    const replacementId = server.booksByFingerprint.get(fingerprint)?.bookId;
    expect(replacementId).toBeTruthy();
    expect(replacementId).not.toBe(original.bookId);
    const local = await mirror(page);
    expect(local.downloads).toStrictEqual([
      {
        bookId: replacementId,
        byteSize: bytes.byteLength,
        mediaMissingSince: null,
      },
    ]);
    expect(await playable(page, replacementId!)).toStrictEqual({
      record: true,
      media: true,
      byteSize: bytes.byteLength,
    });
    expect(local.books.filter((book) => book.media?.fingerprint === fingerprint)).toHaveLength(1);
    await expect(page.locator("article.book-item", { hasText: FIXTURE_TITLE })).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("a stale player cannot attach audio after another tab permanently deletes the book", async ({
  browser,
}) => {
  session ??= await sharedSession(browser);
  const { account, storageState } = session;
  await resetAccount(account.userId);

  const { context, page: stalePlayer } = await openDevice(
    browser,
    STALE_ATTACH_DEVICE,
    storageState,
  );
  try {
    await stalePlayer.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await stalePlayer.waitForSelector("[data-launch-ready]", {
      state: "attached",
      timeout: 60_000,
    });
    await attachDriver(stalePlayer, account, STALE_ATTACH_DEVICE);

    const bytes = readFileSync(FIXTURE);
    await importThroughUi(stalePlayer, path.basename(FIXTURE), bytes);
    await expect(stalePlayer.getByRole("link", { name: FIXTURE_TITLE, exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await drainOutbox(stalePlayer);
    expect(await pull(stalePlayer)).toBe("applied");
    const initial = await readServerState(account.userId);
    const bookId = [...initial.booksByFingerprint.values()][0]?.bookId;
    expect(bookId).toBeTruthy();

    expect((await evictAudio(stalePlayer)).removedCaches.length).toBeGreaterThan(0);
    await stalePlayer.goto(`${APP_ORIGIN}/books/${bookId}`, { waitUntil: "domcontentloaded" });
    await expect(stalePlayer.getByRole("button", { name: "Attach MP3" })).toBeVisible({
      timeout: 60_000,
    });

    const deletingTab = await context.newPage();
    await deletingTab.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await deletingTab.waitForSelector("[data-launch-ready]", {
      state: "attached",
      timeout: 60_000,
    });
    await deletingTab.getByRole("link", { name: FIXTURE_TITLE, exact: true }).click();
    await deletingTab.waitForURL(/\/books\//, { timeout: 30_000 });
    await deletingTab.getByRole("button", { name: "Delete this book" }).click();
    await deletingTab.getByRole("button", { name: "Tap again to permanently delete" }).click();
    await deletingTab.waitForURL(/\/library$/, { timeout: 30_000 });
    await expect(deletingTab.locator("article.book-item")).toHaveCount(0);

    await stalePlayer.setInputFiles('input[aria-label^="Attach "]', {
      name: path.basename(FIXTURE),
      mimeType: "audio/mpeg",
      buffer: bytes,
    });
    await expect(
      stalePlayer.getByText("This book was deleted, so its audio was not saved."),
    ).toBeVisible({
      timeout: 30_000,
    });
    await attachDriver(stalePlayer, account, STALE_ATTACH_DEVICE);
    expect(await playable(stalePlayer, bookId!)).toStrictEqual({
      record: false,
      media: false,
      byteSize: null,
    });
    expect((await mirror(stalePlayer)).downloads).toStrictEqual([]);

    await stalePlayer.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await stalePlayer.waitForSelector("[data-launch-ready]", {
      state: "attached",
      timeout: 60_000,
    });
    await expect(stalePlayer.locator("article.book-item")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a tab closed while permanent cleanup waits cannot resurrect local media", async ({
  browser,
}) => {
  session ??= await sharedSession(browser);
  const { account, storageState } = session;
  await resetAccount(account.userId);

  const { context, page: deletingTab } = await openDevice(
    browser,
    CRASH_DELETE_DEVICE,
    storageState,
  );
  try {
    await deletingTab.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await deletingTab.waitForSelector("[data-launch-ready]", {
      state: "attached",
      timeout: 60_000,
    });
    await attachDriver(deletingTab, account, CRASH_DELETE_DEVICE);

    const bytes = readFileSync(FIXTURE);
    await importThroughUi(deletingTab, path.basename(FIXTURE), bytes);
    await expect(deletingTab.getByRole("link", { name: FIXTURE_TITLE, exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await drainOutbox(deletingTab);
    expect(await pull(deletingTab)).toBe("applied");
    const server = await readServerState(account.userId);
    const bookId = [...server.booksByFingerprint.values()][0]?.bookId;
    expect(bookId).toBeTruthy();

    const before = await deletionState(deletingTab, account.userId, bookId!);
    expect(before.download?.offlineMediaUrl).toBeTruthy();
    const lockName = `chapterline-media:${account.userId}:${bookId}`;

    const holder = await context.newPage();
    await holder.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await holder.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await attachDriver(holder, account, CRASH_DELETE_DEVICE);
    await holder.evaluate((name) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const state = {
        acquired: false,
        release: () => release(),
      };
      const target = window as typeof window & { __heldMediaLock?: typeof state };
      target.__heldMediaLock = state;
      void navigator.locks.request(name, async () => {
        state.acquired = true;
        await held;
      });
    }, lockName);
    await holder.waitForFunction(
      () =>
        (
          window as typeof window & {
            __heldMediaLock?: { acquired: boolean };
          }
        ).__heldMediaLock?.acquired === true,
    );

    await deletingTab.getByRole("link", { name: FIXTURE_TITLE, exact: true }).click();
    await deletingTab.waitForURL(/\/books\//, { timeout: 30_000 });
    await deletingTab.getByRole("button", { name: "Details" }).click();
    const dialog = deletingTab.getByRole("dialog");
    await dialog.getByRole("button", { name: "Delete this book" }).click();
    await dialog.getByRole("button", { name: "Tap again to permanently delete" }).click();

    await expect
      .poll(
        async () => {
          const state = await deletionState(holder, account.userId, bookId!);
          return {
            download: !!state.download,
            mirrorBook: state.mirrorBook,
            permanentFence: state.deletion?.clearPlaybackHistory === true,
            cleanupComplete: state.deletion?.completedAt !== undefined,
          };
        },
        { timeout: 30_000, message: "deletion did not fence media before waiting on the lock" },
      )
      .toStrictEqual({
        download: true,
        mirrorBook: false,
        permanentFence: true,
        cleanupComplete: false,
      });

    // This is the crash window: the delete intent and mirror removal are both
    // durable, but byte cleanup cannot enter its lock. Closing this tab must
    // leave enough journal state for another launch to finish the operation.
    await deletingTab.close();
    await holder.evaluate(() => {
      (
        window as typeof window & {
          __heldMediaLock?: { release: () => void };
        }
      ).__heldMediaLock?.release();
    });
    await holder.reload({ waitUntil: "domcontentloaded" });
    await holder.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await attachDriver(holder, account, CRASH_DELETE_DEVICE);

    await expect(holder.locator("article.book-item", { hasText: FIXTURE_TITLE })).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const state = await deletionState(holder, account.userId, bookId!);
          return {
            download: !!state.download,
            mirrorBook: state.mirrorBook,
            permanentFence: state.deletion?.clearPlaybackHistory === true,
            cleanupComplete: state.deletion?.completedAt !== undefined,
          };
        },
        { timeout: 30_000, message: "a relaunched tab did not finish the journaled cleanup" },
      )
      .toStrictEqual({
        download: false,
        mirrorBook: false,
        permanentFence: true,
        cleanupComplete: true,
      });
    expect(await playable(holder, bookId!)).toStrictEqual({
      record: false,
      media: false,
      byteSize: null,
    });
    expect(await mediaCacheEntries(holder)).toBe(0);

    await drainOutbox(holder);
    expect(await pull(holder)).toBe("applied");
    expect((await readServerState(account.userId)).booksByFingerprint.size).toBe(0);
  } finally {
    await context.close();
  }
});

async function deletionState(page: Page, userId: string, bookId: string) {
  return page.evaluate(
    async ({ userId: ownerId, bookId: targetBookId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("chapterline-offline-v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const key = `${ownerId}:${targetBookId}`;
        const transaction = db.transaction(["downloads", "deletions", "books"]);
        const read = <T>(request: IDBRequest<T>) =>
          new Promise<T>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const [download, deletion, mirrorBook] = await Promise.all([
          read<{ offlineMediaUrl: string } | undefined>(
            transaction.objectStore("downloads").get(key),
          ),
          read<{ clearPlaybackHistory?: boolean; completedAt?: number } | undefined>(
            transaction.objectStore("deletions").get(key),
          ),
          read<unknown>(transaction.objectStore("books").get(key)),
        ]);
        return { download, deletion, mirrorBook: mirrorBook !== undefined };
      } finally {
        db.close();
      }
    },
    { userId, bookId },
  );
}

/**
 * Eviction recovery when the network cannot serve the app's own code.
 *
 * Section 10's recovery is "re-pick the file", and the import path reaches its
 * MP3 parser and its hasher through lazy `import()` -- the parser through a
 * SECOND lazy import inside `music-metadata`, and the fingerprint through a
 * Worker whose script no `import()` can reach at all. None of those is
 * referenced by the cached shell, so nothing precached them, and an import with
 * no network used to die on a chunk fetch with the audiobook one step away.
 * That is what this guards: no `/_next/` request can be answered, and the
 * import must still finish from what was warmed after launch.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is drive the fully-offline variant, where the
 * registration POST also fails and the merge only becomes knowable when the
 * queued row replays into a 409. That is a limit of the harness rather than a
 * gap in the product, and both halves were measured rather than assumed:
 *
 *  - `context.route(...).abort()` cannot stop that POST. A service-worker
 *    controlled page reissues an `/api` fetch outside Playwright's interception
 *    and it reaches the server anyway -- the import came back with the canonical
 *    id and never queued.
 *  - `context.setOffline(true)` does stop it, but WebKit then fails EVERY
 *    resource load with "WebKit encountered an internal error", including ones
 *    the service worker would answer from Cache Storage. The import never
 *    reaches the code under test, and the failure belongs to the browser.
 *
 * So the replay-time merge is proved where it can be proved honestly: at unit
 * level in `src/lib/offline-sync.test.ts`, against the real outbox, the real
 * replay and a real 409 body; and in the fuzz, which generates
 * duplicate-fingerprint imports and asserts one book per fingerprint on both
 * sides. If Playwright's WebKit gains a working offline mode, this is the spec
 * to extend -- do not weaken it in the meantime.
 */
test("an evicted book is recovered by re-import when the app chunks cannot be fetched", async ({
  browser,
}) => {
  session ??= await sharedSession(browser);
  const { account, storageState } = session;
  await resetAccount(account.userId);

  const { context, page } = await openDevice(browser, OFFLINE_DEVICE, storageState);
  // Whatever the browser complains about, and every request that could not be
  // answered. An import that dies with the network down dies for a *reason* —
  // a chunk nobody warmed, a worker script, a fetch it should not have made —
  // and without these the only symptom is "no book appeared", which reads like
  // a merge bug and is not one. Three separate caching faults hid behind that
  // sentence before this was collected here.
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 220));
  });
  page.on("pageerror", (error) => consoleErrors.push(`uncaught: ${error.message.slice(0, 220)}`));
  page.on("requestfailed", (request) => failedRequests.push(new URL(request.url()).pathname));

  /** Everything known about why the import did not finish, in one message. */
  async function importDiagnosis(): Promise<string> {
    const shown = await page
      .locator(".form-error")
      .allInnerTexts()
      .catch(() => [] as string[]);
    const unique = [...new Set(failedRequests)];
    const chunks = unique.filter((path) => path.startsWith("/_next/"));
    const others = unique.filter((path) => !path.startsWith("/_next/"));
    return [
      `the app showed: ${shown.join(" | ") || "(no error surfaced to the user)"}`,
      `console: ${consoleErrors.slice(-6).join(" | ") || "(nothing)"}`,
      `unanswered chunk requests: ${chunks.join(", ") || "(none)"}`,
      `unanswered other requests: ${others.join(", ") || "(none)"}`,
      "A /_next/ entry is the smoking gun: something the import needs is lazily imported and " +
        "was not resolved before the network went away, so warm it in " +
        "`pwa-register.tsx#warmImportChunks`. `/api/sync/pull` and `/api/books/local` are " +
        "SUPPOSED to be in the other list — the queued registration is the whole point.",
    ].join("\n            ");
  }

  try {
    await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await attachDriver(page, account, OFFLINE_DEVICE);

    // ---------------------------------------------------------------- import
    const bytes = readFileSync(FIXTURE);
    await importThroughUi(page, path.basename(FIXTURE), bytes);
    await expect(page.getByRole("link", { name: FIXTURE_TITLE, exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await attachDriver(page, account, OFFLINE_DEVICE);
    expect(await pull(page)).toBe("applied");

    const before = await readServerState(account.userId);
    expect(before.booksByFingerprint.size, "the import did not create exactly one book").toBe(1);
    const [fingerprint, originalRow] = [...before.booksByFingerprint.entries()][0]!;
    const bookId = originalRow.bookId;
    const chapterCount = originalRow.chapterCount;
    expect(chapterCount, "the import stored no chapters").toBeGreaterThan(0);

    // --------------------------------------------- everything worth losing
    const collectionId = await createCollection(page, "Offline Re-import Shelf");
    await commit(page, { kind: "rename", bookId, fields: { tags: ["keepme", "second"] } });
    await commit(page, { kind: "collection", collectionId, bookId, include: true });
    await commit(page, {
      kind: "progress",
      bookId,
      positionMs: SAVED_POSITION_MS,
      playbackRate: 1.25,
      completed: false,
      eventOccurredAt: new Date().toISOString(),
    });
    await drainOutbox(page);
    expect(await pull(page)).toBe("applied");

    // ----------------------------------------------------------- eviction
    const removed = await evictAudio(page);
    expect(removed.removedCaches.length).toBeGreaterThan(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await expect(
      page.locator(".book-item", { hasText: FIXTURE_TITLE }).getByText(/attach its original file/),
      "the evicted book does not tell the user to re-import it, so nothing here would be " +
        "testing the recovery the product actually offers",
    ).toBeVisible({ timeout: 30_000 });
    await attachDriver(page, account, OFFLINE_DEVICE);
    expect(
      (await playable(page, bookId)).media,
      "the eviction left the audio in place, so the re-import below recovers nothing",
    ).toBe(false);

    // ------------------------------------------------ re-import, offline
    // The network really goes away here, and that is only survivable because
    // `PwaRegister` pulls the import path's lazy chunks in after every launch
    // paints. Wait for that to finish, and assert it happened: if it silently
    // stopped, the import below would fail on a chunk fetch and this test would
    // report a merge bug that is really a caching one.
    await page.waitForSelector("[data-import-ready]", { state: "attached", timeout: 30_000 });

    // Everything the app might still fetch OF ITSELF is now gone: a chunk asked
    // for from here can come from Cache Storage or not at all. The fingerprint
    // worker's script is one of them, and it is unreachable by any warm — a
    // Worker URL is not a module import — so `fingerprintMedia` hashes inline
    // instead, which is the whole reason that fallback exists.
    await context.route("**/_next/**", (route) => route.abort());
    await importThroughUi(page, path.basename(FIXTURE), bytes);
    // The bytes are on the device again long before the server knows, so this
    // waits for the AUDIO, not for anything on the network.
    //
    // It used to wait for a download record under a book id that was not there
    // before the re-import. That only ever fired because the eviction had
    // DELETED this book's record — and deleting it on a missed `cache.match`
    // was a data-loss one-way door (`library.ts#reconcileOfflineRecord`). The
    // record now survives the eviction, marked "not on this device", so no new
    // id can appear and that probe could only time out. Waiting on the bytes
    // themselves is what the sentence meant in the first place, and it is
    // strictly more than a row appearing.
    try {
      await expect
        .poll(async () => (await playable(page, bookId)).media, { timeout: 120_000 })
        .toBe(true);
    } catch {
      // Re-thrown with the evidence attached, because a bare timeout here has
      // already cost three rounds of guessing at which resource the import was
      // waiting for.
      throw new Error(
        `the offline import never stored the audio on this device.\n            ${await importDiagnosis()}`,
      );
    }
    // The registration POST is NOT blocked here — see the note above the test —
    // so the server names the book during the import, exactly as it does online,
    // and the recovered audio is filed under the id the book already had. What
    // this proves is that the import completed at all with no network available
    // for the app's own code.
    expect(
      (await mirror(page)).downloads.map((row) => row.bookId).filter((id) => id !== bookId),
      "the recovered audio was filed under a new id instead of the book it belongs to",
    ).toStrictEqual([]);

    // -------------------------------------------------------- reconnect
    await context.unroute("**/_next/**");
    await goOnline(context, page);
    await drainOutbox(page);
    expect(await pull(page)).toBe("applied");

    // ---------------------------------------------------------- verdict
    const after = await readServerState(account.userId);
    expect(
      after.bookRowsByFingerprint.get(fingerprint)?.length,
      "the offline re-import created a SECOND book on the server",
    ).toBe(1);
    expect(
      after.booksByFingerprint.get(fingerprint)?.bookId,
      "the offline re-import landed on a different book id, so every reference to the old one " +
        "(progress, tags, collections, history) is now orphaned",
    ).toBe(bookId);
    expect(
      after.booksByFingerprint.get(fingerprint)?.chapterCount,
      "the chapter list changed across the offline re-import",
    ).toBe(chapterCount);
    expect(
      after.progressByFingerprint.get(fingerprint)?.positionMs,
      "the saved position was reset by the offline re-import",
    ).toBe(SAVED_POSITION_MS);
    expect(
      [...(after.tagsByFingerprint.get(fingerprint) || [])].sort(),
      "the tags were lost across the offline re-import",
    ).toStrictEqual(["keepme", "second"]);
    expect(
      [...(after.collectionMembers.get("Offline Re-import Shelf") || [])],
      "the collection membership was lost across the offline re-import",
    ).toStrictEqual([fingerprint]);

    const [counts] = await sql()<{ books: number; assets: number }[]>`
      SELECT
        (SELECT count(*)::int FROM books WHERE owner_id = ${account.userId}) AS books,
        (SELECT count(*)::int FROM media_assets WHERE owner_id = ${account.userId}) AS assets
    `;
    expect(counts, "a duplicate row was created somewhere").toMatchObject({ books: 1, assets: 1 });

    // The device: ONE book, and the audio filed under the id the server kept.
    const device = toDeviceState(await mirror(page));
    expect(device.bookRowsByFingerprint.get(fingerprint)?.length).toBe(1);
    expect(
      device.downloadedBookIds,
      "this device holds the audio twice, or under an id the server does not have",
    ).toStrictEqual([bookId]);
    expect(
      device.orphanedDownloadIds,
      "the audio is filed under a book id no pull will ever mention: a phantom second copy of " +
        "the same audiobook, playable here and invisible on every other device",
    ).toStrictEqual([]);
    expect(device.progressByFingerprint.get(fingerprint)?.positionMs).toBe(SAVED_POSITION_MS);
    expect([...(device.tagsByFingerprint.get(fingerprint) || [])].sort()).toStrictEqual([
      "keepme",
      "second",
    ]);

    // And it still plays: the record the gate reads, and the bytes it names.
    expect(
      await playable(page, bookId),
      "the merge left the book unplayable — the audio it moved is the only copy in existence",
    ).toMatchObject({ record: true, media: true });
    expect(await mediaCacheEntries(page)).toBeGreaterThan(0);

    // Finally, what the user actually sees on the next launch.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await expect(
      page.locator(".book-item", { hasText: FIXTURE_TITLE }),
      "the library lists the same audiobook more than once",
    ).toHaveCount(1);
    await expect(
      page
        .locator(".book-item", { hasText: FIXTURE_TITLE })
        .getByText(/^[\d.]+ (B|KB|MB|GB) on this device$/),
      "the surviving row does not have the audio",
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await context.close();
  }
});
