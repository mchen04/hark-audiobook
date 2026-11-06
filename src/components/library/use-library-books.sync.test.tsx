// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLibraryBooks, type LibraryFilters } from "@/components/library/use-library-books";
import {
  applyPullBatch,
  getSyncMeta,
  readMirrorLibrary,
  listMirrorCollections,
  getMirrorPlayerBook,
} from "@/lib/offline/mirror";
import {
  commitMetadataEdit,
  commitTagEdge,
  commitCollectionEdge,
  commitImport,
} from "@/lib/offline/outbox";
import { listQueuedMutations, replayQueuedMutations, queueProgress } from "@/lib/offline-sync";
import { createProgressPersister } from "@/components/player/progress-persister";
import { withSyncNetworkLock, withBookProjectionLock } from "@/lib/offline-sync/locks";
import { projectLocalBookRegistration } from "@/lib/offline/local-import-mirror";
import type { PullBatch, PulledBook } from "@/lib/offline/sync-protocol";

const user = "h7-user";
const filters: LibraryFilters = {
  query: "",
  status: "all",
  tag: null,
  sort: "title",
  onDevice: false,
};
const t0 = "2026-11-06T12:00:00.000Z";
const t1 = "2026-11-06T12:01:00.000Z";
const t2 = "2026-11-06T12:02:00.000Z";
function book(title: string, updatedAt: string): PulledBook {
  return {
    id: "h7-book",
    title,
    updatedAt,
    author: "Author",
    narrator: null,
    description: null,
    series: null,
    seriesPosition: null,
    chapterDiagnostic: null,
    archivedAt: null,
    createdAt: t0,
    media: null,
    chapters: [],
    tagIds: [],
  };
}
function batch(title: string, cursor: string, since: string | null): PullBatch {
  return {
    since,
    cursor,
    complete: true,
    books: [book(title, cursor)],
    playbackStates: [],
    tags: [],
    collections: [],
    preferences: null,
    listeningSessions: [],
    liveBookIds: ["h7-book"],
  };
}
let requests: { url: string; resolve: (response: Response) => void }[];
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("caches", {
    open: async () => ({ match: async () => undefined, delete: async () => true }),
  });
  requests = [];
  vi.stubGlobal(
    "fetch",
    (url: string) => new Promise<Response>((resolve) => requests.push({ url, resolve })),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("shares an unfinished first pull with an online retry", async () => {
  const { result } = renderHook(() => useLibraryBooks(user, filters));
  await waitFor(() => expect(requests).toHaveLength(1));
  act(() => window.dispatchEvent(new Event("online")));
  await act(async () => requests[0]!.resolve(Response.json(batch("New title", t2, null))));
  await waitFor(() => expect(result.current.snapshot?.books[0]?.title).toBe("New title"));
  expect(requests).toHaveLength(1);
  expect((await getSyncMeta(user))?.cursor).toBe(t2);
});
it("ignores older batches without dropping microsecond precision", async () => {
  const newer = "2026-11-06T12:00:00.000002Z";
  const older = "2026-11-06T12:00:00.000001Z";
  await applyPullBatch(user, batch("New title", newer, null));
  await applyPullBatch(user, batch("Old title", older, null));
  expect((await readMirrorLibrary(user)).books[0]?.title).toBe("New title");
  expect((await getSyncMeta(user))?.cursor).toBe(newer);
  await applyPullBatch(user, batch("Later title", "2026-11-06T12:00:00.001Z", newer));
  expect((await readMirrorLibrary(user)).books[0]?.title).toBe("Later title");
});
it("keeps a pending metadata edit when an older pull arrives later", async () => {
  await applyPullBatch(user, batch("Original title", t0, null));
  const { result } = renderHook(() => useLibraryBooks(user, filters));
  await act(async () => {
    await result.current.reload();
  });
  await waitFor(() => expect(requests).toHaveLength(1));
  await commitMetadataEdit({ userId: user, deviceId: "h7-device" }, "h7-book", {
    title: "My pending title",
  });
  expect((await readMirrorLibrary(user)).books[0]?.title).toBe("My pending title");
  expect((await listQueuedMutations(user)).map((row) => row.payload)).toContainEqual({
    title: "My pending title",
  });
  await act(async () => requests[0]!.resolve(Response.json(batch("Original title", t1, t0))));
  await waitFor(async () => expect((await getSyncMeta(user))?.cursor).toBe(t1));
  const mirror = await readMirrorLibrary(user);
  const queued = await listQueuedMutations(user);
  console.log(
    "H7 pending edit result",
    JSON.stringify({ title: mirror.books[0]?.title, pending: queued.map((row) => row.payload) }),
  );
  expect(mirror.books[0]?.title).toBe("My pending title");
});

it("keeps a metadata edit acknowledged while an older pull is still in flight", async () => {
  await applyPullBatch(user, batch("Original title", t0, null));
  const { result } = renderHook(() => useLibraryBooks(user, filters));
  await act(async () => {
    await result.current.reload();
  });
  await waitFor(() => expect(requests).toHaveLength(1));
  await commitMetadataEdit({ userId: user, deviceId: "h7-device" }, "h7-book", {
    title: "My accepted title",
  });
  expect((await readMirrorLibrary(user)).books[0]?.title).toBe("My accepted title");
  const patch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  const replay = replayQueuedMutations(user, patch);
  await act(async () => requests[0]!.resolve(Response.json(batch("Original title", t1, t0))));
  await waitFor(async () => expect((await getSyncMeta(user))?.cursor).toBe(t1));
  await replay;
  expect(patch).toHaveBeenCalledOnce();
  expect(await listQueuedMutations(user)).toHaveLength(0);
  const mirror = await readMirrorLibrary(user);
  console.log(
    "H7 accepted edit result",
    JSON.stringify({
      title: mirror.books[0]?.title,
      pending: (await listQueuedMutations(user)).length,
    }),
  );
  expect(mirror.books[0]?.title).toBe("My accepted title");
});

it.each(["headers", "body"])("releases replay when a pull stalls at its %s", async (phase) => {
  const deadlines = vi.spyOn(globalThis, "setTimeout");
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    if (phase === "headers") {
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), {
              once: true,
            });
          },
        }),
      ),
    );
  });
  const send = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  const { result } = renderHook(() => useLibraryBooks(user, filters));
  await act(async () => {
    await result.current.reload();
  });
  await waitFor(() =>
    expect(deadlines.mock.calls.some(([, delay]) => delay === 15_000)).toBe(true),
  );
  await commitMetadataEdit({ userId: user, deviceId: "device" }, "h7-book", { title: "Pending" });
  const replay = replayQueuedMutations(user, send);
  expect(send).not.toHaveBeenCalled();
  const deadline = deadlines.mock.calls.find(([, delay]) => delay === 15_000)![0];
  await act(async () => {
    if (typeof deadline === "function") deadline();
    await replay;
  });
  expect(send).toHaveBeenCalledOnce();
  expect(await listQueuedMutations(user)).toHaveLength(0);
});

