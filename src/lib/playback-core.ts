import type { PlayerBook } from "@/domain/player";
import { isAccountWriteFenced } from "@/lib/account-deletion-fence";

const PLAYBACK_WRITE_SOURCES = [
  "media-tick",
  "cadence-timer",
  "visibility-flush",
  "pagehide-flush",
  "pause",
  "seek",
  "ended",
  "rate-change",
  "player-bootstrap",
  "book-switch",
  "book-unload",
] as const;

export type PlaybackWriteSource = (typeof PLAYBACK_WRITE_SOURCES)[number];

export type LocalPosition = {
  positionMs: number;
  positionAtWrite?: number;
  occurredAt: number;
  playbackRate?: number;
  playbackRateAtWrite?: number;
  playbackRateOccurredAt?: number;
  completed?: boolean;
  completedAtWrite?: boolean;
  completedOccurredAt?: number;
  writerId?: string;
  source?: PlaybackWriteSource;
  writtenAt?: number;
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
    playing?: boolean;
    positionAtWrite?: number;
    positionChanged?: boolean;
    playbackRateChanged?: boolean;
    completedChanged?: boolean;
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
      playbackRegisterPrefix("position", userId, bookId),
      writerId,
      candidate.positionMs,
      candidate.occurredAt,
      positionChanged,
    );
    if (positionChanged) candidate.occurredAt = persisted.occurredAt;
  }
  if ((state.hydrate || playbackRateChanged) && typeof candidate.playbackRate === "number") {
    const persisted = persistLocalRegister(
      playbackRegisterPrefix("rate", userId, bookId),
      writerId,
      candidate.playbackRate,
      candidate.playbackRateOccurredAt ?? candidate.writtenAt ?? candidate.occurredAt,
      playbackRateChanged,
    );
    if (playbackRateChanged) candidate.playbackRateOccurredAt = persisted.occurredAt;
  }
  if ((state.hydrate || completedChanged) && typeof candidate.completed === "boolean") {
    const persisted = persistLocalRegister(
      playbackRegisterPrefix("completed", userId, bookId),
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
  const record = joinLocalPlaybackRegisters(userId, bookId, merged) ?? merged;
  writeLocalValue(localPositionKey(userId, bookId), JSON.stringify(record));
  if (isAccountWriteFenced(userId)) {
    clearLocalPlaybackState(userId, bookId);
    return null;
  }
  return record;
}

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
  const preservedProvenance =
    current?.source &&
    current.positionMs === resolvedPositionMs &&
    current.occurredAt === resolvedPositionClock
      ? current
      : null;
  const writerId = `!canonical:${localPlaybackWriterId()}`;
  const positionWriterId = preservedProvenance?.writerId
    ? `!canonical:${documentPlaybackWriterId(preservedProvenance.writerId)}`
    : writerId;

  const positionPersisted =
    !replacePosition ||
    persistAuthoritativeLocalRegister(
      playbackRegisterPrefix("position", userId, bookId),
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
      playbackRegisterPrefix("rate", userId, bookId),
      writerId,
      server.playbackRate,
      server.playbackRateOccurredAt,
      rateSource.value,
      rateSource.occurredAt,
    );
  const completionPersisted =
    !replaceCompleted ||
    persistAuthoritativeLocalRegister(
      playbackRegisterPrefix("completed", userId, bookId),
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

function momentThisPositionWasReached(
  previous: LocalPosition | null,
  positionMs: number,
  now: number,
): number {
  return previous && previous.positionMs === positionMs && previous.occurredAt > 0
    ? previous.occurredAt
    : now;
}

export function clearLocalPlaybackState(userId: string, bookId: string): void {
  pendingPlaybackNormalizations.delete(localPositionKey(userId, bookId));
  const remove = (key: string) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        localStorage.removeItem(key);
        return;
      } catch {}
    }
  };
  remove(localPositionKey(userId, bookId));
  const registerPrefixes = [
    playbackRegisterPrefix("position", userId, bookId),
    playbackRegisterPrefix("rate", userId, bookId),
    playbackRegisterPrefix("completed", userId, bookId),
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
    } catch {}
  }
  registerKeys.forEach(remove);
  remove(lastPausedKey(userId, bookId));
  remove(suspensionDismissedKey(userId, bookId));
}

