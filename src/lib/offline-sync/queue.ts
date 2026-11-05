import type { IDBPObjectStore } from "idb";

import { assertAccountWritable } from "@/lib/account-deletion-fence";
import { withKeyedLock } from "@/lib/keyed-lock";

import {
  database,
  progressPayload,
  type MutationKind,
  type QueuedMutation,
  type QueuedProgress,
  type SyncDatabase,
} from "./db";
import { progressMutationKey } from "./keys";
import {
  queuedMediaRegistrationIdentity,
  sameQueuedMediaRegistration,
} from "./media-registration-identity";
import { reserveDeviceSequenceAboveInStore } from "./sequences";

export const MUTATION_COALESCING: Record<MutationKind, "sequence" | "replace" | "never"> = {
  progress: "sequence",
  metadata: "replace",
  archive: "replace",
  tag: "replace",
  collection: "replace",
  import: "never",
  delete: "never",
  history: "never",
};

export function newMutationId(): string {
  return crypto.randomUUID();
}

export type MutationDraft = Omit<QueuedMutation, "mutationId" | "queuedAt" | "attempts"> & {
  mutationId?: string;
  queuedAt?: number;
};

export function buildMutation(draft: MutationDraft): QueuedMutation {
  return {
    ...draft,
    mutationId: draft.mutationId || newMutationId(),
    queuedAt: draft.queuedAt ?? Date.now(),
    attempts: 0,
  };
}

export async function queueMutation(mutation: QueuedMutation): Promise<QueuedMutation> {
  return (await queueMutationWithOutcome(mutation)).queued;
}

export async function queueMutationWithOutcome(
  mutation: QueuedMutation,
): Promise<{ queued: QueuedMutation; changed: boolean }> {
  assertAccountWritable(mutation.userId);
  const db = await database();
  const transaction = db.transaction(["mutations", "sequences"], "readwrite");
  const mutations = transaction.objectStore("mutations");
  const existing = await mutations.get(mutation.key);
  const resolved = resolveCoalescing(existing, mutation);
  let winner = resolved;
  if (existing && mutation.kind === "progress" && resolved !== existing && resolved !== mutation) {
    const deviceSequence = await reserveDeviceSequenceAboveInStore(
      transaction.objectStore("sequences"),
      mutation.entityId,
      Math.max(existing.deviceSequence, mutation.deviceSequence),
      mutation.userId,
    );
    winner = { ...resolved, mutationId: newMutationId(), deviceSequence };
  }
  if (winner !== existing) await mutations.put(winner);
  if (winner === mutation && mutation.kind === "delete") {
    await dropSupersededImports(mutations, mutation);
  }
  assertAccountWritable(mutation.userId);
  await transaction.done;
  return { queued: winner, changed: winner !== existing };
}

type MutationStore = IDBPObjectStore<
  SyncDatabase,
  ("mutations" | "sequences")[],
  "mutations",
  "readwrite"
>;

async function dropSupersededImports(
  store: MutationStore,
  deletion: QueuedMutation,
): Promise<void> {
  const deletedIdentity = queuedMediaRegistrationIdentity(deletion);
  let cursor = await store.index("by-user").openCursor(deletion.userId);
  while (cursor) {
    const row = cursor.value;
    const supersedes =
      row.kind === "import" &&
      (row.payload.bookId === deletion.entityId ||
        sameQueuedMediaRegistration(queuedMediaRegistrationIdentity(row), deletedIdentity));
    if (supersedes) await cursor.delete();
    cursor = await cursor.continue();
  }
}

export function resolveCoalescing(
  existing: QueuedMutation | undefined,
  next: QueuedMutation,
): QueuedMutation {
  if (!existing) return next;
  if (MUTATION_COALESCING[next.kind] === "never") return existing;
  if (MUTATION_COALESCING[next.kind] === "sequence") {
    return mergeProgressMutations(existing, next);
  }
  return next;
}

