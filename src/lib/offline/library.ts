import type { PlayerBook } from "@/domain/player";
import { withAccountWriteLock } from "@/lib/account-deletion-fence";
import {
  applyPendingProgressNormalizations,
  clearQueuedMutationsForUser,
  purgeProgressNormalizationsForUser,
  registerImportReattachedHandler,
  registerProgressConflictHandler,
} from "@/lib/offline-sync";
import { clearPlaybackHistoryForUser } from "@/lib/playback-history";
import { invalidatePreferenceWrites } from "@/lib/preferences";

import {
  database,
  MEDIA_CACHE,
  mirrorChapterKey,
  mirrorPrefixRange,
  offlineBookKey,
  OfflineStorageUnavailableError,
  withMediaWriteLock,
  type OfflineBook,
  type OfflineDb,
} from "./db";
import {
  deleteJournaledCacheEntries,
  removeOfflineBook,
  retryPendingOfflineDeletions,
} from "./deletion-journal";
import { isPermanentOfflineDeletion } from "./deletion-fence";
import { rekeyMirroredLocalBook } from "./local-import-mirror";
import { notifyLibraryChanged } from "./library-revision";
import { deleteAllTranscriptsForUser } from "./transcript-store";

export async function listOfflineBooks(userId: string): Promise<OfflineBook[]> {
  await retryPendingOfflineDeletions(userId);
  const records = await listStoredOfflineBooks(userId);
  const db = await database();
  const cache = await caches.open(MEDIA_CACHE);
  const reconciled = await Promise.all(
    records.map((record) => reconcileOfflineRecord(db, cache, record)),
  );
  return reconciled
    .filter((record): record is OfflineBook => !!record)
    .sort((left, right) => right.downloadedAt.localeCompare(left.downloadedAt));
}

export async function listStoredOfflineBooks(userId: string): Promise<OfflineBook[]> {
  const db = await database();
  return db.getAllFromIndex("downloads", "by-user", userId);
}

export async function listVisibleStoredOfflineBooks(userId: string): Promise<OfflineBook[]> {
  const db = await database();
  const transaction = db.transaction(["downloads", "deletions"]);
  const [records, deletions] = await Promise.all([
    transaction.objectStore("downloads").index("by-user").getAll(userId),
    transaction.objectStore("deletions").index("by-user").getAll(userId),
  ]);
  await transaction.done;
  const permanentlyDeleted = new Set(
    deletions.filter(isPermanentOfflineDeletion).map((entry) => entry.bookId),
  );
  return records.filter((record) => !permanentlyDeleted.has(record.book.id));
}

export async function getStoredOfflineBook(
  userId: string,
  bookId: string,
): Promise<OfflineBook | undefined> {
  const db = await database();
  return db.get("downloads", offlineBookKey(userId, bookId));
}

export async function getOfflineBook(userId: string, bookId: string) {
  try {
    await applyPendingProgressNormalizations(userId, bookId);
    const db = await database();
    const key = offlineBookKey(userId, bookId);
    const [record, deletion] = await Promise.all([
      db.get("downloads", key),
      db.get("deletions", key),
    ]);
    if (!record || isPermanentOfflineDeletion(deletion)) return undefined;

    const cache = await caches.open(MEDIA_CACHE);
    const reconciled = await reconcileOfflineRecord(db, cache, record);
    if (isPermanentOfflineDeletion(await db.get("deletions", key))) return undefined;
    return reconciled;
  } catch {
    throw new OfflineStorageUnavailableError();
  }
}

async function reconcileOfflineRecord(db: OfflineDb, cache: Cache, record: OfflineBook) {
  if (await cache.match(record.offlineMediaUrl)) {
    if (!record.mediaMissingSince) return record;
    await setMediaMissingSince(db, record, null);
    return { ...record, mediaMissingSince: null };
  }
  if (!record.mediaMissingSince) {
    await setMediaMissingSince(db, record, new Date().toISOString());
  }
  return undefined;
}

async function setMediaMissingSince(
  db: OfflineDb,
  record: OfflineBook,
  mediaMissingSince: string | null,
): Promise<void> {
  const transaction = db.transaction("downloads", "readwrite");
  const current = await transaction.store.get(record.key);
  if (
    current &&
    current.offlineMediaUrl === record.offlineMediaUrl &&
    (current.mediaMissingSince ?? null) !== mediaMissingSince
  ) {
    await transaction.store.put({ ...current, mediaMissingSince });
  }
  await transaction.done;
  notifyLibraryChanged();
}

