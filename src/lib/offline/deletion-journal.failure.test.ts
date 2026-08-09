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
import { removeOfflineBook, retryPendingOfflineDeletions } from "./deletion-journal";

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
