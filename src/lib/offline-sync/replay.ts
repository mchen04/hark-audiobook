import { readLocalProgress } from "@/lib/playback-core";
import { ensurePermanentOfflineBookDeletion } from "@/lib/offline/deletion-fence";
import { singleFlight } from "@/lib/single-flight";
import { withKeyedLock } from "@/lib/keyed-lock";
import { runBounded } from "@/lib/run-bounded";

import { database, type QueuedMutation, type SyncDb } from "./db";
import { withBookProjectionLock } from "./locks";
import { queuedMediaRegistrationIdentity } from "./media-registration-identity";
import {
  hasPendingDeleteForMediaRegistration,
  withMediaRegistrationLock,
} from "./media-registration-guard";
import { newMutationId, withProgressMutationLock } from "./queue";
import {
  awaitsRegistration,
  duplicateProgressRetryFloor,
  reattachDuplicateImport,
  reconcileAcceptedProgressWithStatus,
  reconcileProgressConflict,
  toQueuedProgress,
} from "./reconcile";
import {
  currentDeviceSequence,
  replayAcknowledgementKey,
  reserveDeviceSequenceAbove,
  reserveDeviceSequenceAboveInStore,
} from "./sequences";

export const REPLAY_PAGE_SIZE = 100;
export const REPLAY_CONCURRENCY = 4;
const activeReplays = new Map<string, Promise<void>>();

function isRetryableMutationStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function shouldRetainMutation(status: number): boolean {
  return status === 401 || status === 403 || isRetryableMutationStatus(status);
}

export type ReplayRequest = { url: string; init: RequestInit };