it("releases pulls and retains the queued edit when replay stalls", async () => {
  await applyPullBatch(user, batch("Original title", t0, null));
  await commitMetadataEdit({ userId: user, deviceId: "device" }, "h7-book", { title: "Pending" });
  const deadlines = vi.spyOn(globalThis, "setTimeout");
  const send = vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }),
  );
  const replay = replayQueuedMutations(user, send);
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  const pull = vi.fn().mockResolvedValue(Response.json(batch("Original title", t1, t0)));
  vi.stubGlobal("fetch", pull);
  const { result } = renderHook(() => useLibraryBooks(user, filters));
  await act(async () => {
    await result.current.reload();
  });
  expect(pull).not.toHaveBeenCalled();
  const deadline = deadlines.mock.calls.find(([, delay]) => delay === 15_000)![0];
  await act(async () => {
    if (typeof deadline === "function") deadline();
    await replay;
  });
  await waitFor(() => expect(pull).toHaveBeenCalledOnce());
  await waitFor(async () => expect((await getSyncMeta(user))?.cursor).toBe(t1));
  expect(await listQueuedMutations(user)).toHaveLength(1);
  expect((await readMirrorLibrary(user)).books[0]?.title).toBe("Pending");
});

it("pulls while replay waits for a stalled foreground progress save", async () => {
  await applyPullBatch(user, batch("Original title", t0, null));
  await queueProgress({
    userId: user,
    bookId: "h7-book",
    deviceId: "device",
    deviceSequence: 1,
    positionMs: 12000,
    playbackRate: 1,
    completed: false,
    eventOccurredAt: t0,
  });
  let finish!: (response: Response) => void;
  const foreground = vi.fn(
    () =>
      new Promise<Response>((done) => {
        finish = done;
      }),
  );
  vi.stubGlobal("fetch", foreground);
  const audio = document.createElement("audio");
  const playerBook = {
    id: "h7-book",
    title: "Book",
    author: "Author",
    durationMs: 120000,
    mediaUrl: "/media",
    coverUrl: null,
    initialPositionMs: 12000,
    initialProgressOccurredAt: t0,
    initialPlaybackRate: 1,
    completed: false,
    chapters: [],
  };
  const persister = createProgressPersister({
    getUserId: () => user,
    getAudio: () => audio,
    getActiveBook: () => playerBook,
  });
  persister.markPositionChanged();
  const save = persister.persistProgress("seek", 20000);
  await waitFor(() => expect(foreground).toHaveBeenCalledOnce());
  const replaySend = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  const replay = replayQueuedMutations(user, replaySend);
  await new Promise((done) => setTimeout(done, 25));
  const pull = vi.fn().mockResolvedValue(Response.json(batch("Remote title", t1, t0)));
  vi.stubGlobal("fetch", pull);
  const hook = renderHook(() => useLibraryBooks(user, filters));
  try {
    await act(async () => {
      await hook.result.current.reload();
    });
    await waitFor(() => expect(pull).toHaveBeenCalledOnce());
    expect(replaySend).not.toHaveBeenCalled();
  } finally {
    finish(Response.json({ ok: true }));
    await act(async () => {
      await save;
      await replay;
    });
    await waitFor(() => expect(pull).toHaveBeenCalledOnce());
  }
});

