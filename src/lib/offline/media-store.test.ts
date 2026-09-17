import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import { withAccountWriteLock } from "@/lib/account-deletion-fence";

import { database, MEDIA_CACHE, offlineBookKey } from "./db";
import {
  createStreamedLocalBookMedia,
  hasEnoughCapacity,
  type MediaSlot,
  storeLocalBookMedia,
  withLocalMediaSlot,
} from "./media-store";

type FakeCache = { store: Map<string, Response> };

function fakeCaches() {
  const stores = new Map<string, FakeCache>();
  const open = async (name: string) => {
    const cache = stores.get(name) || { store: new Map<string, Response>() };
    stores.set(name, cache);
    return {
      async put(request: Request | string, response: Response) {
        cache.store.set(typeof request === "string" ? request : request.url, response);
      },
      async match(request: Request | string) {
        return cache.store.get(typeof request === "string" ? request : request.url);
      },
      async delete(request: Request | string) {
        return cache.store.delete(typeof request === "string" ? request : request.url);
      },
    };
  };
  return { api: { open }, stores };
}

let fakeCacheStorage: ReturnType<typeof fakeCaches>;

beforeEach(() => {
  vi.stubGlobal("indexedDB", new FakeIDBFactory());
  vi.stubGlobal("navigator", {
    storage: {
      estimate: vi.fn(async () => ({ quota: 100_000_000, usage: 0 })),
      persist: vi.fn(async () => true),
    },
  });
  fakeCacheStorage = fakeCaches();
  vi.stubGlobal("caches", fakeCacheStorage.api);
});

describe("offline storage capacity", () => {
  it("allows unknown quotas and unknown file sizes", () => {
    expect(hasEnoughCapacity({}, 10_000)).toBe(true);
    expect(hasEnoughCapacity({ quota: 1_000, usage: 999 }, 0)).toBe(true);
  });

  it("reserves headroom instead of filling the device quota", () => {
    expect(hasEnoughCapacity({ quota: 1_000, usage: 100 }, 800)).toBe(true);
    expect(hasEnoughCapacity({ quota: 1_000, usage: 100 }, 850)).toBe(false);
  });
});

