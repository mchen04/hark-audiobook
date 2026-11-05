// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerBook } from "@/domain/player";
import { bootstrapPlaybackState, readLocalProgress } from "@/lib/playback-core";
import { mergeProgressFields } from "@/server/playback/progress-policy";

const {
  commitProgress,
  mirrorProgress,
  reconcileProgressConflict,
  replayQueuedMutations,
  reserveDeviceSequenceAbove,
} = vi.hoisted(() => ({
  commitProgress: vi.fn(),
  mirrorProgress: vi.fn(),
  reconcileProgressConflict: vi.fn(),
  replayQueuedMutations: vi.fn(),
  reserveDeviceSequenceAbove: vi.fn(),
}));

vi.mock("@/lib/offline/outbox", () => ({ commitProgress, mirrorProgress }));
vi.mock("@/lib/offline-sync", async () => {
  const actual = await vi.importActual<typeof import("@/lib/offline-sync")>("@/lib/offline-sync");
  return {
    ...actual,
    reconcileProgressConflict,
    replayQueuedMutations,
    nextDeviceSequence: vi.fn().mockResolvedValue(1),
    reserveDeviceSequenceAbove,
    withProgressMutationLock: (_bookId: string, run: () => Promise<void>) => run(),
  };
});

import {
  applyPendingProgressNormalizations,
  listProgressNormalizations,
  nextDeviceSequence,
} from "@/lib/offline-sync";

import { useProgressPersistence } from "./use-progress-persistence";

const book: PlayerBook = {
  id: "book-1",
  title: "Test Book",
  author: "Test Author",
  durationMs: 60_000,
  mediaUrl: "/offline-media/test",
  coverUrl: null,
  chapters: [],
  initialPositionMs: 0,
  initialProgressOccurredAt: null,
  initialPlaybackRate: 1,
  completed: false,
};

function mountHook({
  paused = true,
  activeBook = book,
  currentTime = 12,
  playbackRate = 1,
}: {
  paused?: boolean;
  activeBook?: PlayerBook;
  currentTime?: number;
  playbackRate?: number;
} = {}) {
  const audio = {
    currentTime,
    playbackRate,
    paused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLAudioElement;
  const audioRef = { current: audio };
  const activeBookRef = { current: activeBook };
  const { result } = renderHook(() => useProgressPersistence("user-a", audioRef, activeBookRef));
  result.current.markInProgress();
  return result;
}

function respondWith(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(status === 204 ? null : "{}", { status })),
  );
}

