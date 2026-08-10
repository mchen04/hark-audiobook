import type { LocalBookRegistration } from "@/domain/local-book";
import { isValidChapterSequence } from "@/domain/mp3";
import { assertAccountWritable } from "@/lib/account-deletion-fence";

import {
  database,
  mirrorChapterKey,
  mirrorKey,
  mirrorPrefixRange,
  type MirrorBook,
  type MirrorChapter,
  type MirrorPlaybackState,
  type OfflineBook,
} from "./db";

type CanonicalBook = OfflineBook["book"];

/** Makes an accepted local registration immediately available to offline routes. */
export async function projectLocalBookRegistration(
  userId: string,
  registration: LocalBookRegistration,
  canonical: CanonicalBook | null = null,
): Promise<void> {
  const chapters = canonical?.chapters || registration.chapters;
  const durationMs = canonical?.durationMs || registration.durationMs;
  if (!isValidChapterSequence(chapters, durationMs)) {
    throw new Error("The local book registration has an invalid chapter timeline.");
  }

  assertAccountWritable(userId);
  const db = await database();
  const transaction = db.transaction(["books", "chapters"], "readwrite");
  const books = transaction.objectStore("books");
  const chapterStore = transaction.objectStore("chapters");
  const key = mirrorKey(userId, registration.bookId);
  try {
    const [existing, existingChapters] = await Promise.all([
      books.get(key),
      chapterStore.index("by-user-book").getAll([userId, registration.bookId]),
    ]);
    const localBook = toMirrorBook(userId, registration, canonical, new Date().toISOString());

    if (!existing || !existing.media) {
      await books.put(existing ? { ...existing, media: localBook.media } : localBook);
    }
    if (!existingChapters.length) {
      for (const chapter of toMirrorChapters(userId, registration.bookId, chapters)) {
        await chapterStore.put(chapter);
      }
    }
    assertAccountWritable(userId);
    await transaction.done;
  } catch (error) {
    abortQuietly(transaction);
    throw error;
  }
}

/**
 * Moves the optimistic mirror aggregate after the server resolves a device id
 * to a pre-existing canonical book. This is idempotent: the outbox keeps the
 * registration until both the byte record and this projection have moved.
 */
export async function rekeyMirroredLocalBook(
  userId: string,
  fromBookId: string,
  toBookId: string,
  canonical: CanonicalBook | null,
): Promise<void> {
  if (!fromBookId || !toBookId || fromBookId === toBookId) return;
  assertAccountWritable(userId);
  const db = await database();
  const transaction = db.transaction(
    ["books", "chapters", "bookTags", "playbackStates", "collectionBooks", "listeningSessions"],
    "readwrite",
  );
  const books = transaction.objectStore("books");
  const chapters = transaction.objectStore("chapters");
  const bookTags = transaction.objectStore("bookTags");
  const playbackStates = transaction.objectStore("playbackStates");
  const collectionBooks = transaction.objectStore("collectionBooks");
  const listeningSessions = transaction.objectStore("listeningSessions");
  const fromKey = mirrorKey(userId, fromBookId);
  const toKey = mirrorKey(userId, toBookId);
  try {
    const [
      sourceBook,
      targetBook,
      sourceChapters,
      targetChapters,
      sourceTags,
      targetTags,
      sourceState,
      targetState,
      allCollectionEdges,
      sourceSessions,
    ] = await Promise.all([
      books.get(fromKey),
      books.get(toKey),
      chapters.index("by-user-book").getAll([userId, fromBookId]),
      chapters.index("by-user-book").getAll([userId, toBookId]),
      bookTags.index("by-user-book").getAll([userId, fromBookId]),
      bookTags.index("by-user-book").getAll([userId, toBookId]),
      playbackStates.get(fromKey),
      playbackStates.get(toKey),
      collectionBooks.index("by-user").getAll(userId),
      listeningSessions.index("by-user-book").getAll([userId, fromBookId]),
    ]);

    if (sourceBook && !targetBook) {
      await books.put(renameMirrorBook(sourceBook, toBookId, canonical));
    }
    if (sourceBook) await books.delete(fromKey);

    if (sourceBook && !targetChapters.length) {
      const chapterSource = canonical?.chapters || sourceChapters;
      for (const chapter of toMirrorChapters(userId, toBookId, chapterSource)) {
        await chapters.put(chapter);
      }
    }
    await chapters.delete(mirrorPrefixRange(userId, fromBookId));

    const targetTagKeys = new Set(targetTags.map((edge) => edge.key));
    for (const edge of sourceTags) {
      const key = mirrorKey(userId, toBookId, edge.tagId);
      if (!targetTagKeys.has(key)) {
        await bookTags.put({ ...edge, key, bookId: toBookId });
      }
    }
    await bookTags.delete(mirrorPrefixRange(userId, fromBookId));

    if (sourceState) {
      await playbackStates.put(
        targetState
          ? mergePlaybackState(sourceState, targetState, toBookId)
          : { ...sourceState, key: toKey, bookId: toBookId },
      );
      await playbackStates.delete(fromKey);
    }

    const targetCollectionKeys = new Set(
      allCollectionEdges.filter((edge) => edge.bookId === toBookId).map((edge) => edge.key),
    );
    for (const edge of allCollectionEdges.filter((candidate) => candidate.bookId === fromBookId)) {
      const key = mirrorKey(userId, edge.collectionId, toBookId);
      if (!targetCollectionKeys.has(key)) {
        await collectionBooks.put({ ...edge, key, bookId: toBookId });
      }
      await collectionBooks.delete(edge.key);
    }
    for (const session of sourceSessions) {
      await listeningSessions.put({ ...session, bookId: toBookId });
    }

    assertAccountWritable(userId);
    await transaction.done;
  } catch (error) {
    abortQuietly(transaction);
    throw error;
  }
}