export async function reattachLocalBookIdentity(
  userId: string,
  fromBookId: string,
  toBookId: string,
  canonical: unknown = null,
): Promise<void> {
  if (!fromBookId || !toBookId || fromBookId === toBookId) return;
  const db = await database();
  const fromKey = offlineBookKey(userId, fromBookId);
  const toKey = offlineBookKey(userId, toBookId);
  const canonicalBook = toCanonicalBook(canonical);

  const journaled = await withMediaWriteLock(fromKey, async () => {
    const [record, target] = await Promise.all([
      db.get("downloads", fromKey),
      db.get("downloads", toKey),
    ]);
    if (record && target && (await mediaIsStored(target.offlineMediaUrl))) {
      await db.put("deletions", {
        key: fromKey,
        userId,
        bookId: fromBookId,
        offlineMediaUrl: record.offlineMediaUrl,
        offlineCoverUrl: record.offlineCoverUrl,
        offlineCoverThumbUrl: record.offlineCoverThumbUrl,
      });
      await db.delete("downloads", fromKey);
      return true;
    }
    await rekeyLocalBook(db, userId, fromBookId, toBookId, canonicalBook);
    return false;
  });
  await rekeyMirroredLocalBook(userId, fromBookId, toBookId, canonicalBook);
  if (journaled) await retryPendingOfflineDeletions(userId).catch(() => undefined);
}

async function mediaIsStored(offlineMediaUrl: string): Promise<boolean> {
  const cache = await caches.open(MEDIA_CACHE);
  return !!(await cache.match(offlineMediaUrl));
}

async function rekeyLocalBook(
  db: OfflineDb,
  userId: string,
  fromBookId: string,
  toBookId: string,
  canonical: OfflineBook["book"] | null,
): Promise<void> {
  const fromKey = offlineBookKey(userId, fromBookId);
  const toKey = offlineBookKey(userId, toBookId);
  const transaction = db.transaction(["downloads", "cacheEntries", "transcripts"], "readwrite");
  const downloads = transaction.objectStore("downloads");
  const entries = transaction.objectStore("cacheEntries");
  const transcripts = transaction.objectStore("transcripts");

  const [record, cacheRows, cues, targetCueKeys] = await Promise.all([
    downloads.get(fromKey),
    entries.index("by-user").getAll(userId),
    transcripts.getAll(mirrorPrefixRange(userId, fromBookId)),
    transcripts.getAllKeys(mirrorPrefixRange(userId, toBookId)),
  ]);

  const writes: Promise<unknown>[] = [];
  if (record) {
    writes.push(
      downloads.put({
        ...record,
        key: toKey,
        book: canonical ? { ...canonical, id: toBookId } : renameBook(record.book, toBookId),
      }),
      downloads.delete(fromKey),
    );
  }
  for (const row of cacheRows) {
    if (row.bookId === fromBookId) writes.push(entries.put({ ...row, bookId: toBookId }));
  }
  for (const cue of cues) {
    writes.push(transcripts.delete(cue.key));
    if (!targetCueKeys.length) {
      writes.push(
        transcripts.put({
          ...cue,
          key: mirrorChapterKey(userId, toBookId, cue.chapterIndex),
          bookId: toBookId,
        }),
      );
    }
  }
  await Promise.all([...writes, transaction.done]);
  notifyLibraryChanged();
}

function renameBook(book: OfflineBook["book"], bookId: string): OfflineBook["book"] {
  return {
    ...book,
    id: bookId,
    chapters: book.chapters.map((chapter) => ({ ...chapter, id: `${bookId}:${chapter.position}` })),
  };
}

function toCanonicalBook(value: unknown): OfflineBook["book"] | null {
  if (!value || typeof value !== "object") return null;
  const book = value as Partial<PlayerBook>;
  if (typeof book.id !== "string" || !book.id) return null;
  if (typeof book.title !== "string" || typeof book.author !== "string") return null;
  if (typeof book.durationMs !== "number" || !Array.isArray(book.chapters)) return null;
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    durationMs: book.durationMs,
    chapters: book.chapters,
    initialPositionMs: Number(book.initialPositionMs) || 0,
    initialProgressOccurredAt:
      typeof book.initialProgressOccurredAt === "string" ? book.initialProgressOccurredAt : null,
    initialPlaybackRate: Number(book.initialPlaybackRate) || 1,
    initialPlaybackRateOccurredAt:
      typeof book.initialPlaybackRateOccurredAt === "string"
        ? book.initialPlaybackRateOccurredAt
        : typeof book.initialProgressOccurredAt === "string"
          ? book.initialProgressOccurredAt
          : null,
    completed: !!book.completed,
    initialCompletedOccurredAt:
      typeof book.initialCompletedOccurredAt === "string"
        ? book.initialCompletedOccurredAt
        : typeof book.initialProgressOccurredAt === "string"
          ? book.initialProgressOccurredAt
          : null,
  };
}

