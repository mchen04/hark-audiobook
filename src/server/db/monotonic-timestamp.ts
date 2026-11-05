import { sql, type SQLWrapper } from "drizzle-orm";

export function monotonicTimestamp(previous: SQLWrapper) {
  return sql<Date>`greatest(clock_timestamp(), ${previous} + interval '1 microsecond')`;
}
