import type { PlayerBook, PlayerChapter } from "@/domain/player";
import { isAccountWriteFenced } from "@/lib/account-deletion-fence";

/** How close to a boundary counts as "at" it, in milliseconds. */
export const CHAPTER_END_EPSILON_MS = 350;
export const BOOK_END_EPSILON_MS = 1_000;

/**
 * The chapter containing a position. Positions at or past the last chapter's
 * start (including the sliver between its endMs and the audio's true duration)
 * belong to the final chapter so chapter navigation keeps working at the end.
 */
export function selectCurrentChapter(
  chapters: PlayerChapter[],
  currentTimeMs: number,
): PlayerChapter | null {
  const last = chapters[chapters.length - 1];
  if (!last) return null;
  if (currentTimeMs >= last.startMs) return last;
  // Chapters are sorted and non-overlapping, so binary-search the last one
  // starting at or before the position — this runs per timeupdate tick and
  // books can carry 10k+ chapters.
  let low = 0;
  let high = chapters.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (chapters[mid]!.startMs <= currentTimeMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate === -1) return null;
  const chapter = chapters[candidate]!;
  return currentTimeMs < chapter.endMs ? chapter : null;
}

/** Bounded smart-rewind for time spent away from the book. */
export function rewindForAbsence(absenceMs: number): number {
  if (!Number.isFinite(absenceMs) || absenceMs < 60_000) return 0;
  if (absenceMs < 10 * 60_000) return 5_000;
  if (absenceMs < 60 * 60_000) return 15_000;
  return 30_000;
}

/**
 * Where playback should begin for a stored position. A book stored at its very
 * end restarts from the beginning; otherwise smart rewind (when enabled and a
 * pause marker exists) backs up a bounded amount.
 */
export function resolveStartPosition(input: {
  storedPositionMs: number;
  durationMs: number;
  smartRewindEnabled: boolean;
  msSinceLastPause: number | null;
}): { startAtMs: number; appliedRewindMs: number } {
  if (input.storedPositionMs >= input.durationMs - BOOK_END_EPSILON_MS) {
    return { startAtMs: 0, appliedRewindMs: 0 };
  }
  const appliedRewindMs =
    input.smartRewindEnabled && input.msSinceLastPause !== null
      ? rewindForAbsence(input.msSinceLastPause)
      : 0;
  return { startAtMs: Math.max(0, input.storedPositionMs - appliedRewindMs), appliedRewindMs };
}

export function isChapterEnding(chapter: PlayerChapter, positionMs: number): boolean {
  return chapter.endMs - positionMs <= CHAPTER_END_EPSILON_MS;
}

/* Per-user local playback state. Keys are user-scoped so account switches on
 * one device never leak positions between accounts. */

/**
 * WHICH MECHANISM performed a durable write — not which function called it.
 *
 * This exists to settle one question that no instrument on a development
 * machine can answer (`docs/resume-durability-device-check.md`): while a PWA is
 * backgrounded with the screen off and audio playing, does iOS suspend BOTH the
 * 200 ms rescheduling timer AND the media element's `timeupdate`? Each writer
 * alone is measured to bound the loss; only their simultaneous suspension loses
 * ground, and the automated suite cannot observe it because Playwright's WebKit
 * never reports a page as genuinely hidden.
 *
 * The answer is legible from the record itself once the record says who wrote
 * it. After a backgrounded listen, `"visibility-flush"` with a stale `writtenAt`
 * means both writers were frozen for the whole session; `"media-tick"` or
 * `"cadence-timer"` with a recent one means that writer survived.
 *
 * So these are named for the PLATFORM MECHANISM that produced the write —
 * `"media-tick"` is the media pipeline, `"cadence-timer"` is `setTimeout` — and
 * not for the hook or handler the call sits in, because it is the mechanism's
 * survival that is in question.
 */
const PLAYBACK_WRITE_SOURCES = [
  /** The media pipeline's `timeupdate`. Survives iOS suspending timers. */
  "media-tick",
  /** The 200 ms self-rescheduling `setTimeout`. Suspended by a backgrounded page. */
  "cadence-timer",
  /** The synchronous flush on `visibilitychange` to hidden. */
  "visibility-flush",
  /** The synchronous flush on `pagehide`, which is terminal at any visibility. */
  "pagehide-flush",
  "pause",
  "seek",
  "ended",
  "rate-change",
  /** Copies authoritative server/mirror clocks into this device before playback. */
  "player-bootstrap",
  /** Leaving one book for another; the write belongs to the book being left. */
  "book-switch",
  "book-unload",
] as const;

export type PlaybackWriteSource = (typeof PLAYBACK_WRITE_SOURCES)[number];

export type LocalPosition = {
  positionMs: number;
  /** Writer-local media position paired with lifecycle provenance. */
  positionAtWrite?: number;
  occurredAt: number;
  /** Absent on records written before the rate and completion were durable. */
  playbackRate?: number;
  /** Writer-local rate paired with lifecycle provenance, not the joined rate. */
  playbackRateAtWrite?: number;
  /** When `playbackRate` last changed; absent on older records. */
  playbackRateOccurredAt?: number;
  completed?: boolean;
  /** Writer-local completion paired with lifecycle provenance. */
  completedAtWrite?: boolean;
  /** When `completed` last changed; absent on older records. */
  completedOccurredAt?: number;
  /** Document that wrote the compatibility tuple; joins provenance safely. */
  writerId?: string;
  /**
   * Which mechanism wrote this record. Absent on records written before writes
   * carried their provenance.
   */
  source?: PlaybackWriteSource;
  /**
   * WHEN THE WRITE HAPPENED — deliberately NOT `occurredAt`.
   *
   * `occurredAt` means "when this position was reached" and is preserved across
   * a re-write that carries no new position, because it is the only thing
   * `localWinsOver` compares and re-stamping it lets a stale tab overrule
   * another device's real listening. `writtenAt` has the opposite job: it is
   * always the real moment of the write, so a record whose position has not
   * moved for five minutes still shows that something wrote it five minutes ago
   * — or that nothing did. Conflating the two would reintroduce the cross-device
   * regression `momentThisPositionWasReached` exists to prevent.
   *
   * Absent on records written before writes carried their provenance.
   */
  writtenAt?: number;
  /**
   * WAS THE AUDIO ACTUALLY PLAYING at the instant of this write?
   *
   * The one fact a durable record could not previously answer, and the one
   * `detectSuspendedSession` cannot do without. Everything else it needs is
   * already here: `positionMs` is where the user was, `writtenAt` is when, and
   * `playbackRate` is how fast the book was moving. What none of those say is
   * whether there was a listening session still running at that moment — and a
   * hide-edge write happens on EVERY backgrounding, paused or playing. A paused
   * one has no lost stretch behind it and must never produce an offer.
   *
   * Written only when true, so absent means "not playing, or a build that
   * predates this field" — both of which are correctly read as "do not offer".
   */
  playingAtWrite?: boolean;
};

export type PlaybackFieldNormalization<T extends number | boolean> = {
  submitted: { value: T; occurredAt: number };
  canonical: { value: T; occurredAt: number };
};

export type PlaybackPredecessor = {
  position?: { value: number; occurredAt: number };
  playbackRate?: { value: number; occurredAt: number };
  completed?: { value: boolean; occurredAt: number };
};

/**
 * Exact physical-register corrections left behind by an acknowledged request.
 *
 * There is at most one obligation per field. While localStorage is unavailable,
 * its physical winner cannot change, so later acknowledgements update the
 * canonical target without appending another copy of that same source. This
 * keeps permanently blocked storage O(1) per book instead of growing once per
 * heartbeat.
 */
export type PlaybackNormalization = {
  position?: PlaybackFieldNormalization<number>;
  playbackRate?: PlaybackFieldNormalization<number>;
  completed?: PlaybackFieldNormalization<boolean>;
};

const pendingPlaybackNormalizations = new Map<string, PlaybackNormalization>();

export function installPendingPlaybackNormalizations(
  userId: string,
  bookId: string,
  normalization: PlaybackNormalization | null,
): void {
  const key = localPositionKey(userId, bookId);
  if (normalization && hasPlaybackNormalization(normalization)) {
    pendingPlaybackNormalizations.set(key, normalization);
  } else pendingPlaybackNormalizations.delete(key);
}

