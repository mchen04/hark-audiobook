import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from "idb";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import type { PlaybackPredecessor } from "@/lib/playback-core";

const DATABASE_NAME = "chapterline-sync-v1";
const SYNC_DATABASE_VERSION = 5;

export type MutationKind =
  "progress" | "import" | "metadata" | "tag" | "collection" | "archive" | "delete" | "history";

export type QueuedMutation = {
  key: string;
  userId: string;
  kind: MutationKind;
  entityId: string;
  payload: Record<string, unknown>;
  mutationId: string;
  deviceId: string;
  deviceSequence: number;
  queuedAt: number;
  attempts: number;
  progressPredecessor?: PlaybackPredecessor;
};

export type QueuedProgress = {
  userId: string;
  bookId: string;
  deviceId: string;
  deviceSequence: number;
  positionMs: number;
  playbackRate: number;
  completed: boolean;
  eventOccurredAt: string;
  playbackRateOccurredAt?: string;
  completedOccurredAt?: string;
  stateOccurredAt?: string;
  predecessor?: PlaybackPredecessor;
};

type LegacyProgressMutation = {
  key: string;
  userId: string;
  kind: "progress";
  entry: QueuedProgress;
};

export interface SyncDatabase extends DBSchema {
  mutations: {
    key: string;
    value: QueuedMutation;
    indexes: { "by-user": string; "by-user-key": [string, string] };
  };
  sequences: {
    key: string;
    value: SequenceRow;
  };
}

type SequenceRow = { key: string; userId?: string; bookId?: string; value: number };

export type SyncDb = IDBPDatabase<SyncDatabase>;

export function database() {
  return openDB<SyncDatabase>(DATABASE_NAME, SYNC_DATABASE_VERSION, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const mutations = db.createObjectStore("mutations", { keyPath: "key" });
        mutations.createIndex("by-user", "userId");
        mutations.createIndex("by-user-key", ["userId", "key"]);
        db.createObjectStore("sequences", { keyPath: "key" });
        return;
      }
      if (oldVersion < 2) {
        const mutations = transaction.objectStore("mutations");
        let cursor = await mutations.openCursor();
        while (cursor) {
          const legacy = cursor.value as LegacyProgressMutation | { kind: string };
          if (legacy.kind !== "progress") await cursor.delete();
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 3) {
        transaction.objectStore("mutations").createIndex("by-user-key", ["userId", "key"]);
      }
      if (oldVersion < 4) {
        const mutations = transaction.objectStore("mutations");
        let cursor = await mutations.openCursor();
        while (cursor) {
          await cursor.update(
            migrateLegacyMutation(
              cursor.value as unknown as LegacyProgressMutation | QueuedMutation,
            ),
          );
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 5) {
        await attributeSequencesToActiveUser(transaction);
      }
    },
  });
}

type UpgradeTransaction = IDBPTransaction<
  SyncDatabase,
  StoreNames<SyncDatabase>[],
  "versionchange"
>;

async function attributeSequencesToActiveUser(transaction: UpgradeTransaction): Promise<void> {
  const owner = activeUserId();
  if (!owner) return;
  const store = transaction.objectStore("sequences");
  for (const row of await store.getAll()) {
    if (row.userId !== undefined || row.key === SEQUENCE_FLOOR_KEY) continue;
    const scoped = deviceSequenceKey(owner, row.key);
    const existing = await store.get(scoped);
    await store.put({
      key: scoped,
      userId: owner,
      bookId: row.key,
      value: Math.max(existing?.value || 0, row.value),
    });
    await store.delete(row.key);
  }
}

function migrateLegacyMutation(row: LegacyProgressMutation | QueuedMutation): QueuedMutation {
  if (!("entry" in row)) return row;
  const { entry } = row;
  return {
    key: row.key,
    userId: row.userId,
    kind: "progress",
    entityId: entry.bookId,
    payload: progressPayload(entry),
    mutationId: `legacy:${row.key}:${entry.deviceSequence}`,
    deviceId: entry.deviceId,
    deviceSequence: entry.deviceSequence,
    queuedAt: 0,
    attempts: 0,
  };
}

export function progressPayload(entry: Omit<QueuedProgress, "userId">): Record<string, unknown> {
  return {
    positionMs: Math.round(entry.positionMs),
    playbackRate: entry.playbackRate,
    completed: entry.completed,
    eventOccurredAt: entry.eventOccurredAt,
    ...(entry.playbackRateOccurredAt
      ? { playbackRateOccurredAt: entry.playbackRateOccurredAt }
      : {}),
    ...(entry.completedOccurredAt ? { completedOccurredAt: entry.completedOccurredAt } : {}),
    ...(entry.stateOccurredAt ? { stateOccurredAt: entry.stateOccurredAt } : {}),
  };
}

export const SEQUENCE_FLOOR_KEY = "\u0000device-sequence-floor";

export function deviceSequenceKey(userId: string, bookId: string): string {
  return `${userId}:${bookId}`;
}

export function activeUserId(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(ACTIVE_USER_KEY);
  } catch {
    return null;
  }
}
