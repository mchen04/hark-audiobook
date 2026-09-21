// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { LibraryBook } from "@/domain/library";
import { notifyLibraryChanged } from "@/lib/offline/library-revision";

const reader = vi.hoisted(() => vi.fn());
vi.mock("@/lib/offline/mirror", () => ({
  readMirrorLibrary: reader,
  healMirrorPlaybackFromLocal: async () => 0,
  getSyncMeta: async () => ({ cursor: "2026-09-21T00:00:00.000Z" }),
}));
vi.mock("@/lib/offline/library", () => ({ listVisibleStoredOfflineBooks: async () => [] }));
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
beforeEach(() => {
  reader.mockReset();
  reader.mockResolvedValue({ books: [book], tags: ["Calm"], continueBook: null });
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
