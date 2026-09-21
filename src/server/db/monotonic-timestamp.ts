import { sql, type SQLWrapper } from "drizzle-orm";

/**
 * Server receipt time, not a client event clock. Evaluate after the row lock
 * using the database clock, and advance even if a retained timestamp is ahead.
 * Sync cursors preserve PostgreSQL's microseconds; no host Date conversion.
 */
export function monotonicTimestamp(previous: SQLWrapper) {
  return sql<Date>`greatest(clock_timestamp(), ${previous} + interval '1 microsecond')`;
}