export function mergeProgressMutations(
  existing: QueuedMutation,
  next: QueuedMutation,
  tieWinner = existing.deviceSequence <= next.deviceSequence ? next : existing,
): QueuedMutation {
  const envelope = tieWinner;
  const position = newerProgressField(existing, next, "position", envelope);
  const rate = newerProgressField(existing, next, "rate", envelope);
  const completed = newerProgressField(existing, next, "completed", envelope);
  if (position === envelope && rate === envelope && completed === envelope) return envelope;
  const payload: Record<string, unknown> = {
    ...envelope.payload,
    positionMs: position.payload.positionMs,
    eventOccurredAt: progressClock(position, "position"),
    playbackRate: rate.payload.playbackRate,
    playbackRateOccurredAt: progressClock(rate, "rate"),
    completed: completed.payload.completed,
    completedOccurredAt: progressClock(completed, "completed"),
  };
  payload.stateOccurredAt = laterProgressClock(
    String(payload.playbackRateOccurredAt),
    String(payload.completedOccurredAt),
  );
  if (sameProgressPayload(envelope.payload, payload)) return envelope;
  return {
    ...envelope,
    mutationId: next.mutationId,
    queuedAt: next.queuedAt,
    attempts: next.attempts,
    payload,
    progressPredecessor: {
      ...(position.progressPredecessor?.position
        ? { position: position.progressPredecessor.position }
        : {}),
      ...(rate.progressPredecessor?.playbackRate
        ? { playbackRate: rate.progressPredecessor.playbackRate }
        : {}),
      ...(completed.progressPredecessor?.completed
        ? { completed: completed.progressPredecessor.completed }
        : {}),
    },
  };
}

type ProgressField = "position" | "rate" | "completed";

function newerProgressField(
  left: QueuedMutation,
  right: QueuedMutation,
  field: ProgressField,
  tieWinner: QueuedMutation,
): QueuedMutation {
  const leftClock = progressClockMoment(left, field);
  const rightClock = progressClockMoment(right, field);
  if (leftClock === null && rightClock === null) return tieWinner;
  if (leftClock === null) return right;
  if (rightClock === null) return left;
  if (leftClock === rightClock) return tieWinner;
  return leftClock > rightClock ? left : right;
}

function progressClock(mutation: QueuedMutation, field: ProgressField): string {
  const { payload } = mutation;
  const value =
    field === "position"
      ? payload.eventOccurredAt
      : field === "rate"
        ? (payload.playbackRateOccurredAt ?? payload.stateOccurredAt ?? payload.eventOccurredAt)
        : (payload.completedOccurredAt ?? payload.stateOccurredAt ?? payload.eventOccurredAt);
  return String(value ?? "");
}

function progressClockMoment(mutation: QueuedMutation, field: ProgressField): number | null {
  const parsed = Date.parse(progressClock(mutation, field));
  return Number.isFinite(parsed) ? parsed : null;
}

function laterProgressClock(left: string, right: string): string {
  const leftMoment = Date.parse(left);
  const rightMoment = Date.parse(right);
  if (!Number.isFinite(leftMoment)) return right;
  if (!Number.isFinite(rightMoment)) return left;
  return leftMoment >= rightMoment ? left : right;
}

function sameProgressPayload(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return (
    left.positionMs === right.positionMs &&
    left.playbackRate === right.playbackRate &&
    left.completed === right.completed &&
    left.eventOccurredAt === right.eventOccurredAt &&
    left.playbackRateOccurredAt === right.playbackRateOccurredAt &&
    left.completedOccurredAt === right.completedOccurredAt &&
    left.stateOccurredAt === right.stateOccurredAt
  );
}

export function buildProgressMutation(entry: QueuedProgress): QueuedMutation {
  return buildMutation({
    key: progressMutationKey(entry),
    userId: entry.userId,
    kind: "progress",
    entityId: entry.bookId,
    payload: progressPayload(entry),
    deviceId: entry.deviceId,
    deviceSequence: entry.deviceSequence,
    ...(entry.predecessor ? { progressPredecessor: entry.predecessor } : {}),
  });
}

export async function queueProgress(entry: QueuedProgress): Promise<void> {
  await queueMutation(buildProgressMutation(entry));
}

export function toProgressBody(entry: Omit<QueuedProgress, "userId">): string {
  return JSON.stringify({
    deviceId: entry.deviceId,
    deviceSequence: entry.deviceSequence,
    ...progressPayload(entry),
  });
}

export function withProgressMutationLock<T>(
  bookId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(`chapterline:progress:${bookId}`, operation);
}

export async function listQueuedMutations(userId: string): Promise<QueuedMutation[]> {
  const db = await database();
  return db.getAllFromIndex("mutations", "by-user", userId);
}

export async function listQueuedMutationUserIds(): Promise<string[]> {
  const db = await database();
  const index = db.transaction("mutations").store.index("by-user");
  const users: string[] = [];
  let cursor = await index.openKeyCursor();
  while (cursor) {
    const userId = String(cursor.key);
    users.push(userId);
    cursor = await cursor.continue(`${userId}￿`);
  }
  return users;
}

export async function clearQueuedMutationsForUser(userId: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  let cursor = await transaction.store.index("by-user").openCursor(userId);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await transaction.done;
}