/**
 * Synchronously persists the playback fields a terminating page can finish.
 *
 * Each document owns one register per field, so it never rewrites another
 * document's position while changing only rate or completion. The joined tuple
 * remains for older builds and diagnostics. None of these writes waits on a
 * lock or IndexedDB transaction: a terminal lifecycle handler may get only its
 * current task. Storage failures are contained so the caller can still journal
 * the same event in the IndexedDB outbox.
 */
export function saveLocalPlaybackState(
  userId: string,
  bookId: string,
  state: {
    positionMs: number;
    playbackRate?: number;
    playbackRateOccurredAt?: number;
    completed?: boolean;
    completedOccurredAt?: number;
    occurredAt?: number;
    source?: PlaybackWriteSource;
    /** Was the media element playing at the instant of this write? */
    playing?: boolean;
    /** Actual media position when a durable smart-rewind floor is carried. */
    positionAtWrite?: number;
    /** Explicit field mask supplied by the player causal baseline. */
    positionChanged?: boolean;
    playbackRateChanged?: boolean;
    completedChanged?: boolean;
    /** Populate missing per-writer registers from an authoritative tuple. */
    hydrate?: boolean;
  },
): LocalPosition | null {
  if (isAccountWriteFenced(userId)) return null;
  const positionMs = Math.round(state.positionMs);
  const previous = readLocalProgress(userId, bookId);
  const writtenAt = Date.now();
  const writerId = localPlaybackWriterId();
  const candidate: LocalPosition = {
    positionMs,
    occurredAt: state.occurredAt ?? momentThisPositionWasReached(previous, positionMs, writtenAt),
    // Always the real moment of THIS write, whatever `occurredAt` resolved to.
    writtenAt,
    writerId,
  };
  if (typeof state.playbackRate === "number" && Number.isFinite(state.playbackRate)) {
    candidate.playbackRate = state.playbackRate;
    candidate.playbackRateAtWrite = state.playbackRate;
    candidate.playbackRateOccurredAt =
      state.playbackRateOccurredAt ??
      (previous?.playbackRate === state.playbackRate
        ? (previous.playbackRateOccurredAt ?? previous.writtenAt ?? previous.occurredAt)
        : writtenAt);
  }
  if (typeof state.completed === "boolean") {
    candidate.completed = state.completed;
    candidate.completedAtWrite = state.completed;
    candidate.completedOccurredAt =
      state.completedOccurredAt ??
      (previous?.completed === state.completed
        ? (previous.completedOccurredAt ?? previous.writtenAt ?? previous.occurredAt)
        : writtenAt);
  }
  if (state.source) candidate.source = state.source;
  if (typeof state.positionAtWrite === "number" && Number.isFinite(state.positionAtWrite)) {
    candidate.positionAtWrite = Math.round(state.positionAtWrite);
  }
  if (state.playing === true) candidate.playingAtWrite = true;
  const positionChanged =
    state.positionChanged ??
    (!state.hydrate &&
      (!previous ||
        candidate.positionMs !== previous.positionMs ||
        candidate.occurredAt !== previous.occurredAt));
  const playbackRateChanged =
    state.playbackRateChanged ??
    (!state.hydrate &&
      typeof candidate.playbackRate === "number" &&
      (!previous ||
        candidate.playbackRate !== previous.playbackRate ||
        candidate.playbackRateOccurredAt !== previous.playbackRateOccurredAt));
  const completedChanged =
    state.completedChanged ??
    (!state.hydrate &&
      typeof candidate.completed === "boolean" &&
      (!previous ||
        candidate.completed !== previous.completed ||
        candidate.completedOccurredAt !== previous.completedOccurredAt));
  if (state.hydrate || positionChanged) {
    const persisted = persistLocalRegister(
      positionRegisterPrefix(userId, bookId),
      writerId,
      candidate.positionMs,
      candidate.occurredAt,
      positionChanged,
    );
    if (positionChanged) candidate.occurredAt = persisted.occurredAt;
  }
  if ((state.hydrate || playbackRateChanged) && typeof candidate.playbackRate === "number") {
    const persisted = persistLocalRegister(
      rateRegisterPrefix(userId, bookId),
      writerId,
      candidate.playbackRate,
      candidate.playbackRateOccurredAt ?? candidate.writtenAt ?? candidate.occurredAt,
      playbackRateChanged,
    );
    if (playbackRateChanged) candidate.playbackRateOccurredAt = persisted.occurredAt;
  }
  if ((state.hydrate || completedChanged) && typeof candidate.completed === "boolean") {
    const persisted = persistLocalRegister(
      completedRegisterPrefix(userId, bookId),
      writerId,
      candidate.completed,
      candidate.completedOccurredAt ?? candidate.writtenAt ?? candidate.occurredAt,
      completedChanged,
    );
    if (completedChanged) candidate.completedOccurredAt = persisted.occurredAt;
  }
  const merged = mergeLocalPlaybackFields(previous, candidate, {
    positionChanged,
    playbackRateChanged,
    completedChanged,
    hydrate: state.hydrate === true,
  });
  // Normalize the compatibility tuple against the winning registers before it
  // is written. In particular, a stale tab must not attach its pagehide
  // provenance to a peer's newer position.
  const record = joinLocalPlaybackRegisters(userId, bookId, merged) ?? merged;
  // Kept as a joined legacy snapshot for old builds, diagnostics and book-key
  // enumeration. New reads arbitrate it against the independent registers.
  writeLocalValue(localPositionKey(userId, bookId), JSON.stringify(record));
  if (isAccountWriteFenced(userId)) {
    clearLocalPlaybackState(userId, bookId);
    return null;
  }
  return record;
}

/** Reconciles a successful server response without erasing a later local action. */
export function applyAuthoritativePlaybackState(
  userId: string,
  bookId: string,
  server: Parameters<typeof applyAuthoritativePlaybackStateWithStatus>[2],
  submitted: Parameters<typeof applyAuthoritativePlaybackStateWithStatus>[3],
  source?: PlaybackWriteSource,
): LocalPosition | null {
  return applyAuthoritativePlaybackStateWithStatus(userId, bookId, server, submitted, source).state;
}

export type AuthoritativePlaybackStateResult = {
  state: LocalPosition | null;
  persisted: boolean;
  normalization: PlaybackNormalization | null;
};

