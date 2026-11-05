import { openDB, type DBSchema } from "idb";

import type { PlayerBook } from "@/domain/player";
import type { TranscriptSentence } from "@/domain/transcript";
import { withKeyedLock } from "@/lib/keyed-lock";

const DATABASE_NAME = "chapterline-offline-v1";
export const MEDIA_CACHE = "chapterline-media-v2";

export type OfflineBook = {
  key: string;
  userId: string;
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl" | "coverThumbUrl">;
  offlineMediaUrl: string;
  offlineCoverUrl: string | null;
  offlineCoverThumbUrl?: string | null;
  byteSize: number;
  downloadedAt: string;
  mediaMissingSince?: string | null;
};

export class OfflineStorageUnavailableError extends Error {
  constructor() {
    super("This device's offline storage is temporarily unavailable.");
    this.name = "OfflineStorageUnavailableError";
  }
}

export type StoredChapterTranscript = {
  key: string;
  userId: string;
  bookId: string;
  chapterIndex: number;
  granularity: "word" | "sentence";
  sentences: TranscriptSentence[];
};

type MirrorMediaAsset = {
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  fingerprint: string;
  fingerprintKind: string;
  renditionKey: string;
  durationMs: number;
};

export type MirrorBook = {
  key: string;
  userId: string;
  bookId: string;
  title: string;
  author: string;
  narrator: string | null;
  description: string | null;
  series: string | null;
  seriesPosition: string | null;
  chapterDiagnostic: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  media: MirrorMediaAsset | null;
  searchText: string;
};

export type MirrorChapter = {
  key: string;
  userId: string;
  bookId: string;
  position: number;
  title: string;
  startMs: number;
  endMs: number;
};

export type MirrorPlaybackState = {
  key: string;
  userId: string;
  bookId: string;
  positionMs: number;
  playbackRate: number;
  completed: boolean;
  deviceId: string;
  deviceSequence: number;
  eventOccurredAt: string;
  playbackRateOccurredAt?: string;
  completedOccurredAt?: string;
  stateOccurredAt?: string;
  updatedAt: string;
};

export type MirrorTag = {
  key: string;
  userId: string;
  tagId: string;
  name: string;
};

export type MirrorBookTag = {
  key: string;
  userId: string;
  bookId: string;
  tagId: string;
};

export type MirrorCollection = {
  key: string;
  userId: string;
  collectionId: string;
  name: string;
  updatedAt: string;
};

export type MirrorCollectionBook = {
  key: string;
  userId: string;
  collectionId: string;
  bookId: string;
  position: number;
};

type MirrorPreferences = {
  userId: string;
  skipBackMs: number;
  skipForwardMs: number;
  smartRewind: boolean;
  autoplayNextInCollection: boolean;
  updatedAt: string;
};

export type MirrorListeningSession = {
  key: string;
  userId: string;
  sessionId: string;
  bookId: string;
  startedAt: string;
  endedAt: string;
  startPositionMs: number;
  endPositionMs: number;
  listenedMs: number;
};

export type MirrorSyncMeta = {
  userId: string;
  cursor: string;
  lastSyncedAt: string;
};

export interface OfflineDatabase extends DBSchema {
  downloads: {
    key: string;
    value: OfflineBook;
    indexes: { "by-user": string };
  };
  transcripts: {
    key: string;
    value: StoredChapterTranscript;
    indexes: { "by-user": string };
  };
  deletions: {
    key: string;
    value: {
      key: string;
      userId: string;
      bookId: string;
      operationId?: string;
      offlineMediaUrl?: string;
      offlineCoverUrl?: string | null;
      offlineCoverThumbUrl?: string | null;
      clearPlaybackHistory?: boolean;
      completedAt?: number;
    };
    indexes: { "by-user": string };
  };
  cacheEntries: {
    key: string;
    value: { url: string; userId: string; bookId: string };
    indexes: { "by-user": string };
  };
  books: {
    key: string;
    value: MirrorBook;
    indexes: { "by-user": string; "by-user-updated": [string, string] };
  };
  chapters: {
    key: string;
    value: MirrorChapter;
    indexes: { "by-user-book": [string, string] };
  };
  playbackStates: {
    key: string;
    value: MirrorPlaybackState;
    indexes: { "by-user": string };
  };
  tags: {
    key: string;
    value: MirrorTag;
    indexes: { "by-user": string };
  };
  bookTags: {
    key: string;
    value: MirrorBookTag;
    indexes: { "by-user": string; "by-user-book": [string, string] };
  };
  collections: {
    key: string;
    value: MirrorCollection;
    indexes: { "by-user": string };
  };
  collectionBooks: {
    key: string;
    value: MirrorCollectionBook;
    indexes: { "by-user": string; "by-user-collection": [string, string] };
  };
  preferences: {
    key: string;
    value: MirrorPreferences;
  };
  listeningSessions: {
    key: string;
    value: MirrorListeningSession;
    indexes: { "by-user-book": [string, string] };
  };
  syncMeta: {
    key: string;
    value: MirrorSyncMeta;
  };
}

