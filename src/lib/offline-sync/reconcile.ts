import { PROGRESS_CONFLICT_EVENT } from "@/lib/app-keys";
import { isAccountWriteFenced } from "@/lib/account-deletion-fence";
import { applyAuthoritativePlaybackStateWithStatus, readLocalProgress } from "@/lib/playback-core";

import { database, type QueuedMutation, type QueuedProgress } from "./db";
import { persistProgressNormalization } from "./normalizations";
import {
  archiveMutationKey,
  collectionMutationKey,
  eventMutationKey,
  metadataMutationKey,
  progressMutationKey,
  tagMutationKey,
} from "./keys";
import {
  mergeProgressMutations,
  MUTATION_COALESCING,
  newMutationId,
  resolveCoalescing,
  withProgressMutationLock,
} from "./queue";
import { currentDeviceSequence, reserveDeviceSequenceAboveInStore } from "./sequences";

type ImportReattachedHandler = (
  userId: string,
  fromBookId: string,
  toBookId: string,
  canonical: unknown,
) => Promise<void>;

type ProgressConflictHandler = (
  userId: string,
  bookId: string,
  state: {
    positionMs: number;
    completed: boolean;
    playbackRate: number;
    eventOccurredAt: string | null;
    playbackRateOccurredAt: string | null;
    completedOccurredAt: string | null;
    stateOccurredAt: string | null;
  },
) => Promise<void>;

let importReattachedHandler: ImportReattachedHandler | null = null;
let progressConflictHandler: ProgressConflictHandler | null = null;

export function registerImportReattachedHandler(handler: ImportReattachedHandler): void {
  importReattachedHandler = handler;
}

export function registerProgressConflictHandler(handler: ProgressConflictHandler): void {
  progressConflictHandler = handler;
}

export async function reattachDuplicateImport(
  task: QueuedMutation,
  response: Response,
): Promise<boolean> {
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as { existingBookId?: unknown; playerBook?: unknown } | null;
  const canonicalId = typeof payload?.existingBookId === "string" ? payload.existingBookId : null;
  const importedId = typeof task.payload.bookId === "string" ? task.payload.bookId : null;
  if (!canonicalId || !importedId || canonicalId === importedId) return true;
  if (!importReattachedHandler) return false;
  try {
    await repointQueuedMutations(task.userId, importedId, canonicalId);
    await importReattachedHandler(task.userId, importedId, canonicalId, payload?.playerBook);
    return true;
  } catch {
    return false;
  }
}

export async function awaitsRegistration(task: QueuedMutation): Promise<boolean> {
  const bookId = queuedBookId(task);
  if (!bookId) return false;
  const db = await database();
  const queued = await db.getAllFromIndex("mutations", "by-user", task.userId);
  return queued.some((row) => row.kind === "import" && row.payload.bookId === bookId);
}

function queuedBookId(row: QueuedMutation): string | null {
  if (row.kind === "import") return null;
  if (row.kind === "collection") {
    return typeof row.payload.bookId === "string" ? row.payload.bookId : null;
  }
  return row.entityId;
}

function addressedTo(row: QueuedMutation, bookId: string): QueuedMutation {
  switch (row.kind) {
    case "progress":
      return {
        ...row,
        entityId: bookId,
        key: progressMutationKey({ userId: row.userId, bookId, deviceId: row.deviceId }),
      };
    case "metadata":
      return { ...row, entityId: bookId, key: metadataMutationKey(row.userId, bookId) };
    case "archive":
      return { ...row, entityId: bookId, key: archiveMutationKey(row.userId, bookId) };
    case "tag":
      return {
        ...row,
        entityId: bookId,
        key: tagMutationKey(row.userId, bookId, String(row.payload.tagId ?? "")),
      };
    case "collection":
      return {
        ...row,
        payload: { ...row.payload, bookId },
        key: collectionMutationKey(row.userId, row.entityId, bookId),
      };
    case "delete":
    case "history":
      return {
        ...row,
        entityId: bookId,
        key: eventMutationKey(row.userId, row.kind, bookId, row.mutationId),
      };
    case "import":
      return row;
  }
}