it.each(["queued", "response", "projection"])(
  "keeps account ownership when a pull is waiting for %s",
  async (phase) => {
    await applyPullBatch("account-a", batch("Account A title", t0, null));
    let release!: () => void;
    const held =
      phase === "queued"
        ? withSyncNetworkLock(
            "account-a",
            () =>
              new Promise<void>((done) => {
                release = done;
              }),
          )
        : Promise.resolve();
    let session = "account-a";
    const sends: string[] = [];
    let respond!: (response: Response) => void;
    vi.stubGlobal("fetch", async () => {
      sends.push(session);
      if (session === "account-a")
        return new Promise<Response>((done) => {
          respond = done;
        });
      return Response.json(batch("Account B private title", t1, null));
    });
    const hook = renderHook(({ userId }) => useLibraryBooks(userId, filters), {
      initialProps: { userId: "account-a" },
    });
    await act(async () => {
      await hook.result.current.reload();
    });
    if (phase === "queued") {
      await new Promise((done) => setTimeout(done, 25));
      expect(sends).toEqual([]);
    } else {
      await waitFor(() => expect(sends).toEqual(["account-a"]));
    }
    let projection = Promise.resolve();
    if (phase === "projection") {
      projection = withBookProjectionLock(
        "account-a",
        () =>
          new Promise<void>((done) => {
            release = done;
          }),
      );
      await act(async () => respond(Response.json(batch("Stale response", t1, t0))));
      await new Promise((done) => setTimeout(done, 25));
    }
    session = "account-b";
    act(() => hook.rerender({ userId: session }));
    await waitFor(async () => expect((await getSyncMeta("account-b"))?.cursor).toBe(t1));
    await act(async () => {
      if (phase === "response") respond(Response.json(batch("Account B private title", t1, t0)));
      else release();
      await held;
      await projection;
      await withSyncNetworkLock("account-a", async () => undefined);
    });
    expect((await readMirrorLibrary("account-a")).books[0]?.title).toBe("Account A title");
    expect((await getSyncMeta("account-a"))?.cursor).toBe(t0);
    expect(sends.filter((id) => id === "account-b")).toHaveLength(1);
  },
);

