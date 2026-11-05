import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

import {
  applyPendingProgressNormalizations,
  listProgressNormalizations,
  listQueuedMutations,
  queueProgress,
  registerProgressConflictHandler,
  replayQueuedMutations,
  type QueuedProgress,
} from "../offline-sync";

const USER = "reconcile-user";

function progressEntry(overrides: Partial<QueuedProgress> = {}): QueuedProgress {
  return {
    userId: USER,
    bookId: "book-1",
    deviceId: "device-1",
    deviceSequence: 1,
    positionMs: 5_000,
    playbackRate: 1.5,
    completed: false,
    eventOccurredAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

function conflict409() {
  return new Response(
    JSON.stringify({
      state: {
        positionMs: 9_000,
        completed: false,
        playbackRate: 1,
        eventOccurredAt: "2026-07-09T01:00:00.000Z",
        playbackRateOccurredAt: "2026-07-09T01:01:00.000Z",
        completedOccurredAt: "2026-07-09T00:59:00.000Z",
        stateOccurredAt: "2026-07-09T01:01:00.000Z",
      },
    }),
    { status: 409 },
  );
}

describe("progress 409 with no registered conflict handler", () => {
  it("retains the row until a handler can project the server's state, then settles", async () => {
    const values = new Map<string, string>();
    let blockRegisters = false;
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blockRegisters && key.startsWith("chapterline:playback-")) {
          throw new DOMException("Full", "QuotaExceededError");
        }
        values.set(key, value);
      },
      removeItem: (key: string) => void values.delete(key),
    } as Storage);
    await queueProgress(progressEntry());
    const fetchFn = vi.fn().mockImplementation(async () => conflict409());

    await replayQueuedMutations(USER, fetchFn as typeof fetch);
    expect(await listQueuedMutations(USER)).toHaveLength(1);

    const handler = vi.fn().mockResolvedValue(undefined);
    registerProgressConflictHandler(handler);
    blockRegisters = true;
    await replayQueuedMutations(USER, fetchFn as typeof fetch);
    expect(handler).toHaveBeenCalledWith(USER, "book-1", {
      positionMs: 9_000,
      completed: false,
      playbackRate: 1,
      eventOccurredAt: "2026-07-09T01:00:00.000Z",
      playbackRateOccurredAt: "2026-07-09T01:01:00.000Z",
      completedOccurredAt: "2026-07-09T00:59:00.000Z",
      stateOccurredAt: "2026-07-09T01:01:00.000Z",
    });
    expect(await listQueuedMutations(USER)).toHaveLength(0);
    expect(await listProgressNormalizations(USER)).toHaveLength(1);

    blockRegisters = false;
    await expect(applyPendingProgressNormalizations(USER, "book-1")).resolves.toBe(0);
    expect(await listProgressNormalizations(USER)).toStrictEqual([]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