export function applyAuthoritativePlaybackStateWithStatus(
  userId: string,
  bookId: string,
  server: {
    positionMs: number;
    occurredAt: number;
    playbackRate: number;
    playbackRateOccurredAt: number;
    completed: boolean;
    completedOccurredAt: number;
  },
  submitted: {
    positionMs: number;
    occurredAt: number;
    playbackRate: number;
    playbackRateOccurredAt: number;
    completed: boolean;
    completedOccurredAt: number;
    /** Exact joined registers observed before this event's local write. */
    predecessor?: PlaybackPredecessor;
  },
  source?: PlaybackWriteSource,
  ignorePendingNormalizations = false,
  fieldMask: {
    position: boolean;
    playbackRate: boolean;
    completed: boolean;
  } = { position: true, playbackRate: true, completed: true },
): AuthoritativePlaybackStateResult {
  if (isAccountWriteFenced(userId)) {
    return { state: null, persisted: false, normalization: null };
  }
  const clocks = [
    server.occurredAt,
    server.playbackRateOccurredAt,
    server.completedOccurredAt,
    submitted.occurredAt,
    submitted.playbackRateOccurredAt,
    submitted.completedOccurredAt,
  ];
  if (
    !Number.isFinite(server.positionMs) ||
    server.positionMs < 0 ||
    !Number.isFinite(server.playbackRate) ||
    server.playbackRate <= 0 ||
    clocks.some((clock) => !Number.isFinite(clock) || clock < 0)
  ) {
    return {
      state: ignorePendingNormalizations
        ? readLocalProgressRaw(userId, bookId)
        : readLocalProgress(userId, bookId),
      persisted: false,
      normalization: null,
    };
  }

  const current = ignorePendingNormalizations
    ? readLocalProgressRaw(userId, bookId)
    : readLocalProgress(userId, bookId);
  const currentRateClock = current
    ? (current.playbackRateOccurredAt ?? current.writtenAt ?? current.occurredAt)
    : -1;
  const currentCompletedClock = current
    ? (current.completedOccurredAt ?? current.writtenAt ?? current.occurredAt)
    : -1;
  const positionDecision = serverFieldDecision(
    fieldMask.position,
    current?.positionMs,
    current?.occurredAt ?? -1,
    server.occurredAt,
    submitted.positionMs,
    submitted.occurredAt,
    submitted.predecessor?.position,
  );
  const rateDecision = serverFieldDecision(
    fieldMask.playbackRate,
    current?.playbackRate,
    currentRateClock,
    server.playbackRateOccurredAt,
    submitted.playbackRate,
    submitted.playbackRateOccurredAt,
    submitted.predecessor?.playbackRate,
  );
  const completedDecision = serverFieldDecision(
    fieldMask.completed,
    current?.completed,
    currentCompletedClock,
    server.completedOccurredAt,
    submitted.completed,
    submitted.completedOccurredAt,
    submitted.predecessor?.completed,
  );
  const replacePosition = positionDecision.replace;
  const replaceRate = rateDecision.replace;
  const replaceCompleted = completedDecision.replace;
  const positionSource = positionDecision.source;
  const rateSource = rateDecision.source;
  const completedSource = completedDecision.source;

  const resolvedPositionMs = replacePosition
    ? server.positionMs
    : (current?.positionMs ?? server.positionMs);
  const resolvedPositionClock = replacePosition
    ? server.occurredAt
    : (current?.occurredAt ?? server.occurredAt);
  /**
   * A server acknowledgement is not a new physical write mechanism.
   *
   * In particular, acknowledging a `visibility-flush` used to replace its
   * ordinary register with a canonical one and then rebuild the compatibility
   * tuple without `source`, `writtenAt`, or `playingAtWrite`. A renderer killed
   * after that response therefore lost the exact suspension signature it had
   * synchronously made durable before the request began.
   *
   * Preserve provenance only when the resolved server position is the exact
   * position/moment the current tuple describes. A clamp, conflict, or newer
   * server value must not inherit evidence from a different local position.
   */
  const preservedProvenance =
    current?.source &&
    current.positionMs === resolvedPositionMs &&
    current.occurredAt === resolvedPositionClock
      ? current
      : null;
  // Canonical entries intentionally lose an equal-clock tie to every ordinary
  // document writer. A local action can land after the read above but before
  // this write; giving the server entry lexical priority would let compaction
  // erase that concurrent action without a compare-and-set primitive.
  const writerId = `!canonical:${localPlaybackWriterId()}`;
  // When canonicalizing the exact position that supplied the provenance, keep
  // its document identity. `joinLocalPlaybackRegisters` can then prove that the
  // metadata and winning position still belong together across a reload.
  const positionWriterId = preservedProvenance?.writerId
    ? `!canonical:${documentPlaybackWriterId(preservedProvenance.writerId)}`
    : writerId;

  const positionPersisted =
    !replacePosition ||
    persistAuthoritativeLocalRegister(
      positionRegisterPrefix(userId, bookId),
      positionWriterId,
      server.positionMs,
      server.occurredAt,
      positionSource.value,
      positionSource.occurredAt,
      writerId,
    );
  const ratePersisted =
    !replaceRate ||
    persistAuthoritativeLocalRegister(
      rateRegisterPrefix(userId, bookId),
      writerId,
      server.playbackRate,
      server.playbackRateOccurredAt,
      rateSource.value,
      rateSource.occurredAt,
    );
  const completionPersisted =
    !replaceCompleted ||
    persistAuthoritativeLocalRegister(
      completedRegisterPrefix(userId, bookId),
      writerId,
      server.completed,
      server.completedOccurredAt,
      completedSource.value,
      completedSource.occurredAt,
    );

  const requestedProvenance = source && replacePosition ? source : null;
  const seed: LocalPosition = {
    positionMs: resolvedPositionMs,
    occurredAt: resolvedPositionClock,
    playbackRate: replaceRate
      ? server.playbackRate
      : (current?.playbackRate ?? server.playbackRate),
    playbackRateOccurredAt: replaceRate
      ? server.playbackRateOccurredAt
      : currentRateClock >= 0
        ? currentRateClock
        : server.playbackRateOccurredAt,
    completed: replaceCompleted ? server.completed : (current?.completed ?? server.completed),
    completedOccurredAt: replaceCompleted
      ? server.completedOccurredAt
      : currentCompletedClock >= 0
        ? currentCompletedClock
        : server.completedOccurredAt,
    ...(preservedProvenance
      ? {
          source: preservedProvenance.source,
          ...(preservedProvenance.positionAtWrite !== undefined
            ? { positionAtWrite: preservedProvenance.positionAtWrite }
            : {}),
          ...(preservedProvenance.writtenAt !== undefined
            ? { writtenAt: preservedProvenance.writtenAt }
            : {}),
          writerId: preservedProvenance.writerId,
          ...(preservedProvenance.playingAtWrite ? { playingAtWrite: true } : {}),
          ...(preservedProvenance.playbackRateAtWrite !== undefined
            ? { playbackRateAtWrite: preservedProvenance.playbackRateAtWrite }
            : {}),
          ...(preservedProvenance.completedAtWrite !== undefined
            ? { completedAtWrite: preservedProvenance.completedAtWrite }
            : {}),
        }
      : requestedProvenance
        ? {
            source: requestedProvenance,
            writtenAt: Date.now(),
            writerId: positionWriterId,
            playbackRateAtWrite: server.playbackRate,
            completedAtWrite: server.completed,
          }
        : {}),
  };
  const record = joinLocalPlaybackRegisters(userId, bookId, seed) ?? seed;
  writeLocalValue(localPositionKey(userId, bookId), JSON.stringify(record));
  if (isAccountWriteFenced(userId)) {
    clearLocalPlaybackState(userId, bookId);
    return { state: null, persisted: false, normalization: null };
  }
  const normalization: PlaybackNormalization = {
    ...(!positionPersisted && replacePosition
      ? {
          position: {
            submitted: positionSource,
            canonical: { value: server.positionMs, occurredAt: server.occurredAt },
          },
        }
      : {}),
    ...(!ratePersisted && replaceRate
      ? {
          playbackRate: {
            submitted: rateSource,
            canonical: {
              value: server.playbackRate,
              occurredAt: server.playbackRateOccurredAt,
            },
          },
        }
      : {}),
    ...(!completionPersisted && replaceCompleted
      ? {
          completed: {
            submitted: completedSource,
            canonical: { value: server.completed, occurredAt: server.completedOccurredAt },
          },
        }
      : {}),
  };
  return {
    state: record,
    persisted: positionPersisted && ratePersisted && completionPersisted,
    normalization: hasPlaybackNormalization(normalization) ? normalization : null,
  };
}

function serverFieldDecision<T extends number | boolean>(
  enabled: boolean,
  currentValue: T | undefined,
  currentClock: number,
  serverClock: number,
  submittedValue: T,
  submittedClock: number,
  predecessor: { value: T; occurredAt: number } | undefined,
): { replace: boolean; source: { value: T; occurredAt: number } } {
  const submittedSource = { value: submittedValue, occurredAt: submittedClock };
  if (!enabled) return { replace: false, source: submittedSource };
  const currentMatchesSubmitted =
    currentClock === submittedClock && currentValue === submittedValue;
  const currentMatchesPredecessor =
    !!predecessor && currentClock === predecessor.occurredAt && currentValue === predecessor.value;
  const serverSupersedesCurrent = serverClock > Math.max(currentClock, submittedClock);
  const replace =
    currentValue === undefined ||
    currentMatchesSubmitted ||
    currentMatchesPredecessor ||
    serverSupersedesCurrent;
  return {
    replace,
    source:
      currentValue !== undefined && (currentMatchesPredecessor || serverSupersedesCurrent)
        ? { value: currentValue, occurredAt: currentClock }
        : submittedSource,
  };
}

