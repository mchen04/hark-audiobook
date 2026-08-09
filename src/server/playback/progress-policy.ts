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
  stateOccurredAt: Date | null;
};

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ORDERING_TOLERANCE_MS = 2_000;

export function decideProgressUpdate(
  existing: ExistingProgress | null,
  occurredAt: Date,
  serverNow: Date,
): ProgressDecision {
  const incomingTime = occurredAt.getTime();
  const now = serverNow.getTime();
  if (!Number.isFinite(incomingTime)) {
    return { accept: false, occurredAt: serverNow, reason: "invalid-time" };
  }

  const bounded = new Date(Math.min(incomingTime, now + MAX_FUTURE_SKEW_MS));
  if (existing && bounded.getTime() + ORDERING_TOLERANCE_MS < existing.eventOccurredAt.getTime()) {
    return { accept: false, occurredAt: bounded, reason: "stale-event" };
  }

  return { accept: true, occurredAt: bounded, reason: "accepted" };
}

/**
 * Position and rate/completion are independent last-writer-wins registers.
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
  const existingStateClock = existing?.stateOccurredAt ?? existing?.eventOccurredAt ?? null;
  const state = decideProgressUpdate(
    existingStateClock ? { eventOccurredAt: existingStateClock } : null,
    incoming.stateOccurredAt ?? incoming.eventOccurredAt,
    serverNow,
  );
  return {
    position,
    state,
    merged: {
      positionMs:
        !existing || position.accept
          ? Math.min(Math.max(0, incoming.positionMs), durationMs)
          : existing.positionMs,
      playbackRate: !existing || state.accept ? incoming.playbackRate : existing.playbackRate,
      completed: !existing || state.accept ? incoming.completed : existing.completed,
      eventOccurredAt:
        !existing || position.accept ? position.occurredAt : existing.eventOccurredAt,
      stateOccurredAt:
        !existing || state.accept
          ? state.occurredAt
          : (existing.stateOccurredAt ?? existing.eventOccurredAt),
    } satisfies ProgressFieldState,
  };
}
