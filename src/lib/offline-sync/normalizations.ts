import { openDB, type DBSchema } from "idb";

import { withAccountWriteLock } from "@/lib/account-deletion-fence";
import {
  applyAuthoritativePlaybackStateWithStatus,
  installPendingPlaybackNormalizations,
  type PlaybackFieldNormalization,
  type PlaybackNormalization,
} from "@/lib/playback-core";

const DATABASE_NAME = "chapterline-progress-normalizations-v1";
const CHANNEL_NAME = "chapterline-progress-normalizations";

export type ProgressNormalizationRow = {
  key: string;
  userId: string;
  bookId: string;
  normalization: PlaybackNormalization;
};

interface NormalizationDatabase extends DBSchema {
  normalizations: {
    key: string;
    value: ProgressNormalizationRow;
    indexes: { "by-user": string };
  };
}

function database() {
  return openDB<NormalizationDatabase>(DATABASE_NAME, 1, {
    upgrade(db) {
      const store = db.createObjectStore("normalizations", { keyPath: "key" });
      store.createIndex("by-user", "userId");
    },
  });
}

function normalizationKey(userId: string, bookId: string): string {
  return `${userId}:${bookId}`;
}

let channel: BroadcastChannel | null | undefined;

type NormalizationMessage = {
  userId: string;
  bookId: string;
  normalization: PlaybackNormalization | null;
};

function normalizationChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    channel = null;
    return null;
  }
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener("message", (event: MessageEvent<NormalizationMessage>) => {
    const message = event.data;
    if (!validMessage(message)) return;
    installPendingPlaybackNormalizations(message.userId, message.bookId, message.normalization);
  });
  return channel;
}

function publishNormalization(
  userId: string,
  bookId: string,
  normalization: PlaybackNormalization | null,
): void {
  installPendingPlaybackNormalizations(userId, bookId, normalization);
  normalizationChannel()?.postMessage({ userId, bookId, normalization });
}

export function persistProgressNormalization(
  userId: string,
  bookId: string,
  normalization: PlaybackNormalization,
): Promise<void> {
  return withAccountWriteLock(userId, () =>
    writeProgressNormalization(userId, bookId, normalization),
  );
}

async function writeProgressNormalization(
  userId: string,
  bookId: string,
  normalization: PlaybackNormalization,
): Promise<void> {
  const db = await database();
  const transaction = db.transaction("normalizations", "readwrite");
  const key = normalizationKey(userId, bookId);
  const current = await transaction.store.get(key);
  const merged = mergeNormalizations(current?.normalization, normalization);
  const row: ProgressNormalizationRow = { key, userId, bookId, normalization: merged };
  await transaction.store.put(row);
  await transaction.done;
  publishNormalization(userId, bookId, row.normalization);
}

export async function applyPendingProgressNormalizations(
  userId: string,
  bookId: string,
): Promise<number> {
  const db = await database();
  const key = normalizationKey(userId, bookId);
  const row = await db.get("normalizations", key);
  if (!row) {
    installPendingPlaybackNormalizations(userId, bookId, null);
    return 0;
  }
  // The common path is a read-only miss and needs no account-wide lock. A hit
  // is re-read inside the lock: purge either waits for this mutation and then
  // removes it, or fences it before it can recreate the departed account.
  return withAccountWriteLock(userId, () => drainProgressNormalization(userId, bookId));
}

async function drainProgressNormalization(userId: string, bookId: string): Promise<number> {
  const db = await database();
  const key = normalizationKey(userId, bookId);
  const row = await db.get("normalizations", key);
  if (!row) {
    installPendingPlaybackNormalizations(userId, bookId, null);
    return 0;
  }

  // Keep the projection installed across every await below. A synchronous
  // player read in another microtask may be provisional, but it must never see
  // the raw acknowledged tuple while this realm is draining the durable row.
  installPendingPlaybackNormalizations(userId, bookId, row.normalization);
  const result = applyNormalization(userId, bookId, row.normalization);
  const transaction = db.transaction("normalizations", "readwrite");
  const current = await transaction.store.get(key);
  if (current && sameNormalization(current.normalization, row.normalization)) {
    if (result.normalization) {
      const next = { ...current, normalization: result.normalization };
      await transaction.store.put(next);
      installPendingPlaybackNormalizations(userId, bookId, next.normalization);
    } else {
      await transaction.store.delete(key);
      installPendingPlaybackNormalizations(userId, bookId, null);
    }
  } else {
    installPendingPlaybackNormalizations(userId, bookId, current?.normalization ?? null);
  }
  await transaction.done;
  if (current && sameNormalization(current.normalization, row.normalization)) {
    publishNormalization(userId, bookId, result.normalization);
  }
  return result.normalization ? normalizationFieldCount(result.normalization) : 0;
}

