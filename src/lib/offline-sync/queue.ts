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
import { reserveDeviceSequenceAboveInStore } from "./sequences";

/**
 * Coalescing policy, exactly as the design contract states it.
 *
 * - `sequence`: progress for one book+device keeps the highest
 *   `deviceSequence` as its replay envelope and independently keeps the newest
 *   position, rate and completion registers from every coalesced row.
 * - `replace`: the latest intent for this entity wins outright (a rename, an
 *   archive flip, one tag edge, one collection edge).
 * - `never`: each row is a distinct event. `import`, `delete` and `history`
 *   carry a unique key so no two of them can ever collapse — dropping one is a
 *   lost write, not a saved round trip.
 */
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

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

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

/**
 * Journals one intent. Returns the row that is now durable — which is the
 * existing row when an out-of-order progress event was dropped, so a caller can
 * never believe it queued something the outbox refused.
 */
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

/**
 * A delete supersedes an UNSENT import of the same file.
 *
 * Deleting a book and re-picking its MP3 are two intents about one file, and
 * the outbox replays rows in key order with four in flight — not in the order
 * the user expressed them. So a registration queued before the delete lands
 * after it, finds the fingerprint free because the delete just released it, and
 * creates the book again. The user's delete is not lost in transit; it is
 * undone by an intent they had already superseded, and the book comes back.
 *
 * Resolving it here rather than at replay is what makes it deterministic: this
 * runs inside the SAME transaction that journals the delete, so there is no
 * window in which both rows exist and no ordering to get right afterwards.
 *
 * Two ways a queued registration is recognised as being about the deleted book,
 * because there are two ways the user can be looking at one. `payload.bookId`
 * matches the row the import itself created on this device — the "device-only"
 * book the library projects from a download record before any pull mentions it.
 * The fingerprint matches the other case: a re-import of a book this device
 * already knows, where the registration carries an id the server will discard.
 */
async function dropSupersededImports(
  store: MutationStore,
  deletion: QueuedMutation,
): Promise<void> {
  const fingerprint =
    typeof deletion.payload.fingerprint === "string" ? deletion.payload.fingerprint : null;
  let cursor = await store.index("by-user").openCursor(deletion.userId);
  while (cursor) {
    const row = cursor.value;
    const supersedes =
      row.kind === "import" &&
      (row.payload.bookId === deletion.entityId || (!!fingerprint && row.entityId === fingerprint));
    if (supersedes) await cursor.delete();
    cursor = await cursor.continue();
  }
}

export function resolveCoalescing(
  existing: QueuedMutation | undefined,
  next: QueuedMutation,
): QueuedMutation {
  if (!existing) return next;
  // A `never` kind cannot reach here with a different row: its key embeds a
  // unique mutationId. Re-queueing the identical id is the caller retrying the
  // same intent, which must stay one event.
  if (MUTATION_COALESCING[next.kind] === "never") return existing;
  if (MUTATION_COALESCING[next.kind] === "sequence") {
    return mergeProgressMutations(existing, next);
  }
  return next;
}

/**
 * The highest sequence is the replay envelope, not permission to discard the
 * other event's independently newer fields. Tabs share a device id and mint
 * sequences from one counter, but each can be carrying a different causal
 * baseline; merge before the single keyed outbox row replaces either event.
 */
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
  // Any payload change is a new outbox revision even when the highest sequence
  // still belongs to `existing`. Otherwise an in-flight acknowledgement for
  // that old mutationId can delete the newly merged field in `settleMutation`.
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

/**
 * One progress event in outbox form. Shared by the queue-only path and by
 * `offline/outbox.ts#commitProgress`, so the row a replay sends and the row the
 * mirror is projected from are assembled once, from the same builder.
 */
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

/**
 * Every account with an unsent write in this database.
 *
 * The account purge enumerates the device before it sweeps it, and an account
 * whose only remaining trace is a queued mutation is still an account whose
 * intent — a rename, a tag, the title of a book — is readable by whoever signs
 * in next. Read from the `by-user` index's keys, so the cost is the number of
 * distinct accounts rather than the size of the queue.
 */
export async function listQueuedMutationUserIds(): Promise<string[]> {
  const db = await database();
  const index = db.transaction("mutations").store.index("by-user");
  const users: string[] = [];
  // A key cursor that skips past each account once it is seen: the walk costs
  // one step per distinct account, not one per queued write.
  let cursor = await index.openKeyCursor();
  while (cursor) {
    const userId = String(cursor.key);
    users.push(userId);
    cursor = await cursor.continue(`${userId}￿`);
  }
  return users;
}

/**
 * Drops one account's queue. `sequences` is deliberately untouched: those
 * high-water marks order every future replay, and resetting them would let a
 * stale event overwrite a newer one after the next sign-in.
 */
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
