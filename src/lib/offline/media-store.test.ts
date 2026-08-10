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