async function repointQueuedMutations(
  userId: string,
  fromBookId: string,
  toBookId: string,
): Promise<number> {
  if (!fromBookId || !toBookId || fromBookId === toBookId) return 0;
  return withProgressMutationLock(toBookId, async () => {
    const db = await database();
    const transaction = db.transaction(["mutations", "sequences"], "readwrite");
    const store = transaction.objectStore("mutations");
    const all = await store.index("by-user").getAll(userId);
    const affected = all.filter((row) => queuedBookId(row) === fromBookId);
    if (!affected.length) {
      await transaction.done;
      return 0;
    }
    const progressFloor = all.reduce(
      (highest, row) =>
        row.kind === "progress" && (row.entityId === fromBookId || row.entityId === toBookId)
          ? Math.max(highest, row.deviceSequence)
          : highest,
      0,
    );
    const sequence = affected.some((row) => row.kind === "progress")
      ? await reserveDeviceSequenceAboveInStore(
          transaction.objectStore("sequences"),
          toBookId,
          progressFloor,
          userId,
        )
      : 0;

    let moved = 0;
    for (const snapshot of affected) {
      const current = await store.get(snapshot.key);
      if (!current || current.mutationId !== snapshot.mutationId) continue;
      const candidate = addressedTo(current, toBookId);
      const existing = await store.get(candidate.key);
      const winner = existing ? pickRepointWinner(existing, candidate) : candidate;
      await store.delete(current.key);
      const progressRevision = winner.kind === "progress" && winner !== existing;
      await store.put({
        ...winner,
        key: candidate.key,
        ...(progressRevision
          ? {
              deviceSequence: sequence,
              ...(winner !== candidate ? { mutationId: newMutationId() } : {}),
            }
          : {}),
      });
      moved += 1;
    }
    await transaction.done;
    return moved;
  });
}

function pickRepointWinner(existing: QueuedMutation, candidate: QueuedMutation): QueuedMutation {
  const candidateIsNewer = candidate.queuedAt > existing.queuedAt;
  if (MUTATION_COALESCING[candidate.kind] === "sequence") {
    return mergeProgressMutations(existing, candidate, candidateIsNewer ? candidate : existing);
  }
  return candidateIsNewer
    ? resolveCoalescing(existing, candidate)
    : resolveCoalescing(candidate, existing);
}

export function toQueuedProgress(mutation: QueuedMutation): QueuedProgress {
  const payload = mutation.payload as unknown as Omit<
    QueuedProgress,
    "userId" | "bookId" | "deviceId" | "deviceSequence"
  >;
  return {
    userId: mutation.userId,
    bookId: mutation.entityId,
    deviceId: mutation.deviceId,
    deviceSequence: mutation.deviceSequence,
    ...(mutation.progressPredecessor ? { predecessor: mutation.progressPredecessor } : {}),
    ...payload,
  };
}

type ServerProgressState = {
  positionMs: number;
  completed: boolean;
  playbackRate: number;
  eventOccurredAt: string;
  playbackRateOccurredAt: string;
  completedOccurredAt: string;
  stateOccurredAt: string;
};

