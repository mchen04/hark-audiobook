import type { PlayerBook } from "@/domain/player";
import {
  assertAccountWritable,
  createAccountWriteScope,
  withAccountWriteLock,
} from "@/lib/account-deletion-fence";
import { throwIfAborted } from "@/lib/abort";
import { createCoverThumbnail } from "@/lib/cover-thumbnail";
import { runBounded } from "@/lib/run-bounded";

import { database, MEDIA_CACHE, offlineBookKey, withMediaWriteLock, type OfflineBook } from "./db";
import {
  deleteJournaledCacheEntries,
  deleteJournaledCacheEntry,
  deleteJournaledMedia,
} from "./deletion-journal";
import { getStoredOfflineBook } from "./library";

const MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;
// Overlaps file reads with cache commits while keeping at most ~12MB of audio
// in flight, well inside iOS WebKit's memory budget.
const MEDIA_WRITE_CONCURRENCY = 3;

/**
 * One book's media slot, held across a caller-owned sequence.
 *
 * An import writes three things under the id this device minted — the bytes,
 * the download record and the transcript — and a replay that learns the server
 * settled on a *different* id has to move all three
 * (`library.ts#reattachLocalBookIdentity`). Holding the slot for the whole
 * sequence is what stops the move from landing in the middle of it and leaving
 * whatever was written afterwards behind under a dead id.
 *
 * The handle is the proof of possession: `storeLocalBookMedia` re-acquires the
 * lock unless it is handed the slot for the very key it is about to write, so a
 * nested call cannot deadlock on a lock its own caller holds and an unrelated
 * caller cannot skip it by accident.
 */
declare const mediaSlotBrand: unique symbol;
export type MediaSlot = { readonly key: string; readonly [mediaSlotBrand]: true };
const heldMediaSlots = new WeakSet<MediaSlot>();

export type StreamedLocalMedia = {
  /** Append-only MP3 bytes; backpressure includes the Cache Storage write. */
  writable: WritableStream<Uint8Array>;
  commit: (
    book: Omit<PlayerBook, "mediaUrl" | "coverUrl">,
    targetSlot?: MediaSlot,
  ) => Promise<OfflineBook>;
  abort: (reason?: unknown) => Promise<void>;
};

export function withLocalMediaSlot<T>(
  userId: string,
  bookId: string,
  operation: (slot: MediaSlot) => Promise<T>,
): Promise<T> {
  const key = offlineBookKey(userId, bookId);
  return withMediaWriteLock(key, async () => {
    const slot = { key } as MediaSlot;
    heldMediaSlots.add(slot);
    try {
      return await operation(slot);
    } finally {
      heldMediaSlots.delete(slot);
    }
  });
}

/**
 * Stores an imported MP3 in bounded chunks. iOS WebKit has a much smaller
 * memory budget than desktop browsers, so neither import nor a later Range
 * request may materialize a whole audiobook-sized Blob.
 */
export async function storeLocalBookMedia(
  userId: string,
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl">,
  file: File,
  artwork: { data: Uint8Array; mimeType: string } | null,
  onProgress?: (fraction: number) => void,
  slot?: MediaSlot,
  signal?: AbortSignal,
): Promise<OfflineBook> {
  const key = offlineBookKey(userId, book.id);
  if (holdsMediaSlot(slot, key)) {
    return storeLocalBookMediaWithinFence(userId, book, file, artwork, onProgress, slot, signal);
  }
  const scope = createAccountWriteScope(userId, signal);
  try {
    return await withAccountWriteLock(userId, () =>
      storeLocalBookMediaWithinFence(
        userId,
        book,
        file,
        artwork,
        onProgress,
        undefined,
        scope.signal,
      ),
    );
  } finally {
    scope.release();
  }
}

async function storeLocalBookMediaWithinFence(
  userId: string,
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl">,
  file: File,
  artwork: { data: Uint8Array; mimeType: string } | null,
  onProgress?: (fraction: number) => void,
  slot?: MediaSlot,
  signal?: AbortSignal,
): Promise<OfflineBook> {
  throwIfAborted(signal);
  assertAccountWritable(userId);
  const key = offlineBookKey(userId, book.id);
  const startedAt = Date.now();
  const write = async () => {
    const pending = await (await database()).get("deletions", key);
    if (pending?.completedAt && pending.completedAt >= startedAt) {
      throw new Error("This download was removed while it was being saved.");
    }
    return storeLocalBookMediaUnlocked(userId, book, file, artwork, onProgress, startedAt, signal);
  };
  return holdsMediaSlot(slot, key) ? write() : withMediaWriteLock(key, write);
}

