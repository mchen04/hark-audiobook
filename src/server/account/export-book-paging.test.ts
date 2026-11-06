import { expect, it, vi } from "vitest";
import type { Sql } from "postgres";

const fixture = await vi.hoisted(async () => {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { getTableColumns } = await import("drizzle-orm");
  const { books } = await import("@/server/db/schema");
  const exactCreatedAt = "2026-01-01T00:00:00.123456Z";
  const ids = Array.from(
    { length: 100 },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const bookQueries: unknown[][] = [];
  const driver = {
    options: { parsers: {}, serializers: {} },
    begin: async (run: (client: unknown) => Promise<void>) => run(driver),
    unsafe: (query: string, parameters: unknown[]) => ({
      values: async () => {
        if (!query.includes('from "books"')) return [];
        bookQueries.push(parameters);
        if (bookQueries.length > 1) {
          expect(parameters).toContain(exactCreatedAt);
          return [];
        }
        return ids.map((id) => {
          const record: Record<string, unknown> = {
            id,
            ownerId: "export-owner",
            title: "Export book",
            author: "Author",
            createdAt: exactCreatedAt,
            updatedAt: exactCreatedAt,
          };
          const row = Object.keys(getTableColumns(books)).map((key) => record[key] ?? null);
          if (query.includes("to_char(")) row.push(exactCreatedAt);
          return row;
        });
      },
    }),
  };
  const database = drizzle(driver as unknown as Sql);
  return { database, ids, bookQueries };
});

vi.mock("@/server/db/client", () => ({ db: fixture.database }));

import { createAccountExportStream } from "./export-stream";

it("retains the database timestamp precision when advancing an export page", async () => {
  const stream = createAccountExportStream({
    id: "export-owner",
    name: "Export owner",
    email: "export@hark.test",
  });
  const result = await new Response(stream).json();

  expect(fixture.bookQueries).toHaveLength(2);
  expect(result.books.map((book: { id: string }) => book.id)).toEqual(fixture.ids);
  expect(Object.keys(result.books[0]).sort()).toEqual([
    "archivedAt",
    "author",
    "chapterDiagnostic",
    "chapters",
    "createdAt",
    "description",
    "id",
    "media",
    "narrator",
    "ownerId",
    "series",
    "seriesPosition",
    "title",
    "updatedAt",
  ]);
});
