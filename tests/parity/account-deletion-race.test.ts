import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";

const database = await vi.hoisted(async () => {
  const { readFileSync } = await import("node:fs");
  const { parseEnvFile } = await import("../../scripts/lib/env-file.mjs");
  const { assertLocalDatabase } = await import("../../scripts/lib/assert-local-database.mjs");
  const environment = parseEnvFile(
    readFileSync(new URL("../../.env.test", import.meta.url), "utf8"),
  );
  assertLocalDatabase(environment.DATABASE_URL, { context: "Account deletion regression" });
  Object.assign(process.env, environment, { BETTER_AUTH_URL: "http://127.0.0.1:3400" });
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("@/server/db/schema");
  const client = postgres(process.env.DATABASE_URL!, {
    max: 4,
    connection: { application_name: "hark-account-deletion-race", statement_timeout: 5000 },
  });
  return { client, db: drizzle(client, { schema }) };
});

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/client", () => ({ db: database.db }));
vi.mock("@/server/auth", () => ({
  auth: { api: { signOut: async () => new Response(null) } },
}));

import { POST } from "@/app/api/account/delete/route";
import { books, bookTombstones, user, verification } from "@/server/db/schema";
import { syncReceipt } from "@/server/db/sync-receipt";
import { saveProgress } from "@/server/playback/progress";

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

function databaseError(error: unknown): unknown {
  if (error instanceof Error && error.cause) return databaseError(error.cause);
  return error;
}

afterAll(() => database.client.end());

it("account deletion waits for an admitted book writer and rejects writes after deletion", async () => {
  const userId = `deletion-race:${randomUUID()}`;
  const bookId = randomUUID();
  const token = randomUUID() + randomUUID();
  const intentId = `account-delete:${createHash("sha256").update(userId).digest("hex")}`;
  const ready = gate();
  const finish = gate();
  let writerPid = 0;
  let writer: Promise<unknown> | undefined;
  let deletion: Promise<unknown> | undefined;
  try {
    await database.db.insert(user).values({
      id: userId,
      email: `${randomUUID()}@hark.test`,
      name: "Account deletion race",
    });
    await database.db.insert(books).values({ id: bookId, ownerId: userId, title: "Race fixture" });
    await database.db.insert(verification).values({
      id: intentId,
      identifier: intentId,
      value: JSON.stringify({
        status: "prepared",
        tokenHash: createHash("sha256").update(token).digest("hex"),
      }),
      expiresAt: new Date(Date.now() + 60_000),
    });
    writer = database.db
      .transaction(async (transaction) => {
        const [backend] = await transaction.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        writerPid = backend!.pid;
        const receipt = await syncReceipt(transaction, userId);
        await transaction.delete(books).where(eq(books.id, bookId));
        ready.release();
        await finish.wait;
        await transaction
          .insert(bookTombstones)
          .values({ bookId, ownerId: userId, deletedAt: receipt });
      })
      .then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error: databaseError(error) }),
      );
    await ready.wait;
    deletion = POST(
      new Request("http://127.0.0.1:3400/api/account/delete", {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:3400", "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "commit", userId, deleteToken: token }),
      }),
    ).then(
      async (response) => ({ status: response.status, body: await response.json() }),
      (error: unknown) => ({ error: databaseError(error) }),
    );
    const blocked = await vi.waitFor(
      async () => {
        const [row] = await database.client`
        select pid, wait_event as "waitEvent", query
        from pg_stat_activity
        where application_name = 'hark-account-deletion-race'
          and ${writerPid} = any(pg_blocking_pids(pid))
      `;
        expect(row).toBeDefined();
        return row;
      },
      { timeout: 3000, interval: 10 },
    );
    finish.release();
    const results = await Promise.all([writer, deletion]);
    console.log(JSON.stringify({ blocked, results }));
    expect(results).toEqual([{ ok: true }, { status: 200, body: { deleted: true } }]);
    expect(
      await saveProgress(userId, {
        bookId,
        deviceId: "deletion-race-device",
        deviceSequence: 1,
        positionMs: 123400,
        playbackRate: 1,
        completed: false,
        eventOccurredAt: new Date(),
      }),
    ).toEqual({ kind: "not-found" });
    await expect(
      database.db.transaction(async (transaction) => {
        const receipt = await syncReceipt(transaction, userId);
        await transaction.insert(books).values({
          ownerId: userId,
          title: "Late import",
          updatedAt: receipt,
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    const remaining = await database.client`
      select
        (select count(*)::int from "user" where id = ${userId}) as users,
        (select count(*)::int from books where owner_id = ${userId}) as books,
        (select count(*)::int from book_tombstones where owner_id = ${userId}) as tombstones,
        (select count(*)::int from playback_states where user_id = ${userId}) as progress
    `;
    expect(remaining[0]).toEqual({ users: 0, books: 0, tombstones: 0, progress: 0 });
  } finally {
    finish.release();
    await Promise.allSettled([writer, deletion]);
    await database.db.delete(user).where(eq(user.id, userId));
    await database.db.delete(verification).where(eq(verification.id, intentId));
  }
}, 10_000);