describe("the server half of a progress write", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as Storage);
    vi.stubGlobal("crypto", { randomUUID: () => "device-1" } as Crypto);
    commitProgress.mockReset().mockResolvedValue(undefined);
    mirrorProgress.mockReset().mockResolvedValue(undefined);
    reconcileProgressConflict.mockReset().mockResolvedValue(undefined);
    replayQueuedMutations.mockReset().mockResolvedValue(undefined);
    reserveDeviceSequenceAbove.mockReset().mockResolvedValue(7);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("projects an accepted write to the shelf and journals nothing", async () => {
    respondWith(200);
    const result = mountHook();
    await result.current.persistProgress("pause", 12_000);
    expect(mirrorProgress).toHaveBeenCalledOnce();
    expect(commitProgress).not.toHaveBeenCalled();
  });

  it("journals a fresh sequence when a duplicate response skipped the live write", async () => {
    const fetchMock = vi.fn(async () => {
      return Response.json({
        kind: "duplicate",
        lastSequence: 6,
        state: {
          positionMs: 0,
          playbackRate: "1.00",
          completed: false,
          deviceId: "device-1",
          deviceSequence: 6,
          eventOccurredAt: "2026-07-09T00:00:00.000Z",
          playbackRateOccurredAt: "2026-07-09T00:00:00.000Z",
          completedOccurredAt: "2026-07-09T00:00:00.000Z",
          stateOccurredAt: "2026-07-09T00:00:00.000Z",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = mountHook();

    await result.current.persistProgress("pause", 12_000);

    expect(reserveDeviceSequenceAbove).toHaveBeenCalledWith("book-1", 6, "user-a");
    expect(commitProgress).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: "book-1", deviceSequence: 7, positionMs: 12_000 }),
    );
    expect(mirrorProgress).not.toHaveBeenCalled();
  });

  it("records pending normalization without requeueing an accepted live write", async () => {
    const values = new Map<string, string>();
    let blockAuthoritativeRegisters = false;
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blockAuthoritativeRegisters && key.startsWith("chapterline:playback-")) {
          throw new DOMException("Full", "QuotaExceededError");
        }
        values.set(key, value);
      },
      removeItem: (key: string) => void values.delete(key),
    } as Storage);
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      blockAuthoritativeRegisters = true;
      return Response.json({
        kind: "saved",
        state: { ...body, playbackRate: String(body.playbackRate) },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = mountHook();

    await result.current.persistProgress("pause", 12_000);

    expect(commitProgress).not.toHaveBeenCalled();
    expect(mirrorProgress).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: "book-1", positionMs: 12_000 }),
    );
    expect(await listProgressNormalizations("user-a")).toHaveLength(1);

    blockAuthoritativeRegisters = false;
    await expect(applyPendingProgressNormalizations("user-a", "book-1")).resolves.toBe(0);
    expect(await listProgressNormalizations("user-a")).toStrictEqual([]);
  });

  it("journals a retryable rejection and projects nothing", async () => {
    respondWith(503);
    const result = mountHook();
    await result.current.persistProgress("pause", 12_000);
    expect(commitProgress).toHaveBeenCalledOnce();
    expect(mirrorProgress).not.toHaveBeenCalled();
  });

  for (const status of [404, 410, 413, 422]) {
    it(`neither projects nor journals a permanently refused write (${status})`, async () => {
      respondWith(status);
      const result = mountHook();
      await result.current.persistProgress("pause", 12_000);
      expect(
        mirrorProgress,
        `a ${status} is a refusal; mirroring it tells this device's shelf the server holds a ` +
          "position it rejected",
      ).not.toHaveBeenCalled();
      expect(
        commitProgress,
        `a ${status} will be refused again on every replay, so journalling it queues a write ` +
          "that can never drain",
      ).not.toHaveBeenCalled();
    });
  }

  it("retains a v2 event when a predecessor server rejects its new clock keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = mountHook();

    await result.current.persistProgress("pause", 12_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      playbackRateOccurredAt: expect.any(String),
      completedOccurredAt: expect.any(String),
    });
    expect(commitProgress).toHaveBeenCalledOnce();
    expect(mirrorProgress).not.toHaveBeenCalled();
  });

  it("journals a write that never reached a server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));
    const result = mountHook();
    await result.current.persistProgress("pause", 12_000);
    expect(commitProgress).toHaveBeenCalledOnce();
    expect(mirrorProgress).not.toHaveBeenCalled();
  });

  it("does not journal an accepted write when the local projection is what failed", async () => {
    respondWith(200);
    mirrorProgress.mockRejectedValue(new Error("QuotaExceededError"));
    const result = mountHook();
    await result.current.persistProgress("pause", 12_000);
    expect(mirrorProgress).toHaveBeenCalledOnce();
    expect(
      commitProgress,
      "the server accepted this write; a failure to project it locally is not an unsent intent",
    ).not.toHaveBeenCalled();
  });

  it("does not retry the outbox write that just failed", async () => {
    respondWith(503);
    commitProgress.mockRejectedValue(new Error("QuotaExceededError"));
    const result = mountHook();
    await result.current.persistProgress("pause", 12_000);
    expect(commitProgress).toHaveBeenCalledOnce();
  });

  it("never rejects, whatever the storage layer does", async () => {
    respondWith(200);
    vi.mocked(nextDeviceSequence).mockRejectedValueOnce(new Error("InvalidStateError"));
    const result = mountHook();
    await expect(result.current.persistProgress("pause", 12_000)).resolves.toBeUndefined();
  });

  it("still writes the durable local position when the server half throws", async () => {
    respondWith(200);
    vi.mocked(nextDeviceSequence).mockRejectedValueOnce(new Error("InvalidStateError"));
    const result = mountHook();
    await result.current.persistProgress("pause", 12_000);
    expect(JSON.parse(localStorage.getItem("chapterline:position:user-a:book-1")!)).toMatchObject({
      positionMs: 12_000,
    });
  });

  it("keeps a rate-only write from claiming a newer position clock", async () => {
    const positionOccurredAt = "2026-07-09T19:58:00.000Z";
    const rateBook: PlayerBook = {
      ...book,
      initialPositionMs: 12_000,
      initialProgressOccurredAt: positionOccurredAt,
      initialPlaybackRate: 0.75,
      initialPlaybackRateOccurredAt: positionOccurredAt,
      initialCompletedOccurredAt: positionOccurredAt,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const bootstrap = bootstrapPlaybackState("user-a", rateBook);

    const result = mountHook({ activeBook: bootstrap.book });
    await result.current.persistProgress("rate-change", 12_000);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.eventOccurredAt).toBe(positionOccurredAt);
    expect(Date.parse(body.playbackRateOccurredAt)).toBeGreaterThan(Date.parse(positionOccurredAt));
    expect(body.completedOccurredAt).toBe(positionOccurredAt);
    expect(body.stateOccurredAt).toBe(body.playbackRateOccurredAt);
  });

  it("does not persist smart rewind when the only action is changing rate", async () => {
    const positionClock = "2026-07-09T20:00:05.000Z";
    const rateClock = "2026-07-09T20:00:30.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const storedBook: PlayerBook = {
        ...book,
        initialPositionMs: 60_000,
        initialProgressOccurredAt: positionClock,
        initialPlaybackRate: 1,
        initialPlaybackRateOccurredAt: positionClock,
        initialCompletedOccurredAt: positionClock,
      };
      const bootstrap = bootstrapPlaybackState("user-a", storedBook);
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = mountHook({
        activeBook: bootstrap.book,
        currentTime: 45,
        playbackRate: 2,
      });

      vi.setSystemTime(new Date(rateClock));
      await result.current.persistProgress("rate-change", 45_000);
      await result.current.persistProgress("pagehide-flush", 45_000);
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        positionMs: 60_000,
        positionAtWrite: 45_000,
        source: "pagehide-flush",
      });
      await result.current.persistProgress("media-tick", 50_000);

      const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
      expect(bodies).toHaveLength(3);
      expect(bodies[0]).toMatchObject({
        positionMs: 60_000,
        eventOccurredAt: positionClock,
        playbackRate: 2,
        playbackRateOccurredAt: rateClock,
      });
      expect(bodies[1]).toMatchObject({ positionMs: 60_000, eventOccurredAt: positionClock });
      expect(bodies[2]).toMatchObject({ positionMs: 60_000, eventOccurredAt: positionClock });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        positionMs: 60_000,
        occurredAt: Date.parse(positionClock),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an explicit seek intentionally move backward through the rewind floor", async () => {
    const positionClock = "2026-07-09T20:00:05.000Z";
    const seekClock = "2026-07-09T20:00:30.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(seekClock));
      const storedBook: PlayerBook = {
        ...book,
        initialPositionMs: 60_000,
        initialProgressOccurredAt: positionClock,
        initialPlaybackRateOccurredAt: positionClock,
        initialCompletedOccurredAt: positionClock,
      };
      const bootstrap = bootstrapPlaybackState("user-a", storedBook);
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = mountHook({ activeBook: bootstrap.book, currentTime: 45 });

      await result.current.persistProgress("seek", 45_000);

      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        positionMs: 45_000,
        eventOccurredAt: seekClock,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("mints changed field clocks monotonically when the device clock moved backward", async () => {
    const futureClock = "2026-07-09T20:01:00.000Z";
    const deviceNow = "2026-07-09T20:00:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(deviceNow));
      const futureBook: PlayerBook = {
        ...book,
        initialPositionMs: 60_000,
        initialProgressOccurredAt: futureClock,
        initialPlaybackRate: 1,
        initialPlaybackRateOccurredAt: futureClock,
        initialCompletedOccurredAt: futureClock,
      };
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = mountHook({ activeBook: futureBook, currentTime: 60, playbackRate: 2 });

      await result.current.persistProgress("rate-change", 60_000);
      await result.current.persistProgress("seek", 45_000);
      await result.current.persistProgress("ended", 60_000, true);

      const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
      expect(bodies[0]).toMatchObject({
        eventOccurredAt: futureClock,
        playbackRateOccurredAt: "2026-07-09T20:01:00.001Z",
        completedOccurredAt: futureClock,
      });
      expect(bodies[1]).toMatchObject({
        eventOccurredAt: "2026-07-09T20:01:00.001Z",
        playbackRateOccurredAt: "2026-07-09T20:01:00.001Z",
        completedOccurredAt: futureClock,
      });
      expect(bodies[2]).toMatchObject({
        eventOccurredAt: "2026-07-09T20:01:00.002Z",
        playbackRateOccurredAt: "2026-07-09T20:01:00.001Z",
        completedOccurredAt: "2026-07-09T20:01:00.001Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not adopt a peer position as this tab's causal baseline", async () => {
    const staleClock = "2026-07-09T20:00:05.000Z";
    const peerPositionClock = "2026-07-09T20:00:20.000Z";
    const rateClock = "2026-07-09T20:00:30.000Z";
    const flushClock = "2026-07-09T20:00:40.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      localStorage.setItem(
        "chapterline:playback-position:user-a:book-1:peer-b",
        JSON.stringify({ value: 100_000, occurredAt: Date.parse(peerPositionClock) }),
      );
      const staleBook: PlayerBook = {
        ...book,
        initialPositionMs: 0,
        initialProgressOccurredAt: staleClock,
        initialPlaybackRate: 1,
        initialPlaybackRateOccurredAt: staleClock,
        initialCompletedOccurredAt: staleClock,
      };
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = mountHook({ activeBook: staleBook, currentTime: 0, playbackRate: 2 });

      vi.setSystemTime(new Date(rateClock));
      await result.current.persistProgress("rate-change", 0);
      vi.setSystemTime(new Date(flushClock));
      await result.current.persistProgress("pagehide-flush", 0);

      const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toMatchObject({
        positionMs: 100_000,
        eventOccurredAt: peerPositionClock,
        playbackRate: 2,
        playbackRateOccurredAt: rateClock,
      });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        positionMs: 100_000,
        occurredAt: Date.parse(peerPositionClock),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a cold stale device advance position without overwriting newer remote fields", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const staleClock = "2026-07-09T19:58:00.000Z";
      const remoteClock = "2026-07-09T19:59:00.000Z";
      const listenClock = "2026-07-09T20:00:00.000Z";
      vi.setSystemTime(new Date(listenClock));
      const staleBook: PlayerBook = {
        ...book,
        initialPositionMs: 5_000,
        initialProgressOccurredAt: staleClock,
        initialPlaybackRate: 1,
        initialPlaybackRateOccurredAt: staleClock,
        completed: false,
        initialCompletedOccurredAt: staleClock,
      };
      const bootstrap = bootstrapPlaybackState("user-a", staleBook);
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const result = mountHook({ activeBook: bootstrap.book });
      await result.current.persistProgress("media-tick", 12_000);
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

      expect(body).toMatchObject({
        eventOccurredAt: listenClock,
        playbackRateOccurredAt: staleClock,
        completedOccurredAt: staleClock,
      });

      const merge = mergeProgressFields(
        {
          positionMs: 10_000,
          playbackRate: 2,
          completed: true,
          eventOccurredAt: new Date(remoteClock),
          playbackRateOccurredAt: new Date(remoteClock),
          completedOccurredAt: new Date(remoteClock),
        },
        {
          positionMs: body.positionMs,
          playbackRate: body.playbackRate,
          completed: body.completed,
          eventOccurredAt: new Date(body.eventOccurredAt),
          playbackRateOccurredAt: new Date(body.playbackRateOccurredAt),
          completedOccurredAt: new Date(body.completedOccurredAt),
          stateOccurredAt: new Date(body.stateOccurredAt),
        },
        new Date(listenClock),
        book.durationMs,
      );

      expect(merge.merged).toMatchObject({
        positionMs: 12_000,
        playbackRate: 2,
        completed: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps bootstrap field clocks even when localStorage rejects the hydration write", async () => {
    const staleClock = "2026-07-09T19:58:00.000Z";
    const listenClock = "2026-07-09T20:00:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(listenClock));
      vi.stubGlobal("localStorage", {
        get length() {
          return 0;
        },
        key: () => null,
        getItem: () => null,
        setItem: () => {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        },
        removeItem: () => undefined,
      } as unknown as Storage);
      const staleBook: PlayerBook = {
        ...book,
        initialPositionMs: 5_000,
        initialProgressOccurredAt: staleClock,
        initialPlaybackRateOccurredAt: staleClock,
        initialCompletedOccurredAt: staleClock,
      };
      const bootstrap = bootstrapPlaybackState("user-a", staleBook);
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const result = mountHook({ activeBook: bootstrap.book });
      await result.current.persistProgress("media-tick", 12_000);
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

      expect(body).toMatchObject({
        eventOccurredAt: listenClock,
        playbackRateOccurredAt: staleClock,
        completedOccurredAt: staleClock,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not mint a position clock when the first action only changes rate", async () => {
    const remoteClock = "2026-07-09T19:59:00.000Z";
    const rateClock = "2026-07-09T20:00:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(rateClock));
      const untouchedBook: PlayerBook = {
        ...book,
        initialPositionMs: 0,
        initialProgressOccurredAt: null,
        initialPlaybackRate: 0.75,
        initialPlaybackRateOccurredAt: null,
        completed: false,
        initialCompletedOccurredAt: null,
      };
      const bootstrap = bootstrapPlaybackState("user-a", untouchedBook);
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const result = mountHook({
        activeBook: bootstrap.book,
        currentTime: 0,
        playbackRate: 1,
      });
      await result.current.persistProgress("rate-change", 0);
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

      expect(body).toMatchObject({
        eventOccurredAt: "1970-01-01T00:00:00.000Z",
        playbackRateOccurredAt: rateClock,
        completedOccurredAt: "1970-01-01T00:00:00.000Z",
      });

      const merge = mergeProgressFields(
        {
          positionMs: 45_000,
          playbackRate: 0.75,
          completed: false,
          eventOccurredAt: new Date(remoteClock),
          playbackRateOccurredAt: new Date(0),
          completedOccurredAt: new Date(0),
        },
        {
          positionMs: body.positionMs,
          playbackRate: body.playbackRate,
          completed: body.completed,
          eventOccurredAt: new Date(body.eventOccurredAt),
          playbackRateOccurredAt: new Date(body.playbackRateOccurredAt),
          completedOccurredAt: new Date(body.completedOccurredAt),
          stateOccurredAt: new Date(body.stateOccurredAt),
        },
        new Date(rateClock),
        book.durationMs,
      );

      expect(merge.merged).toMatchObject({
        positionMs: 45_000,
        playbackRate: 1,
        completed: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the durable cadence, with two sources", () => {
  const KEY = "chapterline:position:user-a:book-1";
  const INTERVAL_MS = 200;

  class FakeAudio extends EventTarget {
    currentTime = 12;
    playbackRate = 1;
    paused = true;
  }

  let writes: number[];
  let records: Array<{ positionMs: number; source?: string }>;
  const sources = () => records.map((record) => record.source);

  beforeEach(() => {
    writes = [];
    records = [];
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === KEY) {
          const record = JSON.parse(value) as { positionMs: number; source?: string };
          writes.push(record.positionMs);
          records.push(record);
        }
        store.set(key, value);
      },
      removeItem: (key: string) => void store.delete(key),
    } as Storage);
    vi.stubGlobal("crypto", { randomUUID: () => "device-1" } as Crypto);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    replayQueuedMutations.mockReset().mockResolvedValue(undefined);
    mirrorProgress.mockReset().mockResolvedValue(undefined);
    commitProgress.mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function playing() {
    const audio = new FakeAudio();
    const audioRef = { current: audio as unknown as HTMLAudioElement };
    const activeBookRef = { current: book };
    const { result, unmount } = renderHook(() =>
      useProgressPersistence("user-a", audioRef, activeBookRef),
    );
    result.current.markInProgress();
    audio.paused = false;
    audio.dispatchEvent(new Event("play"));
    return { audio, result, unmount };
  }

  function listen(
    audio: FakeAudio,
    result: { current: { onListeningTick: (positionMs: number) => void } },
    { ms, tickMs }: { ms: number; tickMs: number | null },
  ) {
    const step = 10;
    let sinceTick = 0;
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      vi.advanceTimersByTime(step);
      audio.currentTime += step / 1000;
      if (tickMs === null) continue;
      sinceTick += step;
      if (sinceTick < tickMs) continue;
      sinceTick = 0;
      if (!audio.paused) result.current.onListeningTick(audio.currentTime * 1000);
    }
  }

  it("keeps writing with no timeupdate at all", () => {
    const { audio, result, unmount } = playing();
    listen(audio, result, { ms: 2_000, tickMs: null });
    expect(writes.length, "the timer alone wrote nothing over two seconds").toBeGreaterThanOrEqual(
      9,
    );
    expect(writes.at(-1)).toBeGreaterThan(writes[0]!);
    unmount();
  });

  it("keeps writing with the timer frozen", () => {
    const frozen = vi.spyOn(window, "setTimeout").mockImplementation(() => 0 as never);
    const { audio, result, unmount } = playing();
    listen(audio, result, { ms: 2_000, tickMs: 250 });
    frozen.mockRestore();
    expect(
      writes.length,
      "with the timer dead the timeupdate tick wrote nothing, so a backgrounded listening " +
        "session would record no position at all",
    ).toBeGreaterThanOrEqual(7);
    expect(writes.at(-1)).toBeGreaterThan(writes[0]!);
    unmount();
  });

  it("does not amplify the write rate when both sources are alive", () => {
    const { audio, result, unmount } = playing();
    listen(audio, result, { ms: 4_000, tickMs: 16 });
    const ceiling = 4_000 / INTERVAL_MS + 1;
    expect(
      writes.length,
      `${writes.length} durable writes in 4s with a 60Hz tick and a ${INTERVAL_MS}ms timer; the ` +
        `shared gate caps this at ${ceiling}`,
    ).toBeLessThanOrEqual(ceiling);
    expect(writes.length, "the cadence stopped being met").toBeGreaterThanOrEqual(18);
    unmount();
  });

  it("an out-of-band write must not stretch the cadence to two intervals", () => {
    const { audio, result, unmount } = playing();
    const at: number[] = [];
    const store = localStorage.setItem.bind(localStorage);
    vi.stubGlobal("localStorage", {
      ...localStorage,
      setItem: (key: string, value: string) => {
        if (key === KEY) at.push(Date.now());
        store(key, value);
      },
    } as unknown as Storage);

    listen(audio, result, { ms: 1_000, tickMs: null });
    vi.advanceTimersByTime(90);
    result.current.saveDurableState("visibility-flush", audio.currentTime * 1000);
    listen(audio, result, { ms: 2_000, tickMs: null });

    const gaps = at.slice(1).map((value, index) => value - at[index]!);
    expect(gaps.length, "not enough writes to measure a gap").toBeGreaterThan(8);
    expect(
      Math.max(...gaps),
      `the longest gap between two durable writes was ${Math.max(...gaps)}ms after an out-of-band ` +
        `write landed mid-interval (gaps ${JSON.stringify(gaps)}). The cadence is ${INTERVAL_MS}ms ` +
        "and every bar in `tests/resume` is stated as one interval, so a write that closes the " +
        "gate must delay the next cadence write to when it is DUE, not to a full interval after " +
        "the turn it refused.",
    ).toBeLessThanOrEqual(INTERVAL_MS + 20);
    unmount();
  });

  it("writes nothing at all while the element is paused", () => {
    const { audio, result, unmount } = playing();
    listen(audio, result, { ms: 1_000, tickMs: 250 });
    const whilePlaying = writes.length;
    expect(whilePlaying).toBeGreaterThan(0);

    audio.paused = true;
    audio.dispatchEvent(new Event("pause"));
    writes.length = 0;
    listen(audio, result, { ms: 5_000, tickMs: 250 });
    result.current.onListeningTick(99_000);
    expect(
      writes,
      "a paused player wrote its position, so the write rate is not zero at rest",
    ).toStrictEqual([]);
    unmount();
  });

  it("signs a tick-driven write as the media pipeline and a timer-driven one as the timer", () => {
    const { audio, result, unmount } = playing();

    result.current.onListeningTick(audio.currentTime * 1000);
    const fromTick = records.length;
    expect(fromTick).toBeGreaterThan(0);
    expect(
      new Set(sources()),
      "a write the media pipeline produced is not signed `media-tick`, so a phone whose timer " +
        "had been suspended could not tell that the tick was what kept the position current",
    ).toStrictEqual(new Set(["media-tick"]));

    vi.advanceTimersByTime(INTERVAL_MS * 2);
    expect(records.length).toBeGreaterThan(fromTick);
    expect(
      new Set(sources().slice(fromTick)),
      "the timer's writes are being attributed to another writer, so a phone that had suspended " +
        "`timeupdate` would still report the tick as alive",
    ).toStrictEqual(new Set(["cadence-timer"]));
    unmount();
  });

  it("writes nothing once the active book is gone", () => {
    const audio = new FakeAudio();
    const audioRef = { current: audio as unknown as HTMLAudioElement };
    const activeBookRef: { current: PlayerBook | null } = { current: book };
    const { result, unmount } = renderHook(() =>
      useProgressPersistence("user-a", audioRef, activeBookRef),
    );
    result.current.markInProgress();
    audio.paused = false;
    audio.dispatchEvent(new Event("play"));
    activeBookRef.current = null;
    writes.length = 0;
    listen(audio, result, { ms: 2_000, tickMs: 250 });
    expect(writes).toStrictEqual([]);
    unmount();
  });
});

describe("the provenance of a lifecycle write", () => {
  const KEY = "chapterline:position:user-a:book-1";

  beforeEach(() => {
    cleanup();
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as Storage);
    vi.stubGlobal("crypto", { randomUUID: () => "device-1" } as Crypto);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    commitProgress.mockReset().mockResolvedValue(undefined);
    mirrorProgress.mockReset().mockResolvedValue(undefined);
    replayQueuedMutations.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const storedSource = () => (JSON.parse(localStorage.getItem(KEY)!) as { source?: string }).source;

  it("signs the hidden edge as the visibility flush", () => {
    mountHook();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden" as DocumentVisibilityState);
    document.dispatchEvent(new Event("visibilitychange"));
    visibility.mockRestore();
    expect(storedSource()).toBe("visibility-flush");
  });

  it("signs a terminal pagehide apart from a backgrounding", () => {
    mountHook();
    window.dispatchEvent(new Event("pagehide"));
    expect(
      storedSource(),
      "the two lifecycle edges write the same source, so the readout cannot distinguish a page " +
        "that was backgrounded from one that was torn down",
    ).toBe("pagehide-flush");
  });

  it("carries a caller's mechanism through to the record unchanged", async () => {
    for (const source of ["pause", "seek", "ended", "rate-change", "book-unload"] as const) {
      cleanup();
      const keys = Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index),
      ).filter((key): key is string => !!key);
      keys.forEach((key) => localStorage.removeItem(key));
      const bootstrap = bootstrapPlaybackState("user-a", book);
      const result = mountHook({ activeBook: bootstrap.book });
      await result.current.persistProgress(source, 12_000);
      expect(storedSource()).toBe(source);
    }
  });

  const storedLiveness = () =>
    (JSON.parse(localStorage.getItem(KEY)!) as { playingAtWrite?: boolean }).playingAtWrite;

  it("records that the hidden edge caught a live listening session", () => {
    mountHook({ paused: false });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden" as DocumentVisibilityState);
    document.dispatchEvent(new Event("visibilitychange"));
    visibility.mockRestore();
    expect(storedSource()).toBe("visibility-flush");
    expect(
      storedLiveness(),
      "the hide-edge write does not record that audio was playing, so a suspended listening " +
        "session is indistinguishable from a book backgrounded while paused and no lost " +
        "stretch can ever be detected",
    ).toBe(true);
  });

  it("records nothing of the sort for a hide edge taken while paused", () => {
    mountHook({ paused: true });
    window.dispatchEvent(new Event("pagehide"));
    expect(storedSource()).toBe("pagehide-flush");
    expect(
      storedLiveness(),
      "a hide edge taken while the book was PAUSED claims audio was live, which would offer to " +
        "move the user forward over content that never played",
    ).toBeUndefined();
  });
});
