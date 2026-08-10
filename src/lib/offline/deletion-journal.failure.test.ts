import { beforeEach, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

const cleanup = vi.hoisted(() => ({
  transcript: vi.fn(),
  history: vi.fn(),
}));

vi.mock("./transcript-store", () => ({ deleteBookTranscript: cleanup.transcript }));
vi.mock("@/lib/playback-history", () => ({
  clearPlaybackHistoryForBook: cleanup.history,
}));

import { database, offlineBookKey } from "./db";
import { ensurePermanentOfflineBookDeletion } from "./deletion-fence";
import {
  removeOfflineBook,
  retryAllPendingOfflineDeletions,
  retryPendingOfflineDeletions,
} from "./deletion-journal";

const USER = "user-a";
const BOOK = "book-a";

beforeEach(async () => {
  vi.stubGlobal("indexedDB", new FakeIDBFactory());
  vi.stubGlobal("caches", {
    open: vi.fn(async () => ({ delete: vi.fn(async () => true) })),
  });
  cleanup.transcript.mockReset().mockResolvedValue(undefined);
  cleanup.history.mockReset().mockResolvedValue(undefined);
  const db = await database();
  await db.put("downloads", {
    key: offlineBookKey(USER, BOOK),
    userId: USER,
    book: {
      id: BOOK,
      title: "Book",
      author: "Author",
      durationMs: 1,
      chapters: [],
      completed: false,
      initialPositionMs: 0,
      initialProgressOccurredAt: null,
      initialPlaybackRate: 1,
    },
    offlineMediaUrl: "/offline-media/book-a",
    offlineCoverUrl: null,
    byteSize: 1,
    downloadedAt: "2026-08-09T00:00:00.000Z",
  });
});

it("keeps transcript cleanup retryable instead of completing the deletion journal", async () => {
  cleanup.transcript.mockRejectedValueOnce(new Error("transcript store busy"));

  await expect(removeOfflineBook(USER, BOOK)).rejects.toThrow("transcript store busy");
  const db = await database();
  expect(await db.get("deletions", offlineBookKey(USER, BOOK))).not.toHaveProperty("completedAt");

  await retryPendingOfflineDeletions(USER);
  expect(await db.get("deletions", offlineBookKey(USER, BOOK))).toHaveProperty("completedAt");
});

it("journals permanent-book history cleanup and retries it after failure", async () => {
  cleanup.history.mockRejectedValueOnce(new Error("history store busy"));

  await expect(removeOfflineBook(USER, BOOK, { clearPlaybackHistory: true })).rejects.toThrow(
    "history store busy",
  );
  const db = await database();
  expect(await db.get("deletions", offlineBookKey(USER, BOOK))).not.toHaveProperty("completedAt");

  await retryPendingOfflineDeletions(USER);
  expect(cleanup.history).toHaveBeenCalledTimes(2);
  expect(await db.get("deletions", offlineBookKey(USER, BOOK))).toHaveProperty("completedAt");
});

it("persists a permanent deletion fence before waiting for the media lock", async () => {
  let releaseLock!: () => void;
  let lockRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    lockRequested = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  vi.stubGlobal("navigator", {
    locks: {
      request: vi.fn(async (_name: string, operation: () => Promise<unknown>) => {
        lockRequested();
        await held;
        return operation();
      }),
    },
  });

  const removal = removeOfflineBook(USER, BOOK, { clearPlaybackHistory: true });
  await requested;
  const db = await database();
  const markerBeforeLock = await db.get("deletions", offlineBookKey(USER, BOOK));
  releaseLock();
  await removal;

  expect(markerBeforeLock).toMatchObject({
    userId: USER,
    bookId: BOOK,
    clearPlaybackHistory: true,
  });
  expect(markerBeforeLock).not.toHaveProperty("completedAt");
});

it("does not recreate a deletion journal row removed by an account purge", async () => {
  let releaseDelete!: () => void;
  let deletionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    deletionStarted = resolve;
  });
  const heldDelete = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  vi.stubGlobal("caches", {
    open: vi.fn(async () => ({
      delete: vi.fn(async () => {
        deletionStarted();
        await heldDelete;
        return true;
      }),
    })),
  });

  const removal = removeOfflineBook(USER, BOOK);
  await started;

  const db = await database();
  const key = offlineBookKey(USER, BOOK);
  await db.delete("deletions", key);
  releaseDelete();
  await removal;

  expect(await db.get("deletions", key)).toBeUndefined();
});

it("keeps permanent-book tombstones after completed cleanup", async () => {
  const db = await database();
  const key = offlineBookKey(USER, BOOK);
  await db.put("deletions", {
    key,
    userId: USER,
    bookId: BOOK,
    clearPlaybackHistory: true,
    completedAt: Date.now() - 25 * 60 * 60_000,
  });

  await retryAllPendingOfflineDeletions();

  expect(await db.get("deletions", key)).toMatchObject({
    clearPlaybackHistory: true,
    completedAt: expect.any(Number),
  });
});

it("a retry reclaims media committed by the writer that previously held the lock", async () => {
  const deleted = vi.fn(async () => true);
  vi.stubGlobal("caches", { open: vi.fn(async () => ({ delete: deleted })) });
  await ensurePermanentOfflineBookDeletion(USER, BOOK);
  const db = await database();
  const key = offlineBookKey(USER, BOOK);
  const existing = (await db.get("downloads", key))!;
  await db.put("downloads", {
    ...existing,
    offlineMediaUrl: "/offline-media/committed-after-fence",
  });

  await retryPendingOfflineDeletions(USER);

  expect(deleted).toHaveBeenCalledWith("/offline-media/committed-after-fence");
  expect(await db.get("downloads", key)).toBeUndefined();
});
