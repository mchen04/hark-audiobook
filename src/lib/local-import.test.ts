import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import { database, mirrorKey } from "@/lib/offline/db";

// An import journals its registration in the outbox before it touches the
// network, so the module under test needs the two browser globals that write
// reaches for: IndexedDB for the queue, and localStorage for the device id it
// attributes the mutation to.
const { storeLocalBookMedia } = vi.hoisted(() => ({ storeLocalBookMedia: vi.fn() }));

// Only the byte-writing half is stubbed. `withLocalMediaSlot` is the REAL one,
// so the lock the import holds across its whole local write is the lock the
// product takes — a stub of it would quietly delete the ordering guarantee that
// keeps a concurrent reattach out of the middle of an import.
vi.mock("@/lib/offline/media-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offline/media-store")>()),
  storeLocalBookMedia,
}));
vi.mock("music-metadata", () => ({
  parseBlob: vi.fn().mockResolvedValue({
    format: {
      hasAudio: true,
      hasVideo: false,
      container: "MPEG",
      codec: "MPEG 1 Layer 3",
      duration: 8,
    },
    common: { title: "Mobile PWA Fixture", artist: "Ada Mobile" },
    native: {},
    quality: { warnings: [] },
  }),
}));

import { importLocalMp3, LOCAL_REGISTRATION_TIMEOUT_MS } from "./local-import";

