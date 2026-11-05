import { replayQueuedMutations } from "@/lib/offline-sync";
import { commitHistoryEvent } from "@/lib/offline/outbox";
import { getDeviceId } from "@/lib/device-id";

const MIN_SESSION_MS = 5_000;

type ListeningStretch = {
  startedAt: string;
  endedAt: string;
  startPositionMs: number;
  endPositionMs: number;
};

type PostSession = (bookId: string, payload: ListeningStretch) => void;

export function createListeningTracker(post: PostSession, now: () => number = Date.now) {
  let started: { startedAtMs: number; startPositionMs: number } | null = null;

  return {
    begin(positionMs: number): void {
      if (!started) started = { startedAtMs: now(), startPositionMs: positionMs };
    },
    end(bookId: string, endPositionMs: number): void {
      const current = started;
      started = null;
      if (!current) return;
      const endedAtMs = now();
      if (endedAtMs - current.startedAtMs < MIN_SESSION_MS) return;
      post(bookId, {
        startedAt: new Date(current.startedAtMs).toISOString(),
        endedAt: new Date(endedAtMs).toISOString(),
        startPositionMs: Math.round(current.startPositionMs),
        endPositionMs: Math.round(endPositionMs),
      });
    },
    reset(): void {
      started = null;
    },
  };
}

export function queueListeningSession(userId: string): PostSession {
  return (bookId, payload) => {
    void commitHistoryEvent({ userId, deviceId: getDeviceId() }, bookId, payload)
      .then(() => replayQueuedMutations(userId))
      .catch(() => undefined);
  };
}
