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
import { withBookProjectionLock } from "@/lib/offline-sync/locks";
import { projectLocalBookRegistration } from "@/lib/offline/local-import-mirror";
import * as mirrorStore from "@/lib/offline/mirror";
import * as launch from "@/lib/launch-revalidation";
import { replayAcknowledgements, purgeDeviceSequencesForUser } from "@/lib/offline-sync/sequences";
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

it.each(["headers", "body"])("allows replay while a pull stalls at its %s", async (phase) => {
  const entered = vi.fn();
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    entered();
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
  const hook = renderHook(() => useLibraryBooks(user, filters));
  await waitFor(() => expect(entered).toHaveBeenCalledOnce());
  await commitMetadataEdit({ userId: user, deviceId: "device" }, "h7-book", { title: "Pending" });
  const send = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  await replayQueuedMutations(user, send);
  expect(send).toHaveBeenCalledOnce();
  expect(await listQueuedMutations(user)).toHaveLength(0);
  hook.unmount();
});

it("applies pulls without losing queued edits while replay stalls", async () => {
  await applyPullBatch(user, batch("Original title", t0, null));
  await commitMetadataEdit({ userId: user, deviceId: "device" }, "h7-book", { title: "Pending" });
  let finish!: (response: Response) => void;
  const send = vi.fn(
    () =>
      new Promise<Response>((done) => {
        finish = done;
      }),
  );
  const replay = replayQueuedMutations(user, send);
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  vi.stubGlobal("fetch", async () => Response.json(batch("Original title", t1, t0)));
  const hook = renderHook(() => useLibraryBooks(user, filters));
  await act(async () => {
    await hook.result.current.reload();
  });
  await waitFor(async () => expect((await getSyncMeta(user))?.cursor).toBe(t1));
  expect((await readMirrorLibrary(user)).books[0]?.title).toBe("Pending");
  finish(new Response(null, { status: 503 }));
  await replay;
  expect(await listQueuedMutations(user)).toHaveLength(1);
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
    let held = Promise.resolve();
    if (phase === "queued") {
      const read = mirrorStore.getSyncMeta;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      vi.spyOn(mirrorStore, "getSyncMeta").mockImplementation(async (id) => {
        if (id === "account-a") await gate;
        return read(id);
      });
      held = gate;
    }
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
      await withBookProjectionLock("account-a", async () => undefined);
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

it.each(["deadline", "pull-first"])("retains an import during a %s pull", async (phase) => {
  const timers = vi.spyOn(globalThis, "setTimeout");
  const r = {
    bookId: "offline-import",
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
  await projectLocalBookRegistration(user, r);
  await commitImport({ userId: user, deviceId: "device" }, r.fingerprint, r);
  expect(await getMirrorPlayerBook(user, r.bookId)).not.toBeNull();
  renderHook(() => useLibraryBooks(user, filters));
  await waitFor(() => expect(requests).toHaveLength(1));
  let registered = false;
  const send = vi.fn(async () => {
    registered = true;
    return Response.json({ bookId: r.bookId }, { status: 201 });
  });
  const replay = replayQueuedMutations(user, send);
  await new Promise((done) => setTimeout(done, 25));
  if (phase === "deadline") {
    const deadline = timers.mock.calls.filter(([, ms]) => ms === 15000)[1]?.[0];
    await act(async () =>
      requests[0]!.resolve(
        Response.json({
          ...batch("Page one", t1, null),
          complete: false,
          liveBookIds: null,
        }),
      ),
    );
    await waitFor(() => expect(requests).toHaveLength(2));
    if (deadline) deadline();
  }
  const response = batch("Page two", t2, phase === "deadline" ? t1 : null);
  response.books = registered
    ? [
        {
          ...book(r.title, t2),
          id: r.bookId,
          chapters: r.chapters,
          media: { ...r, originalFilename: r.fileName },
        },
      ]
    : [];
  response.liveBookIds = ["h7-book", ...(registered ? [r.bookId] : [])];
  await act(async () => {
    requests.at(-1)!.resolve(Response.json(response));
    await replay;
  });
  const actual = {
    sent: send.mock.calls.length,
    queued: (await listQueuedMutations(user)).length,
    available: !!(await getMirrorPlayerBook(user, r.bookId)),
  };
  console.log(phase, JSON.stringify(actual));
  expect(actual).toEqual({ sent: 1, queued: 0, available: true });
});

it("starts another pull when retry interrupts a stalled response", async () => {
  const hook = renderHook(() => useLibraryBooks(user, filters));
  await waitFor(() => expect(requests).toHaveLength(1));
  act(() => hook.result.current.retry());
  await new Promise((done) => setTimeout(done, 100));
  console.log("RETRY", JSON.stringify({ requests: requests.length }));
  expect(requests).toHaveLength(2);
  await act(async () => requests[1]!.resolve(Response.json(batch("Latest title", t2, null))));
  await waitFor(async () => expect((await getSyncMeta(user))?.cursor).toBe(t2));
  await act(async () => requests[0]!.resolve(Response.json(batch("Old title", t1, null))));
  expect((await readMirrorLibrary(user)).books[0]?.title).toBe("Latest title");
  expect((await getSyncMeta(user))?.cursor).toBe(t2);
});
it("recovers a cancelled import that has no local book record", async () => {
  const r = {
    bookId: "h7-book",
    fileName: "fixture.mp3",
    mimeType: "audio/mpeg",
    byteSize: 1000,
    durationMs: 60000,
    fingerprint: "f".repeat(64),
    fingerprintKind: "sha256-v1" as const,
    renditionKey: "source-v1",
    title: "Imported",
    author: "Author",
    narrator: null,
    chapterDiagnostic: null,
    chapters: [{ position: 0, title: "One", startMs: 0, endMs: 60000 }],
  };
  const { registerLocalBook } = await import("@/lib/local-import");
  const controller = new AbortController();
  vi.stubGlobal("fetch", async () => {
    controller.abort();
    return Response.json({ bookId: r.bookId }, { status: 201 });
  });
  await expect(registerLocalBook(user, r, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(await listQueuedMutations(user)).toHaveLength(1);
  const pulled = batch(r.title, t1, null);
  pulled.books[0]!.media = { ...r, originalFilename: r.fileName };
  pulled.books[0]!.chapters = r.chapters;
  await applyPullBatch(user, pulled);
  await replayQueuedMutations(user, async () => Response.json({ bookId: r.bookId }));
  const delta = batch(r.title, t1, t1);
  delta.books = [];
  await applyPullBatch(user, delta);
  const result = {
    queued: (await listQueuedMutations(user)).length,
    available: !!(await getMirrorPlayerBook(user, r.bookId)),
    cursor: (await getSyncMeta(user))?.cursor,
  };
  console.log("IMPORT", JSON.stringify(result));
  expect(result.available).toBe(true);
});

it("keeps a server title correction after an import retry and the next delta", async () => {
  const registration = {
    bookId: "h7-book",
    fileName: "fixture.mp3",
    mimeType: "audio/mpeg",
    byteSize: 1000,
    durationMs: 60000,
    fingerprint: "f".repeat(64),
    fingerprintKind: "sha256-v1" as const,
    renditionKey: "source-v1",
    title: "Imported title",
    author: "Author",
    narrator: null,
    chapterDiagnostic: null,
    chapters: [{ position: 0, title: "One", startMs: 0, endMs: 60000 }],
  };
  await projectLocalBookRegistration(user, registration);
  await commitImport({ userId: user, deviceId: "device" }, registration.fingerprint, registration);
  const correction = batch("Corrected on another device", t1, null);
  correction.books[0]!.media = { ...registration, originalFilename: registration.fileName };
  correction.books[0]!.chapters = registration.chapters;
  await applyPullBatch(user, correction);
  await replayQueuedMutations(user, async () =>
    Response.json({ bookId: registration.bookId, alreadyRegistered: true }),
  );
  await applyPullBatch(user, { ...correction, since: t1, books: [] });
  expect((await readMirrorLibrary(user)).books[0]?.title).toBe("Corrected on another device");
  expect(await listQueuedMutations(user)).toHaveLength(0);
  expect((await getSyncMeta(user))?.cursor).toBe(t1);
});

it.each(["import", "edit"])("preserves user data across an old %s pull", async (kind) => {
  if (kind === "import") {
    const r = {
      bookId: "h7-book",
      title: "Pending import",
      author: "Author",
      narrator: null,
      fileName: "fixture.mp3",
      mimeType: "audio/mpeg",
      byteSize: 1000,
      durationMs: 60000,
      fingerprint: "f".repeat(64),
      fingerprintKind: "sha256-v1" as const,
      renditionKey: "source-v1",
      chapterDiagnostic: null,
      chapters: [{ position: 0, title: "One", startMs: 0, endMs: 60000 }],
    };
    await projectLocalBookRegistration(user, r);
    await commitImport({ userId: user, deviceId: "device" }, r.fingerprint, r);
  } else {
    await applyPullBatch(user, batch("Original title", t0, null));
    await commitMetadataEdit({ userId: user, deviceId: "device" }, "h7-book", { title: "My edit" });
  }
  const delayed = batch("Original title", t1, t0);
  if (kind === "import") {
    delayed.books = [];
    delayed.liveBookIds = [];
  } else await replayQueuedMutations(user, async () => Response.json({ ok: true }));
  await applyPullBatch(user, delayed);
  const actual = {
    queued: (await listQueuedMutations(user)).length,
    title: (await readMirrorLibrary(user)).books[0]?.title ?? null,
  };
  console.log(kind, JSON.stringify(actual));
  expect(actual).toEqual(
    kind === "import" ? { queued: 1, title: "Pending import" } : { queued: 0, title: "My edit" },
  );
});

it("refetches whole batches after repeated acknowledgements without advancing the stale cursor", async () => {
  await applyPullBatch(user, batch("Original title", t0, null));
  const hook = renderHook(() => useLibraryBooks(user, filters));
  await act(async () => hook.result.current.reload());
  await waitFor(() => expect(requests).toHaveLength(1));
  for (let index = 0; index < 8; index++) {
    await commitMetadataEdit({ userId: user, deviceId: "device" }, "h7-book", {
      title: `My edit ${index}`,
    });
    await replayQueuedMutations(user, async () => Response.json({ ok: true }));
    const old = batch("Original title", t2, t0);
    old.tags = [{ id: "old-tag", name: "Old tag" }];
    await act(async () => requests[index]!.resolve(Response.json(old)));
    await waitFor(() => expect(requests).toHaveLength(index + 2));
    const mirror = await readMirrorLibrary(user);
    expect(mirror.books[0]?.title).toBe(`My edit ${index}`);
    expect(mirror.tags).toEqual([]);
    expect((await getSyncMeta(user))?.cursor).toBe(t0);
  }
  await act(async () => requests[8]!.resolve(Response.json(batch("My edit 7", t2, t0))));
  await waitFor(async () => expect((await getSyncMeta(user))?.cursor).toBe(t2));
  expect((await readMirrorLibrary(user)).books[0]?.title).toBe("My edit 7");
  expect(await listQueuedMutations(user)).toHaveLength(0);
});

function pendingRegistration() {
  return {
    bookId: "h7-book",
    title: "Pending import",
    author: "Author",
    narrator: null,
    fileName: "fixture.mp3",
    mimeType: "audio/mpeg",
    byteSize: 1000,
    durationMs: 60000,
    fingerprint: "f".repeat(64),
    fingerprintKind: "sha256-v1" as const,
    renditionKey: "source-v1",
    chapterDiagnostic: null,
    chapters: [{ position: 0, title: "One", startMs: 0, endMs: 60000 }],
  };
}

it.each(["tombstone", "gone"])("allows a queued import to be removed after %s", async (mode) => {
  const registration = pendingRegistration();
  await projectLocalBookRegistration(user, registration);
  await commitImport({ userId: user, deviceId: "device" }, registration.fingerprint, registration);
  if (mode === "gone")
    await replayQueuedMutations(user, async () => new Response(null, { status: 410 }));
  const deleted = batch("Deleted", t1, null);
  deleted.books = [];
  deleted.liveBookIds = [];
  if (mode === "tombstone") deleted.tombstones = [{ bookId: registration.bookId, deletedAt: t1 }];
  await applyPullBatch(user, deleted, undefined, undefined, await replayAcknowledgements(user));
  expect(await getMirrorPlayerBook(user, registration.bookId)).toBeNull();
  expect(await listQueuedMutations(user)).toHaveLength(mode === "gone" ? 0 : 1);
  expect((await getSyncMeta(user))?.cursor).toBe(t1);
});

it.each(["initial", "reload"])(
  "yields after bounded %s invalidations and resumes automatically",
  async (mode) => {
    await projectLocalBookRegistration(user, pendingRegistration());
    const scheduled: (() => void)[] = [];
    if (mode === "reload") {
      await applyPullBatch(user, batch("Pending import", t0, null));
      vi.spyOn(launch, "afterLaunchPaint").mockImplementation((run) => {
        scheduled.push(run);
        return () => {};
      });
    }
    const timers = vi.spyOn(window, "setTimeout");
    const hook = renderHook(() => useLibraryBooks(user, filters));
    if (mode === "reload") {
      await waitFor(() => expect(scheduled).toHaveLength(1), { interval: 1 });
      await act(async () => hook.result.current.reload());
    }
    for (let index = 0; index < 50; index++) {
      await waitFor(() => expect(requests).toHaveLength(index + 1), { interval: 1 });
      await commitMetadataEdit({ userId: user, deviceId: "device" }, "h7-book", {
        title: `Edit ${index}`,
      });
      await replayQueuedMutations(user, async () => Response.json({ ok: true }));
      await act(async () => requests[index]!.resolve(Response.json(batch("Old title", t1, null))));
    }
    expect(requests).toHaveLength(50);
    expect((await getSyncMeta(user))?.cursor).toBe(mode === "initial" ? undefined : t0);
    expect((await readMirrorLibrary(user)).books[0]?.title).toBe("Edit 49");
    if (mode === "initial") {
      await waitFor(() => expect(timers.mock.calls.some(([, ms]) => ms === 2000)).toBe(true), {
        interval: 1,
      });
      const retry = timers.mock.calls.find(([, ms]) => ms === 2000)![0];
      expect(typeof retry).toBe("function");
      await act(async () => {
        if (typeof retry === "function") retry();
      });
    } else {
      await waitFor(() => expect(scheduled).toHaveLength(2), { interval: 1 });
      await act(async () => scheduled[1]!());
    }
    await waitFor(() => expect(requests).toHaveLength(51), { interval: 1 });
    await act(async () => requests[50]!.resolve(Response.json(batch("Edit 49", t1, null))));
    await waitFor(async () => expect((await getSyncMeta(user))?.cursor).toBe(t1), { interval: 1 });
    await waitFor(() => expect(hook.result.current.preparing).toBe(false), { interval: 1 });
    expect((await readMirrorLibrary(user)).books[0]?.title).toBe("Edit 49");
  },
  5000,
);

it("persists acknowledgement counts per account and removes them with account data", async () => {
  await applyPullBatch(user, batch("Original", t0, null));
  await commitMetadataEdit({ userId: user, deviceId: "device" }, "h7-book", { title: "My edit" });
  await replayQueuedMutations(user, async () => new Response(null, { status: 503 }));
  expect(await replayAcknowledgements(user)).toBe(0);
  await replayQueuedMutations(user, async () => Response.json({ ok: true }));
  expect(await replayAcknowledgements(user)).toBe(1);
  expect(await replayAcknowledgements("other-owner")).toBe(0);
  vi.resetModules();
  const reopened = await import("@/lib/offline-sync/sequences");
  expect(await reopened.replayAcknowledgements(user)).toBe(1);
  await purgeDeviceSequencesForUser(user);
  expect(await reopened.replayAcknowledgements(user)).toBe(0);
});
