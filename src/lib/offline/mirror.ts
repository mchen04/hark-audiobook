import type { IDBPTransaction } from "idb";

import {
  assertAccountWritable,
  isAccountDeletionFenced,
  subscribeAccountDeletionFence,
} from "@/lib/account-deletion-fence";
import { selectContinueBook, type LibraryBook } from "@/domain/library";
import type { PlayerBook } from "@/domain/player";
import { notifyLibraryChanged } from "./library-revision";
import { liveBookDigest } from "./live-book-digest";
import type { MediaFingerprintKind } from "@/lib/media-fingerprint";
import { listLocalPlaybackStates } from "@/lib/playback-core";
import {
  applyPendingProgressNormalizations,
  applyPendingProgressNormalizationsForUser,
} from "@/lib/offline-sync/normalizations";

import {
  database,
  mirrorChapterKey,
  mirrorKey,
  mirrorKeyTail,
  mirrorPrefixRange,
  type MirrorBook,
  type MirrorBookTag,
  type MirrorChapter,
  type MirrorCollection,
  type MirrorCollectionBook,
  type MirrorListeningSession,
  type MirrorPlaybackState,
  type MirrorSyncMeta,
  type MirrorTag,
  type OfflineDatabase,
} from "./db";
import type { PullBatch, PulledBook } from "./sync-protocol";
import { listQueuedMutations } from "@/lib/offline-sync/queue";
import { withBookProjectionLock } from "@/lib/offline-sync/locks";
import { bookFieldsFrom } from "./outbox";

type MirrorStoreName =
  | "downloads"
  | "books"
  | "chapters"
  | "playbackStates"
  | "tags"
  | "bookTags"
  | "collections"
  | "collectionBooks"
  | "preferences"
  | "listeningSessions"
  | "syncMeta";

const MIRROR_STORES: MirrorStoreName[] = [
  "downloads",
  "books",
  "chapters",
  "playbackStates",
  "tags",
  "bookTags",
  "collections",
  "collectionBooks",
  "preferences",
  "listeningSessions",
  "syncMeta",
];

type MirrorTransaction = IDBPTransaction<OfflineDatabase, MirrorStoreName[], "readwrite">;

export type MirrorPlayerBook = {
  playerBook: PlayerBook;
  mediaFingerprint: string;
  mediaFingerprintKind: MediaFingerprintKind | null;
  mediaRenditionKey: string;
  byteSize: number;
  sourceFilename: string;
  sourceMimeType: string;
};

export class LiveBookSetChangedError extends Error {
  constructor() {
    super("The device's books changed while the pull was in flight.");
  }
}

export async function applyPullBatch(
  userId: string,
  batch: PullBatch,
  digestedBookIds?: readonly string[],
): Promise<void> {
  return withBookProjectionLock(userId, () =>
    applyPullBatchUnlocked(userId, batch, digestedBookIds),
  );
}

async function applyPullBatchUnlocked(
  userId: string,
  batch: PullBatch,
  digestedBookIds?: readonly string[],
): Promise<void> {
  assertAccountWritable(userId);
  const pending = await listQueuedMutations(userId);
  const edits = new Map<string, Partial<MirrorBook>>();
  for (const mutation of pending) {
    if (mutation.kind !== "metadata" && mutation.kind !== "archive") continue;
    edits.set(mutation.entityId, {
      ...edits.get(mutation.entityId),
      ...bookFieldsFrom(mutation.payload),
    });
  }
  const incomingBooks = batch.books.map((book) => ({ ...book, ...edits.get(book.id) }));
  const db = await database();
  const transaction = db.transaction(MIRROR_STORES, "readwrite");
  const unsubscribe = subscribeAccountDeletionFence(() => {
    if (isAccountDeletionFenced(userId)) abortQuietly(transaction);
  });

  try {
    const current = await transaction.objectStore("syncMeta").get(userId);
    if (current && orderedCursor(current.cursor) > orderedCursor(batch.cursor)) {
      await transaction.done;
      return;
    }
    await clearBookAggregates(transaction, userId, batch.books);
    await writeBookAggregates(transaction, userId, incomingBooks);
    await writePlaybackStates(transaction, userId, batch);
    if (batch.complete) {
      await replaceTags(transaction, userId, batch);
      await replaceCollections(transaction, userId, batch);
      await writePreferences(transaction, userId, batch);
      await writeListeningSessions(transaction, userId, batch);
    }
    await applyTombstones(transaction, userId, batch, digestedBookIds);

    const meta: MirrorSyncMeta = {
      userId,
      cursor: batch.cursor,
      lastSyncedAt: new Date().toISOString(),
    };
    await transaction.objectStore("syncMeta").put(meta);

    assertAccountWritable(userId);
    await transaction.done;
    notifyLibraryChanged();
  } catch (error) {
    abortQuietly(transaction);
    throw error;
  } finally {
    unsubscribe();
  }
}