/** Builds the backward-compatible joined snapshot; registers remain authoritative. */
function mergeLocalPlaybackFields(
  previous: LocalPosition | null,
  candidate: LocalPosition,
  fields: {
    positionChanged: boolean;
    playbackRateChanged: boolean;
    completedChanged: boolean;
    hydrate: boolean;
  },
): LocalPosition {
  if (!previous) return candidate;
  const positionFromCandidate =
    (fields.positionChanged || (fields.hydrate && candidate.occurredAt > previous.occurredAt)) &&
    candidate.occurredAt >= previous.occurredAt;
  const record: LocalPosition = {
    positionMs: positionFromCandidate ? candidate.positionMs : previous.positionMs,
    occurredAt: positionFromCandidate ? candidate.occurredAt : previous.occurredAt,
  };

  const previousRateClock =
    previous.playbackRateOccurredAt ?? previous.writtenAt ?? previous.occurredAt;
  const candidateRateClock = candidate.playbackRateOccurredAt;
  const rateFromCandidate =
    (fields.playbackRateChanged ||
      (fields.hydrate &&
        candidateRateClock !== undefined &&
        candidateRateClock > previousRateClock)) &&
    typeof candidate.playbackRate === "number" &&
    (typeof previous.playbackRate !== "number" ||
      (candidateRateClock !== undefined && candidateRateClock >= previousRateClock));
  if (rateFromCandidate) {
    record.playbackRate = candidate.playbackRate;
    record.playbackRateOccurredAt = candidateRateClock;
  } else if (typeof previous.playbackRate === "number") {
    record.playbackRate = previous.playbackRate;
    record.playbackRateOccurredAt = previousRateClock;
  }

  const previousCompletedClock =
    previous.completedOccurredAt ?? previous.writtenAt ?? previous.occurredAt;
  const candidateCompletedClock = candidate.completedOccurredAt;
  const completedFromCandidate =
    (fields.completedChanged ||
      (fields.hydrate &&
        candidateCompletedClock !== undefined &&
        candidateCompletedClock > previousCompletedClock)) &&
    typeof candidate.completed === "boolean" &&
    (typeof previous.completed !== "boolean" ||
      (candidateCompletedClock !== undefined && candidateCompletedClock >= previousCompletedClock));
  if (completedFromCandidate) {
    record.completed = candidate.completed;
    record.completedOccurredAt = candidateCompletedClock;
  } else if (typeof previous.completed === "boolean") {
    record.completed = previous.completed;
    record.completedOccurredAt = previousCompletedClock;
  }

  const candidateDescribesPosition =
    candidate.positionMs === record.positionMs && candidate.occurredAt === record.occurredAt;
  if (candidateDescribesPosition) {
    if (candidate.source) record.source = candidate.source;
    if (candidate.positionAtWrite !== undefined) record.positionAtWrite = candidate.positionAtWrite;
    if (candidate.writtenAt !== undefined) record.writtenAt = candidate.writtenAt;
    if (candidate.playingAtWrite) record.playingAtWrite = true;
    if (candidate.playbackRateAtWrite !== undefined) {
      record.playbackRateAtWrite = candidate.playbackRateAtWrite;
    }
    if (candidate.completedAtWrite !== undefined) {
      record.completedAtWrite = candidate.completedAtWrite;
    }
    record.writerId = candidate.writerId;
  } else if (previous.writerId) {
    record.writerId = previous.writerId;
  }
  return record;
}

/**
 * When did this device reach this position? Not: when did it last say so.
 *
 * `occurredAt` is the only thing `localWinsOver` compares, so it is a CLAIM
 * ABOUT LISTENING, not a write timestamp — and a write that carries no new
 * position has no new listening to claim. Re-stamping one is how a device
 * silently overrules another device that really did move the book forward.
 *
 * The path that proved it (`tests/resume/uncovered-axes.spec.ts` X3, measured in
 * WebKit): device A is paused at 6793 ms and its tab is left open; device B
 * takes the book to 15666 ms; A's tab is then navigated away from. `pagehide` is
 * terminal at any visibility so it flushes unconditionally — correctly, it is
 * the last task a killed iOS page gets — and the flush rewrote A's own record as
 * the SAME 6793 ms with an `occurredAt` 15.4 s newer. Nothing about the user's
 * position changed; only the clock did. `localWinsOver` then read that fresher
 * stamp, preferred it over the server's newer cross-device value, and A came
 * back 8873 ms behind, throwing away listening the user had really done, with no
 * user input anywhere in the sequence.
 *
 * Keeping the earlier moment fixes it at the source and leaves the flush alone,
 * which matters: the same unconditional flush is what saves the position in the
 * single-device crash cases, and removing it to fix this would trade one lost
 * position for another. A write that moves the position by even a millisecond
 * still stamps `Date.now()`, because then there IS new listening to claim.
 *
 * A caller that passes `occurredAt` explicitly is stating the moment itself and
 * is left alone. A stored record with `occurredAt: 0` (every pre-v2 value)
 * claims no moment at all, so it cannot lend one.
 */
function momentThisPositionWasReached(
  previous: LocalPosition | null,
  positionMs: number,
  now: number,
): number {
  return previous && previous.positionMs === positionMs && previous.occurredAt > 0
    ? previous.occurredAt
    : now;
}

export function saveLocalPosition(
  userId: string,
  bookId: string,
  positionMs: number,
  occurredAt = Date.now(),
): void {
  saveLocalPlaybackState(userId, bookId, { positionMs, occurredAt });
}

/**
 * Forget everything this device remembers about where the user was in a book.
 *
 * Deleting a book has to take the position with it, and it did not. The delete
 * flow dispatches `UNLOAD_PLAYER_EVENT`, and `unloadBook` writes the position
 * one last time on the way out — so a delete ENDED by recording a fresh
 * `chapterline:position:*` record for the book it had just destroyed, stamped
 * later than anything in the mirror.
 *
 * `healMirrorPlaybackFromLocal` then sweeps exactly those keys on every launch
 * and writes back any whose moment beats the mirror's. The delete removed the
 * book aggregate from IndexedDB; the next launch put a playback row for it
 * straight back, and the launch after that did it again, because nothing ever
 * removed the localStorage record that was feeding it. One orphan row per
 * deleted book, forever, on a store the shelf reads.
 *
 * The pause marker goes with it. It is the same book's state, it is what smart
 * rewind reads, and a re-import of the same file is matched to the same book id
 * by fingerprint — so a stale marker would hand a freshly imported book a
 * rewind earned by a copy the user deleted months ago. The dismissed-suspension
 * marker goes for the same reason: it is an answer about one deleted book's
 * unrecorded stretch, and the fingerprint match would hand it to the re-import.
 */
export function clearLocalPlaybackState(userId: string, bookId: string): void {
  pendingPlaybackNormalizations.delete(localPositionKey(userId, bookId));
  const remove = (key: string) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        localStorage.removeItem(key);
        return;
      } catch {
        // A transient lifecycle/storage fault gets one immediate retry.
      }
    }
  };
  remove(localPositionKey(userId, bookId));
  const registerPrefixes = [
    positionRegisterPrefix(userId, bookId),
    rateRegisterPrefix(userId, bookId),
    completedRegisterPrefix(userId, bookId),
  ];
  const registerKeys = new Set<string>();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && registerPrefixes.some((prefix) => key.startsWith(prefix))) {
          registerKeys.add(key);
        }
      }
      break;
    } catch {
      // Retry the scan once; individual removals remain isolated below.
    }
  }
  registerKeys.forEach(remove);
  remove(lastPausedKey(userId, bookId));
  remove(suspensionDismissedKey(userId, bookId));
}

export function readLocalPosition(userId: string, bookId: string): number | null {
  return readLocalProgress(userId, bookId)?.positionMs ?? null;
}

export function readLocalProgress(userId: string, bookId: string): LocalPosition | null {
  return applyPendingPlaybackNormalizations(userId, bookId, readLocalProgressRaw(userId, bookId));
}

function readLocalProgressRaw(userId: string, bookId: string): LocalPosition | null {
  // `getItem` is inside the try, not in front of it: it throws outright when
  // the user has blocked storage, and a throw from here used to propagate
  // through `loadBook` so the book never opened at all.
  try {
    const value = localStorage.getItem(localPositionKey(userId, bookId));
    let legacy: LocalPosition | null = null;
    if (value !== null) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (typeof parsed === "number") legacy = validLocalPosition(parsed, 0);
        else if (parsed && typeof parsed === "object") {
          legacy = validLocalPosition(parsed, undefined);
        }
      } catch {
        legacy = validLocalPosition(Number(value), 0);
      }
    }
    return joinLocalPlaybackRegisters(userId, bookId, legacy);
  } catch {
    return null;
  }
}

