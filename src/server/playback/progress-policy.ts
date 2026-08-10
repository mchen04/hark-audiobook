export type ExistingProgress = {
  eventOccurredAt: Date;
};

export type ProgressDecision = {
  accept: boolean;
  occurredAt: Date;
  reason: "accepted" | "stale-event" | "invalid-time";
};

export type ProgressFieldState = {
  positionMs: number;
  playbackRate: number;
  completed: boolean;
  eventOccurredAt: Date;
  playbackRateOccurredAt?: Date | null;
  completedOccurredAt?: Date | null;
  /** Combined clock stored by clients and rows that predate per-field clocks. */
  stateOccurredAt?: Date | null;
};

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ORDERING_TOLERANCE_MS = 2_000;

export function decideProgressUpdate(
  existing: ExistingProgress | null,
  occurredAt: Date,
  serverNow: Date,
  orderingToleranceMs = ORDERING_TOLERANCE_MS,
): ProgressDecision {
  const incomingTime = occurredAt.getTime();
  const now = serverNow.getTime();
  if (!Number.isFinite(incomingTime)) {
    return { accept: false, occurredAt: serverNow, reason: "invalid-time" };
  }

  const bounded = new Date(Math.min(incomingTime, now + MAX_FUTURE_SKEW_MS));
  if (existing && bounded.getTime() + orderingToleranceMs < existing.eventOccurredAt.getTime()) {
    return { accept: false, occurredAt: bounded, reason: "stale-event" };
  }

  return { accept: true, occurredAt: bounded, reason: "accepted" };
}

/**
 * Position, rate and completion are independent last-writer-wins registers.
 * Changing playback speed is not authorization to seek a book backward, while
 * listening on another device is not authorization to discard a later speed.
 */
export function mergeProgressFields(
  existing: ProgressFieldState | null,
  incoming: ProgressFieldState,
  serverNow: Date,
  durationMs: number,
) {
  const position = decideProgressUpdate(existing, incoming.eventOccurredAt, serverNow);
  const existingRateClock = existing ? playbackRateClock(existing) : null;
  const existingCompletionClock = existing ? completionClock(existing) : null;
  const playbackRate = decideProgressUpdate(
    existingRateClock ? { eventOccurredAt: existingRateClock } : null,
    playbackRateClock(incoming),
    serverNow,
    incoming.playbackRateOccurredAt == null ? ORDERING_TOLERANCE_MS : 0,
  );
  const completed = decideProgressUpdate(
    existingCompletionClock ? { eventOccurredAt: existingCompletionClock } : null,
    completionClock(incoming),
    serverNow,
    incoming.completedOccurredAt == null ? ORDERING_TOLERANCE_MS : 0,
  );
  const playbackRateOccurredAt =
    existing && !playbackRate.accept ? playbackRateClock(existing) : playbackRate.occurredAt;
  const completedOccurredAt =
    existing && !completed.accept ? completionClock(existing) : completed.occurredAt;
  return {
    position,
    playbackRate,
    completed,
    merged: {
      positionMs:
        !existing || position.accept
          ? Math.min(Math.max(0, incoming.positionMs), durationMs)
          : existing.positionMs,
      playbackRate:
        !existing || playbackRate.accept ? incoming.playbackRate : existing.playbackRate,
      completed: !existing || completed.accept ? incoming.completed : existing.completed,
      eventOccurredAt:
        !existing || position.accept ? position.occurredAt : existing.eventOccurredAt,
      playbackRateOccurredAt,
      completedOccurredAt,
      stateOccurredAt: new Date(
        Math.max(playbackRateOccurredAt.getTime(), completedOccurredAt.getTime()),
      ),
    } satisfies ProgressFieldState,
  };
}

function playbackRateClock(state: ProgressFieldState): Date {
  return state.playbackRateOccurredAt ?? state.stateOccurredAt ?? state.eventOccurredAt;
}

function completionClock(state: ProgressFieldState): Date {
  return state.completedOccurredAt ?? state.stateOccurredAt ?? state.eventOccurredAt;
}