export function readLocalProgress(userId: string, bookId: string): LocalPosition | null {
  return applyPendingPlaybackNormalizations(userId, bookId, readLocalProgressRaw(userId, bookId));
}

function readLocalProgressRaw(userId: string, bookId: string): LocalPosition | null {
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

export function readLatestLocalPlayback(
  userId: string,
): { bookId: string; state: LocalPosition } | null {
  let latest: { bookId: string; state: LocalPosition } | null = null;
  for (const entry of listLocalPlaybackStates(userId)) {
    if (!latest || (entry.state.writtenAt ?? 0) > (latest.state.writtenAt ?? 0)) latest = entry;
  }
  return latest;
}

const HIDE_EDGE_SOURCES: readonly PlaybackWriteSource[] = ["visibility-flush", "pagehide-flush"];

export const SUSPENSION_GAP_FLOOR_MS = 60_000;

export type SuspendedSession = {
  recordedPositionMs: number;
  writtenAt: number;
  elapsedMs: number;
  playbackRate: number;
  projectedPositionMs: number;
};

export function detectSuspendedSession(input: {
  record: LocalPosition | null;
  durationMs: number;
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
  } catch {}
}

function suspensionDismissedKey(userId: string, bookId: string): string {
  return `chapterline:suspension-dismissed:${userId}:${bookId}`;
}

export function localWinsOver(
  local: LocalPosition | null,
  serverOccurredAt: string | null,
): boolean {
  if (!local) return false;
  if (!serverOccurredAt) return true;
  const serverTime = Date.parse(serverOccurredAt);
  return !Number.isFinite(serverTime) || local.occurredAt > serverTime;
}

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
  } catch {}
}

function lastPausedKey(userId: string, bookId: string): string {
  return `chapterline:last-paused-at:${userId}:${bookId}`;
}

function localPositionKey(userId: string, bookId: string): string {
  return `chapterline:position:${userId}:${bookId}`;
}

function playbackRegisterPrefix(
  field: "position" | "rate" | "completed",
  userId: string,
  bookId: string,
): string {
  return `chapterline:playback-${field}:${userId}:${bookId}:`;
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
      const revision = String(++playbackRegisterRevision).padStart(12, "0");
      const key = `${prefix}${writerId}:${revision}`;
      localStorage.setItem(key, JSON.stringify({ value, occurredAt: claimedAt, writerId }));
      compactLocalRegisters(prefix);
      if (!claimLatest) break;
      const winner = readNewestLocalRegister(prefix);
      if (!winner || winner.storageKey === key || winner.occurredAt !== claimedAt) break;
      claimedAt = winner.occurredAt + 1;
    }
  } catch {}
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

    const revision = String(++playbackRegisterRevision).padStart(12, "0");
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
    if (localStorage.getItem(entry.key) === entry.raw) localStorage.removeItem(entry.key);
  }
}

function writeLocalValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
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
  const position = readNewestLocalRegister(playbackRegisterPrefix("position", userId, bookId));
  const registeredPosition =
    position && typeof position.value === "number" && position.value >= 0 ? position : null;
  const rate = readNewestLocalRegister(playbackRegisterPrefix("rate", userId, bookId));
  const registeredRate = rate && typeof rate.value === "number" ? rate : null;
  const completed = readNewestLocalRegister(playbackRegisterPrefix("completed", userId, bookId));
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
  if (isWriteSource(entry?.source)) record.source = entry.source;
  const writtenAt = entry?.writtenAt;
  if (typeof writtenAt === "number" && Number.isFinite(writtenAt) && writtenAt >= 0) {
    record.writtenAt = writtenAt;
  }
  if (entry?.playingAtWrite === true) record.playingAtWrite = true;
  if (typeof entry?.writerId === "string" && entry.writerId.length > 0) {
    record.writerId = entry.writerId;
  }
  return record;
}

function isWriteSource(value: unknown): value is PlaybackWriteSource {
  return (PLAYBACK_WRITE_SOURCES as readonly string[]).includes(value as string);
}