export type OfflineDb = Awaited<ReturnType<typeof database>>;

export function database() {
  return openDB<OfflineDatabase>(DATABASE_NAME, 7, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const downloads = db.createObjectStore("downloads", { keyPath: "key" });
        downloads.createIndex("by-user", "userId");
      }
      if (oldVersion < 2) {
        const deletions = db.createObjectStore("deletions", { keyPath: "key" });
        deletions.createIndex("by-user", "userId");
      }
      if (oldVersion < 4) {
        const entries = db.createObjectStore("cacheEntries", { keyPath: "url" });
        entries.createIndex("by-user", "userId");
      }
      if (oldVersion < 6) {
        const transcripts = db.createObjectStore("transcripts", { keyPath: "key" });
        transcripts.createIndex("by-user", "userId");
      }
      if (oldVersion < 7) {
        const mirrorBooks = db.createObjectStore("books", { keyPath: "key" });
        mirrorBooks.createIndex("by-user", "userId");
        mirrorBooks.createIndex("by-user-updated", ["userId", "updatedAt"]);

        db.createObjectStore("chapters", { keyPath: "key" }).createIndex("by-user-book", [
          "userId",
          "bookId",
        ]);

        db.createObjectStore("playbackStates", { keyPath: "key" }).createIndex("by-user", "userId");
        db.createObjectStore("tags", { keyPath: "key" }).createIndex("by-user", "userId");

        const mirrorBookTags = db.createObjectStore("bookTags", { keyPath: "key" });
        mirrorBookTags.createIndex("by-user", "userId");
        mirrorBookTags.createIndex("by-user-book", ["userId", "bookId"]);

        db.createObjectStore("collections", { keyPath: "key" }).createIndex("by-user", "userId");

        const mirrorCollectionBooks = db.createObjectStore("collectionBooks", { keyPath: "key" });
        mirrorCollectionBooks.createIndex("by-user", "userId");
        mirrorCollectionBooks.createIndex("by-user-collection", ["userId", "collectionId"]);

        db.createObjectStore("preferences", { keyPath: "userId" });

        db.createObjectStore("listeningSessions", { keyPath: "key" }).createIndex("by-user-book", [
          "userId",
          "bookId",
        ]);

        db.createObjectStore("syncMeta", { keyPath: "userId" });
      }
      if (oldVersion >= 1 && oldVersion < 5) {
        const downloads = transaction.objectStore("downloads");
        void downloads.openCursor().then(async function removeLegacyBookmarks(cursor) {
          if (!cursor) return;
          const record = cursor.value as OfflineBook & { bookmarks?: unknown };
          if ("bookmarks" in record) {
            const { bookmarks, ...clean } = record;
            void bookmarks;
            await cursor.update(clean);
          }
          await removeLegacyBookmarks(await cursor.continue());
        });
      }
    },
  });
}

export function offlineBookKey(userId: string, bookId: string) {
  return `${userId}:${bookId}`;
}

export function mirrorKey(userId: string, ...parts: string[]) {
  return [userId, ...parts].join(":");
}

export function mirrorChapterKey(userId: string, bookId: string, position: number) {
  return mirrorKey(userId, bookId, String(position).padStart(6, "0"));
}

export function mirrorKeyTail(key: string) {
  return key.slice(key.lastIndexOf(":") + 1);
}

export function mirrorPrefixRange(...parts: string[]) {
  const prefix = `${parts.join(":")}:`;
  return IDBKeyRange.bound(prefix, `${prefix}￿`);
}

export function withMediaWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  return withKeyedLock(`chapterline-media:${key}`, operation);
}
