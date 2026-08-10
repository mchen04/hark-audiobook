import { runBounded } from "@/lib/run-bounded";
import { clearPlaybackHistoryForBook } from "@/lib/playback-history";

import {
  database,
  MEDIA_CACHE,
  offlineBookKey,
  withMediaWriteLock,
  type OfflineBook,
  type OfflineDb,
} from "./db";
import { journalOfflineBookDeletion } from "./deletion-fence";
import { deleteBookTranscript } from "./transcript-store";

const CACHE_DELETE_CONCURRENCY = 8;

/**
 * Deletions are journaled before any bytes are removed so a crash mid-delete
 * leaves a retryable record instead of orphaned cache entries.
 */
export async function removeOfflineBook(
  userId: string,
  bookId: string,
  options: { clearPlaybackHistory?: boolean } = {},
) {
  const { db, key, operationId, needsCleanup } = await journalOfflineBookDeletion(
    userId,
    bookId,
    options,
  );
  if (!needsCleanup) return;
  await withMediaWriteLock(key, () => completeJournaledOfflineDeletion(db, key, operationId));
}

async function completeJournaledOfflineDeletion(
  db: OfflineDb,
  key: string,
  operationId: string | undefined,
): Promise<void> {
  if (!(await refreshJournaledMedia(db, key, operationId))) return;
  await completeOfflineDeletion(db, key);
}

/**
 * A writer that already held the lock may have passed its first fence check
 * before the journal landed. Re-read its final record under the lock and make
 * that token the one this deletion owns before removing anything.
 */
async function refreshJournaledMedia(
  db: OfflineDb,
  key: string,
  operationId: string | undefined,
): Promise<boolean> {
  const transaction = db.transaction(["downloads", "deletions"], "readwrite");
  const downloads = transaction.objectStore("downloads");
  const deletions = transaction.objectStore("deletions");
  const [existing, pending] = await Promise.all([downloads.get(key), deletions.get(key)]);
  if (
    !pending ||
    (operationId ? pending.operationId !== operationId : pending.operationId !== undefined)
  ) {
    await transaction.done;
    return false;
  }
  if (existing) {
    await deletions.put({
      ...pending,
      offlineMediaUrl: existing.offlineMediaUrl,
      offlineCoverUrl: existing.offlineCoverUrl,
      offlineCoverThumbUrl: existing.offlineCoverThumbUrl,
    });
  }
  await transaction.done;
  return true;
}

export async function retryPendingOfflineDeletions(userId: string): Promise<void> {
  const db = await database();
  const pending = await db.getAllFromIndex("deletions", "by-user", userId);
  await Promise.all(
    pending
      .filter((entry) => typeof entry.bookId === "string" && !entry.completedAt)
      .map((entry) =>
        withMediaWriteLock(entry.key, () =>
          completeJournaledOfflineDeletion(db, entry.key, entry.operationId),
        ),
      ),
  );
}

export async function retryAllPendingOfflineDeletions(): Promise<void> {
  const db = await database();
  const pending = await db.getAll("deletions");
  const now = Date.now();
  await Promise.allSettled(
    pending.map((entry) =>
      entry.completedAt
        ? // A permanent book deletion is also a durable liveness fence. A stale
          // player tab must never be able to attach bytes under that dead id;
          // account purge removes the marker with the rest of the user's data.
          !entry.clearPlaybackHistory && entry.completedAt < now - 24 * 60 * 60_000
          ? db.delete("deletions", entry.key)
          : Promise.resolve()
        : withMediaWriteLock(entry.key, () =>
            completeJournaledOfflineDeletion(db, entry.key, entry.operationId),
          ),
    ),
  );
  await reconcileOrphanedCacheEntries(db);
}

async function completeOfflineDeletion(db: OfflineDb, key: string): Promise<void> {
  const pending = await db.get("deletions", key);
  const existing = await db.get("downloads", key);
  const mediaUrl = pending?.offlineMediaUrl || existing?.offlineMediaUrl;
  const coverUrl = pending?.offlineCoverUrl || existing?.offlineCoverUrl;
  const coverThumbUrl = pending?.offlineCoverThumbUrl || existing?.offlineCoverThumbUrl;
  if (mediaUrl) {
    const cache = await caches.open(MEDIA_CACHE);
    await deleteJournaledMedia(db, cache, mediaUrl);
    if (coverUrl) await deleteJournaledCacheEntry(db, cache, coverUrl);
    if (coverThumbUrl) await deleteJournaledCacheEntry(db, cache, coverThumbUrl);
  }
  const bookId = pending?.bookId || existing?.book.id;
  const userId = pending?.userId || existing?.userId;
  if (bookId && userId) {
    await deleteBookTranscript(db, userId, bookId);
    if (pending?.clearPlaybackHistory) {
      await clearPlaybackHistoryForBook(userId, bookId);
    }
  }
  await db.delete("downloads", key);
  if (pending) {
    // Account purge may have deleted this row while Cache Storage or history
    // cleanup was awaited. Re-read and complete it in one transaction: a
    // removed row stays removed, and a newer removal attempt is never marked
    // complete using the older attempt's work.
    const transaction = db.transaction("deletions", "readwrite");
    const current = await transaction.store.get(key);
    if (
      current &&
      (pending.operationId
        ? current.operationId === pending.operationId
        : current.operationId === undefined)
    ) {
      await transaction.store.put({
        ...current,
        offlineMediaUrl: undefined,
        offlineCoverUrl: undefined,
        offlineCoverThumbUrl: undefined,
        clearPlaybackHistory: current.clearPlaybackHistory,
        completedAt: Date.now(),
      });
    }
    await transaction.done;
  }
}