/**
 * Opens a crash-recoverable, bounded-memory media stream for generated MP3s.
 *
 * Every completed chunk is journaled before it enters Cache Storage. The
 * caller must hold `slot` until `commit` or `abort` completes; this prevents
 * another tab's orphan sweep from mistaking an in-progress narration for
 * garbage. A duplicate registration may commit under a different canonical
 * book id, in which case the journal ownership moves atomically first.
 */
export async function createStreamedLocalBookMedia(
  userId: string,
  bookId: string,
  estimatedBytes: number,
  slot: MediaSlot,
): Promise<StreamedLocalMedia> {
  assertAccountWritable(userId);
  const sourceKey = offlineBookKey(userId, bookId);
  if (!holdsMediaSlot(slot, sourceKey)) throw new Error("The generated media slot is not held.");
  await ensureStorageCapacity(estimatedBytes);
  if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);

  const startedAt = Date.now();
  const writer = await openChunkedMediaWriter(userId, bookId);
  let chunk = new Uint8Array(MEDIA_CHUNK_BYTES);
  let chunkLength = 0;
  let chunkCount = 0;
  let totalBytes = 0;
  let closed = false;
  let committed = false;

  const flushChunk = async () => {
    if (!chunkLength) return;
    await writer.writeChunk(chunkCount, chunk.slice(0, chunkLength));
    chunkCount += 1;
    chunk = new Uint8Array(MEDIA_CHUNK_BYTES);
    chunkLength = 0;
  };

  const append = async (bytes: Uint8Array) => {
    if (closed) throw new Error("The generated media stream is already closed.");
    let offset = 0;
    totalBytes += bytes.byteLength;
    while (offset < bytes.byteLength) {
      const length = Math.min(MEDIA_CHUNK_BYTES - chunkLength, bytes.byteLength - offset);
      chunk.set(bytes.subarray(offset, offset + length), chunkLength);
      chunkLength += length;
      offset += length;
      if (chunkLength === MEDIA_CHUNK_BYTES) await flushChunk();
    }
  };

  const close = async () => {
    if (closed) return;
    if (!totalBytes) throw new Error("Kestrel did not produce any audio.");
    await flushChunk();
    await writer.finish(totalBytes, chunkCount);
    closed = true;
  };

  const abort = async () => {
    if (committed) return;
    closed = true;
    await writer.cleanup();
  };

  const writable = new WritableStream<Uint8Array>({
    write: append,
    close,
    abort,
  });

  const commit = async (
    book: Omit<PlayerBook, "mediaUrl" | "coverUrl">,
    targetSlot?: MediaSlot,
  ): Promise<OfflineBook> => {
    if (!closed) throw new Error("The generated media stream has not been finalized.");
    if (committed) throw new Error("The generated media stream was already committed.");
    const targetKey = offlineBookKey(userId, book.id);
    const write = async () => {
      const record = await commitChunkedMedia(
        writer,
        book,
        totalBytes,
        { url: null, thumbUrl: null },
        startedAt,
      );
      committed = true;
      return record;
    };
    return holdsMediaSlot(targetSlot, targetKey) ? write() : withMediaWriteLock(targetKey, write);
  };

  return { writable, commit, abort };
}

function holdsMediaSlot(slot: MediaSlot | undefined, key: string): slot is MediaSlot {
  return Boolean(slot && slot.key === key && heldMediaSlots.has(slot));
}

type ChunkedMediaWriter = Awaited<ReturnType<typeof openChunkedMediaWriter>>;