function applyPendingPlaybackNormalizations(
  userId: string,
  bookId: string,
  state: LocalPosition | null,
): LocalPosition | null {
  if (!state) return null;
  const receipt = pendingPlaybackNormalizations.get(localPositionKey(userId, bookId));
  if (!receipt) return state;
  const currentRateClock = state.playbackRateOccurredAt ?? state.writtenAt ?? state.occurredAt;
  const currentCompletedClock = state.completedOccurredAt ?? state.writtenAt ?? state.occurredAt;
  const replacePosition =
    !!receipt.position &&
    state.positionMs === receipt.position.submitted.value &&
    state.occurredAt === receipt.position.submitted.occurredAt;
  const replaceRate =
    !!receipt.playbackRate &&
    state.playbackRate === receipt.playbackRate.submitted.value &&
    currentRateClock === receipt.playbackRate.submitted.occurredAt;
  const replaceCompleted =
    !!receipt.completed &&
    state.completed === receipt.completed.submitted.value &&
    currentCompletedClock === receipt.completed.submitted.occurredAt;
  return {
    ...state,
    ...(replacePosition
      ? {
          positionMs: receipt.position!.canonical.value,
          occurredAt: receipt.position!.canonical.occurredAt,
          positionAtWrite: undefined,
          source: undefined,
          writtenAt: undefined,
          writerId: undefined,
          playingAtWrite: undefined,
        }
      : {}),
    ...(replaceRate
      ? {
          playbackRate: receipt.playbackRate!.canonical.value,
          playbackRateOccurredAt: receipt.playbackRate!.canonical.occurredAt,
        }
      : {}),
    ...(replaceCompleted
      ? {
          completed: receipt.completed!.canonical.value,
          completedOccurredAt: receipt.completed!.canonical.occurredAt,
        }
      : {}),
  };
}

function hasPlaybackNormalization(normalization: PlaybackNormalization): boolean {
  return !!(normalization.position || normalization.playbackRate || normalization.completed);
}

/** Every book this device holds a local position for, for the shelf projection. */
export function listLocalPlaybackStates(
  userId: string,
): Array<{ bookId: string; state: LocalPosition }> {
  const legacyPrefix = `chapterline:position:${userId}:`;
  const registerPrefixes = [
    `chapterline:playback-position:${userId}:`,
    `chapterline:playback-rate:${userId}:`,
    `chapterline:playback-completed:${userId}:`,
  ];
  const bookIds = new Set<string>();
  const found: Array<{ bookId: string; state: LocalPosition }> = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      if (key.startsWith(legacyPrefix)) {
        bookIds.add(key.slice(legacyPrefix.length));
        continue;
      }
      const prefix = registerPrefixes.find((candidate) => key.startsWith(candidate));
      if (!prefix) continue;
      const raw = localStorage.getItem(key);
      const register = raw ? parseLocalRegister(raw) : null;
      if (!register?.writerId) continue;
      const suffix = key.slice(prefix.length);
      const writerMarker = `:${register.writerId}:`;
      const writerOffset = suffix.lastIndexOf(writerMarker);
      if (writerOffset > 0) bookIds.add(suffix.slice(0, writerOffset));
    }
    for (const bookId of bookIds) {
      const state = readLocalProgress(userId, bookId);
      if (state) found.push({ bookId, state });
    }
  } catch {
    return found;
  }
  return found;
}

/**
 * The book this device wrote a position for most recently — for the settings
 * diagnostics readout, which reports the provenance of the latest durable write.
 *
 * Ordered by `writtenAt`, not `occurredAt`: the question this answers is "what
 * wrote last", and `occurredAt` is deliberately frozen across re-writes that
 * carry no new position, so ordering by it would show the wrong book. A record
 * from before provenance existed has no `writtenAt` and so sorts oldest, which
 * is the honest answer — nothing is known about when it was written.
 */
export function readLatestLocalPlayback(
  userId: string,
): { bookId: string; state: LocalPosition } | null {
  let latest: { bookId: string; state: LocalPosition } | null = null;
  for (const entry of listLocalPlaybackStates(userId)) {
    if (!latest || (entry.state.writtenAt ?? 0) > (latest.state.writtenAt ?? 0)) latest = entry;
  }
  return latest;
}

/* ------------------------------------------------------------------ *
 * Recovering a listening session the device could not record
 * ------------------------------------------------------------------ */

/**
 * The write occasions that mean "the app was going away".
 *
 * Only these two can leave the signature below, and that is the whole trick:
 * there is ONE durable record per (user, book) and every write overwrites it,
 * so a record still saying `visibility-flush` or `pagehide-flush` is proof that
 * NOTHING wrote after the hide edge. No extra bookkeeping, no second key, and
 * nothing for a later write to forget to clear — the absence of a later write
 * is the absence of a later write.
 */
const HIDE_EDGE_SOURCES: readonly PlaybackWriteSource[] = ["visibility-flush", "pagehide-flush"];

/**
 * How much unrecorded listening is worth telling the user about.
 *
 * The cadence writes every 200 ms, so anything the normal writers covered is
 * off by a fifth of a second and would never reach a record that still names
 * the hide edge in the first place. This floor is the second, independent
 * guard: 60 s is three hundred cadence intervals, and it is stated on the
 * PROJECTED ADVANCE rather than on the elapsed wall clock so that the same
 * number means the same thing at 0.5x and at 3x, and so that a projection the
 * duration clamp has flattened cannot be offered as a jump to nowhere.
 *
 * BEING STATED ON THE ADVANCE IS ALSO WHAT COVERS THE END OF THE BOOK, and
 * there is deliberately no second check for it. A book parked within
 * `BOOK_END_EPSILON_MS` of its end restarts from zero on the next open
 * (`resolveStartPosition`), so a projection from its stored position describes
 * a place the player is not going to be — but the clamp already leaves at most
 * `BOOK_END_EPSILON_MS` of advance there, and this floor is sixty times that,
 * so the offer is withdrawn by arithmetic. An explicit end-of-book branch was
 * written first and then removed: no test could make it fail, which is the
 * definition of a line that is not doing anything.
 *
 * It is deliberately coarse. A recovery prompt is an interruption, and one that
 * appears after an ordinary thirty-second glance at another app is a bug the
 * user meets several times a day. Erring long costs a user who really did lose
 * fifty seconds nothing they cannot fix by scrubbing.
 */
export const SUSPENSION_GAP_FLOOR_MS = 60_000;

/**
 * A stretch of listening the device could not record, and where it MIGHT have
 * reached. Every field is evidence; `projectedPositionMs` alone is a guess.
 */
export type SuspendedSession = {
  /**
   * The position the hide-edge write recorded. THIS REMAINS THE SOURCE OF
   * TRUTH: the app resumes here, and nothing in this module may move it.
   */
  recordedPositionMs: number;
  /** Wall clock of the hide-edge write. Identifies this gap for dismissal. */
  writtenAt: number;
  /** How long the device went without recording anything. */
  elapsedMs: number;
  /** The rate the book was playing at when the app went away. */
  playbackRate: number;
  /**
   * Where playback WOULD have reached if it ran for the whole gap at that rate,
   * clamped to the book. An estimate, and must be labelled as one wherever it
   * is shown — if iOS stopped the audio early, this is simply wrong, which is
   * exactly why it is offered and never applied.
   */
  projectedPositionMs: number;
};

