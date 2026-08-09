import "server-only";

import { and, eq, lt, lte, or, sql } from "drizzle-orm";

import { db } from "@/server/db/client";
import { rateLimit } from "@/server/db/schema";

type RateLimitValue = { key: string; count: number; lastRequest: number };
type RateLimitRule = { window: number; max: number };

/**
 * Better Auth 1.6.23's database wrapper prunes with only the global and built-in
 * windows. It does not include `customRules`, so a one-minute request can erase
 * a still-live ten-minute signup or password-reset bucket. This store keeps the
 * same shared, atomic database contract while deriving retention from every
 * window the app actually configured.
 */
export function createDatabaseRateLimitStorage(retentionWindowSeconds: number) {
  let nextPruneAt = 0;

  async function pruneExpiredRows(now: number): Promise<void> {
    if (now < nextPruneAt) return;
    nextPruneAt = now + 60_000;
    await db
      .delete(rateLimit)
      .where(lt(rateLimit.lastRequest, now - retentionWindowSeconds * 1_000));
  }

  async function consume(
    key: string,
    rule: RateLimitRule,
  ): Promise<{ allowed: boolean; retryAfter: number | null }> {
    const now = Date.now();
    const [inserted] = await db
      .insert(rateLimit)
      .values({ id: crypto.randomUUID(), key, count: 1, lastRequest: now })
      .onConflictDoNothing({ target: rateLimit.key })
      .returning({ key: rateLimit.key });
    if (inserted) {
      await pruneExpiredRows(now);
      return { allowed: true, retryAfter: null };
    }

    const windowStart = now - rule.window * 1_000;
    const [updated] = await db
      .update(rateLimit)
      .set({
        count: sql<number>`case when ${rateLimit.lastRequest} <= ${windowStart} then 1 else ${rateLimit.count} + 1 end`,
        lastRequest: now,
      })
      .where(
        and(
          eq(rateLimit.key, key),
          or(lte(rateLimit.lastRequest, windowStart), lt(rateLimit.count, rule.max)),
        ),
      )
      .returning({ key: rateLimit.key });
    if (updated) {
      await pruneExpiredRows(now);
      return { allowed: true, retryAfter: null };
    }

    const [current] = await db
      .select({ lastRequest: rateLimit.lastRequest })
      .from(rateLimit)
      .where(eq(rateLimit.key, key))
      .limit(1);
    // A concurrent cleanup can remove the row between UPDATE and SELECT. The
    // retry will insert it and count this request exactly once.
    if (!current) return consume(key, rule);
    return {
      allowed: false,
      retryAfter: Math.max(
        1,
        Math.ceil((current.lastRequest + rule.window * 1_000 - Date.now()) / 1_000),
      ),
    };
  }

  return {
    async get(key: string): Promise<RateLimitValue | null> {
      const [row] = await db
        .select({ key: rateLimit.key, count: rateLimit.count, lastRequest: rateLimit.lastRequest })
        .from(rateLimit)
        .where(eq(rateLimit.key, key))
        .limit(1);
      return row ?? null;
    },
    async set(key: string, value: RateLimitValue): Promise<void> {
      await db
        .insert(rateLimit)
        .values({
          id: crypto.randomUUID(),
          key,
          count: value.count,
          lastRequest: value.lastRequest,
        })
        .onConflictDoUpdate({
          target: rateLimit.key,
          set: { count: value.count, lastRequest: value.lastRequest },
        });
    },
    consume,
  };
}