async function openChunkedMediaWriter(userId: string, bookId: string) {
  const offlineMediaUrl = `/offline-media/${crypto.randomUUID()}`;
  const db = await database();
  const cache = await caches.open(MEDIA_CACHE);
  const journaledUrls: string[] = [];
  let cleanupPromise: Promise<void> | null = null;

  const journal = async (urls: string[]) => {
    const transaction = db.transaction("cacheEntries", "readwrite");
    await Promise.all([
      ...urls.map((url) => transaction.store.put({ url, userId, bookId })),
      transaction.done,
    ]);
    journaledUrls.push(...urls);
  };

  const chunkUrl = (index: number) => `${offlineMediaUrl}/chunk/${index}`;

  return {
    userId,
    bookId,
    offlineMediaUrl,
    db,
    cache,
    journaledUrls,
    chunkUrl,
    journal,
    async writeChunk(index: number, body: BodyInit, alreadyJournaled = false) {
      const url = chunkUrl(index);
      if (!alreadyJournaled) await journal([url]);
      await cache.put(
        url,
        new Response(body, { headers: { "Content-Type": "application/octet-stream" } }),
      );
    },
    async finish(byteSize: number, chunkCount: number, alreadyJournaled = false) {
      if (!alreadyJournaled) await journal([offlineMediaUrl]);
      await cache.put(offlineMediaUrl, chunkManifest(byteSize, chunkCount));
    },
    async reassignOwner(targetBookId: string) {
      if (targetBookId === bookId) return;
      const transaction = db.transaction("cacheEntries", "readwrite");
      for (const url of journaledUrls) {
        await transaction.store.put({ url, userId, bookId: targetBookId });
      }
      await transaction.done;
    },
    cleanup() {
      cleanupPromise ??= deleteJournaledCacheEntries(db, cache, [...journaledUrls]).catch(
        () => undefined,
      );
      return cleanupPromise;
    },
  };
}

function chunkManifest(byteSize: number, chunkCount: number): Response {
  return new Response(
    JSON.stringify({
      format: "chapterline-chunked-media-v1",
      byteSize,
      chunkSize: MEDIA_CHUNK_BYTES,
      chunkCount,
    }),
    {
      headers: {
        "Content-Type": "application/vnd.chapterline.media+json",
        "X-Chapterline-Media-Format": "chunked-v1",
      },
    },
  );
}

async function commitChunkedMedia(
  writer: ChunkedMediaWriter,
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl">,
  byteSize: number,
  cover: { url: string | null; thumbUrl: string | null },
  startedAt: number,
): Promise<OfflineBook> {
  const { userId, db, cache, offlineMediaUrl } = writer;
  const key = offlineBookKey(userId, book.id);
  const pending = await db.get("deletions", key);
  if (pending?.completedAt && pending.completedAt >= startedAt) {
    await writer.cleanup();
    for (const url of [cover.url, cover.thumbUrl]) {
      if (url) await deleteJournaledCacheEntry(db, cache, url).catch(() => false);
    }
    throw new Error("This download was removed while it was being saved.");
  }

  const record: OfflineBook = {
    key,
    userId,
    book,
    offlineMediaUrl,
    offlineCoverUrl: cover.url,
    offlineCoverThumbUrl: cover.thumbUrl,
    byteSize,
    downloadedAt: new Date().toISOString(),
    mediaMissingSince: null,
  };
  let existing: OfflineBook | undefined;
  try {
    assertAccountWritable(userId);
    await writer.reassignOwner(book.id);
    existing = await getStoredOfflineBook(userId, book.id);
    await db.put("downloads", record);
    const [storedRecord, storedMedia] = await Promise.all([
      db.get("downloads", key),
      cache.match(offlineMediaUrl),
    ]);
    if (storedRecord?.offlineMediaUrl !== offlineMediaUrl || !storedMedia) {
      throw new Error("Offline media verification failed.");
    }
    if (existing) {
      await deleteJournaledMedia(db, cache, existing.offlineMediaUrl).catch(() => false);
      for (const url of [existing.offlineCoverUrl, existing.offlineCoverThumbUrl]) {
        if (url) await deleteJournaledCacheEntry(db, cache, url).catch(() => false);
      }
    }
    return record;
  } catch (error) {
    const current = await db.get("downloads", key).catch(() => undefined);
    if (current?.offlineMediaUrl === offlineMediaUrl) {
      if (existing) await db.put("downloads", existing).catch(() => undefined);
      else await db.delete("downloads", key).catch(() => undefined);
    }
    await writer.cleanup();
    for (const url of [cover.url, cover.thumbUrl]) {
      if (url) await deleteJournaledCacheEntry(db, cache, url).catch(() => false);
    }
    throw offlineStorageError(error);
  }
}

