import { mediaTime } from "./media-source";

import type { PlayerBook } from "@/domain/player";
import {
  applyPendingProgressNormalizations,
  duplicateProgressRetryFloor,
  nextDeviceSequence,
  reconcileAcceptedProgressWithStatus,
  reconcileProgressConflict,
  reserveDeviceSequenceAbove,
  shouldRetainMutation,
  toProgressBody,
  withProgressMutationLock,
} from "@/lib/offline-sync";
import { commitProgress, mirrorProgress } from "@/lib/offline/outbox";
import {
  readLocalProgress,
  saveLocalPlaybackState,
  type LocalPosition,
  type PlaybackPredecessor,
  type PlaybackWriteSource,
} from "@/lib/playback-core";
import { getDeviceId } from "@/lib/device-id";

const DURABLE_SAVE_INTERVAL_MS = 200;
const SERVER_SAVE_INTERVAL_MS = 15_000;

export type ProgressConflictDetail = {
  userId: string;
  bookId: string;
  positionMs: number;
  completed: boolean;
  playbackRate: number;
  eventOccurredAt: string | null;
  playbackRateOccurredAt: string | null;
  completedOccurredAt: string | null;
};

export type ProgressPersisterDeps = {
  getUserId: () => string;
  getAudio: () => HTMLAudioElement | null;
  getActiveBook: () => PlayerBook | null;
};

export type ProgressPersister = ReturnType<typeof createProgressPersister>;