it.each(["tag", "collection"])(
  "keeps an acknowledged %s edit when a pull overlaps replay",
  async (kind) => {
    const edgeBatch = (included: boolean, cursor: string, since: string | null) => {
      const result = batch("Original title", cursor, since);
      result.tags = [{ id: "tag-one", name: "Favorite" }];
      result.books[0]!.tagIds = included ? ["tag-one"] : [];
      result.collections = [
        {
          id: "collection-one",
          name: "Favorite",
          updatedAt: cursor,
          books: included ? [{ bookId: "h7-book", position: 0 }] : [],
        },
      ];
      return result;
    };
    const included = async () =>
      kind === "tag"
        ? (await readMirrorLibrary(user)).books[0]?.tags.includes("Favorite")
        : (await listMirrorCollections(user, "h7-book"))[0]?.includesBook;
    await applyPullBatch(user, edgeBatch(false, t0, null));
    const origin = { userId: user, deviceId: "device" };
    if (kind === "tag") await commitTagEdge(origin, "h7-book", "tag-one", true);
    else await commitCollectionEdge(origin, "collection-one", "h7-book", true);
    expect(await included()).toBe(true);
    let finish!: () => void;
    const hold = new Promise<void>((done) => {
      finish = done;
    });
    let serverIncluded = false;
    const send = vi.fn(async () => {
      await hold;
      serverIncluded = true;
      return Response.json({ ok: true });
    });
    const replay = replayQueuedMutations(user, send);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    vi.stubGlobal("fetch", async () => Response.json(edgeBatch(serverIncluded, t1, t0)));
    const hook = renderHook(() => useLibraryBooks(user, filters));
    await act(async () => {
      await hook.result.current.reload();
    });
    await new Promise((done) => setTimeout(done, 25));
    await act(async () => {
      finish();
      await replay;
    });
    await waitFor(async () => expect((await getSyncMeta(user))?.cursor).toBe(t1));
    expect(await listQueuedMutations(user)).toHaveLength(0);
    expect(await included()).toBe(true);
  },
);

it("keeps a local import available to the player while registration replays", async () => {
  const registration = {
    bookId: "h7-book",
    fileName: "fixture.mp3",
    mimeType: "audio/mpeg",
    byteSize: 1000,
    durationMs: 60000,
    fingerprint: "f".repeat(64),
    fingerprintKind: "sha256-v1" as const,
    renditionKey: "source-v1",
    title: "Offline import",
    author: "Author",
    narrator: null,
    chapterDiagnostic: null,
    chapters: [{ position: 0, title: "One", startMs: 0, endMs: 60000 }],
  };
  await projectLocalBookRegistration(user, registration);
  expect(await getMirrorPlayerBook(user, registration.bookId)).not.toBeNull();
  await commitImport({ userId: user, deviceId: "device" }, registration.fingerprint, registration);
  let finish!: () => void;
  const hold = new Promise<void>((done) => {
    finish = done;
  });
  let serverRegistered = false;
  const send = vi.fn(async () => {
    await hold;
    serverRegistered = true;
    return Response.json({ bookId: "h7-book" }, { status: 201 });
  });
  const replay = replayQueuedMutations(user, send);
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  vi.stubGlobal("fetch", async () => {
    const result = batch("Offline import", t1, null);
    result.books[0]!.media = {
      originalFilename: "fixture.mp3",
      mimeType: "audio/mpeg",
      byteSize: 1000,
      fingerprint: registration.fingerprint,
      fingerprintKind: "sha256-v1",
      renditionKey: "source-v1",
      durationMs: 60000,
    };
    result.books[0]!.chapters = registration.chapters;
    if (!serverRegistered) {
      result.books = [];
      result.liveBookIds = [];
    }
    return Response.json(result);
  });
  const hook = renderHook(() => useLibraryBooks(user, filters));
  await act(async () => {
    await hook.result.current.reload();
  });
  await new Promise((done) => setTimeout(done, 50));
  await act(async () => {
    finish();
    await replay;
  });
  await waitFor(async () => expect((await getSyncMeta(user))?.cursor).toBe(t1));
  const books = (await readMirrorLibrary(user)).books.map((book) => book.id);
  const playerAvailable = !!(await getMirrorPlayerBook(user, registration.bookId));
  console.log(
    "IMPORT_REPLAY_PULL",
    JSON.stringify({
      serverRegistered,
      books,
      playerAvailable,
      queued: (await listQueuedMutations(user)).length,
    }),
  );
  expect(playerAvailable).toBe(true);
  expect(books).toEqual(["h7-book"]);
});
