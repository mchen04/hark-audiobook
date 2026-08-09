import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "@/server/db/client";
import { books, mediaAssets, playbackDeviceSequences, playbackStates } from "@/server/db/schema";

import { mergeProgressFields, type ProgressFieldState } from "./progress-policy";

export type ProgressInput = {
  bookId: string;
  deviceId: string;
  deviceSequence: number;
  positionMs: number;
  playbackRate: number;
  completed: boolean;
  eventOccurredAt: Date;
  playbackRateOccurredAt?: Date;
  completedOccurredAt?: Date;
  /** Combined clock sent by clients that predate per-field clocks. */
  stateOccurredAt?: Date;
};

type PlaybackStateRow = typeof playbackStates.$inferSelect;

/**
 * The hottest write path (15s heartbeats plus every transport action), kept
 * under one per-book advisory lock. Device sequence claims and the merged
 * state still land in one CTE, while position, rate and completion arbitrate
 * on independent clocks.
 */
export async function saveProgress(userId: string, input: ProgressInput) {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${input.bookId}`}, 0))`,
    );
    const [ownedBook] = await transaction
      .select({
        durationMs: mediaAssets.durationMs,
        state: {
          userId: playbackStates.userId,
          bookId: playbackStates.bookId,
          positionMs: playbackStates.positionMs,
          playbackRate: playbackStates.playbackRate,
          completed: playbackStates.completed,
          deviceId: playbackStates.deviceId,
          deviceSequence: playbackStates.deviceSequence,
          eventOccurredAt: playbackStates.eventOccurredAt,
          playbackRateOccurredAt: playbackStates.playbackRateOccurredAt,
          completedOccurredAt: playbackStates.completedOccurredAt,
          stateOccurredAt: playbackStates.stateOccurredAt,
          updatedAt: playbackStates.updatedAt,
        },
      })
      .from(books)
      .innerJoin(mediaAssets, eq(mediaAssets.bookId, books.id))
      .leftJoin(
        playbackStates,
        and(eq(playbackStates.bookId, books.id), eq(playbackStates.userId, userId)),
      )
      .where(and(eq(books.id, input.bookId), eq(books.ownerId, userId)))
      .limit(1);
    if (!ownedBook) return { kind: "not-found" as const };
    const existing = ownedBook.state;
    const duplicate = async () => {
      const [sequence] = await transaction
        .select({ lastSequence: playbackDeviceSequences.lastSequence })
        .from(playbackDeviceSequences)
        .where(
          and(
            eq(playbackDeviceSequences.userId, userId),
            eq(playbackDeviceSequences.bookId, input.bookId),
            eq(playbackDeviceSequences.deviceId, input.deviceId),
          ),
        )
        .limit(1);
      return {
        kind: "duplicate" as const,
        state: existing,
        lastSequence: sequence?.lastSequence ?? input.deviceSequence,
      };
    };
    const existingFields: ProgressFieldState | null = existing
      ? {
          positionMs: existing.positionMs,
          playbackRate: Number(existing.playbackRate),
          completed: existing.completed,
          eventOccurredAt: existing.eventOccurredAt,
          playbackRateOccurredAt: existing.playbackRateOccurredAt,
          completedOccurredAt: existing.completedOccurredAt,
          stateOccurredAt: existing.stateOccurredAt,
        }
      : null;
    const decisions = mergeProgressFields(
      existingFields,
      {
        positionMs: input.positionMs,
        playbackRate: input.playbackRate,
        completed: input.completed,
        eventOccurredAt: input.eventOccurredAt,
        playbackRateOccurredAt: input.playbackRateOccurredAt,
        completedOccurredAt: input.completedOccurredAt,
        stateOccurredAt: input.stateOccurredAt,
      },
      new Date(),
      ownedBook.durationMs,
    );

    const allAccepted =
      decisions.position.accept && decisions.playbackRate.accept && decisions.completed.accept;
    const anyAccepted =
      decisions.position.accept || decisions.playbackRate.accept || decisions.completed.accept;
    if (!anyAccepted || (!existing && !allAccepted)) {
      // The sequence is still consumed so a replay of this event stays a
      // no-op instead of re-litigating the conflict later.
      const [sequenceClaim] = await transaction
        .insert(playbackDeviceSequences)
        .values({
          userId,
          bookId: input.bookId,
          deviceId: input.deviceId,
          lastSequence: input.deviceSequence,
        })
        .onConflictDoUpdate({
          target: [
            playbackDeviceSequences.userId,
            playbackDeviceSequences.bookId,
            playbackDeviceSequences.deviceId,
          ],
          set: { lastSequence: input.deviceSequence, updatedAt: new Date() },
          setWhere: lt(playbackDeviceSequences.lastSequence, input.deviceSequence),
        })
        .returning({ lastSequence: playbackDeviceSequences.lastSequence });
      if (!sequenceClaim) return duplicate();
      return {
        kind: "conflict" as const,
        reason: !decisions.position.accept
          ? decisions.position.reason
          : !decisions.playbackRate.accept
            ? decisions.playbackRate.reason
            : decisions.completed.reason,
        state: existing,
      };
    }

    const merged = decisions.merged;
    const saved = await transaction.execute<PlaybackStateRow>(sql`
      with claimed as (
        insert into ${playbackDeviceSequences} ("user_id", "book_id", "device_id", "last_sequence")
        values (${userId}, ${input.bookId}, ${input.deviceId}, ${input.deviceSequence})
        on conflict ("user_id", "book_id", "device_id") do update
          set "last_sequence" = excluded."last_sequence", "updated_at" = now()
          where ${playbackDeviceSequences}."last_sequence" < excluded."last_sequence"
        returning "last_sequence"
      )
      insert into ${playbackStates} (
        "user_id", "book_id", "position_ms", "playback_rate", "completed",
        "device_id", "device_sequence", "event_occurred_at",
        "playback_rate_occurred_at", "completed_occurred_at", "state_occurred_at", "updated_at"
      )
      select ${userId}, ${input.bookId}::uuid, ${merged.positionMs}::bigint,
        ${merged.playbackRate.toFixed(2)}::numeric, ${merged.completed}::boolean,
        ${input.deviceId}, ${input.deviceSequence}::bigint,
        ${merged.eventOccurredAt.toISOString()}::timestamptz,
        ${merged.playbackRateOccurredAt.toISOString()}::timestamptz,
        ${merged.completedOccurredAt.toISOString()}::timestamptz,
        ${merged.stateOccurredAt.toISOString()}::timestamptz, now()
      from claimed
      on conflict ("user_id", "book_id") do update set
        "position_ms" = excluded."position_ms",
        "playback_rate" = excluded."playback_rate",
        "completed" = excluded."completed",
        "device_id" = excluded."device_id",
        "device_sequence" = excluded."device_sequence",
        "event_occurred_at" = excluded."event_occurred_at",
        "playback_rate_occurred_at" = excluded."playback_rate_occurred_at",
        "completed_occurred_at" = excluded."completed_occurred_at",
        "state_occurred_at" = excluded."state_occurred_at",
        "updated_at" = excluded."updated_at"
      returning
        "user_id" as "userId",
        "book_id" as "bookId",
        "position_ms"::float8 as "positionMs",
        "playback_rate" as "playbackRate",
        "completed",
        "device_id" as "deviceId",
        "device_sequence"::float8 as "deviceSequence",
        "event_occurred_at" as "eventOccurredAt",
        "playback_rate_occurred_at" as "playbackRateOccurredAt",
        "completed_occurred_at" as "completedOccurredAt",
        "state_occurred_at" as "stateOccurredAt",
        "updated_at" as "updatedAt"
    `);
    const state = saved[0];
    if (!state) return duplicate();
    if (!allAccepted) {
      return {
        kind: "conflict" as const,
        reason: !decisions.position.accept
          ? "stale-position"
          : !decisions.playbackRate.accept
            ? "stale-playback-rate"
            : "stale-completed",
        state,
      };
    }
    return { kind: "saved" as const, state };
  });
}
