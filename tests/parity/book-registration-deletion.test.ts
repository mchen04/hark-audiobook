import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";

const fixture = await vi.hoisted(async () => {
  const { readFileSync } = await import("node:fs");
  const { parseEnvFile } = await import("../../scripts/lib/env-file.mjs");
  const { assertLocalDatabase } = await import("../../scripts/lib/assert-local-database.mjs");
  const environment = parseEnvFile(
    readFileSync(process.env.HARK_ENV_FILE ?? new URL("../../.env.test", import.meta.url), "utf8"),
  );
  assertLocalDatabase(environment.DATABASE_URL, { context: "Deleted registration regression" });
  Object.assign(process.env, environment);
  const { randomUUID } = await import("node:crypto");
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("@/server/db/schema");
  const client = postgres(environment.DATABASE_URL!, {
    max: 1,
    connection: { statement_timeout: 5000 },
  });
  const account = {
    id: randomUUID(),
    email: `${randomUUID()}@hark.test`,
    name: "Registration fixture",
  };
  return { client, db: drizzle(client, { schema }), account, origin: environment.BETTER_AUTH_URL! };
});

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/client", () => ({ db: fixture.db }));
vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: async () => ({ user: fixture.account }) } },
}));

import { POST } from "@/app/api/books/local/route";
import { DELETE } from "@/app/api/books/[bookId]/route";
import { books, bookTombstones, user } from "@/server/db/schema";

afterAll(() => fixture.client.end());

it("rejects replay of a deleted book UUID while allowing a new import of the same source", async () => {
  const bookId = randomUUID();
  const payload = {
    bookId,
    fileName: "fixture.mp3",
    mimeType: "audio/mpeg",
    byteSize: 1000,
    durationMs: 60_000,
    fingerprint: createHash("sha256").update(bookId).digest("hex"),
    fingerprintKind: "sha256-v1",
    renditionKey: "source-v1",
    title: "Registration fixture",
    author: "Author",
    narrator: null,
    chapterDiagnostic: null,
    chapters: [{ position: 0, title: "One", startMs: 0, endMs: 60_000 }],
  };
  const register = (id: string) =>
    POST(
      new Request(`${fixture.origin}/api/books/local`, {
        method: "POST",
        headers: { Origin: fixture.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, bookId: id }),
      }),
    );
  try {
    await fixture.db.insert(user).values(fixture.account);
    expect((await register(bookId)).status).toBe(201);
    expect((await register(bookId)).status).toBe(200);
    expect(
      (
        await DELETE(
          new Request(`${fixture.origin}/api/books/${bookId}`, {
            method: "DELETE",
            headers: { Origin: fixture.origin },
          }),
          { params: Promise.resolve({ bookId }) },
        )
      ).status,
    ).toBe(200);
    const replay = await register(bookId);
    const live = await fixture.db.select().from(books).where(eq(books.id, bookId));
    const tombstones = await fixture.db
      .select()
      .from(bookTombstones)
      .where(eq(bookTombstones.bookId, bookId));
    console.log(
      JSON.stringify({
        replayStatus: replay.status,
        liveRows: live.length,
        tombstoneRows: tombstones.length,
      }),
    );
    expect({ liveRows: live.length, tombstoneRows: tombstones.length }).toEqual({
      liveRows: 0,
      tombstoneRows: 1,
    });
    expect(replay.status).toBe(410);
    expect((await register(randomUUID())).status).toBe(201);
  } finally {
    await fixture.db.delete(user).where(eq(user.id, fixture.account.id));
  }
}, 10_000);

it("keeps a live registration idempotent beside a retained tombstone", async () => {
  const bookId = randomUUID();
  const payload = {
    bookId,
    fileName: "legacy.mp3",
    mimeType: "audio/mpeg",
    byteSize: 1000,
    durationMs: 60000,
    fingerprint: createHash("sha256").update(bookId).digest("hex"),
    fingerprintKind: "sha256-v1",
    renditionKey: "source-v1",
    title: "Legacy live book",
    author: "Author",
    narrator: null,
    chapterDiagnostic: null,
    chapters: [{ position: 0, title: "One", startMs: 0, endMs: 60000 }],
  };
  const register = (changes = {}) =>
    POST(
      new Request(`${fixture.origin}/api/books/local`, {
        method: "POST",
        headers: { Origin: fixture.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, ...changes }),
      }),
    );
  try {
    await fixture.db.insert(user).values(fixture.account);
    expect((await register()).status).toBe(201);
    await fixture.db.insert(bookTombstones).values({ bookId, ownerId: fixture.account.id });
    const retry = await register();
    console.log("Legacy live registration retry", retry.status);
    expect(retry.status).toBe(200);
    expect((await register({ fingerprint: "e".repeat(64) })).status).toBe(422);
    expect(await fixture.db.select().from(books).where(eq(books.id, bookId))).toHaveLength(1);
    expect(
      await fixture.db.select().from(bookTombstones).where(eq(bookTombstones.bookId, bookId)),
    ).toHaveLength(1);
  } finally {
    await fixture.db.delete(user).where(eq(user.id, fixture.account.id));
  }
}, 10000);