/**
 * Did this device stop being able to record a session that was still playing?
 *
 * THE SIGNATURE. The last durable write was made at the hide edge, it says
 * audio was live at that moment, and the wall clock has since moved far enough
 * that the cadence cannot account for it. On a phone that means: the app was
 * backgrounded with the book playing, iOS suspended both the 200 ms timer and
 * the media element's `timeupdate` — the one question this repo cannot answer
 * on a development machine, see `docs/resume-durability-device-check.md` — and
 * the process was then reaped with no further callback. The measured cost of
 * that case is the entire session: `tests/resume`'s both-writers-dead row loses
 * 9644 ms out of 9500 ms of listening, scaling linearly.
 *
 * WHAT THIS IS NOT. It is not a claim that iOS does suspend both writers, and
 * it does not need one. If either writer survives a real backgrounding the last
 * record names that writer, the predicate returns null, and the user never sees
 * anything. The cost in the good case is one `localStorage` read at launch.
 *
 * WHAT IT MUST NEVER DO is move anybody. The returned position is a PROPOSAL
 * for a control the user has to press. Resuming forward on the strength of an
 * extrapolation would skip content the user never heard — the worst failure
 * this player has, and a blocker here at any magnitude — and it would be
 * straightforwardly wrong in the case where iOS stopped the audio too.
 *
 * The bounds, all of them refusals rather than adjustments:
 *
 *   - a record that names any other writer is a record something wrote after
 *     the hide edge, so there is no unrecorded stretch;
 *   - a hide edge taken while PAUSED has nothing behind it to recover;
 *   - a finished book has no unheard stretch behind it;
 *   - a missing or nonsensical rate falls back to 1x rather than scaling the
 *     estimate by a number nobody wrote;
 *   - the projection is clamped to the book, and the offer is withdrawn when
 *     what survives the clamp is under the floor.
 */
export function detectSuspendedSession(input: {
  record: LocalPosition | null;
  durationMs: number;
  /** Injected so the maths is testable; defaults to the wall clock. */
  now?: number;
}): SuspendedSession | null {
  const { record, durationMs } = input;
  const completedAtWrite = record?.completedAtWrite ?? record?.completed;
  if (!record || record.playingAtWrite !== true || completedAtWrite === true) return null;
  if (!record.source || !HIDE_EDGE_SOURCES.includes(record.source)) return null;
  const writtenAt = record.writtenAt;
  if (typeof writtenAt !== "number" || !Number.isFinite(writtenAt) || writtenAt <= 0) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const elapsedMs = (input.now ?? Date.now()) - writtenAt;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  const rateAtWrite = record.playbackRateAtWrite ?? record.playbackRate;
  const rate =
    typeof rateAtWrite === "number" && Number.isFinite(rateAtWrite) && rateAtWrite > 0
      ? rateAtWrite
      : 1;
  const projectionBase = record.positionAtWrite ?? record.positionMs;
  const projectedPositionMs = Math.min(projectionBase + elapsedMs * rate, durationMs);
  if (projectedPositionMs - record.positionMs < SUSPENSION_GAP_FLOOR_MS) return null;
  return {
    recordedPositionMs: record.positionMs,
    writtenAt,
    elapsedMs,
    playbackRate: rate,
    projectedPositionMs,
  };
}

/**
 * The gap this device has already been told to stop asking about.
 *
 * Keyed by the hide-edge write's own `writtenAt`, which is what makes "the same
 * gap" a decidable question: a dismissal is a statement about one specific
 * unrecorded stretch, not a permanent opt-out. A LATER suspension writes a
 * later `writtenAt` and is offered again, which is right — it is a different
 * loss, and the user's last answer said nothing about it.
 */