describe("generated media streaming", () => {
  it("rejects a forged media-slot-shaped object", async () => {
    const forged = { key: offlineBookKey("user", "minted") } as MediaSlot;

    await expect(createStreamedLocalBookMedia("user", "minted", 1, forged)).rejects.toThrow(
      /slot is not held/i,
    );
  });

  it("stores bounded chunks and commits a service-worker-readable manifest", async () => {
    const bytes = new Uint8Array(4 * 1024 * 1024 + 3).fill(7);
    const record = await withLocalMediaSlot("user", "minted", async (slot) => {
      const stream = await createStreamedLocalBookMedia("user", "minted", bytes.length, slot);
      const writer = stream.writable.getWriter();
      await writer.write(bytes.subarray(0, 123));
      await writer.write(bytes.subarray(123));
      await writer.close();
      return stream.commit(book("minted"), slot);
    });

    const cache = fakeCacheStorage.stores.get(MEDIA_CACHE)!.store;
    expect([...cache.keys()].sort()).toEqual([
      record.offlineMediaUrl,
      `${record.offlineMediaUrl}/chunk/0`,
      `${record.offlineMediaUrl}/chunk/1`,
    ]);
    const firstChunk = new Uint8Array(
      await cache.get(`${record.offlineMediaUrl}/chunk/0`)!.arrayBuffer(),
    );
    const secondChunk = new Uint8Array(
      await cache.get(`${record.offlineMediaUrl}/chunk/1`)!.arrayBuffer(),
    );
    expect(firstChunk).toHaveLength(4 * 1024 * 1024);
    expect(firstChunk.every((byte) => byte === 7)).toBe(true);
    expect(secondChunk).toEqual(new Uint8Array([7, 7, 7]));
    expect(await cache.get(record.offlineMediaUrl)!.json()).toMatchObject({
      format: "chapterline-chunked-media-v1",
      byteSize: bytes.length,
      chunkCount: 2,
    });
    expect(await (await database()).get("downloads", offlineBookKey("user", "minted"))).toEqual(
      record,
    );
  });

  it("moves cache ownership when registration resolves to a canonical book", async () => {
    await withLocalMediaSlot("user", "minted", async (slot) => {
      const stream = await createStreamedLocalBookMedia("user", "minted", 3, slot);
      const writer = stream.writable.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();
      await stream.commit(book("canonical"));
    });

    const db = await database();
    expect(await db.get("downloads", offlineBookKey("user", "minted"))).toBeUndefined();
    expect(await db.get("downloads", offlineBookKey("user", "canonical"))).toMatchObject({
      userId: "user",
      book: { id: "canonical" },
    });
    const owners = await db.getAllFromIndex("cacheEntries", "by-user", "user");
    expect(new Set(owners.map((entry) => entry.bookId))).toEqual(new Set(["canonical"]));
  });

  it("removes all cache bytes and journal rows when generation aborts", async () => {
    await withLocalMediaSlot("user", "minted", async (slot) => {
      const stream = await createStreamedLocalBookMedia("user", "minted", 3, slot);
      const writer = stream.writable.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();
      await stream.abort(new Error("generation failed"));
    });

    expect(fakeCacheStorage.stores.get(MEDIA_CACHE)!.store.size).toBe(0);
    expect(await (await database()).getAllFromIndex("cacheEntries", "by-user", "user")).toEqual([]);
  });

  it("rejects use without the matching held media slot", async () => {
    await expect(
      createStreamedLocalBookMedia("user", "minted", 3, { key: "user:someone-else" } as MediaSlot),
    ).rejects.toThrow(/slot is not held/i);
  });

  it("does not let stale regeneration resurrect a permanently deleted book", async () => {
    await markPermanentlyDeleted("user", "deleted");

    await expect(
      withLocalMediaSlot("user", "deleted", async (slot) => {
        const stream = await createStreamedLocalBookMedia("user", "deleted", 3, slot);
        const writer = stream.writable.getWriter();
        await writer.write(new Uint8Array([1, 2, 3]));
        await writer.close();
        return stream.commit(book("deleted"), slot);
      }),
    ).rejects.toThrow(/book was deleted/i);

    expect(
      await (await database()).get("downloads", offlineBookKey("user", "deleted")),
    ).toBeUndefined();
    expect(fakeCacheStorage.stores.get(MEDIA_CACHE)?.store.size ?? 0).toBe(0);
  });
});