async function readServerProgressState(response: Response): Promise<ServerProgressState | null> {
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as { state?: Record<string, unknown> } | null;
  const state = payload?.state;
  const positionMs = state?.positionMs;
  const completed = state?.completed;
  const playbackRate = Number(state?.playbackRate);
  const eventOccurredAt = typeof state?.eventOccurredAt === "string" ? state.eventOccurredAt : null;
  const stateOccurredAt =
    typeof state?.stateOccurredAt === "string" ? state.stateOccurredAt : eventOccurredAt;
  const playbackRateOccurredAt =
    typeof state?.playbackRateOccurredAt === "string"
      ? state.playbackRateOccurredAt
      : stateOccurredAt;
  const completedOccurredAt =
    typeof state?.completedOccurredAt === "string" ? state.completedOccurredAt : stateOccurredAt;
  const clocks = [eventOccurredAt, playbackRateOccurredAt, completedOccurredAt];
  if (
    typeof positionMs !== "number" ||
    typeof completed !== "boolean" ||
    !Number.isFinite(playbackRate) ||
    clocks.some((clock) => !clock || !Number.isFinite(Date.parse(clock)))
  ) {
    return null;
  }
  return {
    positionMs,
    completed,
    playbackRate,
    eventOccurredAt: eventOccurredAt!,
    playbackRateOccurredAt: playbackRateOccurredAt!,
    completedOccurredAt: completedOccurredAt!,
    stateOccurredAt: stateOccurredAt!,
  };
}

export async function duplicateProgressRetryFloor(
  entry: QueuedProgress,
  response: Response,
): Promise<number | null> {
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    kind?: unknown;
    lastSequence?: unknown;
    state?: Record<string, unknown> | null;
  } | null;
  if (payload?.kind !== "duplicate") return null;

  const state = payload.state;
  const stateDeviceId = typeof state?.deviceId === "string" ? state.deviceId : null;
  const stateSequence = Number(state?.deviceSequence);
  if (
    stateDeviceId === entry.deviceId &&
    Number.isSafeInteger(stateSequence) &&
    stateSequence === entry.deviceSequence
  ) {
    return null;
  }

  const statePositionClock = parseClock(state?.eventOccurredAt);
  const stateLegacyClock = parseClock(state?.stateOccurredAt) ?? statePositionClock;
  const stateRateClock = parseClock(state?.playbackRateOccurredAt) ?? stateLegacyClock;
  const stateCompletedClock = parseClock(state?.completedOccurredAt) ?? stateLegacyClock;
  const submittedPositionClock = parseClock(entry.eventOccurredAt);
  const submittedLegacyClock = parseClock(entry.stateOccurredAt) ?? submittedPositionClock;
  const submittedRateClock = parseClock(entry.playbackRateOccurredAt) ?? submittedLegacyClock;
  const submittedCompletedClock = parseClock(entry.completedOccurredAt) ?? submittedLegacyClock;
  const serverRate = Number(state?.playbackRate);
  const lostField =
    fieldWasSkipped(
      entry.positionMs,
      submittedPositionClock,
      state?.positionMs,
      statePositionClock,
    ) ||
    fieldWasSkipped(entry.playbackRate, submittedRateClock, serverRate, stateRateClock) ||
    fieldWasSkipped(
      entry.completed,
      submittedCompletedClock,
      state?.completed,
      stateCompletedClock,
    );
  if (!lostField) return null;

  const reportedHighWater = Number(payload.lastSequence);
  return Math.max(
    entry.deviceSequence,
    Number.isSafeInteger(reportedHighWater) ? reportedHighWater : 0,
    stateDeviceId === entry.deviceId && Number.isSafeInteger(stateSequence) ? stateSequence : 0,
  );
}

