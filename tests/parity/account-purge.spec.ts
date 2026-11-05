import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ACCOUNT_A,
  ACCOUNT_B,
  apiCall,
  endSessionWithoutPurge,
  ensureAccount,
  importThroughUi,
  network,
  openDevice,
  resetAccount,
  signInThroughUi,
  signOutThroughUi,
  sql,
  warmUp,
  type Account,
  type Device,
} from "./harness/app";
import { bookBuffer, SEED_BOOKS } from "./harness/library-seed";
import type { HeldNetworkResponse } from "./harness/network";
import {
  accountBearingPageEntries,
  mediaEntries,
  readDeviceStorage,
  readLibrary,
  residueOf,
  type DeviceStorage,
} from "./harness/snapshot";

const FIXTURE_DIR = path.join(process.cwd(), "tests/fixtures");
const TRANSCRIPT_FIXTURE = path.join(FIXTURE_DIR, "transcripts/tiny-book.mp3");

const KEPT_BOOK = SEED_BOOKS[0]!;
const DROPPED_BOOK = SEED_BOOKS[1]!;
const TRANSCRIPT_BOOK_TITLE = "Tiny Fixture Book";

const STORES_THAT_MUST_HOLD_A = [
  "chapterline-offline-v1/books",
  "chapterline-offline-v1/chapters",
  "chapterline-offline-v1/playbackStates",
  "chapterline-offline-v1/tags",
  "chapterline-offline-v1/bookTags",
  "chapterline-offline-v1/collections",
  "chapterline-offline-v1/collectionBooks",
  "chapterline-offline-v1/preferences",
  "chapterline-offline-v1/listeningSessions",
  "chapterline-offline-v1/syncMeta",
  "chapterline-offline-v1/downloads",
  "chapterline-offline-v1/transcripts",
  "chapterline-offline-v1/deletions",
  "chapterline-offline-v1/cacheEntries",
  "chapterline-sync-v1/mutations",
  "hark-playback-history-v1/actions",
] as const;

let accountA: Account;
let accountB: Account;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  accountA = await ensureAccount(browser, ACCOUNT_A);
  accountB = await ensureAccount(browser, ACCOUNT_B);
});

test.afterAll(async () => {
  const net = await network();
  net.restore();
});