export function createProgressPersister({
  getUserId,
  getAudio,
  getActiveBook,
}: ProgressPersisterDeps) {
  let lastServerSaveAt = 0;
  let lastDurableWriteAt = 0;
  const completion = new Map<string, boolean>();
  const predecessorByRecord = new WeakMap<LocalPosition, PlaybackPredecessor>();
  const progressBaselines = new Map<
    string,
    {
      positionMs: number;
      durablePositionMs: number;
      occurredAt: number;
      playbackRate: number;
      playbackRateOccurredAt: number;
      completed: boolean;
      completedOccurredAt: number;
    }
  >();
  let positionChanged = false;

  const markPositionChanged = () => {
    positionChanged = true;
  };

  const saveDurableState = (
    source: PlaybackWriteSource,
    positionMs?: number,
    completed?: boolean,
    bookOverride?: PlayerBook,
  ) => {
    const activeBook = bookOverride || getActiveBook();
    if (!activeBook) return null;
    if (completed !== undefined) completion.set(activeBook.id, completed);
    if (!positionChanged) return null;
    const audio = getAudio();
    const position = positionMs ?? (audio ? mediaTime(audio) * 1000 : 0);
    if (!Number.isFinite(position) || position < 0) return null;
    const playbackRate = audio?.playbackRate || 1;
    const durableCompleted = completed ?? completion.get(activeBook.id) ?? activeBook.completed;
    const baseline = progressBaselines.get(activeBook.id) ?? {
      positionMs: Math.round(activeBook.initialPositionMs),
      durablePositionMs: Math.round(activeBook.initialPositionMs),
      occurredAt: clockMoment(activeBook.initialProgressOccurredAt),
      playbackRate: activeBook.initialPlaybackRate,
      playbackRateOccurredAt: clockMoment(
        activeBook.initialPlaybackRateOccurredAt ?? activeBook.initialProgressOccurredAt,
      ),
      completed: activeBook.completed,
      completedOccurredAt: clockMoment(
        activeBook.initialCompletedOccurredAt ?? activeBook.initialProgressOccurredAt,
      ),
    };
    const writtenAt = Date.now();
    lastDurableWriteAt = writtenAt;
    const roundedPosition = Math.round(position);
    const playbackRateFieldChanged = playbackRate !== baseline.playbackRate;
    const completedFieldChanged = durableCompleted !== baseline.completed;
    const canMovePositionBackward =
      source === "seek" ||
      source === "ended" ||
      (completedFieldChanged && durableCompleted === false);
    const positionFieldChanged =
      source !== "rate-change" &&
      roundedPosition !== baseline.durablePositionMs &&
      (roundedPosition > baseline.durablePositionMs || canMovePositionBackward);
    const occurredAt = positionFieldChanged
      ? nextFieldClock(writtenAt, baseline.occurredAt)
      : baseline.occurredAt;
    const playbackRateOccurredAt = playbackRateFieldChanged
      ? nextFieldClock(writtenAt, baseline.playbackRateOccurredAt)
      : baseline.playbackRateOccurredAt;
    const completedOccurredAt = completedFieldChanged
      ? nextFieldClock(writtenAt, baseline.completedOccurredAt)
      : baseline.completedOccurredAt;
    const userId = getUserId();
    const predecessor = playbackPredecessor(readLocalProgress(userId, activeBook.id));
    const record = saveLocalPlaybackState(userId, activeBook.id, {
      positionMs: positionFieldChanged ? roundedPosition : baseline.durablePositionMs,
      occurredAt,
      playbackRate,
      playbackRateOccurredAt,
      completed: durableCompleted,
      completedOccurredAt,
      positionChanged: positionFieldChanged,
      playbackRateChanged: playbackRateFieldChanged,
      completedChanged: completedFieldChanged,
      source,
      positionAtWrite: roundedPosition,
      playing: !!audio && !audio.paused,
    });
    if (record) {
      predecessorByRecord.set(record, predecessor);
      progressBaselines.set(activeBook.id, {
        positionMs: roundedPosition,
        durablePositionMs: positionFieldChanged ? record.positionMs : baseline.durablePositionMs,
        occurredAt: positionFieldChanged ? record.occurredAt : occurredAt,
        playbackRate: playbackRateFieldChanged
          ? (record.playbackRate ?? playbackRate)
          : playbackRate,
        playbackRateOccurredAt: playbackRateFieldChanged
          ? (record.playbackRateOccurredAt ?? playbackRateOccurredAt)
          : playbackRateOccurredAt,
        completed: completedFieldChanged
          ? (record.completed ?? durableCompleted)
          : durableCompleted,
        completedOccurredAt: completedFieldChanged
          ? (record.completedOccurredAt ?? completedOccurredAt)
          : completedOccurredAt,
      });
    }
    return record;
  };

  const writeDurableIfDue = (source: PlaybackWriteSource, positionMs: number) => {
    const audio = getAudio();
    if (!audio || audio.paused || !getActiveBook()) return;
    if (Date.now() - lastDurableWriteAt < DURABLE_SAVE_INTERVAL_MS) return;
    saveDurableState(source, positionMs, false);
  };

  const sendProgress = async (
    durableState: LocalPosition,
    completed?: boolean,
    bookOverride?: PlayerBook,
  ) => {
    const activeBook = bookOverride || getActiveBook();
    if (!activeBook || !positionChanged) return;
    const userId = getUserId();
    await withProgressMutationLock(activeBook.id, async () => {
      await applyPendingProgressNormalizations(userId, activeBook.id);
      const currentDurable = mergeProgressState(
        durableState,
        readLocalProgress(userId, activeBook.id),
      );
      const durableCompleted =
        currentDurable.completed ??
        completed ??
        completion.get(activeBook.id) ??
        activeBook.completed;
      const playbackRate = currentDurable.playbackRate ?? getAudio()?.playbackRate ?? 1;
      const playbackRateOccurredAt =
        currentDurable.playbackRateOccurredAt ??
        currentDurable.writtenAt ??
        currentDurable.occurredAt;
      const completedOccurredAt =
        currentDurable.completedOccurredAt ?? currentDurable.writtenAt ?? currentDurable.occurredAt;
      const event = {
        bookId: activeBook.id,
        deviceId: getDeviceId(),
        deviceSequence: await nextDeviceSequence(activeBook.id, userId),
        positionMs: currentDurable.positionMs,
        playbackRate,
        completed: durableCompleted,
        eventOccurredAt: new Date(currentDurable.occurredAt).toISOString(),
        playbackRateOccurredAt: new Date(playbackRateOccurredAt).toISOString(),
        completedOccurredAt: new Date(completedOccurredAt).toISOString(),
        stateOccurredAt: new Date(
          Math.max(playbackRateOccurredAt, completedOccurredAt),
        ).toISOString(),
        predecessor: predecessorByRecord.get(durableState),
      };

      let response: Response;
      try {
        response = await fetch(`/api/books/${activeBook.id}/progress`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: toProgressBody(event),
          keepalive: true,
        });
      } catch {
        await commitProgress({ userId, ...event });
        return;
      }

      if (response.status === 409) {
        await reconcileProgressConflict({ userId, ...event }, response);
      } else if (response.ok) {
        const duplicateFloor = await duplicateProgressRetryFloor({ userId, ...event }, response);
        if (duplicateFloor !== null) {
          const deviceSequence = await reserveDeviceSequenceAbove(
            activeBook.id,
            duplicateFloor,
            userId,
          );
          await commitProgress({ userId, ...event, deviceSequence });
          return;
        }
        const reconciled = await reconcileAcceptedProgressWithStatus(
          { userId, ...event },
          response,
        );
        if (!reconciled.persisted) {
          await commitProgress({ userId, ...event });
          return;
        }
        const accepted = reconciled.progress;
        if (accepted) {
          const liveAudio = getAudio();
          const livePosition = liveAudio ? mediaTime(liveAudio) : undefined;
          progressBaselines.set(activeBook.id, {
            positionMs:
              typeof livePosition === "number" && Number.isFinite(livePosition)
                ? Math.round(livePosition * 1_000)
                : accepted.positionMs,
            durablePositionMs: accepted.positionMs,
            occurredAt: Date.parse(accepted.eventOccurredAt),
            playbackRate: accepted.playbackRate,
            playbackRateOccurredAt: Date.parse(
              accepted.playbackRateOccurredAt ?? accepted.eventOccurredAt,
            ),
            completed: accepted.completed,
            completedOccurredAt: Date.parse(
              accepted.completedOccurredAt ?? accepted.eventOccurredAt,
            ),
          });
          completion.set(activeBook.id, accepted.completed);
        }
        await mirrorProgress(accepted ?? { userId, ...event });
      } else if (response.status === 400 || shouldRetainMutation(response.status)) {
        await commitProgress({ userId, ...event });
      }
    });
  };

  const persistProgress = (
    source: PlaybackWriteSource,
    positionMs: number,
    completed?: boolean,
    bookOverride?: PlayerBook,
  ) => {
    const durableState = saveDurableState(source, positionMs, completed, bookOverride);
    if (!durableState) return Promise.resolve();
    return sendProgress(durableState, completed, bookOverride).catch(() => undefined);
  };

  const onListeningTick = (positionMs: number) => {
    if (!getActiveBook()) return;
    writeDurableIfDue("media-tick", positionMs);
    if (Date.now() - lastServerSaveAt > SERVER_SAVE_INTERVAL_MS) {
      lastServerSaveAt = Date.now();
      void persistProgress("media-tick", positionMs, false);
    }
  };

  const markInProgress = () => {
    const activeBook = getActiveBook();
    if (activeBook) completion.set(activeBook.id, false);
    positionChanged = true;
  };

  const resetPositionChanged = () => {
    positionChanged = false;
  };

  const reconcileCompletion = (detail: ProgressConflictDetail) => {
    completion.set(detail.bookId, detail.completed);
    progressBaselines.set(detail.bookId, {
      positionMs: Math.round(detail.positionMs),
      durablePositionMs: Math.round(detail.positionMs),
      occurredAt: clockMoment(detail.eventOccurredAt),
      playbackRate: detail.playbackRate,
      playbackRateOccurredAt: clockMoment(detail.playbackRateOccurredAt ?? detail.eventOccurredAt),
      completed: detail.completed,
      completedOccurredAt: clockMoment(detail.completedOccurredAt ?? detail.eventOccurredAt),
    });
  };

  let timer: number | null = null;
  const stopCadence = () => {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
  };
  const tick = () => {
    timer = null;
    const element = getAudio();
    if (!element || element.paused || !getActiveBook()) return;
    const remaining = DURABLE_SAVE_INTERVAL_MS - (Date.now() - lastDurableWriteAt);
    if (remaining > 0) {
      timer = window.setTimeout(tick, remaining);
      return;
    }
    writeDurableIfDue("cadence-timer", mediaTime(element) * 1000);
    timer = window.setTimeout(tick, DURABLE_SAVE_INTERVAL_MS);
  };
  const startCadence = () => {
    if (timer !== null) return;
    timer = window.setTimeout(tick, DURABLE_SAVE_INTERVAL_MS);
  };

  return {
    persistProgress,
    onListeningTick,
    markInProgress,
    saveDurableState,
    markPositionChanged,
    resetPositionChanged,
    reconcileCompletion,
    startCadence,
    stopCadence,
  };
}