type OfflineProgressProjection = {
  positionMs: number;
  completed: boolean;
  playbackRate: number;
  eventOccurredAt: string | null;
  playbackRateOccurredAt: string | null;
  completedOccurredAt: string | null;
  stateOccurredAt: string | null;
};

function projectOfflineProgress(
  userId: string,
  bookId: string,
  state: OfflineProgressProjection,
): Promise<void> {
  return withAccountWriteLock(userId, () => writeOfflineProgressProjection(userId, bookId, state));
}

async function writeOfflineProgressProjection(
  userId: string,
  bookId: string,
  state: OfflineProgressProjection,
): Promise<void> {
  const db = await database();
  const transaction = db.transaction(["downloads", "playbackStates"], "readwrite");
  const key = offlineBookKey(userId, bookId);
  const downloads = transaction.objectStore("downloads");
  const playbackStates = transaction.objectStore("playbackStates");
  const record = await downloads.get(key);
  if (record) {
    await downloads.put({
      ...record,
      book: {
        ...record.book,
        initialPositionMs: state.positionMs,
        initialProgressOccurredAt: state.eventOccurredAt,
        initialPlaybackRate: state.playbackRate,
        initialPlaybackRateOccurredAt:
          state.playbackRateOccurredAt ?? state.stateOccurredAt ?? state.eventOccurredAt,
        completed: state.completed,
        initialCompletedOccurredAt:
          state.completedOccurredAt ?? state.stateOccurredAt ?? state.eventOccurredAt,
      },
    });
  }
  const existing = await playbackStates.get(key);
  const eventOccurredAt = state.eventOccurredAt ?? new Date(0).toISOString();
  const playbackRateOccurredAt =
    state.playbackRateOccurredAt ?? state.stateOccurredAt ?? eventOccurredAt;
  const completedOccurredAt = state.completedOccurredAt ?? state.stateOccurredAt ?? eventOccurredAt;
  await playbackStates.put({
    key,
    userId,
    bookId,
    positionMs: state.positionMs,
    playbackRate: state.playbackRate,
    completed: state.completed,
    deviceId: existing?.deviceId ?? "",
    deviceSequence: existing?.deviceSequence ?? 0,
    eventOccurredAt,
    playbackRateOccurredAt,
    completedOccurredAt,
    stateOccurredAt:
      Date.parse(playbackRateOccurredAt) >= Date.parse(completedOccurredAt)
        ? playbackRateOccurredAt
        : completedOccurredAt,
    updatedAt: new Date().toISOString(),
  });
  await transaction.done;
  notifyLibraryChanged();
}

export function asOfflinePlayerBook(record: OfflineBook): PlayerBook {
  return {
    ...record.book,
    mediaUrl: record.offlineMediaUrl,
    coverUrl: record.offlineCoverUrl,
    coverThumbUrl: record.offlineCoverThumbUrl || record.offlineCoverUrl,
  };
}

export async function clearLocalDataForUser(userId: string): Promise<void> {
  invalidatePreferenceWrites(userId);
  const downloads = await listStoredOfflineBooks(userId);
  const cleanup = await Promise.allSettled(
    downloads.map((record) => removeOfflineBook(userId, record.book.id)),
  );
  const cacheCleanupFailed = cleanup.some((result) => result.status === "rejected");
  const db = await database();
  const orphaned = await db.getAllFromIndex("cacheEntries", "by-user", userId);
  const orphansByBook = new Map<string, string[]>();
  for (const entry of orphaned) {
    const group = orphansByBook.get(entry.bookId);
    if (group) group.push(entry.url);
    else orphansByBook.set(entry.bookId, [entry.url]);
  }
  const orphanCleanup = await Promise.allSettled(
    [...orphansByBook.entries()].map(([bookId, urls]) =>
      withMediaWriteLock(offlineBookKey(userId, bookId), async () => {
        const cache = await caches.open(MEDIA_CACHE);
        await deleteJournaledCacheEntries(db, cache, urls);
      }),
    ),
  );

  const keysToRemove: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.includes(`:${userId}`)) keysToRemove.push(key);
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));

  const recordCleanup = await Promise.allSettled([
    deleteAllTranscriptsForUser(userId),
    clearQueuedMutationsForUser(userId),
    purgeProgressNormalizationsForUser(userId),
    clearPlaybackHistoryForUser(userId),
  ]);
  const failures: unknown[] = recordCleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (cacheCleanupFailed || orphanCleanup.some((result) => result.status === "rejected")) {
    failures.push(new OfflineStorageUnavailableError());
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Local account cleanup failed.");
}

registerImportReattachedHandler(reattachLocalBookIdentity);
registerProgressConflictHandler(projectOfflineProgress);
