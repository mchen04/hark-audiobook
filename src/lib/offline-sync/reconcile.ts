import { PROGRESS_CONFLICT_EVENT } from "@/lib/app-keys";
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

// ---------------------------------------------------------------------------
// Registration hooks
// ---------------------------------------------------------------------------

/**
 * The layer above this module, subscribed rather than imported.
 *
 * `offline/library.ts` owns the download records, the cache journal and the
 * read-along cues — and it imports this module for the account purge, so a
 * static edge back up to it would close a cycle. Instead the two moments where
 * reconciliation must touch that layer — a 409 that merges an offline import
 * into a canonical book, and a 409 that hands back the server's progress state
 * — are published through these handlers, which `offline/library.ts` registers
 * at its own module init. That init is not guaranteed to have run: a page can
 * mount the player without ever loading the library layer, and a replay from
 * there drains the queue with no handler in place. The contract is therefore
 * retain-and-defer — a 409 that cannot be reconciled yet keeps its row and is
 * retried on a later drain, exactly as a network failure would be. A visit to
 * any page that loads the library layer completes the reconciliation.
 */
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

/**
 * The offline half of the re-import path (`docs/local-first.md` section 10).
 *
 * A queued registration carries the id this device minted, and the audio, the
 * download record and the transcript were written under it while the network
 * was down. 409 means the server matched the fingerprint to a book it already
 * has: the registration is settled — there is nothing left to send — but the
 * bytes on this device are filed under an id that now exists nowhere, and
 * dropping the answer here is what would leave the user with the same audiobook
 * twice. `local-import.ts` reaches the same outcome online by learning the
 * canonical id before storing anything; this reaches it afterwards, by moving
 * the identity rather than the data.
 *
 * True means "settle this row". A 409 that names no other book — a chapter
 * repair the server refused, or a registration that never carried an id —
 * settles too: those are terminal answers with nothing local to move.
 */
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
  // No subscriber means the library layer has not loaded yet; the row is
  // retained and the next drain — in a session that has it — finishes the move.
  if (!importReattachedHandler) return false;
  try {
    // The queue first, the bytes second. Both halves are idempotent and the
    // registration is only settled once both have run, so an interruption
    // between them is retried whole — but in the order that leaves the user's
    // queued edits addressed to a book that EXISTS if the process stops here.
    await repointQueuedMutations(task.userId, importedId, canonicalId);
    await importReattachedHandler(task.userId, importedId, canonicalId, payload?.playerBook);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Re-pointing a book id the server refused
// ---------------------------------------------------------------------------

/**
 * Is the book this row names still waiting to be registered by this device?
 *
 * True only while a registration naming that very id is in the queue, which is
 * what keeps the retention bounded: nothing here waits on a book the server
 * will never be told about.
 */
export async function awaitsRegistration(task: QueuedMutation): Promise<boolean> {
  const bookId = queuedBookId(task);
  if (!bookId) return false;
  const db = await database();
  const queued = await db.getAllFromIndex("mutations", "by-user", task.userId);
  return queued.some((row) => row.kind === "import" && row.payload.bookId === bookId);
}

/**
 * Which book does this queued row act on?
 *
 * `collection` names the COLLECTION in `entityId` and the book in its payload.
 * `import` names a FINGERPRINT and no book at all — and it is the row whose own
 * answer triggers the move, so re-pointing it would be re-pointing the message
 * that carries the news.
 */
function queuedBookId(row: QueuedMutation): string | null {
  if (row.kind === "import") return null;
  if (row.kind === "collection") {
    return typeof row.payload.bookId === "string" ? row.payload.bookId : null;
  }
  return row.entityId;
}

/**
 * The same intent, addressed to another book.
 *
 * Every key comes from the production builder, called exactly as its own call
 * site in `offline/outbox.ts` calls it — including `tagMutationKey`, whose third
 * argument the tag path fills with the tag ID. A key assembled by hand here
 * would put two spellings of one intent in the outbox and coalesce neither.
 */
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

/**
 * Re-addresses every queued row that still names the id a merge just abandoned.
 *
 * A book imported with no network is minted an id by this device, and the
 * library shows it — so the user can rename it, tag it, play it and delete it
 * long before the server has heard of it, and every one of those writes is
 * queued against that id. When the registration finally replays and the server
 * answers "those bytes are already book Y", the id they all name stops existing:
 * each row would replay into a 404, which is terminal, and be dropped as
 * settled. The user's rename is gone, their tag is gone, and their DELETE is
 * gone while the book quietly survives as Y.
 *
 * Two rows can become one intent here — a queued rename for the phantom and a
 * queued rename for Y are now the same edit. The later one wins, decided by
 * `queuedAt` and then handed to the shipping `resolveCoalescing`, rather than
 * one silently overwriting the other. `queuedAt` is the only ordering the pair
 * share: their device sequences were minted from two different books' counters.
 *
 * Progress is re-stamped with a sequence minted from the TARGET book's counter.
 * The server discards a progress write whose `deviceSequence` is not above what
 * it holds for (user, book, device) — and answers 200 while doing it — so a
 * sequence carried over from the phantom's counter is a write that reports
 * success and vanishes.
 *
 * Idempotent: a second run finds nothing naming the old id. That is what makes
 * it safe to do in a different database from the identity move it accompanies —
 * an interruption between the two halves leaves the registration queued, and
 * the next drain gets the same deterministic 409 and finishes the other half.
 */
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
      // Settled or replaced while this was being read. `settleMutation` compares
      // the same id for the same reason: an acknowledgement of an older intent
      // must not carry a newer one along with it.
      if (!current || current.mutationId !== snapshot.mutationId) continue;
      const candidate = addressedTo(current, toBookId);
      // `never` kinds cannot collide: their key embeds a mutationId no other row
      // has. Everything else can, and is resolved rather than overwritten.
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
  // Highest-sequence-wins is meaningless across two books' counters, so for
  // progress queuedAt selects only the deterministic tie/envelope. Its three
  // field registers are still merged independently by their clocks.
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

/**
 * A 200 duplicate is only an acknowledgement when the server state proves the
 * submitted values already landed. If its per-device high-water skipped this
 * row instead, preserve the intent and tell the caller which sequence it must
 * outrank on the next attempt.
 */
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

/** Applies the bounded state returned for a successful progress request. */
export async function reconcileAcceptedProgress(
  entry: QueuedProgress,
  response: Response,
): Promise<QueuedProgress | null> {
  return (await reconcileAcceptedProgressWithStatus(entry, response)).progress;
}

export type AcceptedProgressReconciliation = {
  progress: QueuedProgress | null;
  persisted: boolean;
};

export async function reconcileAcceptedProgressWithStatus(
  entry: QueuedProgress,
  response: Response,
): Promise<AcceptedProgressReconciliation> {
  const server = await readServerProgressState(response);
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
    } catch {
      // The network row remains the durable retry if both local stores fail.
    }
  }
  // A failed write for one register must not discard a newer independent field
  // that was already durable. The receipt is installed synchronously after its
  // IDB commit, so this read projects only the exact failed source tuple and
  // keeps every held position/rate/completion register fieldwise.
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

/**
 * Returns false only when the conflict could not be reconciled *yet* — the
 * library layer's handler is not registered — so the caller retains the row
 * and retries. A malformed or sequence-stale conflict returns true: there is
 * nothing more this device can learn from it, and the row may settle.
 */
export async function reconcileProgressConflict(
  entry: QueuedProgress,
  response: Response,
): Promise<boolean> {
  const server = await readServerProgressState(response);
  if (!server) return true;
  if ((await currentDeviceSequence(entry.bookId, entry.userId)) > entry.deviceSequence) return true;
  // No subscriber means the library layer has not loaded, so the server's state
  // cannot be projected onto the download record yet; unreconciled, try later.
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
