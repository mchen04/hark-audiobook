import { sql } from "drizzle-orm";

import type { Transaction } from "./client";
import { books, bookTombstones, playbackStates } from "./schema";

export class SyncBusyError extends Error {
  constructor() {
    super("Account sync is busy. Retry shortly.");
  }
}

export async function syncReceipt(transaction: Transaction, userId: string) {
  const [previous] = await transaction.execute<{ timeout: string }>(sql`
    with previous as materialized (select current_setting('lock_timeout') as timeout)
    select timeout, set_config('lock_timeout', '100ms', true) from previous
  `);
  try {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`hark:sync:${userId}`}, 0))`,
    );
  } catch (error) {
    const cause = error instanceof Error && error.cause ? error.cause : error;
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "55P03") {
      throw new SyncBusyError();
    }
    throw error;
  }
  await transaction.execute(sql`select set_config('lock_timeout', ${previous!.timeout}, true)`);
  const rows = await transaction.execute<{ value: string }>(sql`
    select greatest(
      clock_timestamp(),
      (select max(${books.updatedAt}) from ${books} where ${books.ownerId}=${userId}) + interval '1 microsecond',
      (select max(${playbackStates.updatedAt}) from ${playbackStates} where ${playbackStates.userId}=${userId}) + interval '1 microsecond',
      (select max(${bookTombstones.deletedAt}) from ${bookTombstones} where ${bookTombstones.ownerId}=${userId}) + interval '1 microsecond'
    )::text as value
  `);
  return sql<Date>`${rows[0]!.value}::timestamptz`;
}
