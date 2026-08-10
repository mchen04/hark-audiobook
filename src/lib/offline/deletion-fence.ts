import { database, offlineBookKey, type OfflineDatabase, type OfflineDb } from "./db";

type OfflineDeletion = OfflineDatabase["deletions"]["value"];

export type JournaledOfflineDeletion = {
  db: OfflineDb;
  key: string;
  operationId?: string;
  needsCleanup: boolean;
};

export function isPermanentOfflineDeletion(
  deletion: Pick<OfflineDeletion, "clearPlaybackHistory"> | undefined,
): boolean {
  return deletion?.clearPlaybackHistory === true;
}

/**
 * Makes a deletion durable without taking the media lock.
 *
 * This ordering is intentional. A tab can be killed while it waits for a
 * lock held by another tab, so putting the marker behind that lock leaves no
 * recovery fact and lets the orphaned download reappear as a device-only
 * book. Permanent markers also fence stale media writers immediately.
 */
export async function journalOfflineBookDeletion(
  userId: string,
  bookId: string,
  options: { clearPlaybackHistory?: boolean } = {},
): Promise<JournaledOfflineDeletion> {
  const db = await database();
  const key = offlineBookKey(userId, bookId);
  const transaction = db.transaction(["downloads", "deletions"], "readwrite");
  const downloads = transaction.objectStore("downloads");
  const deletions = transaction.objectStore("deletions");
  const [existing, pending] = await Promise.all([downloads.get(key), deletions.get(key)]);
  const clearPlaybackHistory =
    pending?.clearPlaybackHistory === true || options.clearPlaybackHistory === true;
  const ownsMedia = Boolean(
    existing ||
    pending?.offlineMediaUrl ||
    pending?.offlineCoverUrl ||
    pending?.offlineCoverThumbUrl,
  );

  // A completed attempt is already the required fence. Re-open it only when
  // there are bytes to reclaim, or when a completed remove-download is being
  // upgraded to a permanent book deletion that must also clear history.
  if (
    pending?.completedAt !== undefined &&
    !ownsMedia &&
    (options.clearPlaybackHistory !== true || pending.clearPlaybackHistory === true)
  ) {
    await transaction.done;
    return {
      db,
      key,
      operationId: pending.operationId,
      needsCleanup: false,
    };
  }

  const operationId =
    pending && pending.completedAt === undefined
      ? (pending.operationId ?? crypto.randomUUID())
      : crypto.randomUUID();
  const journal: OfflineDeletion = {
    ...pending,
    key,
    userId,
    bookId,
    operationId,
    offlineMediaUrl: existing?.offlineMediaUrl ?? pending?.offlineMediaUrl,
    offlineCoverUrl: existing?.offlineCoverUrl ?? pending?.offlineCoverUrl,
    offlineCoverThumbUrl: existing?.offlineCoverThumbUrl ?? pending?.offlineCoverThumbUrl,
    clearPlaybackHistory,
  };
  delete journal.completedAt;
  await deletions.put(journal);
  await transaction.done;
  return { db, key, operationId, needsCleanup: true };
}

/** A server-visible permanent delete must never exist without this local fence. */
export async function ensurePermanentOfflineBookDeletion(
  userId: string,
  bookId: string,
): Promise<void> {
  await journalOfflineBookDeletion(userId, bookId, { clearPlaybackHistory: true });
}
