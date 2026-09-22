import { sql, type SQLWrapper } from "drizzle-orm";

/**
 * Server receipt time, not a client event clock. Evaluate after the row lock
 * using the database clock, and advance even if a retained timestamp is ahead.
 * For whole-snapshot streams and sequence receipts. Cursor-bearing writes
 * instead need syncReceipt's account-wide order, not just a per-row floor.
 */
export function monotonicTimestamp(previous: SQLWrapper) {
  return sql<Date>`greatest(clock_timestamp(), ${previous} + interval '1 microsecond')`;
}
