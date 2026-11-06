// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLibraryBooks, type LibraryFilters } from "@/components/library/use-library-books";
import { applyPullBatch, getSyncMeta, readMirrorLibrary } from "@/lib/offline/mirror";
import { commitMetadataEdit } from "@/lib/offline/outbox";
import { listQueuedMutations, replayQueuedMutations } from "@/lib/offline-sync";
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