async function storeLocalBookMediaUnlocked(
  userId: string,
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl">,
  file: File,
  artwork: { data: Uint8Array; mimeType: string } | null,
  onProgress?: (fraction: number) => void,
  startedAt = Date.now(),
  signal?: AbortSignal,
): Promise<OfflineBook> {
  throwIfAborted(signal);
  await ensureStorageCapacity(file.size);
  if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);

  const writer = await openChunkedMediaWriter(userId, book.id);
  const { offlineMediaUrl, db, cache } = writer;
  const chunkCount = Math.ceil(file.size / MEDIA_CHUNK_BYTES);
  const chunkUrls = Array.from({ length: chunkCount }, (_, index) => writer.chunkUrl(index));
  const cleanupUrls: string[] = [...chunkUrls, offlineMediaUrl];
  try {
    // Journal rows for every chunk land in one transaction before any bytes
    // move: the journal-before-bytes invariant is unchanged, but a
    // thousand-chunk audiobook costs one IndexedDB commit instead of one per
    // chunk.
    await writer.journal(cleanupUrls);
    let storedChunks = 0;
    let writeFailed = false;
    let writeFailure: unknown;
    // Workers swallow their own failure and drain, so no chunk write is still
    // in flight when cleanup below starts deleting what they wrote.
    await runBounded(
      Array.from({ length: chunkCount }, (_, index) => index),
      MEDIA_WRITE_CONCURRENCY,
      async (index) => {
        if (writeFailed || signal?.aborted) return;
        try {
          await writer.writeChunk(
            index,
            file.slice(
              index * MEDIA_CHUNK_BYTES,
              Math.min(file.size, (index + 1) * MEDIA_CHUNK_BYTES),
            ),
            true,
          );
        } catch (error) {
          if (!writeFailed) {
            writeFailed = true;
            writeFailure = error;
          }
          return;
        }
        storedChunks += 1;
        onProgress?.(storedChunks / (chunkCount + 1));
      },
    );
    throwIfAborted(signal);
    if (writeFailed) throw writeFailure;
    await writer.finish(file.size, chunkCount, true);
    onProgress?.(1);
  } catch (error) {
    await writer.cleanup();
    throwIfAborted(signal);
    throw offlineStorageError(error);
  }

  let offlineCoverUrl: string | null = null;
  let offlineCoverThumbUrl: string | null = null;
  if (artwork) {
    try {
      throwIfAborted(signal);
      offlineCoverUrl = `${offlineMediaUrl}-cover`;
      await db.put("cacheEntries", { url: offlineCoverUrl, userId, bookId: book.id });
      await cache.put(
        offlineCoverUrl,
        new Response(new Blob([Uint8Array.from(artwork.data)], { type: artwork.mimeType }), {
          headers: { "Content-Type": artwork.mimeType },
        }),
      );
      const thumbnail = await createCoverThumbnail(artwork.data, artwork.mimeType);
      throwIfAborted(signal);
      if (thumbnail) {
        offlineCoverThumbUrl = `${offlineCoverUrl}-thumb`;
        await db.put("cacheEntries", { url: offlineCoverThumbUrl, userId, bookId: book.id });
        await cache.put(
          offlineCoverThumbUrl,
          new Response(thumbnail.data, { headers: { "Content-Type": thumbnail.mimeType } }),
        );
      }
    } catch {
      for (const url of [offlineCoverThumbUrl, offlineCoverUrl]) {
        if (url) await deleteJournaledCacheEntry(db, cache, url).catch(() => false);
      }
      throwIfAborted(signal);
      offlineCoverUrl = null;
      offlineCoverThumbUrl = null;
    }
  }

  throwIfAborted(signal);
  return commitChunkedMedia(
    writer,
    book,
    file.size,
    { url: offlineCoverUrl, thumbUrl: offlineCoverThumbUrl },
    startedAt,
  );
}

export function hasEnoughCapacity(
  estimate: { quota?: number; usage?: number },
  requiredBytes: number,
) {
  if (!requiredBytes || !estimate.quota) return true;
  const available = estimate.quota - (estimate.usage || 0);
  return available >= requiredBytes * 1.08;
}

async function ensureStorageCapacity(requiredBytes: number) {
  if (!navigator.storage?.estimate) return;
  const estimate = await navigator.storage.estimate().catch(() => null);
  if (!estimate) return;
  if (!hasEnoughCapacity(estimate, requiredBytes)) {
    throw new Error("This device does not have enough free storage.");
  }
}

function isQuotaError(error: unknown) {
  return error instanceof DOMException && error.name === "QuotaExceededError";
}

function offlineStorageError(error: unknown) {
  if (
    error instanceof Error &&
    error.message === "This device does not have enough free storage."
  ) {
    return error;
  }
  if (isQuotaError(error)) return new Error("This device does not have enough free storage.");
  return new Error(
    "This device could not save the audiobook for offline playback. Check available storage and try again.",
    { cause: error },
  );
}
