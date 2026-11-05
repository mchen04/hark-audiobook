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

export async function ensurePermanentOfflineBookDeletion(
  userId: string,
  bookId: string,
): Promise<void> {
  await journalOfflineBookDeletion(userId, bookId, { clearPlaybackHistory: true });
}