export async function deleteJournaledCacheEntry(
  db: OfflineDb,
  cache: Cache,
  url: string,
): Promise<void> {
  await cache.delete(url);
  await db.delete("cacheEntries", url);
}

/**
 * Bulk variant: bounded cache fan-out and one IndexedDB transaction, so
 * removing a thousand-chunk audiobook does not queue a thousand independent
 * transactions. Journal rows are dropped only for URLs whose cache delete
 * succeeded, preserving the journal-covers-bytes invariant.
 */
export async function deleteJournaledCacheEntries(
  db: OfflineDb,
  cache: Cache,
  urls: string[],
): Promise<void> {
  if (!urls.length) return;
  const removed: string[] = [];
  let failure: unknown;
  let failed = false;
  await runBounded(urls, CACHE_DELETE_CONCURRENCY, async (url) => {
    try {
      await cache.delete(url);
      removed.push(url);
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  });
  if (removed.length) {
    const transaction = db.transaction("cacheEntries", "readwrite");
    await Promise.all([...removed.map((url) => transaction.store.delete(url)), transaction.done]);
  }
  if (failed) throw failure;
}

export async function deleteJournaledMedia(
  db: OfflineDb,
  cache: Cache,
  mediaUrl: string,
): Promise<void> {
  // The store is keyed by URL, so the chunk list is a key-range read instead
  // of a scan across every stored book.
  const chunkPrefix = `${mediaUrl}/chunk/`;
  const urls = await db.getAllKeys(
    "cacheEntries",
    IDBKeyRange.bound(chunkPrefix, `${chunkPrefix}\uffff`),
  );
  urls.push(mediaUrl);
  await deleteJournaledCacheEntries(db, cache, urls);
}

/**
 * Orphan detection is an in-memory diff of two snapshot reads. Chunked
 * audiobooks put thousands of rows in `cacheEntries`, so per-entry work
 * (a lock or a get per row) would stall every launch for minutes-long books;
 * locks are taken only for the rare books that actually have orphans, and
 * ownership is re-checked under the lock so an import that is still
 * journaling in another tab is never swept.
 */
async function reconcileOrphanedCacheEntries(db: OfflineDb): Promise<void> {
  const [entries, downloads] = await Promise.all([
    db.getAll("cacheEntries"),
    db.getAll("downloads"),
  ]);
  const owned = ownedUrls(downloads);
  const orphansByBook = new Map<string, string[]>();
  for (const entry of entries) {
    if (owned.has(ownershipUrl(entry.url))) continue;
    const key = offlineBookKey(entry.userId, entry.bookId);
    const group = orphansByBook.get(key);
    if (group) group.push(entry.url);
    else orphansByBook.set(key, [entry.url]);
  }
  if (!orphansByBook.size) return;
  const cache = await caches.open(MEDIA_CACHE);
  await Promise.allSettled(
    [...orphansByBook.entries()].map(([key, urls]) =>
      withMediaWriteLock(key, async () => {
        const record = await db.get("downloads", key);
        const currentlyOwned = ownedUrls(record ? [record] : []);
        await deleteJournaledCacheEntries(
          db,
          cache,
          urls.filter((url) => !currentlyOwned.has(ownershipUrl(url))),
        );
      }),
    ),
  );
}

function ownedUrls(records: OfflineBook[]): Set<string> {
  const owned = new Set<string>();
  for (const record of records) {
    owned.add(record.offlineMediaUrl);
    if (record.offlineCoverUrl) owned.add(record.offlineCoverUrl);
    if (record.offlineCoverThumbUrl) owned.add(record.offlineCoverThumbUrl);
  }
  return owned;
}

/** Chunk URLs (`…/chunk/N`) are owned through their book's media URL. */
function ownershipUrl(url: string): string {
  const index = url.indexOf("/chunk/");
  return index === -1 ? url : url.slice(0, index);
}