function clockMoment(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nextFieldClock(now: number, previous: number): number {
  return Math.max(now, previous + 1);
}

function playbackPredecessor(state: LocalPosition | null): PlaybackPredecessor {
  if (!state) return {};
  const rateClock = state.playbackRateOccurredAt ?? state.writtenAt ?? state.occurredAt;
  const completedClock = state.completedOccurredAt ?? state.writtenAt ?? state.occurredAt;
  return {
    position: { value: state.positionMs, occurredAt: state.occurredAt },
    ...(typeof state.playbackRate === "number"
      ? { playbackRate: { value: state.playbackRate, occurredAt: rateClock } }
      : {}),
    ...(typeof state.completed === "boolean"
      ? { completed: { value: state.completed, occurredAt: completedClock } }
      : {}),
  };
}

function mergeProgressState(event: LocalPosition, shared: LocalPosition | null): LocalPosition {
  if (!shared) return event;
  const merged = { ...event };
  if (shared.occurredAt > event.occurredAt) {
    merged.positionMs = shared.positionMs;
    merged.occurredAt = shared.occurredAt;
  }
  const eventRateClock = event.playbackRateOccurredAt ?? event.writtenAt ?? event.occurredAt;
  const sharedRateClock = shared.playbackRateOccurredAt ?? shared.writtenAt ?? shared.occurredAt;
  if (
    typeof shared.playbackRate === "number" &&
    (typeof event.playbackRate !== "number" || sharedRateClock > eventRateClock)
  ) {
    merged.playbackRate = shared.playbackRate;
    merged.playbackRateOccurredAt = sharedRateClock;
  }
  const eventCompletedClock = event.completedOccurredAt ?? event.writtenAt ?? event.occurredAt;
  const sharedCompletedClock = shared.completedOccurredAt ?? shared.writtenAt ?? shared.occurredAt;
  if (
    typeof shared.completed === "boolean" &&
    (typeof event.completed !== "boolean" || sharedCompletedClock > eventCompletedClock)
  ) {
    merged.completed = shared.completed;
    merged.completedOccurredAt = sharedCompletedClock;
  }
  return merged;
}