export function readDismissedSuspensionGap(userId: string, bookId: string): number | null {
  try {
    const raw = Number(localStorage.getItem(suspensionDismissedKey(userId, bookId)) || 0);
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function dismissSuspensionGap(userId: string, bookId: string, writtenAt: number): void {
  if (isAccountWriteFenced(userId)) return;
  try {
    const key = suspensionDismissedKey(userId, bookId);
    localStorage.setItem(key, String(writtenAt));
    if (isAccountWriteFenced(userId)) localStorage.removeItem(key);
  } catch {
    // Storage is blocked. The offer reappears next launch, which is a nuisance
    // and not a lost position; nothing else in the player may fail for it.
  }
}

function suspensionDismissedKey(userId: string, bookId: string): string {
  return `chapterline:suspension-dismissed:${userId}:${bookId}`;
}

/**
 * Does this device's own record describe a later moment than the server's?
 *
 * A local record with no timestamp (`occurredAt: 0`, which is every pre-v2
 * value) loses to any server timestamp: it claims no moment at all, so it
 * cannot claim a later one.
 */
export function localWinsOver(
  local: LocalPosition | null,
  serverOccurredAt: string | null,
): boolean {
  if (!local) return false;
  if (!serverOccurredAt) return true;
  const serverTime = Date.parse(serverOccurredAt);
  return !Number.isFinite(serverTime) || local.occurredAt > serverTime;
}

export function freshestPosition(input: {
  local: LocalPosition | null;
  serverPositionMs: number;
  serverOccurredAt: string | null;
}): number {
  const { local } = input;
  return local && localWinsOver(local, input.serverOccurredAt)
    ? local.positionMs
    : input.serverPositionMs;
}

/**
 * Resolves position, rate, and completion independently before a book opens.
 *
 * The local durable tuple can contain an unsent value for only one field, so
 * using position freshness to choose the other two either discards that value
 * or gives a stale value a fresh clock on the first cadence write. Writing the
 * selected tuple back with its original clocks gives every later persistence
 * path one complete causal baseline. This is hydration only: smart rewind is
 * applied afterwards, and `playback-provider` still suppresses server writes
 * until the user actually plays, seeks, or changes rate.
 */
export function bootstrapPlaybackState(
  userId: string,
  serverBook: PlayerBook,
): { book: PlayerBook; storedPositionMs: number } {
  const local = readLocalProgress(userId, serverBook.id);
  const positionFromLocal = localWinsOver(local, serverBook.initialProgressOccurredAt);
  const positionMs = positionFromLocal && local ? local.positionMs : serverBook.initialPositionMs;
  const positionClock =
    positionFromLocal && local
      ? local.occurredAt
      : (parseClock(serverBook.initialProgressOccurredAt) ?? 0);

  const serverRateClock =
    serverBook.initialPlaybackRateOccurredAt ?? serverBook.initialProgressOccurredAt;
  const localRateClock = local
    ? (local.playbackRateOccurredAt ?? local.writtenAt ?? local.occurredAt)
    : null;
  const rateFromLocal =
    typeof local?.playbackRate === "number" && localClockWinsOver(localRateClock, serverRateClock);
  const playbackRate =
    rateFromLocal && typeof local?.playbackRate === "number"
      ? local.playbackRate
      : serverBook.initialPlaybackRate;
  const playbackRateClock = rateFromLocal
    ? (localRateClock ?? 0)
    : (parseClock(serverRateClock) ?? positionClock);

  const serverCompletionClock =
    serverBook.initialCompletedOccurredAt ?? serverBook.initialProgressOccurredAt;
  const localCompletionClock = local
    ? (local.completedOccurredAt ?? local.writtenAt ?? local.occurredAt)
    : null;
  const completionFromLocal =
    typeof local?.completed === "boolean" &&
    localClockWinsOver(localCompletionClock, serverCompletionClock);
  const completed =
    completionFromLocal && typeof local?.completed === "boolean"
      ? local.completed
      : serverBook.completed;
  const completedClock = completionFromLocal
    ? (localCompletionClock ?? 0)
    : (parseClock(serverCompletionClock) ?? positionClock);

  const book: PlayerBook = {
    ...serverBook,
    initialPositionMs: positionMs,
    initialProgressOccurredAt: serializeClock(positionClock),
    initialPlaybackRate: playbackRate,
    initialPlaybackRateOccurredAt: serializeClock(playbackRateClock),
    completed,
    initialCompletedOccurredAt: serializeClock(completedClock),
  };
  applyAuthoritativePlaybackState(
    userId,
    serverBook.id,
    {
      positionMs,
      occurredAt: positionClock,
      playbackRate,
      playbackRateOccurredAt: playbackRateClock,
      completed,
      completedOccurredAt: completedClock,
    },
    {
      positionMs: local?.positionMs ?? positionMs,
      occurredAt: local?.occurredAt ?? positionClock,
      playbackRate: local?.playbackRate ?? playbackRate,
      playbackRateOccurredAt: localRateClock ?? playbackRateClock,
      completed: local?.completed ?? completed,
      completedOccurredAt: localCompletionClock ?? completedClock,
    },
    "player-bootstrap",
  );
  return { book, storedPositionMs: positionMs };
}

function localClockWinsOver(localClock: number | null, serverClock: string | null): boolean {
  if (localClock === null) return false;
  const serverMoment = parseClock(serverClock);
  return serverMoment === null || localClock > serverMoment;
}

function parseClock(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function serializeClock(value: number): string | null {
  return value > 0 && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

/**
 * How long the user has been away from THIS book, for smart rewind.
 *
 * Scoped by user and book. A single global marker made the absence a property
 * of the device rather than of the book: pausing book A and returning to book B
 * a week later rewound B by 30 seconds even though B had never been paused at
 * all, and switching accounts on one device leaked the other account's absence.
 * Smart rewind is "remind me where I was in THIS story", so the marker has to
 * be per story, per account.
 *
 * An absent marker returns null (never 0), which `resolveStartPosition` treats
 * as "no rewind" rather than "no absence" — a book that has never been paused
 * must not be rewound.
 */
export function readMsSinceLastPause(userId: string, bookId: string): number | null {
  try {
    const raw = Number(localStorage.getItem(lastPausedKey(userId, bookId)) || 0);
    return raw > 0 ? Date.now() - raw : null;
  } catch {
    return null;
  }
}

export function markPausedNow(userId: string, bookId: string): void {
  if (isAccountWriteFenced(userId)) return;
  try {
    const key = lastPausedKey(userId, bookId);
    localStorage.setItem(key, String(Date.now()));
    if (isAccountWriteFenced(userId)) localStorage.removeItem(key);
  } catch {
    // A device with storage blocked still has to be able to play.
  }
}

export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem("chapterline:device-id");
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem("chapterline:device-id", created);
    return created;
  } catch {
    return sessionDeviceId();
  }
}

function lastPausedKey(userId: string, bookId: string): string {
  return `chapterline:last-paused-at:${userId}:${bookId}`;
}

/**
 * One stable id for a session that cannot persist one. Minting a fresh uuid per
 * call would give every write its own device identity, and the server orders
 * progress per (user, book, device) — a new device on every write is no
 * ordering at all, and every write but the first would be discarded.
 */
let ephemeralDeviceId: string | null = null;

function sessionDeviceId(): string {
  if (!ephemeralDeviceId) ephemeralDeviceId = `ephemeral:${crypto.randomUUID()}`;
  return ephemeralDeviceId;
}

function localPositionKey(userId: string, bookId: string): string {
  return `chapterline:position:${userId}:${bookId}`;
}

function positionRegisterPrefix(userId: string, bookId: string): string {
  return `chapterline:playback-position:${userId}:${bookId}:`;
}

function rateRegisterPrefix(userId: string, bookId: string): string {
  return `chapterline:playback-rate:${userId}:${bookId}:`;
}

function completedRegisterPrefix(userId: string, bookId: string): string {
  return `chapterline:playback-completed:${userId}:${bookId}:`;
}

type LocalPlaybackRegister = {
  value: number | boolean;
  occurredAt: number;
  writerId?: string;
};
type LocalPlaybackRegisterWithWriter = LocalPlaybackRegister & {
  writerId: string;
  storageKey: string;
};

let playbackRegisterRevision = 0;

function persistLocalRegister(
  prefix: string,
  writerId: string,
  value: number | boolean,
  occurredAt: number,
  claimLatest: boolean,
): LocalPlaybackRegister {
  let claimedAt = occurredAt;
  try {
    while (true) {
      // Immutable keys remove the compare-and-set race from compaction: no live
      // document will ever rewrite a key another document is considering.
      const revision = String(++playbackRegisterRevision).padStart(12, "0");
      const key = `${prefix}${writerId}:${revision}`;
      localStorage.setItem(key, JSON.stringify({ value, occurredAt: claimedAt, writerId }));
      compactLocalRegisters(prefix);
      if (!claimLatest) break;
      const winner = readNewestLocalRegister(prefix);
      if (!winner || winner.storageKey === key || winner.occurredAt !== claimedAt) break;
      // Two documents can change one field from the same baseline in the same
      // millisecond. Whichever write completes last observes the first winner,
      // advances the clock, and returns that exact clock to the network event.
      claimedAt = winner.occurredAt + 1;
    }
  } catch {
    // The returned record can still reach the IndexedDB outbox and server.
  }
  return { value, occurredAt: claimedAt, writerId };
}

function persistAuthoritativeLocalRegister(
  prefix: string,
  writerId: string,
  value: number | boolean,
  occurredAt: number,
  submittedValue: number | boolean,
  submittedAt: number,
  storageWriterId = writerId,
): boolean {
  try {
    const entries: Array<{ key: string; raw: string; register: LocalPlaybackRegister }> = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = localStorage.getItem(key);
      const register = raw ? parseLocalRegister(raw) : null;
      if (raw && register) entries.push({ key, raw, register });
    }

    // Land the canonical replacement before retiring anything. If quota or a
    // blocked store rejects it, the acknowledged local value remains intact.
    const revision = String(++playbackRegisterRevision).padStart(12, "0");
    // The register's writer can deliberately name the previous document when
    // an exact canonical acknowledgement preserves that document's lifecycle
    // provenance. Its storage key still belongs to THIS document. Otherwise a
    // reload resets `playbackRegisterRevision`, recreates the previous key, and
    // the acknowledged-entry cleanup below removes the just-written register.
    const key = `${prefix}${storageWriterId}:${revision}`;
    const canonicalRaw = JSON.stringify({ value, occurredAt, writerId });
    localStorage.setItem(key, canonicalRaw);
    if (localStorage.getItem(key) !== canonicalRaw) return false;
    for (const entry of entries) {
      const acknowledged =
        entry.register.occurredAt === submittedAt && entry.register.value === submittedValue;
      if (acknowledged && localStorage.getItem(entry.key) === entry.raw) {
        localStorage.removeItem(entry.key);
      }
    }
    compactLocalRegisters(prefix);
    const winner = readNewestLocalRegister(prefix);
    if (!winner) return false;
    const acknowledgedStillWins =
      winner.occurredAt === submittedAt &&
      winner.value === submittedValue &&
      (winner.occurredAt !== occurredAt || winner.value !== value);
    return !acknowledgedStillWins;
  } catch {
    return false;
  }
}

function compactLocalRegisters(prefix: string): void {
  const entries: Array<{
    key: string;
    raw: string;
    register: LocalPlaybackRegisterWithWriter;
  }> = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = localStorage.getItem(key);
    const register = raw ? parseLocalRegister(raw) : null;
    if (!raw || !register) continue;
    entries.push({
      key,
      raw,
      register: {
        ...register,
        writerId: register.writerId ?? key.slice(prefix.length),
        storageKey: key,
      },
    });
  }
  const winner = entries.reduce<(typeof entries)[number] | null>(
    (current, entry) =>
      !current || registerIsNewer(entry.register, current.register) ? entry : current,
    null,
  );
  if (!winner) return;
  for (const entry of entries) {
    if (entry.key === winner.key) continue;
    // Exact-raw revalidation protects a key written by an older/mixed build;
    // immutable keys from this build cannot change after the first read.
    if (localStorage.getItem(entry.key) === entry.raw) localStorage.removeItem(entry.key);
  }
}

function writeLocalValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The returned record can still reach the IndexedDB outbox and server.
  }
}

function readLocalRegister(key: string): LocalPlaybackRegister | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? parseLocalRegister(raw) : null;
  } catch {
    return null;
  }
}

function parseLocalRegister(raw: string): LocalPlaybackRegister | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LocalPlaybackRegister> | null;
    if (
      !parsed ||
      (typeof parsed.value !== "number" && typeof parsed.value !== "boolean") ||
      (typeof parsed.value === "number" && !Number.isFinite(parsed.value)) ||
      typeof parsed.occurredAt !== "number" ||
      !Number.isFinite(parsed.occurredAt) ||
      parsed.occurredAt < 0
    ) {
      return null;
    }
    return {
      value: parsed.value,
      occurredAt: parsed.occurredAt,
      ...(typeof parsed.writerId === "string" && parsed.writerId.length > 0
        ? { writerId: parsed.writerId }
        : {}),
    };
  } catch {
    return null;
  }
}