describe("local MP3 import", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    vi.stubGlobal("localStorage", memoryStorage());
    storeLocalBookMedia.mockReset().mockResolvedValue(undefined);
  });

  it("reattaches device media when the same MP3 is already registered", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          { error: "This MP3 is already in your library.", existingBookId: "existing-book" },
          { status: 409 },
        ),
      );
    const file = new File([new Uint8Array([1, 2, 3])], "fixture.mp3", {
      type: "audio/mpeg",
    });

    await importLocalMp3("mobile-user", file, vi.fn());

    expect(storeLocalBookMedia).toHaveBeenCalledWith(
      "mobile-user",
      expect.objectContaining({
        id: "existing-book",
        title: "Mobile PWA Fixture",
        author: "Ada Mobile",
      }),
      file,
      null,
      expect.any(Function),
      // The slot the import holds names the id this device MINTED, not the one
      // the server answered with: everything written under the minted id has to
      // be inside one slot for a later reattach to be able to move all of it.
      { key: expect.stringMatching(/^mobile-user:[0-9a-f-]{36}$/) },
      expect.any(AbortSignal),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const db = await database();
    expect(
      (await db.getAllFromIndex("books", "by-user", "mobile-user")).map((book) => book.bookId),
    ).toStrictEqual(["existing-book"]);
  });

  it("uses canonical synced state when reattaching an existing book", async () => {
    const canonical = {
      id: "existing-book",
      title: "Edited title",
      author: "Edited author",
      durationMs: 8_000,
      chapters: [{ id: "chapter-1", position: 0, title: "One", startMs: 0, endMs: 8_000 }],
      initialPositionMs: 6_000,
      initialProgressOccurredAt: "2026-07-10T12:00:00.000Z",
      initialPlaybackRate: 1.5,
      completed: false,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json(
        {
          error: "This MP3 is already in your library.",
          existingBookId: canonical.id,
          playerBook: canonical,
        },
        { status: 409 },
      ),
    );
    const file = new File([new Uint8Array([1, 2, 3])], "fixture.mp3", {
      type: "audio/mpeg",
    });

    await importLocalMp3("mobile-user", file, vi.fn());

    expect(storeLocalBookMedia).toHaveBeenCalledWith(
      "mobile-user",
      canonical,
      file,
      null,
      expect.any(Function),
      { key: expect.stringMatching(/^mobile-user:[0-9a-f-]{36}$/) },
      expect.any(AbortSignal),
    );
    const db = await database();
    expect(await db.get("books", mirrorKey("mobile-user", canonical.id))).toMatchObject({
      title: "Edited title",
      author: "Edited author",
      media: { durationMs: 8_000 },
    });
  });

  it("keeps recoverable metadata when device storage fails", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ bookId: "new-book" }, { status: 201 }));
    storeLocalBookMedia.mockRejectedValueOnce(new Error("storage failed"));
    const file = new File([new Uint8Array([4, 5, 6])], "fixture.mp3", {
      type: "audio/mpeg",
    });

    await expect(importLocalMp3("mobile-user", file, vi.fn())).rejects.toThrow(
      "Choose the same MP3 again to finish saving it",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const db = await database();
    expect(await db.get("books", mirrorKey("mobile-user", "new-book"))).toMatchObject({
      bookId: "new-book",
      title: "Mobile PWA Fixture",
    });
  });

  it("projects an offline import so its player route can resolve immediately", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("offline"));
    const file = new File([new Uint8Array([7, 8, 9])], "offline%20fixture.mp3", {
      type: "audio/mpeg",
    });

    await importLocalMp3("mobile-user", file, vi.fn());

    const storedBook = storeLocalBookMedia.mock.calls[0]![1];
    const db = await database();
    const [book, chapters] = await Promise.all([
      db.get("books", mirrorKey("mobile-user", storedBook.id)),
      db.getAllFromIndex("chapters", "by-user-book", ["mobile-user", storedBook.id]),
    ]);
    expect(book).toMatchObject({
      bookId: storedBook.id,
      title: "Mobile PWA Fixture",
      author: "Ada Mobile",
      media: {
        originalFilename: "offline%20fixture.mp3",
        mimeType: "audio/mpeg",
        byteSize: 3,
        fingerprintKind: "sha256-v1",
        renditionKey: "source-v1",
        durationMs: 8_000,
      },
    });
    expect(chapters).toEqual([
      expect.objectContaining({
        bookId: storedBook.id,
        position: 0,
        startMs: 0,
        endMs: 8_000,
      }),
    ]);
  });

  it("keeps completed audio when registration receives a retryable response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ error: "temporarily unavailable" }, { status: 503 }),
    );
    const file = new File([new Uint8Array([10, 11, 12])], "retry.mp3", {
      type: "audio/mpeg",
    });

    await importLocalMp3("mobile-user", file, vi.fn());

    expect(storeLocalBookMedia).toHaveBeenCalledOnce();
    const storedBook = storeLocalBookMedia.mock.calls[0]![1];
    const db = await database();
    expect(await db.get("books", mirrorKey("mobile-user", storedBook.id))).toMatchObject({
      bookId: storedBook.id,
      media: { renditionKey: "source-v1" },
    });
  });

  it("bounds a registration request that never answers", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const accelerateRegistrationTimeout = (
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ): ReturnType<typeof setTimeout> => {
      if (timeout === LOCAL_REGISTRATION_TIMEOUT_MS) {
        queueMicrotask(() => handler(...args));
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler, timeout, ...args);
    };
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      accelerateRegistrationTimeout as unknown as typeof setTimeout,
    );
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("timed out", "AbortError")),
            { once: true },
          );
        }),
    );
    const file = new File([new Uint8Array([13, 14, 15])], "timeout.mp3", {
      type: "audio/mpeg",
    });

    await importLocalMp3("mobile-user", file, vi.fn());

    expect(storeLocalBookMedia).toHaveBeenCalledOnce();
  });

  it("does not turn a terminal validation error into a local success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ error: "invalid chapters" }, { status: 422 }),
    );
    const file = new File([new Uint8Array([16, 17, 18])], "invalid.mp3", {
      type: "audio/mpeg",
    });

    await expect(importLocalMp3("mobile-user", file, vi.fn())).rejects.toThrow("invalid chapters");
    expect(storeLocalBookMedia).not.toHaveBeenCalled();
  });
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}
