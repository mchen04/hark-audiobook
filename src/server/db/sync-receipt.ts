import { sql } from "drizzle-orm";

import type { Transaction } from "./client";
import { books, bookTombstones, playbackStates } from "./schema";

/** The transaction did no work; the durable client intent can be retried. */
export class SyncBusyError extends Error {
  constructor() {
    super("Account sync is busy. Retry shortly.");
  }
}

/**
 * Allocate a receipt for the account-wide sync cursor in a READ COMMITTED
 * transaction, before any cursor-bearing write or other write lock.
 *
 * Writers hold this account lock through commit. A pull cannot see a later
 * writer while an earlier receipt is still uncommitted. The separate SELECT
 * after acquiring the lock sees the previous writer's committed rows; combining
 * both statements would take its snapshot before the lock wait.
 *
 * All three streams share a floor, including retained ahead-of-clock receipts.
 * Deletion allocates before removing rows and carries that floor into its
 * tombstone. The MAX queries have (owner, timestamp) indexes. Keep the value
 * as database text: a JS Date would discard the cursor's microseconds.
 */
export async function syncReceipt(transaction: Transaction, userId: string) {
  // Brief concurrent drains may finish; an import must not pin every pool slot
  // with indefinite waiters. Save/restore the caller's timeout, changing it only
  // for account admission. MATERIALIZED reads the old value before set_config.
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
  // This scalar SELECT always returns one non-null row (clock_timestamp).
  return sql<Date>`${rows[0]!.value}::timestamptz`;
}
