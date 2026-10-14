import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";

const database = await vi.hoisted(async () => {
  const { readFileSync } = await import("node:fs");
  const { parseEnvFile } = await import("../../scripts/lib/env-file.mjs");
  const { assertLocalDatabase } = await import("../../scripts/lib/assert-local-database.mjs");
  const environment = parseEnvFile(
    readFileSync(new URL("../../.env.test", import.meta.url), "utf8"),
  );
  assertLocalDatabase(environment.DATABASE_URL, { context: "Account export regression" });
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("@/server/db/schema");
  const client = postgres(environment.DATABASE_URL!, {
    max: 1,
    prepare: false,
    connection: { statement_timeout: 5000 },
  });
  return { client, db: drizzle(client, { schema }) };
});

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/client", () => ({ db: database.db }));

import { createAccountExportStream } from "@/server/account/export-stream";
import { books, playbackActions, user } from "@/server/db/schema";

afterAll(() => database.client.end());

it("exports every action in ID order across pages and excludes another account", async () => {
  const account = { id: randomUUID(), email: `${randomUUID()}@hark.test`, name: "Export fixture" };
  const other = { id: randomUUID(), email: `${randomUUID()}@hark.test`, name: "Other fixture" };
  const bookIds = [randomUUID(), randomUUID()];
  const otherBookId = randomUUID();
  const actionIds = Array.from({ length: 501 }, () => randomUUID());
  try {
    await database.db.insert(user).values([account, other]);
    await database.db
      .insert(books)
      .values([
        ...bookIds.map((id) => ({ id, ownerId: account.id, title: "Export book" })),
        { id: otherBookId, ownerId: other.id, title: "Other book" },
      ]);
    await database.db.insert(playbackActions).values(
      [...actionIds, randomUUID()].map((id, index) => ({
        id,
        userId: index < actionIds.length ? account.id : other.id,
        bookId: index < actionIds.length ? bookIds[index % bookIds.length]! : otherBookId,
        action: "pause" as const,
        positionMs: 123456,
        playbackRate: "1.00",
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      })),
    );
    const result = await new Response(createAccountExportStream(account)).json();
    expect(result.books.map((book: { id: string }) => book.id).sort()).toEqual(bookIds.sort());
    expect(result.playbackHistory.map((action: { id: string }) => action.id)).toEqual(
      actionIds.sort(),
    );
    expect(
      result.playbackHistory.every((action: { userId: string }) => action.userId === account.id),
    ).toBe(true);
  } finally {
    await database.db.delete(user).where(inArray(user.id, [account.id, other.id]));
  }
}, 10000);