function parseClock(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function fieldWasSkipped(
  submittedValue: unknown,
  submittedClock: number | null,
  serverValue: unknown,
  serverClock: number | null,
): boolean {
  return (
    submittedClock !== null &&
    (serverClock === null ||
      submittedClock > serverClock ||
      (submittedClock === serverClock && submittedValue !== serverValue))
  );
}

export type AcceptedProgressReconciliation = {
  progress: QueuedProgress | null;
  persisted: boolean;
};

export async function reconcileAcceptedProgressWithStatus(
  entry: QueuedProgress,
  response: Response,
): Promise<AcceptedProgressReconciliation> {
  if (isAccountWriteFenced(entry.userId)) return { progress: null, persisted: false };
  const server = await readServerProgressState(response);
  if (isAccountWriteFenced(entry.userId)) return { progress: null, persisted: false };
  if (!server) return { progress: null, persisted: true };
  const submittedRateClock =
    entry.playbackRateOccurredAt ?? entry.stateOccurredAt ?? entry.eventOccurredAt;
  const submittedCompletedClock =
    entry.completedOccurredAt ?? entry.stateOccurredAt ?? entry.eventOccurredAt;
  const applied = applyAuthoritativePlaybackStateWithStatus(
    entry.userId,
    entry.bookId,
    {
      positionMs: server.positionMs,
      occurredAt: Date.parse(server.eventOccurredAt),
      playbackRate: server.playbackRate,
      playbackRateOccurredAt: Date.parse(server.playbackRateOccurredAt),
      completed: server.completed,
      completedOccurredAt: Date.parse(server.completedOccurredAt),
    },
    {
      positionMs: entry.positionMs,
      occurredAt: Date.parse(entry.eventOccurredAt),
      playbackRate: entry.playbackRate,
      playbackRateOccurredAt: Date.parse(submittedRateClock),
      completed: entry.completed,
      completedOccurredAt: Date.parse(submittedCompletedClock),
      predecessor: entry.predecessor,
    },
  );
  let durable = applied.persisted;
  if (!durable && applied.normalization) {
    try {
      await persistProgressNormalization(entry.userId, entry.bookId, applied.normalization);
      durable = true;
    } catch {}
  }
  const local = durable ? readLocalProgress(entry.userId, entry.bookId) : applied.state;
  const effectivePositionClock = local?.occurredAt ?? Date.parse(server.eventOccurredAt);
  const effectiveRateClock =
    local?.playbackRateOccurredAt ?? Date.parse(server.playbackRateOccurredAt);
  const effectiveCompletedClock =
    local?.completedOccurredAt ?? Date.parse(server.completedOccurredAt);
  const effective: QueuedProgress = {
    ...entry,
    positionMs: local?.positionMs ?? server.positionMs,
    playbackRate: local?.playbackRate ?? server.playbackRate,
    completed: local?.completed ?? server.completed,
    eventOccurredAt: new Date(effectivePositionClock).toISOString(),
    playbackRateOccurredAt: new Date(effectiveRateClock).toISOString(),
    completedOccurredAt: new Date(effectiveCompletedClock).toISOString(),
    stateOccurredAt: new Date(Math.max(effectiveRateClock, effectiveCompletedClock)).toISOString(),
  };
  if (progressConflictHandler && durable) {
    await progressConflictHandler(entry.userId, entry.bookId, {
      positionMs: effective.positionMs,
      completed: effective.completed,
      playbackRate: effective.playbackRate,
      eventOccurredAt: effective.eventOccurredAt,
      playbackRateOccurredAt: effective.playbackRateOccurredAt ?? null,
      completedOccurredAt: effective.completedOccurredAt ?? null,
      stateOccurredAt: effective.stateOccurredAt ?? null,
    });
  }
  return { progress: effective, persisted: durable };
}

export async function reconcileProgressConflict(
  entry: QueuedProgress,
  response: Response,
): Promise<boolean> {
  const server = await readServerProgressState(response);
  if (!server) return true;
  if ((await currentDeviceSequence(entry.bookId, entry.userId)) > entry.deviceSequence) return true;
  if (!progressConflictHandler) return false;
  const reconciled = await reconcileAcceptedProgressWithStatus(entry, response);
  if (!reconciled.persisted) return false;
  const effective = reconciled.progress;
  if (!effective) return true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(PROGRESS_CONFLICT_EVENT, {
        detail: {
          userId: entry.userId,
          bookId: entry.bookId,
          positionMs: effective.positionMs,
          completed: effective.completed,
          playbackRate: effective.playbackRate,
          eventOccurredAt: effective.eventOccurredAt,
          playbackRateOccurredAt: effective.playbackRateOccurredAt,
          completedOccurredAt: effective.completedOccurredAt,
        },
      }),
    );
  }
  return true;
}