export function toReplayRequest(mutation: QueuedMutation): ReplayRequest {
  const json = (method: string, body: Record<string, unknown>, url: string): ReplayRequest => ({
    url,
    init: { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  });
  switch (mutation.kind) {
    case "progress":
      return json(
        "PATCH",
        {
          deviceId: mutation.deviceId,
          deviceSequence: mutation.deviceSequence,
          ...mutation.payload,
        },
        `/api/books/${mutation.entityId}/progress`,
      );
    case "history":
      return json(
        "POST",
        { ...mutation.payload, id: mutation.mutationId },
        `/api/books/${mutation.entityId}/history`,
      );
    case "import":
      return json("POST", { ...mutation.payload }, "/api/books/local");
    case "collection":
      return json("PATCH", { ...mutation.payload }, `/api/collections/${mutation.entityId}`);
    case "delete":
      return {
        url: `/api/books/${mutation.entityId}`,
        init: { method: "DELETE", headers: { "X-Mutation-Id": mutation.mutationId } },
      };
    case "tag":
      return json(
        "PATCH",
        {
          tagEdge: {
            tagId: mutation.payload.tagId,
            include: mutation.payload.include,
            ...(typeof mutation.payload.name === "string" ? { name: mutation.payload.name } : {}),
          },
          mutationId: mutation.mutationId,
        },
        `/api/books/${mutation.entityId}`,
      );
    default:
      return json("PATCH", { ...mutation.payload }, `/api/books/${mutation.entityId}`);
  }
}

export function replayQueuedMutations(
  userId: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  return singleFlight(activeReplays, userId, () => replayQueueSnapshot(userId, fetchFn));
}

async function replayQueueSnapshot(userId: string, fetchFn: typeof fetch): Promise<void> {
  const db = await database();
  let afterKey: string | undefined;
  while (true) {
    const tasks = await readMutationPage(db, userId, afterKey);
    if (!tasks.length) return;
    await runBounded(tasks, REPLAY_CONCURRENCY, async (task) => {
      try {
        await replayMutation(task, fetchFn);
      } catch {}
    });
    afterKey = tasks.at(-1)!.key;
    if (tasks.length < REPLAY_PAGE_SIZE) return;
  }
}

async function readMutationPage(db: SyncDb, userId: string, afterKey?: string) {
  const range = IDBKeyRange.bound([userId, afterKey || ""], [userId, "￿"], !!afterKey);
  const tasks: QueuedMutation[] = [];
  let cursor = await db.transaction("mutations").store.index("by-user-key").openCursor(range);
  while (cursor && tasks.length < REPLAY_PAGE_SIZE) {
    tasks.push(cursor.value);
    cursor = await cursor.continue();
  }
  return tasks;
}

function withMutationLock<T>(mutation: QueuedMutation, operation: () => Promise<T>): Promise<T> {
  if (mutation.kind === "progress") return withProgressMutationLock(mutation.entityId, operation);

  const identity = queuedMediaRegistrationIdentity(mutation);
  return identity
    ? withMediaRegistrationLock(mutation.userId, identity, operation)
    : withKeyedLock(`chapterline:mutation:${mutation.key}`, operation);
}

async function supersedeStaleProgress(task: QueuedMutation): Promise<QueuedMutation> {
  if (task.kind !== "progress") return task;
  const issuedSequence = await currentDeviceSequence(task.entityId, task.userId);
  const sequenceIsStale = issuedSequence > task.deviceSequence;
  const local = readLocalProgress(task.userId, task.entityId);

  const queuedPositionClock = clockFrom(task.payload.eventOccurredAt);
  const queuedLegacyClock = clockFrom(task.payload.stateOccurredAt ?? task.payload.eventOccurredAt);
  const queuedRateClock = clockFrom(task.payload.playbackRateOccurredAt) ?? queuedLegacyClock;
  const queuedCompletedClock = clockFrom(task.payload.completedOccurredAt) ?? queuedLegacyClock;
  const localRateClock = local
    ? (local.playbackRateOccurredAt ?? local.writtenAt ?? local.occurredAt)
    : -1;
  const localCompletedClock = local
    ? (local.completedOccurredAt ?? local.writtenAt ?? local.occurredAt)
    : -1;

  const positionIsNewer =
    !!local &&
    local.occurredAt > 0 &&
    queuedPositionClock !== null &&
    local.occurredAt > queuedPositionClock;
  const rateIsNewer =
    typeof local?.playbackRate === "number" &&
    queuedRateClock !== null &&
    localRateClock > queuedRateClock;
  const completionIsNewer =
    typeof local?.completed === "boolean" &&
    queuedCompletedClock !== null &&
    localCompletedClock > queuedCompletedClock;
  if (!positionIsNewer && !rateIsNewer && !completionIsNewer && !sequenceIsStale) return task;

  const deviceSequence = await reserveDeviceSequenceAbove(
    task.entityId,
    task.deviceSequence,
    task.userId,
  );
  const superseded: QueuedMutation = {
    ...task,
    deviceSequence,
    payload: {
      ...task.payload,
      ...(positionIsNewer
        ? {
            positionMs: Math.round(local!.positionMs),
            eventOccurredAt: new Date(local!.occurredAt).toISOString(),
          }
        : {}),
      ...(rateIsNewer
        ? {
            playbackRate: local!.playbackRate,
            playbackRateOccurredAt: new Date(localRateClock).toISOString(),
          }
        : {}),
      ...(completionIsNewer
        ? {
            completed: local!.completed,
            completedOccurredAt: new Date(localCompletedClock).toISOString(),
          }
        : {}),
    },
  };
  const rateClock = String(
    superseded.payload.playbackRateOccurredAt ??
      superseded.payload.stateOccurredAt ??
      superseded.payload.eventOccurredAt,
  );
  const completedClock = String(
    superseded.payload.completedOccurredAt ??
      superseded.payload.stateOccurredAt ??
      superseded.payload.eventOccurredAt,
  );
  superseded.payload.stateOccurredAt = laterClock(rateClock, completedClock);

  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  const current = await transaction.store.get(task.key);
  if (current?.mutationId !== task.mutationId) {
    await transaction.done;
    return current ?? task;
  }
  await transaction.store.put(superseded);
  await transaction.done;
  return superseded;
}

function clockFrom(value: unknown): number | null {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function laterClock(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

async function refreshDuplicateProgress(
  task: QueuedMutation,
  serverSequenceFloor: number,
): Promise<void> {
  const db = await database();
  const transaction = db.transaction(["mutations", "sequences"], "readwrite");
  const mutations = transaction.objectStore("mutations");
  const current = await mutations.get(task.key);
  if (current?.mutationId === task.mutationId) {
    const deviceSequence = await reserveDeviceSequenceAboveInStore(
      transaction.objectStore("sequences"),
      task.entityId,
      Math.max(task.deviceSequence, serverSequenceFloor),
      task.userId,
    );
    await mutations.put({
      ...task,
      mutationId: newMutationId(),
      deviceSequence,
      attempts: task.attempts + 1,
    });
  }
  await transaction.done;
}

async function replayMutation(snapshot: QueuedMutation, fetchFn: typeof fetch): Promise<void> {
  await withMutationLock(snapshot, async () => {
    const db = await database();
    const current = await db.get("mutations", snapshot.key);
    if (!current) return;
    const task = await supersedeStaleProgress(current);
    const identity = queuedMediaRegistrationIdentity(task);
    if (
      task.kind === "import" &&
      identity &&
      (await hasPendingDeleteForMediaRegistration(task.userId, identity))
    ) {
      return;
    }
    if (task.kind === "delete") {
      await ensurePermanentOfflineBookDeletion(task.userId, task.entityId);
    }
    const { url, init } = toReplayRequest(task);
    const response = await fetchFn(url, init);
    if (
      response.status === 400 &&
      task.kind === "progress" &&
      ("playbackRateOccurredAt" in task.payload || "completedOccurredAt" in task.payload)
    ) {
      await recordAttempt(task);
      return;
    }
    if (shouldRetainMutation(response.status)) {
      await recordAttempt(task);
      return;
    }
    if (response.status === 404 && (await awaitsRegistration(task))) {
      await recordAttempt(task);
      return;
    }
    if (response.status === 409) {
      if (task.kind === "progress") {
        if (!(await reconcileProgressConflict(toQueuedProgress(task), response))) {
          await recordAttempt(task);
          return;
        }
      } else if (task.kind === "import" && !(await reattachDuplicateImport(task, response))) {
        await recordAttempt(task);
        return;
      }
    }
    if (response.ok && task.kind === "progress") {
      const entry = toQueuedProgress(task);
      const duplicateFloor = await duplicateProgressRetryFloor(entry, response);
      if (duplicateFloor !== null) {
        await refreshDuplicateProgress(task, duplicateFloor);
        return;
      }
      const reconciled = await reconcileAcceptedProgressWithStatus(entry, response);
      if (!reconciled.persisted) {
        await recordAttempt(task);
        return;
      }
    }
    await settleMutation(task);
  });
}

async function settleMutation(snapshot: QueuedMutation): Promise<void> {
  await withBookProjectionLock(snapshot.userId, async () => {
    const db = await database();
    const transaction = db.transaction(["mutations", "sequences"], "readwrite");
    const mutations = transaction.objectStore("mutations");
    const current = await mutations.get(snapshot.key);
    if (current?.mutationId === snapshot.mutationId) await mutations.delete(snapshot.key);
    const sequences = transaction.objectStore("sequences");
    const key = replayAcknowledgementKey(snapshot.userId);
    const acknowledged = await sequences.get(key);
    await sequences.put({ key, userId: snapshot.userId, value: (acknowledged?.value ?? 0) + 1 });
    await transaction.done;
  });
}

async function recordAttempt(snapshot: QueuedMutation): Promise<void> {
  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  const current = await transaction.store.get(snapshot.key);
  if (current?.mutationId === snapshot.mutationId) {
    await transaction.store.put({ ...current, attempts: current.attempts + 1 });
  }
  await transaction.done;
}
