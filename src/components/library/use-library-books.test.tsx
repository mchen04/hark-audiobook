// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibraryBook } from "@/domain/library";
import { notifyLibraryChanged } from "@/lib/offline/library-revision";

const reader = vi.hoisted(() => vi.fn());
const heal = vi.hoisted(() => vi.fn());
const syncMeta = vi.hoisted(() => vi.fn());
vi.mock("@/lib/offline/mirror", () => ({
  readMirrorLibrary: reader,
  healMirrorPlaybackFromLocal: heal,
  getSyncMeta: syncMeta,
  localLiveBooks: async () => null,
  applyPullBatch: async () => {},
}));
vi.mock("@/lib/offline/library", () => ({
  listVisibleStoredOfflineBooks: async () => [],
  listOfflineBooks: async () => [],
}));
vi.mock("@/lib/offline/sync-protocol", () => ({ isPullBatch: () => true }));
vi.mock("@/lib/launch-revalidation", () => ({ afterLaunchPaint: () => () => {} }));
import { useLibraryBooks, type LibraryFilters } from "./use-library-books";

const book: LibraryBook = {
  id: "a-book",
  title: "Quiet Book",
  author: "Reader",
  narrator: null,
  series: null,
  chapterDiagnostic: null,
  archivedAt: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  tags: ["Calm"],
  durationMs: 60000,
  positionMs: 0,
  completed: false,
  progressUpdatedAt: null,
};
const filters: LibraryFilters = {
  query: "",
  status: "all",
  tag: null,
  sort: "title",
  onDevice: false,
};
afterEach(cleanup);
beforeEach(() => {
  vi.unstubAllGlobals();
  syncMeta.mockReset().mockResolvedValue({ cursor: "2026-09-21T00:00:00.000Z" });
  heal.mockReset().mockResolvedValue(0);
  reader.mockReset();
  reader.mockResolvedValue({ books: [book], tags: ["Calm"], continueBook: null });
});

it.each([true, false])(
  "keeps the first-sync gate until the mirror re-read, books=%s",
  async (hasBooks) => {
    syncMeta.mockResolvedValue(null);
    let completePull!: (response: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => (completePull = resolve)));
    let completeRead!: (snapshot: {
      books: LibraryBook[];
      tags: string[];
      continueBook: null;
    }) => void;
    reader.mockResolvedValueOnce({ books: [], tags: [], continueBook: null });
    reader.mockImplementationOnce(() => new Promise((resolve) => (completeRead = resolve)));
    const { result } = renderHook(() => useLibraryBooks("a", filters));
    await waitFor(() => expect(result.current.snapshot?.libraryTotal).toBe(0));
    expect(result.current.preparing).toBe(true);
    await act(async () => completePull(Response.json({ complete: true })));
    await waitFor(() => expect(reader).toHaveBeenCalledTimes(2));
    expect(result.current.snapshot?.libraryTotal).toBe(0);
    expect(result.current.preparing).toBe(true);
    await act(async () =>
      completeRead({ books: hasBooks ? [book] : [], tags: [], continueBook: null }),
    );
    await waitFor(() => expect(result.current.preparing).toBe(false));
    expect(result.current.snapshot?.libraryTotal).toBe(hasBooks ? 1 : 0);
  },
);

it("a rejected account-fenced heal still allows safe reads on mount, focus and route return", async () => {
  heal.mockRejectedValue(new Error("Account deletion is in progress"));
  const { result, rerender } = renderHook(
    (id: string | null) => useLibraryBooks("a", filters, id),
    { initialProps: "a-book" as string | null },
  );
  await waitFor(() => expect(result.current.snapshot?.books).toHaveLength(1));
  const initialCalls = reader.mock.calls.length;
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(reader.mock.calls.length).toBeGreaterThan(initialCalls));
  const focusCalls = reader.mock.calls.length;
  rerender(null);
  await waitFor(() => expect(reader.mock.calls.length).toBeGreaterThan(focusCalls));
  expect(result.current.snapshot?.books).toHaveLength(1);
  expect(heal).toHaveBeenCalled();
});

it("search, tag, sort and device facets reuse the visit snapshot", async () => {
  const { result, rerender } = renderHook((f) => useLibraryBooks("a", f), {
    initialProps: filters,
  });
  await waitFor(() => expect(result.current.snapshot?.books).toHaveLength(1));
  rerender({ ...filters, query: "absent" });
  expect(result.current.snapshot?.books).toHaveLength(0);
  rerender({ ...filters, tag: "Calm", sort: "activity" });
  expect(result.current.snapshot?.books).toHaveLength(1);
  rerender({ ...filters, onDevice: true });
  expect(result.current.snapshot?.books).toHaveLength(0);
  expect(reader).toHaveBeenCalledTimes(1);
});

it("never exposes the previous account while another snapshot is loading", async () => {
  const { result, rerender } = renderHook((id) => useLibraryBooks(id, filters), {
    initialProps: "a",
  });
  await waitFor(() => expect(result.current.snapshot?.books).toHaveLength(1));
  reader.mockReturnValue(new Promise(() => {}));
  rerender("b");
  expect(result.current.snapshot).toBeNull();
});

it("rereads committed changes before applying the next filter", async () => {
  const { result, rerender } = renderHook((f) => useLibraryBooks("a", f), {
    initialProps: filters,
  });
  await waitFor(() => expect(result.current.snapshot?.books).toHaveLength(1));
  reader.mockResolvedValue({ books: [{ ...book, tags: ["Updated"] }], tags: ["Updated"] });
  notifyLibraryChanged();
  rerender({ ...filters, query: "Updated" });
  await waitFor(() => expect(result.current.snapshot?.books).toHaveLength(1));
  expect(reader).toHaveBeenCalledTimes(2);
});

it("refreshes the local snapshot after returning from an offline player route", async () => {
  const { result, rerender } = renderHook(
    (id: string | null) => useLibraryBooks("a", filters, id),
    {
      initialProps: "a-book" as string | null,
    },
  );
  await waitFor(() => expect(result.current.snapshot?.books).toHaveLength(1));
  reader.mockResolvedValue({ books: [{ ...book, positionMs: 42000 }], tags: ["Calm"] });
  rerender(null);
  await waitFor(() => expect(result.current.snapshot?.books[0]?.positionMs).toBe(42000));
});