export async function applyPendingProgressNormalizationsForUser(userId: string): Promise<number> {
  const db = await database();
  const rows = await db.getAllFromIndex("normalizations", "by-user", userId);
  let remaining = 0;
  for (const row of rows) {
    remaining += await applyPendingProgressNormalizations(userId, row.bookId);
  }
  return remaining;
}

export async function purgeProgressNormalization(userId: string, bookId: string): Promise<void> {
  const db = await database();
  await db.delete("normalizations", normalizationKey(userId, bookId));
  publishNormalization(userId, bookId, null);
}

export async function purgeProgressNormalizationsForUser(userId: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction("normalizations", "readwrite");
  let cursor = await transaction.store.index("by-user").openCursor(userId);
  const cleared: Array<{ userId: string; bookId: string }> = [];
  while (cursor) {
    cleared.push({ userId, bookId: cursor.value.bookId });
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await transaction.done;
  for (const entry of cleared) {
    publishNormalization(entry.userId, entry.bookId, null);
  }
}

export async function listProgressNormalizations(
  userId: string,
): Promise<ProgressNormalizationRow[]> {
  const db = await database();
  return db.getAllFromIndex("normalizations", "by-user", userId);
}

export async function listProgressNormalizationUserIds(): Promise<string[]> {
  const db = await database();
  const index = db.transaction("normalizations").store.index("by-user");
  const users: string[] = [];
  let cursor = await index.openKeyCursor(null, "nextunique");
  while (cursor) {
    users.push(String(cursor.key));
    cursor = await cursor.continue();
  }
  return users;
}

function applyNormalization(userId: string, bookId: string, normalization: PlaybackNormalization) {
  const position = normalization.position ?? fallbackNumberField(0);
  const playbackRate = normalization.playbackRate ?? fallbackNumberField(1);
  const completed = normalization.completed ?? fallbackBooleanField(false);
  return applyAuthoritativePlaybackStateWithStatus(
    userId,
    bookId,
    {
      positionMs: position.canonical.value,
      occurredAt: position.canonical.occurredAt,
      playbackRate: playbackRate.canonical.value,
      playbackRateOccurredAt: playbackRate.canonical.occurredAt,
      completed: completed.canonical.value,
      completedOccurredAt: completed.canonical.occurredAt,
    },
    {
      positionMs: position.submitted.value,
      occurredAt: position.submitted.occurredAt,
      playbackRate: playbackRate.submitted.value,
      playbackRateOccurredAt: playbackRate.submitted.occurredAt,
      completed: completed.submitted.value,
      completedOccurredAt: completed.submitted.occurredAt,
    },
    undefined,
    true,
    {
      position: !!normalization.position,
      playbackRate: !!normalization.playbackRate,
      completed: !!normalization.completed,
    },
  );
}

function fallbackNumberField(value: number): PlaybackFieldNormalization<number> {
  return {
    submitted: { value, occurredAt: 0 },
    canonical: { value, occurredAt: 0 },
  };
}

function fallbackBooleanField(value: boolean): PlaybackFieldNormalization<boolean> {
  return {
    submitted: { value, occurredAt: 0 },
    canonical: { value, occurredAt: 0 },
  };
}

function mergeNormalizations(
  current: PlaybackNormalization | undefined,
  next: PlaybackNormalization,
): PlaybackNormalization {
  return {
    position: mergeField(current?.position, next.position),
    playbackRate: mergeField(current?.playbackRate, next.playbackRate),
    completed: mergeField(current?.completed, next.completed),
  };
}

function mergeField<T extends number | boolean>(
  current: PlaybackFieldNormalization<T> | undefined,
  next: PlaybackFieldNormalization<T> | undefined,
): PlaybackFieldNormalization<T> | undefined {
  if (!next) return current;
  if (!current) return next;
  return { submitted: current.submitted, canonical: next.canonical };
}

function normalizationFieldCount(normalization: PlaybackNormalization): number {
  return (
    Number(!!normalization.position) +
    Number(!!normalization.playbackRate) +
    Number(!!normalization.completed)
  );
}

function sameNormalization(left: PlaybackNormalization, right: PlaybackNormalization): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validMessage(value: unknown): value is NormalizationMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<NormalizationMessage>;
  return (
    typeof message.userId === "string" &&
    typeof message.bookId === "string" &&
    (message.normalization === null || typeof message.normalization === "object")
  );
}

void normalizationChannel();