function toMirrorBook(
  userId: string,
  registration: LocalBookRegistration,
  canonical: CanonicalBook | null,
  now: string,
): MirrorBook {
  const book: MirrorBook = {
    key: mirrorKey(userId, registration.bookId),
    userId,
    bookId: registration.bookId,
    title: canonical?.title || registration.title,
    author: canonical?.author || registration.author,
    narrator: registration.narrator,
    description: null,
    series: null,
    seriesPosition: null,
    chapterDiagnostic: registration.chapterDiagnostic,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    media: {
      originalFilename: decodeFilename(registration.fileName),
      mimeType: registration.mimeType,
      byteSize: registration.byteSize,
      fingerprint: registration.fingerprint,
      fingerprintKind: registration.fingerprintKind,
      renditionKey: registration.renditionKey,
      durationMs: canonical?.durationMs || registration.durationMs,
    },
    searchText: "",
  };
  return { ...book, searchText: searchTextFor(book) };
}

function toMirrorChapters(
  userId: string,
  bookId: string,
  chapters: LocalBookRegistration["chapters"],
): MirrorChapter[] {
  return chapters.map((chapter) => ({
    key: mirrorChapterKey(userId, bookId, chapter.position),
    userId,
    bookId,
    position: chapter.position,
    title: chapter.title,
    startMs: chapter.startMs,
    endMs: chapter.endMs,
  }));
}

function renameMirrorBook(
  book: MirrorBook,
  bookId: string,
  canonical: CanonicalBook | null,
): MirrorBook {
  const renamed: MirrorBook = {
    ...book,
    key: mirrorKey(book.userId, bookId),
    bookId,
    ...(canonical
      ? {
          title: canonical.title,
          author: canonical.author,
          media: book.media ? { ...book.media, durationMs: canonical.durationMs } : null,
        }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  return { ...renamed, searchText: searchTextFor(renamed) };
}

function mergePlaybackState(
  source: MirrorPlaybackState,
  target: MirrorPlaybackState,
  bookId: string,
): MirrorPlaybackState {
  const sourceRateClock = rateClock(source);
  const targetRateClock = rateClock(target);
  const sourceCompletedClock = completedClock(source);
  const targetCompletedClock = completedClock(target);
  const sourceIsLatest = newerClock(source.updatedAt, target.updatedAt);
  const envelope = sourceIsLatest ? source : target;
  const positionWins = newerClock(source.eventOccurredAt, target.eventOccurredAt);
  const rateWins = newerClock(sourceRateClock, targetRateClock);
  const completedWins = newerClock(sourceCompletedClock, targetCompletedClock);
  const playbackRateOccurredAt = rateWins ? sourceRateClock : targetRateClock;
  const completedOccurredAt = completedWins ? sourceCompletedClock : targetCompletedClock;
  return {
    ...envelope,
    key: mirrorKey(source.userId, bookId),
    bookId,
    positionMs: positionWins ? source.positionMs : target.positionMs,
    eventOccurredAt: positionWins ? source.eventOccurredAt : target.eventOccurredAt,
    playbackRate: rateWins ? source.playbackRate : target.playbackRate,
    playbackRateOccurredAt,
    completed: completedWins ? source.completed : target.completed,
    completedOccurredAt,
    stateOccurredAt: newerClock(playbackRateOccurredAt, completedOccurredAt)
      ? playbackRateOccurredAt
      : completedOccurredAt,
    updatedAt: newerClock(source.updatedAt, target.updatedAt) ? source.updatedAt : target.updatedAt,
  };
}

function rateClock(state: MirrorPlaybackState): string {
  return state.playbackRateOccurredAt || state.stateOccurredAt || state.eventOccurredAt;
}

function completedClock(state: MirrorPlaybackState): string {
  return state.completedOccurredAt || state.stateOccurredAt || state.eventOccurredAt;
}

function newerClock(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return !Number.isFinite(rightMs) || (Number.isFinite(leftMs) && leftMs >= rightMs);
}

function searchTextFor(book: MirrorBook): string {
  return [book.title, book.author, book.narrator || "", book.series || ""].join(" ").toLowerCase();
}

function decodeFilename(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function abortQuietly(transaction: { abort: () => void; done: Promise<unknown> }): void {
  void transaction.done.catch(() => undefined);
  try {
    transaction.abort();
  } catch {
    // A failing request already aborted it; same outcome.
  }
}