describe("imported media streaming", () => {
  it("reattaches a canonical id without reacquiring its held account lock", async () => {
    const record = await withAccountWriteLock("duplicate-user", (accountSlot) =>
      withLocalMediaSlot("duplicate-user", "minted", (mediaSlot) =>
        storeLocalBookMedia(
          "duplicate-user",
          book("canonical"),
          new File([new Uint8Array([1, 2, 3])], "same.mp3"),
          null,
          undefined,
          mediaSlot,
          undefined,
          accountSlot,
        ),
      ),
    );

    expect(record.book.id).toBe("canonical");
    expect(
      await (await database()).get("downloads", offlineBookKey("duplicate-user", "canonical")),
    ).toEqual(record);
  });

  it("rolls back journaled chunks when an import is canceled", async () => {
    const controller = new AbortController();
    const file = new File([new Uint8Array(5 * 1024 * 1024)], "large.mp3");

    await expect(
      withLocalMediaSlot("user", "minted", (slot) =>
        storeLocalBookMedia(
          "user",
          book("minted"),
          file,
          null,
          () => controller.abort(),
          slot,
          controller.signal,
        ),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fakeCacheStorage.stores.get(MEDIA_CACHE)!.store.size).toBe(0);
    expect(await (await database()).getAllFromIndex("cacheEntries", "by-user", "user")).toEqual([]);
  });

  it("disarms a lying seek table before the bytes reach Cache Storage", async () => {
    // ffmpeg writes a 300-hour book's byte count modulo 2^32 into the Info
    // tag, so a browser seeking by that table lands in the first few minutes.
    const file = new File([brokenSeekTableMp3(5 * 1024 * 1024)], "long-book.mp3");
    const original = new Uint8Array(await file.arrayBuffer());
    const record = await withLocalMediaSlot("user", "minted", (slot) =>
      storeLocalBookMedia("user", book("minted"), file, null, undefined, slot),
    );

    const cache = fakeCacheStorage.stores.get(MEDIA_CACHE)!.store;
    const firstChunk = new Uint8Array(
      await cache.get(`${record.offlineMediaUrl}/chunk/0`)!.arrayBuffer(),
    );
    const secondChunk = new Uint8Array(
      await cache.get(`${record.offlineMediaUrl}/chunk/1`)!.arrayBuffer(),
    );
    const stored = new Uint8Array([...firstChunk, ...secondChunk]);
    expect(stored).toHaveLength(original.length);
    const tagOffset = BROKEN_TAG_OFFSET;
    expect(original[tagOffset + 7]).toBe(0xf);
    expect(stored[tagOffset + 7]).toBe(0x1);
    const changed = [...stored].flatMap((byte, index) => (byte === original[index] ? [] : [index]));
    expect(changed).toEqual([tagOffset + 7]);
    expect(await cache.get(record.offlineMediaUrl)!.json()).toMatchObject({
      byteSize: file.size,
      chunkCount: 2,
    });
    expect(record.byteSize).toBe(file.size);
  });

  it("does not let a stale MP3 attachment resurrect a permanently deleted book", async () => {
    await markPermanentlyDeleted("user", "deleted");

    await expect(
      storeLocalBookMedia(
        "user",
        book("deleted"),
        new File([new Uint8Array([1, 2, 3])], "same.mp3"),
        null,
      ),
    ).rejects.toThrow(/book was deleted/i);

    expect(
      await (await database()).get("downloads", offlineBookKey("user", "deleted")),
    ).toBeUndefined();
    expect(fakeCacheStorage.stores.get(MEDIA_CACHE)?.store.size ?? 0).toBe(0);
  });
});

async function markPermanentlyDeleted(userId: string, bookId: string): Promise<void> {
  await (
    await database()
  ).put("deletions", {
    key: offlineBookKey(userId, bookId),
    userId,
    bookId,
    operationId: crypto.randomUUID(),
    clearPlaybackHistory: true,
    completedAt: Date.now() - 60_000,
  });
}

function book(id: string) {
  return {
    id,
    title: "Generated book",
    author: "Author",
    durationMs: 1_000,
    chapters: [{ id: `${id}:0`, position: 0, title: "One", startMs: 0, endMs: 1_000 }],
    initialPositionMs: 0,
    initialProgressOccurredAt: null,
    initialPlaybackRate: 1,
    completed: false,
  };
}

// ID3v2 tag, then an MPEG-2 Layer III Info frame (64 kbps, 24 kHz, mono) whose
// byte count wrapped past 32 bits: 45,191,770 frames of 192 bytes, declared as
// 86,885,440. Everything after the first frame is filler the decoder never sees.
const BROKEN_ID3_BYTES = 4_000;
const BROKEN_TAG_OFFSET = 10 + BROKEN_ID3_BYTES + 4 + 9;

function brokenSeekTableMp3(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size).fill(0x5a);
  bytes.set([
    0x49,
    0x44,
    0x33,
    3,
    0,
    0,
    0,
    0,
    (BROKEN_ID3_BYTES >> 7) & 0x7f,
    BROKEN_ID3_BYTES & 0x7f,
  ]);
  bytes.fill(0, 10, 10 + BROKEN_ID3_BYTES);
  const frameOffset = 10 + BROKEN_ID3_BYTES;
  bytes.set([0xff, 0xf3, 0x84, 0xc0], frameOffset);
  bytes.fill(0, frameOffset + 4, frameOffset + 192);
  bytes.set([0x49, 0x6e, 0x66, 0x6f], BROKEN_TAG_OFFSET);
  const view = new DataView(bytes.buffer);
  view.setUint32(BROKEN_TAG_OFFSET + 4, 0xf);
  view.setUint32(BROKEN_TAG_OFFSET + 8, 45_191_770);
  view.setUint32(BROKEN_TAG_OFFSET + 12, 86_885_440);
  bytes.fill(0xff, BROKEN_TAG_OFFSET + 16, BROKEN_TAG_OFFSET + 116);
  return bytes;
}