async function seedAccountA(page: Page, origin: string, account: Account): Promise<string> {
  await importThroughUi(page, "purge-kept.mp3", bookBuffer(KEPT_BOOK, 0));
  await expect(page.getByRole("link", { name: KEPT_BOOK.title, exact: true })).toBeVisible({
    timeout: 60_000,
  });

  await importThroughUi(page, "purge-transcript.mp3", readFileSync(TRANSCRIPT_FIXTURE));
  await expect(page.getByRole("link", { name: TRANSCRIPT_BOOK_TITLE, exact: true })).toBeVisible({
    timeout: 60_000,
  });

  await importThroughUi(page, "purge-dropped.mp3", bookBuffer(DROPPED_BOOK, 1));
  await expect(page.getByRole("link", { name: DROPPED_BOOK.title, exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const libraryViewport = page.viewportSize()!;
  await page.getByRole("button", { name: "List view" }).click();
  await page.setViewportSize(libraryViewport);
  await page
    .locator("article.book-item", { hasText: DROPPED_BOOK.title })
    .getByRole("button", { name: `Remove download of ${DROPPED_BOOK.title}` })
    .click();
  await expect(
    page
      .locator("article.book-item", { hasText: DROPPED_BOOK.title })
      .getByText("Not on this device — attach its original file to listen", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });

  const listed = await apiCall(page, "GET", "/api/books?status=all");
  expect(listed.status).toBe(200);
  const books = (listed.body as { books: Array<{ id: string; title: string }> }).books;
  const keptId = books.find((book) => book.title === KEPT_BOOK.title)?.id;
  expect(keptId, "the seeded book was never registered").toBeTruthy();

  expect((await apiCall(page, "PATCH", `/api/books/${keptId}`, { tags: ["private"] })).status).toBe(
    200,
  );
  expect((await apiCall(page, "PATCH", "/api/preferences", { skipBackMs: 15_000 })).status).toBe(
    200,
  );
  const collection = await apiCall(page, "POST", "/api/collections", { name: "A private shelf" });
  expect(collection.status).toBe(201);
  const collectionId = (collection.body as { collection: { id: string } }).collection.id;
  expect(
    (
      await apiCall(page, "PATCH", `/api/collections/${collectionId}`, {
        bookId: keptId,
        include: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await apiCall(page, "PATCH", `/api/books/${keptId}/progress`, {
        deviceId: "purge-device-00000001",
        deviceSequence: 1,
        positionMs: 5_000,
        playbackRate: 1,
        completed: false,
        eventOccurredAt: new Date().toISOString(),
      })
    ).status,
  ).toBeLessThan(300);
  expect(
    (
      await apiCall(page, "POST", `/api/books/${keptId}/sessions`, {
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        endedAt: new Date().toISOString(),
        startPositionMs: 0,
        endPositionMs: 5_000,
      })
    ).status,
  ).toBeLessThan(300);

  await page.goto(`${origin}/books/${keptId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: KEPT_BOOK.title })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("slider", { name: "Audiobook position" }).fill("3000");
  await page.getByRole("button", { name: "Pause" }).click();

  await page.goto(`${origin}/library`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  await page.waitForTimeout(2_000);

  const queued = await page.evaluate(
    async ([userId, bookId]) => {
      window.__harkSync.configure(userId as string, "purge-device-00000001");
      return window.__harkSync.commit({
        kind: "progress",
        bookId: bookId as string,
        positionMs: 7_000,
        playbackRate: 1,
        completed: false,
        eventOccurredAt: new Date().toISOString(),
      });
    },
    [account.userId, keptId!] as const,
  );
  expect(queued.mutationId, "no mutation was journaled into the outbox").toBeTruthy();
  return keptId!;
}

function expectAccountAIsOnTheDevice(storage: DeviceStorage, account: Account): void {
  const empty = STORES_THAT_MUST_HOLD_A.filter(
    (store) => (storage.stores[store]?.ownedByTarget ?? 0) === 0,
  );
  expect(
    empty,
    "these stores hold nothing for account A, so a purge assertion against them would pass " +
      "whether or not the purge ran. The seed is broken, not the product.",
  ).toStrictEqual([]);
  expect(mediaEntries(storage).length, "no audio was stored for account A").toBeGreaterThan(0);
  expect(storage.activeUser, "the device is not signed into account A").toBe(account.userId);
  expect(
    storage.localStorageMentioningTarget.length,
    "no localStorage key names account A",
  ).toBeGreaterThan(0);
}

async function expectNothingOfAccountARemains(
  page: Page,
  account: Account,
  incoming: Account | null,
): Promise<DeviceStorage> {
  await expect
    .poll(async () => residueOf(await readDeviceStorage(page, account.userId)), {
      timeout: 45_000,
      message:
        "account A's data is still on this device after another account signed in. " +
        "Account isolation: a mirrored row, cached page or downloaded file from " +
        "one account must never be readable by another.",
    })
    .toStrictEqual([]);

  const after = await readDeviceStorage(page, account.userId, account.email);
  expect(
    mediaEntries(after),
    "account A's audio is still in Cache Storage after the switch",
  ).toStrictEqual([]);
  expect(
    accountBearingPageEntries(after),
    "an account-bearing page is still cached after the switch; only the user-agnostic shell " +
      "of section 8 may survive one",
  ).toStrictEqual([]);
  expect(
    after.shellBodiesMentioningTarget,
    "a cached shell document still contains account A's id or email in its bytes. The shell is " +
      "only safe to keep across accounts because it renders no identity; if it does, it must be " +
      "purged like any other page",
  ).toStrictEqual([]);
  expect(
    after.localStorageMentioningTarget,
    "a localStorage key still names account A after the switch",
  ).toStrictEqual([]);
  for (const store of ["chapterline-sync-v1/sequences", "hark-playback-history-v1/sequences"]) {
    const dump = after.stores[store];
    console.log(`[parity] ${store} after the switch: ${dump?.count ?? 0} row(s) retained`);
    expect(
      dump?.mentionsTarget ?? 0,
      `${store} still holds a record naming account A after the switch`,
    ).toBe(0);
  }
  expect(
    after.activeUser,
    incoming
      ? "the device did not move to the incoming account"
      : "the device still says it belongs to the account that signed out",
  ).toBe(incoming ? incoming.userId : null);
  return after;
}

async function expectLibraryShowsNothingOfA(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/library`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  const snapshot = await readLibrary(page);
  expect(
    snapshot.launchReady,
    "the incoming account did not reach the genuine empty-library state",
  ).toBe("empty");
  expect(
    snapshot.books.map((book) => book.title),
    "the incoming account can still see the previous one's books",
  ).toStrictEqual([]);
}

async function signOutAndReportLostWrites(page: Page): Promise<void> {
  await signOutThroughUi(page).catch(async (error: unknown) => {
    const warning = await page
      .getByRole("alert")
      .first()
      .innerText()
      .catch(() => "");
    if (!warning) throw error;
    throw new Error(
      `sign-out stopped to report writes it could not deliver: ${warning}. ` +
        "Durable intent: a queued mutation is a user write that exists nowhere " +
        "else, and signing out is not allowed to be what destroys it.",
    );
  });
}

test("signing out leaves nothing of the account on the device, with nobody signed in", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await resetAccount(accountA.userId);
  const device: Device = await openDevice(browser, {
    withDriver: true,
    deviceId: "purge-device-00000001",
  });
  try {
    await signInThroughUi(device.page, accountA);
    await warmUp(device.page);
    const keptId = await seedAccountA(device.page, device.origin, accountA);

    const renamed = `Renamed before signing out ${Date.now()}`;
    await device.page.evaluate(
      async ([userId, bookId, title]) => {
        window.__harkSync.configure(userId as string, "purge-device-00000001");
        await window.__harkSync.commit({
          kind: "rename",
          bookId: bookId as string,
          fields: { title: title as string },
        });
      },
      [accountA.userId, keptId, renamed] as const,
    );

    const before = await readDeviceStorage(device.page, accountA.userId);
    expectAccountAIsOnTheDevice(before, accountA);

    await signOutAndReportLostWrites(device.page);

    await expectNothingOfAccountARemains(device.page, accountA, null);

    const [book] = await sql()<{ title: string }[]>`
      SELECT title FROM books WHERE id = ${keptId}::uuid
    `;
    expect(
      book?.title,
      "the edit queued before signing out never reached the server, and the sign-out purge " +
        "deleted the only copy of it.",
    ).toBe(renamed);
  } finally {
    await device.context.close();
  }
});

test("signing out and signing another account in leaves nothing of the first readable", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await resetAccount(accountA.userId);
  await resetAccount(accountB.userId);
  const device: Device = await openDevice(browser, {
    withDriver: true,
    deviceId: "purge-device-00000001",
  });
  try {
    await signInThroughUi(device.page, accountA);
    await warmUp(device.page);
    await seedAccountA(device.page, device.origin, accountA);

    const before = await readDeviceStorage(device.page, accountA.userId);
    expectAccountAIsOnTheDevice(before, accountA);

    await signOutAndReportLostWrites(device.page);
    await signInThroughUi(device.page, accountB);

    await expectNothingOfAccountARemains(device.page, accountA, accountB);
    await expectLibraryShowsNothingOfA(device.page, device.origin);
  } finally {
    await device.context.close();
  }
});

test("a sign-in finishes a purge a crash interrupted", async ({ browser }) => {
  test.setTimeout(300_000);
  await resetAccount(accountA.userId);
  await resetAccount(accountB.userId);
  const device: Device = await openDevice(browser, {
    withDriver: true,
    deviceId: "purge-device-00000001",
  });
  try {
    await signInThroughUi(device.page, accountA);
    await warmUp(device.page);
    await seedAccountA(device.page, device.origin, accountA);

    const before = await readDeviceStorage(device.page, accountA.userId);
    expectAccountAIsOnTheDevice(before, accountA);

    await endSessionWithoutPurge(device.page);
    const stranded = await readDeviceStorage(device.page, accountA.userId);
    expect(
      residueOf(stranded).length,
      "the interrupted sign-out cleaned up by itself, so the sign-in purge below would have " +
        "nothing to do and this test would prove nothing about it",
    ).toBeGreaterThan(0);
    expectAccountAIsOnTheDevice(stranded, accountA);

    await signInThroughUi(device.page, accountB);

    await expectNothingOfAccountARemains(device.page, accountA, accountB);
    await expectLibraryShowsNothingOfA(device.page, device.origin);
  } finally {
    await device.context.close();
  }
});

test("a late accepted progress response cannot recreate data after sign-out purges it", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await resetAccount(accountA.userId);
  const device: Device = await openDevice(browser, {
    withDriver: true,
    deviceId: "purge-late-progress-0001",
  });
  let heldResponse: HeldNetworkResponse | null = null;
  try {
    await signInThroughUi(device.page, accountA);
    await warmUp(device.page);
    await importThroughUi(device.page, "purge-late-progress.mp3", bookBuffer(KEPT_BOOK, 0));
    await expect(device.page.getByRole("link", { name: KEPT_BOOK.title, exact: true })).toBeVisible(
      {
        timeout: 60_000,
      },
    );
    const listed = await apiCall(device.page, "GET", "/api/books?status=all");
    const bookId = (listed.body as { books: Array<{ id: string; title: string }> }).books.find(
      (book) => book.title === KEPT_BOOK.title,
    )?.id;
    expect(bookId, "the progress-race book was never registered").toBeTruthy();

    await device.page.evaluate(
      async ([userId, targetBookId]) => {
        window.__harkSync.configure(userId as string, "purge-late-progress-0001");
        await window.__harkSync.commit({
          kind: "progress",
          bookId: targetBookId as string,
          positionMs: 12_345,
          playbackRate: 1.25,
          completed: false,
          eventOccurredAt: new Date().toISOString(),
        });
      },
      [accountA.userId, bookId!] as const,
    );
    const queued = await readDeviceStorage(device.page, accountA.userId);
    expect(
      queued.stores["chapterline-sync-v1/mutations"]?.ownedByTarget,
      "the progress request was not durable before sign-out began",
    ).toBeGreaterThan(0);

    const net = await network();
    heldResponse = net.holdNextResponse("PATCH", `/api/books/${bookId}/progress`);

    const signingOut = signOutThroughUi(device.page);
    expect(
      await heldResponse.upstreamStatus,
      "the server did not accept the held progress write while the session was still live",
    ).toBeLessThan(300);
    await signingOut;

    await expectNothingOfAccountARemains(device.page, accountA, null);

    heldResponse.release();
    await device.page.evaluate(async (userId) => {
      window.__harkSync.configure(userId, "purge-late-progress-0001");
      await window.__harkSync.replay();
    }, accountA.userId);

    await expectNothingOfAccountARemains(device.page, accountA, null);
  } finally {
    heldResponse?.release();
    await device.context.close();
  }
});

test("signing out in one tab revokes a playing peer before it can recreate account data", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await resetAccount(accountA.userId);
  const device: Device = await openDevice(browser, { deviceId: "purge-peer-000000001" });
  let peer: Page | null = null;
  try {
    await signInThroughUi(device.page, accountA);
    await warmUp(device.page);
    await importThroughUi(device.page, "purge-peer.mp3", bookBuffer(KEPT_BOOK, 0));
    await expect(device.page.getByRole("link", { name: KEPT_BOOK.title, exact: true })).toBeVisible(
      {
        timeout: 60_000,
      },
    );
    let bookId: string | undefined;
    await expect
      .poll(async () => {
        const listed = await apiCall(device.page, "GET", "/api/books?status=all");
        bookId = (listed.body as { books: Array<{ id: string; title: string }> }).books.find(
          (book) => book.title === KEPT_BOOK.title,
        )?.id;
        return bookId;
      })
      .toBeTruthy();
    expect(bookId, "the peer-tab book was never registered").toBeTruthy();

    peer = await device.context.newPage();
    await peer.goto(`${device.origin}/books/${bookId}`, { waitUntil: "domcontentloaded" });
    await expect(peer.getByRole("button", { name: "Play" })).toBeVisible({ timeout: 60_000 });
    await peer.getByRole("button", { name: "Play" }).click();
    await expect(peer.getByRole("button", { name: "Pause" })).toBeVisible();

    await signOutAndReportLostWrites(device.page);

    await peer.waitForURL(/\/login/, { timeout: 15_000 });
    await expect(peer.locator("audio")).toHaveCount(0);
    await peer.waitForTimeout(16_000);
    await expectNothingOfAccountARemains(peer, accountA, null);
  } finally {
    await peer?.close();
    await device.context.close();
  }
});