function readNewestLocalRegister(prefix: string): LocalPlaybackRegisterWithWriter | null {
  let newest: LocalPlaybackRegisterWithWriter | null = null;
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const register = readLocalRegister(key);
      if (!register) continue;
      const candidate: LocalPlaybackRegisterWithWriter = {
        ...register,
        writerId: register.writerId ?? key.slice(prefix.length),
        storageKey: key,
      };
      if (!newest || registerIsNewer(candidate, newest)) newest = candidate;
    }
  } catch {
    return newest;
  }
  return newest;
}

function registerIsNewer(
  candidate: LocalPlaybackRegisterWithWriter,
  current: LocalPlaybackRegisterWithWriter,
): boolean {
  return (
    candidate.occurredAt > current.occurredAt ||
    (candidate.occurredAt === current.occurredAt && candidate.storageKey > current.storageKey)
  );
}

// Deliberately document-scoped. Browsers copy sessionStorage into opener and
// duplicated tabs; persisting this id there would make two live documents
// overwrite the same register and recreate the lost-update race.
let playbackWriterId: string | null = null;

function localPlaybackWriterId(): string {
  if (playbackWriterId) return playbackWriterId;
  try {
    playbackWriterId = crypto.randomUUID();
  } catch {
    playbackWriterId = `${Date.now()}:${Math.random()}`;
  }
  return playbackWriterId;
}

function joinLocalPlaybackRegisters(
  userId: string,
  bookId: string,
  legacy: LocalPosition | null,
): LocalPosition | null {
  const position = readNewestLocalRegister(positionRegisterPrefix(userId, bookId));
  const registeredPosition =
    position && typeof position.value === "number" && position.value >= 0 ? position : null;
  const rate = readNewestLocalRegister(rateRegisterPrefix(userId, bookId));
  const registeredRate = rate && typeof rate.value === "number" ? rate : null;
  const completed = readNewestLocalRegister(completedRegisterPrefix(userId, bookId));
  const registeredCompleted = completed && typeof completed.value === "boolean" ? completed : null;
  if (!legacy && !registeredPosition && !registeredRate && !registeredCompleted) return null;
  const positionFromRegister =
    !!registeredPosition && (!legacy || registeredPosition.occurredAt >= legacy.occurredAt);
  const record: LocalPosition = {
    positionMs: positionFromRegister
      ? (registeredPosition?.value as number)
      : (legacy?.positionMs ?? 0),
    occurredAt: positionFromRegister
      ? (registeredPosition?.occurredAt ?? 0)
      : (legacy?.occurredAt ?? 0),
  };
  const positionWriterId = positionFromRegister ? registeredPosition?.writerId : legacy?.writerId;
  if (positionWriterId) record.writerId = positionWriterId;

  const legacyRateClock = legacy
    ? (legacy.playbackRateOccurredAt ?? legacy.writtenAt ?? legacy.occurredAt)
    : -1;
  if (registeredRate && registeredRate.occurredAt >= legacyRateClock) {
    record.playbackRate = registeredRate.value as number;
    record.playbackRateOccurredAt = registeredRate.occurredAt;
  } else if (typeof legacy?.playbackRate === "number") {
    record.playbackRate = legacy.playbackRate;
    record.playbackRateOccurredAt = legacyRateClock;
  }

  const legacyCompletedClock = legacy
    ? (legacy.completedOccurredAt ?? legacy.writtenAt ?? legacy.occurredAt)
    : -1;
  if (registeredCompleted && registeredCompleted.occurredAt >= legacyCompletedClock) {
    record.completed = registeredCompleted.value as boolean;
    record.completedOccurredAt = registeredCompleted.occurredAt;
  } else if (typeof legacy?.completed === "boolean") {
    record.completed = legacy.completed;
    record.completedOccurredAt = legacyCompletedClock;
  }

  const registerMatchesLegacy =
    !!legacy &&
    !!registeredPosition &&
    legacy.positionMs === registeredPosition.value &&
    legacy.occurredAt === registeredPosition.occurredAt;
  const provenance = !legacy
    ? null
    : legacy.writerId
      ? registerMatchesLegacy && samePlaybackWriter(legacy.writerId, registeredPosition?.writerId)
        ? legacy
        : null
      : !positionFromRegister || registerMatchesLegacy
        ? legacy
        : null;
  if (provenance?.source) record.source = provenance.source;
  if (provenance?.positionAtWrite !== undefined) {
    record.positionAtWrite = provenance.positionAtWrite;
  }
  if (provenance?.writtenAt !== undefined) record.writtenAt = provenance.writtenAt;
  if (provenance?.playingAtWrite) record.playingAtWrite = true;
  if (provenance?.playbackRateAtWrite !== undefined) {
    record.playbackRateAtWrite = provenance.playbackRateAtWrite;
  }
  if (provenance?.completedAtWrite !== undefined) {
    record.completedAtWrite = provenance.completedAtWrite;
  }
  return record;
}

function samePlaybackWriter(left: string, right: string | undefined): boolean {
  if (!right) return false;
  return documentPlaybackWriterId(left) === documentPlaybackWriterId(right);
}

function documentPlaybackWriterId(value: string): string {
  return value.startsWith("!canonical:") ? value.slice("!canonical:".length) : value;
}

function validLocalPosition(parsed: unknown, occurredAtOverride: number | undefined) {
  const entry = (
    typeof parsed === "number" ? { positionMs: parsed } : parsed
  ) as Partial<LocalPosition> | null;
  const positionMs = entry?.positionMs;
  if (typeof positionMs !== "number" || !Number.isFinite(positionMs) || positionMs < 0) return null;
  const occurredAt = occurredAtOverride ?? entry?.occurredAt;
  const record: LocalPosition = {
    positionMs,
    occurredAt:
      typeof occurredAt === "number" && Number.isFinite(occurredAt) && occurredAt >= 0
        ? occurredAt
        : 0,
  };
  if (
    typeof entry?.positionAtWrite === "number" &&
    Number.isFinite(entry.positionAtWrite) &&
    entry.positionAtWrite >= 0
  ) {
    record.positionAtWrite = entry.positionAtWrite;
  }
  if (typeof entry?.playbackRate === "number" && Number.isFinite(entry.playbackRate)) {
    record.playbackRate = entry.playbackRate;
  }
  if (
    typeof entry?.playbackRateAtWrite === "number" &&
    Number.isFinite(entry.playbackRateAtWrite)
  ) {
    record.playbackRateAtWrite = entry.playbackRateAtWrite;
  }
  if (
    typeof entry?.playbackRateOccurredAt === "number" &&
    Number.isFinite(entry.playbackRateOccurredAt) &&
    entry.playbackRateOccurredAt >= 0
  ) {
    record.playbackRateOccurredAt = entry.playbackRateOccurredAt;
  }
  if (typeof entry?.completed === "boolean") record.completed = entry.completed;
  if (typeof entry?.completedAtWrite === "boolean") {
    record.completedAtWrite = entry.completedAtWrite;
  }
  if (
    typeof entry?.completedOccurredAt === "number" &&
    Number.isFinite(entry.completedOccurredAt) &&
    entry.completedOccurredAt >= 0
  ) {
    record.completedOccurredAt = entry.completedOccurredAt;
  }
  // Provenance is diagnostic and is rendered verbatim, so only a value this
  // build actually writes is carried through; anything else stays absent rather
  // than putting an unknown string in front of the user.
  if (isWriteSource(entry?.source)) record.source = entry.source;
  const writtenAt = entry?.writtenAt;
  if (typeof writtenAt === "number" && Number.isFinite(writtenAt) && writtenAt >= 0) {
    record.writtenAt = writtenAt;
  }
  // Only a literal `true` carries through. Anything else — a string, a 1, a
  // field a future build repurposes — is not evidence that a listening session
  // was running, and `detectSuspendedSession` must never offer to move the
  // user's position on the strength of a value it had to coerce.
  if (entry?.playingAtWrite === true) record.playingAtWrite = true;
  if (typeof entry?.writerId === "string" && entry.writerId.length > 0) {
    record.writerId = entry.writerId;
  }
  return record;
}

function isWriteSource(value: unknown): value is PlaybackWriteSource {
  return (PLAYBACK_WRITE_SOURCES as readonly string[]).includes(value as string);
}