function orderedCursor(cursor: string): string {
  return cursor.replace(
    /(?:\.(\d{1,6}))?Z$/,
    (_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(6, "0")}Z`,
  );
}

function abortQuietly(transaction: MirrorTransaction): void {
  void transaction.done.catch(() => undefined);
  try {
    transaction.abort();
  } catch {}
}

async function clearBookAggregates(
  transaction: MirrorTransaction,
  userId: string,
  books: PulledBook[],
): Promise<void> {
  const chapters = transaction.objectStore("chapters");
  const bookTags = transaction.objectStore("bookTags");
  await Promise.all(
    books.flatMap((book) => [
      chapters.delete(mirrorPrefixRange(userId, book.id)),
      bookTags.delete(mirrorPrefixRange(userId, book.id)),
    ]),
  );
}

async function writeBookAggregates(
  transaction: MirrorTransaction,
  userId: string,
  books: PulledBook[],
): Promise<void> {
  const store = transaction.objectStore("books");
  const chapters = transaction.objectStore("chapters");
  const bookTags = transaction.objectStore("bookTags");
  await Promise.all(
    books.flatMap((book) => {
      const record: MirrorBook = {
        key: mirrorKey(userId, book.id),
        userId,
        bookId: book.id,
        title: book.title,
        author: book.author,
        narrator: book.narrator,
        description: book.description,
        series: book.series,
        seriesPosition: book.seriesPosition,
        chapterDiagnostic: book.chapterDiagnostic,
        archivedAt: book.archivedAt,
        createdAt: book.createdAt,
        updatedAt: book.updatedAt,
        media: book.media
          ? { ...book.media, renditionKey: book.media.renditionKey || "source-v1" }
          : null,
        searchText: searchTextFor(book),
      };
      const chapterRows: MirrorChapter[] = book.chapters.map((chapter) => ({
        key: mirrorChapterKey(userId, book.id, chapter.position),
        userId,
        bookId: book.id,
        position: chapter.position,
        title: chapter.title,
        startMs: chapter.startMs,
        endMs: chapter.endMs,
      }));
      const edgeRows: MirrorBookTag[] = book.tagIds.map((tagId) => ({
        key: mirrorKey(userId, book.id, tagId),
        userId,
        bookId: book.id,
        tagId,
      }));
      return [
        store.put(record),
        ...chapterRows.map((chapter) => chapters.put(chapter)),
        ...edgeRows.map((edge) => bookTags.put(edge)),
      ];
    }),
  );
}

function searchTextFor(book: PulledBook): string {
  return [book.title, book.author, book.narrator || "", book.series || ""].join(" ").toLowerCase();
}

async function writePlaybackStates(
  transaction: MirrorTransaction,
  userId: string,
  batch: PullBatch,
): Promise<void> {
  const states = transaction.objectStore("playbackStates");
  const downloads = transaction.objectStore("downloads");
  await Promise.all(
    batch.playbackStates.map(async (state) => {
      const key = mirrorKey(userId, state.bookId);
      const playbackRateOccurredAt =
        state.playbackRateOccurredAt ?? state.stateOccurredAt ?? state.eventOccurredAt;
      const completedOccurredAt =
        state.completedOccurredAt ?? state.stateOccurredAt ?? state.eventOccurredAt;
      const record: MirrorPlaybackState = {
        key,
        userId,
        bookId: state.bookId,
        positionMs: state.positionMs,
        playbackRate: state.playbackRate,
        completed: state.completed,
        deviceId: state.deviceId,
        deviceSequence: state.deviceSequence,
        eventOccurredAt: state.eventOccurredAt,
        playbackRateOccurredAt,
        completedOccurredAt,
        stateOccurredAt: state.stateOccurredAt ?? state.eventOccurredAt,
        updatedAt: state.updatedAt,
      };
      await states.put(record);
      const download = await downloads.get(key);
      if (!download) return;
      await downloads.put({
        ...download,
        book: {
          ...download.book,
          initialPositionMs: state.positionMs,
          initialProgressOccurredAt: state.eventOccurredAt,
          initialPlaybackRate: state.playbackRate,
          initialPlaybackRateOccurredAt: playbackRateOccurredAt,
          completed: state.completed,
          initialCompletedOccurredAt: completedOccurredAt,
        },
      });
    }),
  );
}

async function replaceTags(
  transaction: MirrorTransaction,
  userId: string,
  batch: PullBatch,
): Promise<void> {
  const store = transaction.objectStore("tags");
  const existing = await store.index("by-user").getAllKeys(userId);
  const surviving = new Set(batch.tags.map((tag) => mirrorKey(userId, tag.id)));
  await Promise.all([
    ...existing.filter((key) => !surviving.has(key)).map((key) => store.delete(key)),
    ...batch.tags.map((tag) => {
      const record: MirrorTag = {
        key: mirrorKey(userId, tag.id),
        userId,
        tagId: tag.id,
        name: tag.name,
      };
      return store.put(record);
    }),
  ]);
}

async function replaceCollections(
  transaction: MirrorTransaction,
  userId: string,
  batch: PullBatch,
): Promise<void> {
  const store = transaction.objectStore("collections");
  const edges = transaction.objectStore("collectionBooks");
  const existing = await store.index("by-user").getAllKeys(userId);
  const surviving = new Set(
    batch.collections.map((collection) => mirrorKey(userId, collection.id)),
  );
  const dropped = existing.filter((key) => !surviving.has(key));

  await Promise.all([
    ...dropped.flatMap((key) => [
      store.delete(key),
      edges.delete(mirrorPrefixRange(userId, mirrorKeyTail(key))),
    ]),
    ...batch.collections.map((collection) =>
      edges.delete(mirrorPrefixRange(userId, collection.id)),
    ),
  ]);

  await Promise.all(
    batch.collections.flatMap((collection) => {
      const record: MirrorCollection = {
        key: mirrorKey(userId, collection.id),
        userId,
        collectionId: collection.id,
        name: collection.name,
        updatedAt: collection.updatedAt,
      };
      const members: MirrorCollectionBook[] = collection.books.map((member) => ({
        key: mirrorKey(userId, collection.id, member.bookId),
        userId,
        collectionId: collection.id,
        bookId: member.bookId,
        position: member.position,
      }));
      return [store.put(record), ...members.map((member) => edges.put(member))];
    }),
  );
}

async function writePreferences(
  transaction: MirrorTransaction,
  userId: string,
  batch: PullBatch,
): Promise<void> {
  if (!batch.preferences) return;
  await transaction.objectStore("preferences").put({ userId, ...batch.preferences });
}

async function writeListeningSessions(
  transaction: MirrorTransaction,
  userId: string,
  batch: PullBatch,
): Promise<void> {
  const store = transaction.objectStore("listeningSessions");
  await Promise.all(
    batch.listeningSessions.map((session) => {
      const record: MirrorListeningSession = {
        key: mirrorKey(userId, session.id),
        userId,
        sessionId: session.id,
        bookId: session.bookId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        startPositionMs: session.startPositionMs,
        endPositionMs: session.endPositionMs,
        listenedMs: session.listenedMs,
      };
      return store.put(record);
    }),
  );
}

async function applyTombstones(
  transaction: MirrorTransaction,
  userId: string,
  batch: PullBatch,
  digestedBookIds: readonly string[] | undefined,
): Promise<void> {
  const doomedSet = new Set((batch.tombstones || []).map((tombstone) => tombstone.bookId));
  const localKeys = await transaction.objectStore("books").index("by-user").getAllKeys(userId);
  const localIds = localKeys.map(mirrorKeyTail);
  if (batch.complete && !batch.liveBookIds && digestedBookIds) {
    if (!sameIds(localIds, digestedBookIds)) throw new LiveBookSetChangedError();
  }
  if (batch.liveBookIds) {
    const live = new Set(batch.liveBookIds);
    for (const bookId of localIds) if (!live.has(bookId)) doomedSet.add(bookId);
  }
  const localIdSet = new Set(localIds);
  const doomed = [...doomedSet].filter((bookId) => localIdSet.has(bookId));
  if (!doomed.length) return;

  const doomedIds = new Set(doomed);
  const books = transaction.objectStore("books");
  const chapters = transaction.objectStore("chapters");
  const bookTags = transaction.objectStore("bookTags");
  const playbackStates = transaction.objectStore("playbackStates");
  const collectionBooks = transaction.objectStore("collectionBooks");
  const listeningSessions = transaction.objectStore("listeningSessions");

  const [edgeKeys, sessionKeyGroups] = await Promise.all([
    collectionBooks.index("by-user").getAllKeys(userId),
    Promise.all(
      doomed.map((bookId) => listeningSessions.index("by-user-book").getAllKeys([userId, bookId])),
    ),
  ]);

  await Promise.all([
    ...doomed.flatMap((bookId) => [
      books.delete(mirrorKey(userId, bookId)),
      playbackStates.delete(mirrorKey(userId, bookId)),
      chapters.delete(mirrorPrefixRange(userId, bookId)),
      bookTags.delete(mirrorPrefixRange(userId, bookId)),
    ]),
    ...edgeKeys
      .filter((key) => doomedIds.has(mirrorKeyTail(key)))
      .map((key) => collectionBooks.delete(key)),
    ...sessionKeyGroups.flat().map((key) => listeningSessions.delete(key)),
  ]);
}

export async function purgeUser(userId: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction(MIRROR_STORES, "readwrite");

  const books = transaction.objectStore("books");
  const chapters = transaction.objectStore("chapters");
  const playbackStates = transaction.objectStore("playbackStates");
  const tags = transaction.objectStore("tags");
  const bookTags = transaction.objectStore("bookTags");
  const collections = transaction.objectStore("collections");
  const collectionBooks = transaction.objectStore("collectionBooks");
  const listeningSessions = transaction.objectStore("listeningSessions");
  const userRange = IDBKeyRange.bound([userId], [userId, "￿"]);

  const [
    bookKeys,
    chapterKeys,
    stateKeys,
    tagKeys,
    edgeKeys,
    collectionKeys,
    memberKeys,
    sessionKeys,
  ] = await Promise.all([
    books.index("by-user").getAllKeys(userId),
    chapters.index("by-user-book").getAllKeys(userRange),
    playbackStates.index("by-user").getAllKeys(userId),
    tags.index("by-user").getAllKeys(userId),
    bookTags.index("by-user").getAllKeys(userId),
    collections.index("by-user").getAllKeys(userId),
    collectionBooks.index("by-user").getAllKeys(userId),
    listeningSessions.index("by-user-book").getAllKeys(userRange),
  ]);

  await Promise.all([
    ...bookKeys.map((key) => books.delete(key)),
    ...chapterKeys.map((key) => chapters.delete(key)),
    ...stateKeys.map((key) => playbackStates.delete(key)),
    ...tagKeys.map((key) => tags.delete(key)),
    ...edgeKeys.map((key) => bookTags.delete(key)),
    ...collectionKeys.map((key) => collections.delete(key)),
    ...memberKeys.map((key) => collectionBooks.delete(key)),
    ...sessionKeys.map((key) => listeningSessions.delete(key)),
    transaction.objectStore("preferences").delete(userId),
    transaction.objectStore("syncMeta").delete(userId),
  ]);

  await transaction.done;
}

export async function getSyncMeta(userId: string): Promise<MirrorSyncMeta | undefined> {
  const db = await database();
  return db.get("syncMeta", userId);
}

export async function healMirrorPlaybackFromLocal(userId: string): Promise<number> {
  assertAccountWritable(userId);
  await applyPendingProgressNormalizationsForUser(userId);
  const local = listLocalPlaybackStates(userId);
  if (!local.length) return 0;
  const db = await database();
  assertAccountWritable(userId);
  const transaction = db.transaction(["playbackStates", "downloads"], "readwrite");
  const states = transaction.objectStore("playbackStates");
  const downloads = transaction.objectStore("downloads");
  let healed = 0;

  try {
    for (const { bookId, state } of local) {
      const key = mirrorKey(userId, bookId);
      const [existing, download] = await Promise.all([states.get(key), downloads.get(key)]);
      const localRateClock = state.playbackRateOccurredAt ?? state.writtenAt ?? state.occurredAt;
      const localCompletedClock = state.completedOccurredAt ?? state.writtenAt ?? state.occurredAt;
      const existingRateClock = momentOf(
        existing?.playbackRateOccurredAt ?? existing?.stateOccurredAt ?? existing?.eventOccurredAt,
      );
      const existingCompletedClock = momentOf(
        existing?.completedOccurredAt ?? existing?.stateOccurredAt ?? existing?.eventOccurredAt,
      );
      const positionWins = state.occurredAt > momentOf(existing?.eventOccurredAt);
      const playbackRateWins =
        typeof state.playbackRate === "number" && localRateClock > existingRateClock;
      const completedWins =
        typeof state.completed === "boolean" && localCompletedClock > existingCompletedClock;
      if (!positionWins && !playbackRateWins && !completedWins) continue;

      const eventOccurredAt = positionWins
        ? new Date(state.occurredAt).toISOString()
        : (existing?.eventOccurredAt ?? new Date(state.occurredAt).toISOString());
      const playbackRateOccurredAt = playbackRateWins
        ? new Date(localRateClock).toISOString()
        : (existing?.playbackRateOccurredAt ?? existing?.stateOccurredAt ?? eventOccurredAt);
      const completedOccurredAt = completedWins
        ? new Date(localCompletedClock).toISOString()
        : (existing?.completedOccurredAt ?? existing?.stateOccurredAt ?? eventOccurredAt);
      const record: MirrorPlaybackState = {
        key,
        userId,
        bookId,
        positionMs: positionWins ? state.positionMs : (existing?.positionMs ?? state.positionMs),
        playbackRate: playbackRateWins
          ? (state.playbackRate ?? existing?.playbackRate ?? 1)
          : (existing?.playbackRate ?? state.playbackRate ?? 1),
        completed: completedWins
          ? (state.completed ?? existing?.completed ?? false)
          : (existing?.completed ?? state.completed ?? false),
        deviceId: existing?.deviceId ?? "",
        deviceSequence: existing?.deviceSequence ?? 0,
        eventOccurredAt,
        playbackRateOccurredAt,
        completedOccurredAt,
        stateOccurredAt: laterClock(playbackRateOccurredAt, completedOccurredAt),
        updatedAt: new Date(
          Math.max(
            Date.parse(eventOccurredAt),
            Date.parse(playbackRateOccurredAt),
            Date.parse(completedOccurredAt),
          ),
        ).toISOString(),
      };
      await states.put(record);
      if (download) {
        await downloads.put({
          ...download,
          book: {
            ...download.book,
            ...(positionWins
              ? {
                  initialPositionMs: record.positionMs,
                  initialProgressOccurredAt: eventOccurredAt,
                }
              : {}),
            ...(playbackRateWins ? { initialPlaybackRate: record.playbackRate } : {}),
            ...(playbackRateWins ? { initialPlaybackRateOccurredAt: playbackRateOccurredAt } : {}),
            ...(completedWins
              ? {
                  completed: record.completed,
                  initialCompletedOccurredAt: completedOccurredAt,
                }
              : {}),
          },
        });
      }
      healed += 1;
    }
    assertAccountWritable(userId);
    await transaction.done;
    return healed;
  } catch (error) {
    abortQuietly(transaction);
    throw error;
  }
}

function momentOf(isoTimestamp: string | null | undefined): number {
  if (!isoTimestamp) return 0;
  const parsed = Date.parse(isoTimestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function laterClock(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export async function localLiveBooks(userId: string): Promise<{ ids: string[]; digest: string }> {
  const db = await database();
  const ids = (await db.getAllKeysFromIndex("books", "by-user", userId)).map(mirrorKeyTail);
  return { ids, digest: await liveBookDigest(ids) };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((id, index) => id === sortedRight[index]);
}

export async function readMirrorLibrary(userId: string): Promise<{
  books: LibraryBook[];
  tags: string[];
  continueBook: LibraryBook | null;
}> {
  const db = await database();
  const transaction = db.transaction(["books", "playbackStates", "bookTags", "tags"], "readonly");
  const [books, states, edges, tags] = await Promise.all([
    transaction.objectStore("books").index("by-user").getAll(userId),
    transaction.objectStore("playbackStates").index("by-user").getAll(userId),
    transaction.objectStore("bookTags").index("by-user").getAll(userId),
    transaction.objectStore("tags").index("by-user").getAll(userId),
    transaction.done,
  ]);

  const nameByTagId = new Map(tags.map((tag) => [tag.tagId, tag.name]));
  const tagsByBook = new Map<string, string[]>();
  for (const edge of edges) {
    const name = nameByTagId.get(edge.tagId);
    if (!name) continue;
    const names = tagsByBook.get(edge.bookId);
    if (names) names.push(name);
    else tagsByBook.set(edge.bookId, [name]);
  }
  for (const names of tagsByBook.values()) names.sort(byName);

  const statesByBook = new Map(states.map((state) => [state.bookId, state]));
  const rows = books.map((book) =>
    toLibraryBook(book, statesByBook.get(book.bookId), tagsByBook.get(book.bookId) ?? []),
  );
  return {
    books: rows,
    tags: tags.map((tag) => tag.name).sort(byName),
    continueBook: selectContinueBook(rows),
  };
}

function byName(left: string, right: string): number {
  return left.localeCompare(right);
}

function toLibraryBook(
  book: MirrorBook,
  state: MirrorPlaybackState | undefined,
  tags: string[],
): LibraryBook {
  return {
    id: book.bookId,
    title: book.title,
    author: book.author,
    narrator: book.narrator,
    series: book.series,
    chapterDiagnostic: book.chapterDiagnostic,
    archivedAt: book.archivedAt,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    tags,
    durationMs: book.media?.durationMs ?? null,
    positionMs: state?.positionMs ?? null,
    completed: state?.completed ?? null,
    progressUpdatedAt: state?.updatedAt ?? null,
  };
}

export async function getMirrorPlayerBook(
  userId: string,
  bookId: string,
): Promise<MirrorPlayerBook | null> {
  await applyPendingProgressNormalizations(userId, bookId);
  const db = await database();
  const transaction = db.transaction(["books", "chapters", "playbackStates"], "readonly");
  const key = mirrorKey(userId, bookId);
  const [book, chapters, state] = await Promise.all([
    transaction.objectStore("books").get(key),
    transaction.objectStore("chapters").index("by-user-book").getAll([userId, bookId]),
    transaction.objectStore("playbackStates").get(key),
    transaction.done,
  ]);
  if (!book?.media?.durationMs) return null;
  const fingerprintKind = book.media.fingerprintKind;
  return {
    playerBook: {
      id: book.bookId,
      title: book.title,
      author: book.author,
      durationMs: book.media.durationMs,
      mediaUrl: "",
      coverUrl: null,
      chapters: chapters.map((chapter) => ({
        id: `${book.bookId}:${chapter.position}`,
        position: chapter.position,
        title: chapter.title,
        startMs: chapter.startMs,
        endMs: chapter.endMs,
      })),
      initialPositionMs: state?.positionMs ?? 0,
      initialProgressOccurredAt: state?.eventOccurredAt ?? null,
      initialPlaybackRate: state?.playbackRate ?? 1,
      initialPlaybackRateOccurredAt:
        state?.playbackRateOccurredAt ?? state?.stateOccurredAt ?? state?.eventOccurredAt ?? null,
      completed: state?.completed ?? false,
      initialCompletedOccurredAt:
        state?.completedOccurredAt ?? state?.stateOccurredAt ?? state?.eventOccurredAt ?? null,
    },
    mediaFingerprint: book.media.fingerprint,
    mediaFingerprintKind:
      fingerprintKind === "sample-v1" || fingerprintKind === "sha256-v1" ? fingerprintKind : null,
    mediaRenditionKey: book.media.renditionKey || "source-v1",
    byteSize: book.media.byteSize,
    sourceFilename: book.media.originalFilename,
    sourceMimeType: book.media.mimeType,
  };
}

export async function listMirrorCollections(
  userId: string,
  bookId: string,
): Promise<Array<{ id: string; name: string; includesBook: boolean }>> {
  const db = await database();
  const transaction = db.transaction(["collections", "collectionBooks"], "readonly");
  const [collections, members] = await Promise.all([
    transaction.objectStore("collections").index("by-user").getAll(userId),
    transaction.objectStore("collectionBooks").index("by-user").getAll(userId),
    transaction.done,
  ]);
  const includes = new Set(
    members.filter((member) => member.bookId === bookId).map((member) => member.collectionId),
  );
  return collections
    .map((collection) => ({
      id: collection.collectionId,
      name: collection.name,
      includesBook: includes.has(collection.collectionId),
    }))
    .sort((left, right) => byName(left.name, right.name));
}
