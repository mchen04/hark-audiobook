import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerBook, PlayerChapter } from "@/domain/player";

import {
  applyAuthoritativePlaybackState,
  applyAuthoritativePlaybackStateWithStatus,
  bootstrapPlaybackState,
  clearLocalPlaybackState,
  detectSuspendedSession,
  dismissSuspensionGap,
  freshestPosition,
  isChapterEnding,
  localWinsOver,
  markPausedNow,
  readDismissedSuspensionGap,
  readLatestLocalPlayback,
  readLocalPosition,
  readLocalProgress,
  readMsSinceLastPause,
  resolveStartPosition,
  rewindForAbsence,
  saveLocalPlaybackState,
  saveLocalPosition,
  selectCurrentChapter,
  SUSPENSION_GAP_FLOOR_MS,
  type LocalPosition,
} from "./playback-core";

const serverBook: PlayerBook = {
  id: "book-1",
  title: "Test Book",
  author: "Test Author",
  durationMs: 600_000,
  mediaUrl: "/media/book-1",
  coverUrl: null,
  chapters: [],
  initialPositionMs: 60_000,
  initialProgressOccurredAt: "2026-07-09T20:05:00.000Z",
  initialPlaybackRate: 1,
  initialPlaybackRateOccurredAt: "2026-07-09T20:04:00.000Z",
  completed: true,
  initialCompletedOccurredAt: "2026-07-09T20:05:00.000Z",
};

const chapters: PlayerChapter[] = [
  { id: "a", position: 0, title: "One", startMs: 0, endMs: 20_000 },
  { id: "b", position: 1, title: "Two", startMs: 20_000, endMs: 40_000 },
  { id: "c", position: 2, title: "Three", startMs: 40_000, endMs: 60_000 },
];

describe("selectCurrentChapter", () => {
  it("picks the containing chapter and treats boundaries as the next chapter", () => {
    expect(selectCurrentChapter(chapters, 0)?.id).toBe("a");
    expect(selectCurrentChapter(chapters, 19_999)?.id).toBe("a");
    expect(selectCurrentChapter(chapters, 20_000)?.id).toBe("b");
  });

  it("keeps the final chapter for the sliver past its end", () => {
    expect(selectCurrentChapter(chapters, 60_000)?.id).toBe("c");
    expect(selectCurrentChapter(chapters, 60_029)?.id).toBe("c");
  });

  it("returns null before any chapter or with no chapters", () => {
    expect(selectCurrentChapter([], 5_000)).toBeNull();
    expect(selectCurrentChapter([{ ...chapters[1]! }], 1_000)).toBeNull();
  });
});

describe("rewindForAbsence", () => {
  it("scales with time away and handles junk", () => {
    expect(rewindForAbsence(30_000)).toBe(0);
    expect(rewindForAbsence(5 * 60_000)).toBe(5_000);
    expect(rewindForAbsence(30 * 60_000)).toBe(15_000);
    expect(rewindForAbsence(24 * 3_600_000)).toBe(30_000);
    expect(rewindForAbsence(Number.NaN)).toBe(0);
  });
});

describe("resolveStartPosition", () => {
  it("restarts a book stored at its very end", () => {
    expect(
      resolveStartPosition({
        storedPositionMs: 60_000,
        durationMs: 60_056,
        smartRewindEnabled: true,
        msSinceLastPause: 3_600_000,
      }),
    ).toEqual({ startAtMs: 0, appliedRewindMs: 0 });
  });

  it("applies bounded smart rewind mid-book", () => {
    expect(
      resolveStartPosition({
        storedPositionMs: 30_000,
        durationMs: 60_000,
        smartRewindEnabled: true,
        msSinceLastPause: 5 * 60_000,
      }),
    ).toEqual({ startAtMs: 25_000, appliedRewindMs: 5_000 });
  });

  it("skips rewind when disabled or unprimed and never goes negative", () => {
    expect(
      resolveStartPosition({
        storedPositionMs: 30_000,
        durationMs: 60_000,
        smartRewindEnabled: false,
        msSinceLastPause: 3_600_000,
      }).startAtMs,
    ).toBe(30_000);
    expect(
      resolveStartPosition({
        storedPositionMs: 30_000,
        durationMs: 60_000,
        smartRewindEnabled: true,
        msSinceLastPause: null,
      }).startAtMs,
    ).toBe(30_000);
    expect(
      resolveStartPosition({
        storedPositionMs: 2_000,
        durationMs: 60_000,
        smartRewindEnabled: true,
        msSinceLastPause: 5 * 60_000,
      }).startAtMs,
    ).toBe(0);
  });
});

describe("isChapterEnding", () => {
  it("fires only inside the epsilon window", () => {
    expect(isChapterEnding(chapters[0]!, 19_700)).toBe(true);
    expect(isChapterEnding(chapters[0]!, 19_000)).toBe(false);
  });
});

describe("local playback state", () => {
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
  });

  it("round-trips positions per user and rejects junk", () => {
    saveLocalPosition("user-a", "book-1", 1234.6, 2_000);
    expect(readLocalPosition("user-a", "book-1")).toBe(1235);
    expect(readLocalPosition("user-b", "book-1")).toBeNull();
    localStorage.setItem("chapterline:position:user-a:book-1", "not-a-number");
    expect(
      readLocalPosition("user-a", "book-1"),
      "the independent position register survives a corrupted legacy snapshot",
    ).toBe(1235);
    localStorage.setItem("chapterline:position:user-c:book-1", "not-a-number");
    expect(readLocalPosition("user-c", "book-1")).toBeNull();
  });

  it("uses the freshest timestamped position and treats legacy local values as oldest", () => {
    expect(
      freshestPosition({
        local: { positionMs: 1_000, occurredAt: 2_000 },
        serverPositionMs: 8_000,
        serverOccurredAt: new Date(3_000).toISOString(),
      }),
    ).toBe(8_000);
    expect(
      freshestPosition({
        local: { positionMs: 9_000, occurredAt: 4_000 },
        serverPositionMs: 8_000,
        serverOccurredAt: new Date(3_000).toISOString(),
      }),
    ).toBe(9_000);
    localStorage.setItem("chapterline:position:user-a:book-1", "7000");
    expect(
      freshestPosition({
        local: { positionMs: readLocalPosition("user-a", "book-1")!, occurredAt: 0 },
        serverPositionMs: 8_000,
        serverOccurredAt: new Date(3_000).toISOString(),
      }),
    ).toBe(8_000);
  });

  it("hydrates a cold device with the server's field clocks instead of minting new ones", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-09T20:10:00.000Z"));
      const bootstrap = bootstrapPlaybackState("user-a", serverBook);

      expect(bootstrap.book).toMatchObject(serverBook);
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        positionMs: 60_000,
        occurredAt: Date.parse("2026-07-09T20:05:00.000Z"),
        playbackRate: 1,
        playbackRateOccurredAt: Date.parse("2026-07-09T20:04:00.000Z"),
        completed: true,
        completedOccurredAt: Date.parse("2026-07-09T20:05:00.000Z"),
        source: "player-bootstrap",
      });

      vi.setSystemTime(new Date("2026-07-09T20:11:00.000Z"));
      saveLocalPlaybackState("user-a", "book-1", {
        positionMs: 61_000,
        playbackRate: 1,
        completed: true,
        source: "media-tick",
      });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        occurredAt: Date.parse("2026-07-09T20:11:00.000Z"),
        playbackRateOccurredAt: Date.parse("2026-07-09T20:04:00.000Z"),
        completedOccurredAt: Date.parse("2026-07-09T20:05:00.000Z"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("chooses position, rate, and completion independently during bootstrap", () => {
    localStorage.setItem(
      "chapterline:position:user-a:book-1",
      JSON.stringify({
        positionMs: 15_000,
        occurredAt: Date.parse("2026-07-09T20:01:00.000Z"),
        playbackRate: 2,
        playbackRateOccurredAt: Date.parse("2026-07-09T20:06:00.000Z"),
        completed: false,
        completedOccurredAt: Date.parse("2026-07-09T20:01:00.000Z"),
      }),
    );

    const bootstrap = bootstrapPlaybackState("user-a", serverBook);

    expect(bootstrap.book).toMatchObject({
      initialPositionMs: 60_000,
      initialProgressOccurredAt: "2026-07-09T20:05:00.000Z",
      initialPlaybackRate: 2,
      initialPlaybackRateOccurredAt: "2026-07-09T20:06:00.000Z",
      completed: true,
      initialCompletedOccurredAt: "2026-07-09T20:05:00.000Z",
    });
  });

  it("uses the canonical server tuple to break equal-clock register ties", () => {
    const clock = Date.parse("2026-07-09T20:05:00.000Z");
    const rateClock = Date.parse("2026-07-09T20:04:00.000Z");
    localStorage.setItem(
      "chapterline:position:user-a:book-1",
      JSON.stringify({
        positionMs: 15_000,
        occurredAt: clock,
        playbackRate: 2,
        playbackRateOccurredAt: rateClock,
        completed: false,
        completedOccurredAt: clock,
      }),
    );

    expect(
      localWinsOver(
        { positionMs: 15_000, occurredAt: clock },
        serverBook.initialProgressOccurredAt,
      ),
    ).toBe(false);
    expect(bootstrapPlaybackState("user-a", serverBook).book).toMatchObject({
      initialPositionMs: 60_000,
      initialPlaybackRate: 1,
      completed: true,
    });
    expect(readLocalProgress("user-a", "book-1")).toMatchObject({
      positionMs: 60_000,
      occurredAt: clock,
      playbackRate: 1,
      playbackRateOccurredAt: rateClock,
      completed: true,
      completedOccurredAt: clock,
    });
    const rateOnly = saveLocalPlaybackState("user-a", "book-1", {
      positionMs: 60_000,
      occurredAt: clock,
      playbackRate: 2,
      playbackRateOccurredAt: clock + 10_000,
      completed: true,
      completedOccurredAt: clock,
      positionChanged: false,
      playbackRateChanged: true,
      completedChanged: false,
    });
    expect(rateOnly?.occurredAt).toBe(clock);
  });

  it("does not let an old server acknowledgement replace a newer local action", () => {
    saveLocalPlaybackState("user-a", "book-1", {
      positionMs: 120_000,
      occurredAt: 51_000,
      playbackRate: 3,
      playbackRateOccurredAt: 51_000,
      completed: false,
      completedOccurredAt: 51_000,
      positionChanged: true,
      playbackRateChanged: true,
      completedChanged: true,
    });

    applyAuthoritativePlaybackState(
      "user-a",
      "book-1",
      {
        positionMs: 100_000,
        occurredAt: 50_000,
        playbackRate: 2,
        playbackRateOccurredAt: 50_000,
        completed: true,
        completedOccurredAt: 50_000,
      },
      {
        positionMs: 100_000,
        occurredAt: 100_000,
        playbackRate: 2,
        playbackRateOccurredAt: 100_000,
        completed: true,
        completedOccurredAt: 100_000,
      },
    );

    expect(readLocalProgress("user-a", "book-1")).toMatchObject({
      positionMs: 120_000,
      occurredAt: 51_000,
      playbackRate: 3,
      playbackRateOccurredAt: 51_000,
      completed: false,
      completedOccurredAt: 51_000,
    });
  });

  it("preserves a different local action tied with the acknowledged clock", () => {
    saveLocalPlaybackState("user-a", "book-1", {
      positionMs: 120_000,
      occurredAt: 100_000,
      playbackRate: 3,
      playbackRateOccurredAt: 100_000,
      completed: false,
      completedOccurredAt: 100_000,
      positionChanged: true,
      playbackRateChanged: true,
      completedChanged: true,
    });

    applyAuthoritativePlaybackState(
      "user-a",
      "book-1",
      {
        positionMs: 100_000,
        occurredAt: 100_000,
        playbackRate: 2,
        playbackRateOccurredAt: 100_000,
        completed: true,
        completedOccurredAt: 100_000,
      },
      {
        positionMs: 100_000,
        occurredAt: 100_000,
        playbackRate: 2,
        playbackRateOccurredAt: 100_000,
        completed: true,
        completedOccurredAt: 100_000,
      },
    );

    expect(readLocalProgress("user-a", "book-1")).toMatchObject({
      positionMs: 120_000,
      occurredAt: 100_000,
      playbackRate: 3,
      playbackRateOccurredAt: 100_000,
      completed: false,
      completedOccurredAt: 100_000,
    });
  });

  it("keeps normalization primary against a stale tab and a failed snapshot write", () => {
    saveLocalPlaybackState("user-a", "book-1", {
      positionMs: 200_000,
      occurredAt: 100_000,
      playbackRate: 3,
      playbackRateOccurredAt: 100_000,
      completed: true,
      completedOccurredAt: 100_000,
      positionChanged: true,
      playbackRateChanged: true,
      completedChanged: true,
    });
    applyAuthoritativePlaybackState(
      "user-a",
      "book-1",
      {
        positionMs: 100_000,
        occurredAt: 50_000,
        playbackRate: 2,
        playbackRateOccurredAt: 50_000,
        completed: false,
        completedOccurredAt: 50_000,
      },
      {
        positionMs: 200_000,
        occurredAt: 100_000,
        playbackRate: 3,
        playbackRateOccurredAt: 100_000,
        completed: true,
        completedOccurredAt: 100_000,
      },
    );

    saveLocalPlaybackState("user-a", "book-1", {
      positionMs: 200_000,
      occurredAt: 100_000,
      playbackRate: 3,
      playbackRateOccurredAt: 100_000,
      completed: true,
      completedOccurredAt: 100_000,
      positionChanged: false,
      playbackRateChanged: false,
      completedChanged: false,
      source: "pagehide-flush",
    });
    expect(readLocalProgress("user-a", "book-1")).toMatchObject({
      positionMs: 100_000,
      occurredAt: 50_000,
      playbackRate: 2,
      playbackRateOccurredAt: 50_000,
      completed: false,
      completedOccurredAt: 50_000,
    });

    const write = localStorage.setItem.bind(localStorage);
    const setItem = vi.spyOn(localStorage, "setItem");
    setItem.mockImplementation((key, value) => {
      if (key === "chapterline:position:user-a:book-1") {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
    saveLocalPlaybackState("user-a", "book-1", {
      positionMs: 101_000,
      occurredAt: 51_000,
      playbackRate: 2.5,
      playbackRateOccurredAt: 51_000,
      completed: true,
      completedOccurredAt: 51_000,
      positionChanged: true,
      playbackRateChanged: true,
      completedChanged: true,
    });
    expect(readLocalProgress("user-a", "book-1")).toMatchObject({
      positionMs: 101_000,
      occurredAt: 51_000,
      playbackRate: 2.5,
      playbackRateOccurredAt: 51_000,
      completed: true,
      completedOccurredAt: 51_000,
    });
  });

  it("reports a transient authoritative-register write failure until all fields normalize", () => {
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
    const future = 100_000;
    const bounded = 50_000;
    const submitted = {
      positionMs: 200_000,
      occurredAt: future,
      playbackRate: 3,
      playbackRateOccurredAt: future,
      completed: true,
      completedOccurredAt: future,
    };
    const server = {
      positionMs: 100_000,
      occurredAt: bounded,
      playbackRate: 2,
      playbackRateOccurredAt: bounded,
      completed: false,
      completedOccurredAt: bounded,
    };
    saveLocalPlaybackState("user-a", "book-1", {
      ...submitted,
      positionChanged: true,
      playbackRateChanged: true,
      completedChanged: true,
    });

    blockRegisters = true;
    const failed = applyAuthoritativePlaybackStateWithStatus("user-a", "book-1", server, submitted);
    blockRegisters = false;

    expect(failed.persisted).toBe(false);
    expect(readLocalProgress("user-a", "book-1")).toMatchObject({
      positionMs: 200_000,
      occurredAt: future,
      playbackRate: 3,
      playbackRateOccurredAt: future,
      completed: true,
      completedOccurredAt: future,
    });

    const retried = applyAuthoritativePlaybackStateWithStatus(
      "user-a",
      "book-1",
      server,
      submitted,
    );
    expect(retried.persisted).toBe(true);
    expect(readLocalProgress("user-a", "book-1")).toMatchObject({
      positionMs: 100_000,
      occurredAt: bounded,
      playbackRate: 2,
      playbackRateOccurredAt: bounded,
      completed: false,
      completedOccurredAt: bounded,
    });
  });

  it("retains an interleaved position write when a stale tab writes only rate", () => {
    const snapshotKey = "chapterline:position:user-a:book-1";
    const positionPrefix = "chapterline:playback-position:user-a:book-1:";
    const ratePrefix = "chapterline:playback-rate:user-a:book-1:";
    const completedPrefix = "chapterline:playback-completed:user-a:book-1:";
    const store = new Map<string, string>();
    let injectPosition = false;
    const registerWrites: string[] = [];
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        // Tab A has already read the old tuple and decided to persist its rate.
        // Tab B lands a position between that read and A's final snapshot write.
        if (key.startsWith("chapterline:playback-")) registerWrites.push(key);
        if (injectPosition && key.startsWith(ratePrefix)) {
          injectPosition = false;
          store.set(
            `${positionPrefix}peer-b`,
            JSON.stringify({ value: 100_000, occurredAt: 20_000 }),
          );
        }
        store.set(key, value);
      },
      removeItem: (key: string) => void store.delete(key),
    } as Storage);

    saveLocalPlaybackState("user-a", "book-1", {
      positionMs: 0,
      occurredAt: 5_000,
      playbackRate: 1,
      playbackRateOccurredAt: 5_000,
      completed: false,
      completedOccurredAt: 5_000,
    });
    registerWrites.length = 0;
    injectPosition = true;
    saveLocalPlaybackState("user-a", "book-1", {
      positionMs: 0,
      occurredAt: 5_000,
      playbackRate: 2,
      playbackRateOccurredAt: 30_000,
      completed: false,
      completedOccurredAt: 5_000,
      source: "rate-change",
    });

    expect(JSON.parse(store.get(snapshotKey)!)).toMatchObject({
      positionMs: 100_000,
      playbackRate: 2,
    });
    expect(registerWrites).toHaveLength(1);
    expect(registerWrites[0]).toMatch(new RegExp(`^${ratePrefix}`));
    expect(registerWrites.some((key) => key.startsWith(positionPrefix))).toBe(false);
    expect(registerWrites.some((key) => key.startsWith(completedPrefix))).toBe(false);
    expect(readLocalProgress("user-a", "book-1")).toMatchObject({
      positionMs: 100_000,
      occurredAt: 20_000,
      playbackRate: 2,
      playbackRateOccurredAt: 30_000,
      completed: false,
      completedOccurredAt: 5_000,
    });
  });

  it("does not attach one tab's pagehide provenance to another tab's position", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(40_000));
      localStorage.setItem(
        "chapterline:playback-position:user-a:book-1:peer-b",
        JSON.stringify({ value: 100_000, occurredAt: 20_000 }),
      );
      saveLocalPlaybackState("user-a", "book-1", {
        positionMs: 0,
        occurredAt: 5_000,
        playbackRate: 1,
        source: "pagehide-flush",
        playing: true,
        positionChanged: false,
      });

      const joined = readLocalProgress("user-a", "book-1");
      expect(joined).toMatchObject({ positionMs: 100_000, occurredAt: 20_000 });
      expect(joined?.source).toBeUndefined();
      expect(joined?.writtenAt).toBeUndefined();
      expect(joined?.playingAtWrite).toBeUndefined();
      expect(
        detectSuspendedSession({ record: joined, durationMs: 600_000, now: 160_000 }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("strips new provenance when the winning legacy position has no matching register", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(40_000));
      localStorage.setItem(
        "chapterline:position:user-a:book-1",
        JSON.stringify({ positionMs: 100_000, occurredAt: 20_000 }),
      );
      saveLocalPlaybackState("user-a", "book-1", {
        positionMs: 0,
        occurredAt: 5_000,
        source: "pagehide-flush",
        playing: true,
        positionChanged: false,
      });

      const joined = readLocalProgress("user-a", "book-1");
      expect(joined).toMatchObject({ positionMs: 100_000, occurredAt: 20_000 });
      expect(joined?.source).toBeUndefined();
      expect(joined?.writtenAt).toBeUndefined();
      expect(joined?.playingAtWrite).toBeUndefined();
      expect(
        detectSuspendedSession({ record: joined, durationMs: 600_000, now: 160_000 }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects suspension from the hide-edge writer's rate and completion", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(5_000));
      saveLocalPlaybackState("user-a", "book-1", {
        positionMs: 0,
        occurredAt: 5_000,
        playbackRate: 1,
        playbackRateOccurredAt: 5_000,
        completed: false,
        completedOccurredAt: 5_000,
        hydrate: true,
      });
      localStorage.setItem(
        "chapterline:playback-rate:user-a:book-1:peer-b",
        JSON.stringify({ value: 3, occurredAt: 20_000 }),
      );
      localStorage.setItem(
        "chapterline:playback-completed:user-a:book-1:peer-b",
        JSON.stringify({ value: true, occurredAt: 20_000 }),
      );

      vi.setSystemTime(new Date(40_000));
      saveLocalPlaybackState("user-a", "book-1", {
        positionMs: 0,
        occurredAt: 5_000,
        playbackRate: 1,
        playbackRateOccurredAt: 5_000,
        playbackRateChanged: false,
        completed: false,
        completedOccurredAt: 5_000,
        completedChanged: false,
        positionChanged: false,
        source: "pagehide-flush",
        playing: true,
      });

      const joined = readLocalProgress("user-a", "book-1");
      expect(joined).toMatchObject({
        playbackRate: 3,
        completed: true,
        playbackRateAtWrite: 1,
        completedAtWrite: false,
      });
      expect(
        detectSuspendedSession({ record: joined, durationMs: 600_000, now: 160_000 }),
      ).toMatchObject({ playbackRate: 1, projectedPositionMs: 120_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps duplicated tabs on distinct writer registers during a same-field interleave", async () => {
    const values = new Map<string, string>();
    const positionWrites: string[] = [];
    let beforeSet: ((key: string) => void) | null = null;
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key.startsWith("chapterline:playback-position:")) positionWrites.push(key);
        beforeSet?.(key);
        values.set(key, value);
      },
      removeItem: (key: string) => void values.delete(key),
    } as Storage);
    // Browsers clone this value into opener/duplicated tabs. It must not be a
    // writer identity shared by the two live documents.
    vi.stubGlobal("sessionStorage", {
      getItem: () => "cloned-writer-id",
      setItem: vi.fn(),
    } as unknown as Storage);
    const randomUuid = vi.fn().mockReturnValueOnce("writer-a").mockReturnValueOnce("writer-b");
    vi.stubGlobal("crypto", { randomUUID: randomUuid } as unknown as Crypto);

    try {
      vi.resetModules();
      const documentA = await import("./playback-core");
      vi.resetModules();
      const documentB = await import("./playback-core");
      documentA.saveLocalPosition("user-a", "book-1", 0, 5_000);

      beforeSet = (key) => {
        if (!key.includes(":writer-b:")) return;
        beforeSet = null;
        documentA.saveLocalPosition("user-a", "book-1", 100_000, 30_000);
      };
      documentB.saveLocalPosition("user-a", "book-1", 50_000, 20_000);
      documentB.saveLocalPosition("user-a", "book-1", 60_000, 25_000);

      expect(documentB.readLocalProgress("user-a", "book-1")).toMatchObject({
        positionMs: 100_000,
        occurredAt: 30_000,
      });
      expect(
        [...values.keys()].filter((key) =>
          key.startsWith("chapterline:playback-position:user-a:book-1:"),
        ),
      ).toHaveLength(1);
      expect(positionWrites.some((key) => key.includes(":writer-a:"))).toBe(true);
      expect(positionWrites.some((key) => key.includes(":writer-b:"))).toBe(true);
      expect(randomUuid).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("makes the later equal-clock action win in both document completion orders", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    } as Storage);
    const randomUuid = vi.fn().mockReturnValueOnce("writer-z").mockReturnValueOnce("writer-a");
    vi.stubGlobal("crypto", { randomUUID: randomUuid } as unknown as Crypto);

    const writeAllFields = (
      document: typeof import("./playback-core"),
      positionMs: number,
      playbackRate: number,
      completed: boolean,
    ) =>
      document.saveLocalPlaybackState("user-a", "book-1", {
        positionMs,
        occurredAt: 20_000,
        playbackRate,
        playbackRateOccurredAt: 20_000,
        completed,
        completedOccurredAt: 20_000,
        positionChanged: true,
        playbackRateChanged: true,
        completedChanged: true,
      });

    try {
      vi.resetModules();
      const documentZ = await import("./playback-core");
      vi.resetModules();
      const documentA = await import("./playback-core");

      writeAllFields(documentZ, 100_000, 1, false);
      const lexicallyLosingLaterWrite = writeAllFields(documentA, 50_000, 2, true);
      expect(lexicallyLosingLaterWrite).toMatchObject({
        positionMs: 50_000,
        occurredAt: 20_001,
        playbackRate: 2,
        playbackRateOccurredAt: 20_001,
        completed: true,
        completedOccurredAt: 20_001,
      });
      expect(documentA.readLocalProgress("user-a", "book-1")).toMatchObject(
        lexicallyLosingLaterWrite!,
      );

      values.clear();
      writeAllFields(documentA, 50_000, 2, true);
      const lexicallyWinningLaterWrite = writeAllFields(documentZ, 100_000, 1, false);
      expect(lexicallyWinningLaterWrite).toMatchObject({
        positionMs: 100_000,
        occurredAt: 20_000,
        playbackRate: 1,
        playbackRateOccurredAt: 20_000,
        completed: false,
        completedOccurredAt: 20_000,
      });
      expect(documentZ.readLocalProgress("user-a", "book-1")).toMatchObject(
        lexicallyWinningLaterWrite!,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not advance a strictly older touched field past a peer register", () => {
    const writes = vi.spyOn(localStorage, "setItem");
    for (const [field, value] of [
      ["position", 100_000],
      ["rate", 3],
      ["completed", true],
    ] as const) {
      localStorage.setItem(
        `chapterline:playback-${field}:user-a:book-1:peer-b`,
        JSON.stringify({ value, occurredAt: 30_000 }),
      );
    }
    writes.mockClear();

    const stale = saveLocalPlaybackState("user-a", "book-1", {
      positionMs: 60_000,
      occurredAt: 25_000,
      playbackRate: 2,
      playbackRateOccurredAt: 25_000,
      completed: false,
      completedOccurredAt: 25_000,
      positionChanged: true,
      playbackRateChanged: true,
      completedChanged: true,
      source: "pagehide-flush",
      playing: true,
    });

    expect(stale).toMatchObject({
      positionMs: 100_000,
      occurredAt: 30_000,
      playbackRate: 3,
      playbackRateOccurredAt: 30_000,
      completed: true,
      completedOccurredAt: 30_000,
    });
    expect(stale?.source).toBeUndefined();
    expect(stale?.playingAtWrite).toBeUndefined();
    const touchedRegisters = writes.mock.calls
      .filter(([key]) => String(key).startsWith("chapterline:playback-"))
      .map(([key, raw]) => [String(key).split(":")[1], JSON.parse(String(raw))]);
    expect(touchedRegisters).toStrictEqual([
      ["playback-position", expect.objectContaining({ value: 60_000, occurredAt: 25_000 })],
      ["playback-rate", expect.objectContaining({ value: 2, occurredAt: 25_000 })],
      ["playback-completed", expect.objectContaining({ value: false, occurredAt: 25_000 })],
    ]);
  });

  it("drops writerless legacy provenance when a different register position wins", () => {
    localStorage.setItem(
      "chapterline:position:user-a:book-1",
      JSON.stringify({
        positionMs: 60_000,
        occurredAt: 20_000,
        source: "pagehide-flush",
        playingAtWrite: true,
        writtenAt: 40_000,
      }),
    );
    localStorage.setItem(
      "chapterline:playback-position:user-a:book-1:peer-b",
      JSON.stringify({ value: 100_000, occurredAt: 30_000 }),
    );

    const joined = readLocalProgress("user-a", "book-1");
    expect(joined).toMatchObject({ positionMs: 100_000, occurredAt: 30_000 });
    expect(joined?.source).toBeUndefined();
    expect(joined?.playingAtWrite).toBeUndefined();
    expect(joined?.writtenAt).toBeUndefined();
  });

  it("compacts immutable register generations across document reloads", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    } as Storage);
    let documentNumber = 0;
    vi.stubGlobal("crypto", {
      randomUUID: () => `writer-${++documentNumber}`,
    } as unknown as Crypto);

    try {
      for (let index = 1; index <= 12; index += 1) {
        vi.resetModules();
        const document = await import("./playback-core");
        document.saveLocalPlaybackState("user-a", "book-1", {
          positionMs: index * 1_000,
          occurredAt: index * 1_000,
          playbackRate: 1.5,
          playbackRateOccurredAt: index * 1_000,
          completed: false,
          completedOccurredAt: index * 1_000,
          hydrate: true,
        });
      }

      for (const field of ["position", "rate", "completed"]) {
        expect(
          [...values.keys()].filter((key) =>
            key.startsWith(`chapterline:playback-${field}:user-a:book-1:`),
          ),
        ).toHaveLength(1);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not compact a register whose exact bytes changed after enumeration", () => {
    const prefix = "chapterline:playback-position:user-a:book-1:";
    const peerKey = `${prefix}mixed-version-peer`;
    const values = new Map<string, string>([
      [peerKey, JSON.stringify({ value: 50_000, occurredAt: 10_000 })],
    ]);
    let compactionStarted = false;
    let peerReadsDuringCompaction = 0;
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => {
        if (compactionStarted && key === peerKey) {
          peerReadsDuringCompaction += 1;
          if (peerReadsDuringCompaction === 2) {
            values.set(peerKey, JSON.stringify({ value: 200_000, occurredAt: 30_000 }));
          }
        }
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (key.startsWith(prefix) && key !== peerKey) compactionStarted = true;
        values.set(key, value);
      },
      removeItem: (key: string) => void values.delete(key),
    } as Storage);

    saveLocalPosition("user-a", "book-1", 100_000, 20_000);

    expect(values.has(peerKey)).toBe(true);
    expect(readLocalProgress("user-a", "book-1")).toMatchObject({
      positionMs: 200_000,
      occurredAt: 30_000,
    });
  });

  /**
   * The unit-level statement of `tests/resume/uncovered-axes.spec.ts` X3.
   *
   * The e2e row is the one that grades the product, in WebKit, on two real
   * devices. This is the same rule expressed where it is cheap to run and
   * impossible to misread: a durable write that carries no new position must
   * not claim a newer moment, because `occurredAt` is the only thing
   * `localWinsOver` compares and a fresher stamp on an unmoved position is how
   * a stale tab overrules another device's real listening.
   */
  it("does not re-stamp a durable write that carries no new position", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(10_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_793 });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        positionMs: 6_793,
        occurredAt: 10_000,
      });

      // Another device moves the book forward while this one sits paused.
      const serverOccurredAt = new Date(20_000).toISOString();

      // The terminal flush: same position, 15 seconds later.
      vi.setSystemTime(new Date(25_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_793 });
      const afterFlush = readLocalProgress("user-a", "book-1")!;
      expect(afterFlush.occurredAt).toBe(10_000);
      expect(localWinsOver(afterFlush, serverOccurredAt)).toBe(false);
      expect(
        freshestPosition({
          local: afterFlush,
          serverPositionMs: 15_666,
          serverOccurredAt,
        }),
      ).toBe(15_666);

      // A write that DOES move the position still claims the new moment.
      vi.setSystemTime(new Date(30_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_794 });
      const afterListening = readLocalProgress("user-a", "book-1")!;
      expect(afterListening.occurredAt).toBe(30_000);
      expect(localWinsOver(afterListening, serverOccurredAt)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A record that claims no moment cannot lend one to the write that follows. */
  it("re-stamps when the stored record is a legacy value with no moment", () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("chapterline:position:user-a:book-1", "6793");
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({ occurredAt: 0 });
      vi.setSystemTime(new Date(25_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_793 });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        positionMs: 6_793,
        occurredAt: 25_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Provenance on the durable record — the two fields that let a person settle
 * `docs/resume-durability-device-check.md` by reading the app instead of
 * inferring from a resumed position.
 */
describe("durable write provenance", () => {
  const KEY = "chapterline:position:user-a:book-1";

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips the mechanism that wrote the record", () => {
    saveLocalPlaybackState("user-a", "book-1", { positionMs: 1_000, source: "cadence-timer" });
    expect(readLocalProgress("user-a", "book-1")?.source).toBe("cadence-timer");
  });

  it("keeps hide-edge provenance when the server acknowledges the exact position", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(40_000));
      localStorage.setItem(
        "chapterline:playback-position:user-a:book-1:!canonical:previous-document:000000000001",
        JSON.stringify({
          value: 12_436,
          occurredAt: 35_000,
          writerId: "!canonical:previous-document",
        }),
      );
      localStorage.setItem(
        KEY,
        JSON.stringify({
          positionMs: 12_436,
          positionAtWrite: 12_436,
          occurredAt: 35_000,
          playbackRate: 1,
          playbackRateOccurredAt: 30_000,
          completed: false,
          completedOccurredAt: 30_000,
          writerId: "!canonical:previous-document",
          source: "visibility-flush",
          writtenAt: 40_000,
          playingAtWrite: true,
        }),
      );

      applyAuthoritativePlaybackState(
        "user-a",
        "book-1",
        {
          positionMs: 12_436,
          occurredAt: 35_000,
          playbackRate: 1,
          playbackRateOccurredAt: 30_000,
          completed: false,
          completedOccurredAt: 30_000,
        },
        {
          positionMs: 12_436,
          occurredAt: 35_000,
          playbackRate: 1,
          playbackRateOccurredAt: 30_000,
          completed: false,
          completedOccurredAt: 30_000,
        },
      );

      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        positionMs: 12_436,
        occurredAt: 35_000,
        source: "visibility-flush",
        writtenAt: 40_000,
        playingAtWrite: true,
      });

      bootstrapPlaybackState("user-a", {
        ...serverBook,
        initialPositionMs: 12_436,
        initialProgressOccurredAt: new Date(35_000).toISOString(),
        initialPlaybackRate: 1,
        initialPlaybackRateOccurredAt: new Date(30_000).toISOString(),
        completed: false,
        initialCompletedOccurredAt: new Date(30_000).toISOString(),
      });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        positionMs: 12_436,
        occurredAt: 35_000,
        source: "visibility-flush",
        writtenAt: 40_000,
        playingAtWrite: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The readout in Settings renders this verbatim, so a value this build does
   * not write is dropped rather than shown. Absent reads as "unknown", which is
   * the truth; a stray string would read as a writer that does not exist.
   */
  it("drops a source the current build does not write", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ positionMs: 1_000, occurredAt: 5_000, source: "carrier-pigeon" }),
    );
    expect(readLocalProgress("user-a", "book-1")?.source).toBeUndefined();
    expect(readLocalProgress("user-a", "book-1")?.positionMs).toBe(1_000);
  });

  /**
   * THE X3 INVARIANT, restated now that a second timestamp exists beside it.
   *
   * `occurredAt` answers "when was this position reached" and must stay frozen
   * across a re-write that carries no new position — re-stamping it is how a
   * stale tab overrules another device's real listening. `writtenAt` answers
   * "when did something last write this record" and must move every time.
   *
   * They are pinned together here because the cheap mistake is to satisfy the
   * new field by reusing the old one, which silently reintroduces the
   * cross-device regression the frozen `occurredAt` exists to prevent.
   */
  it("advances writtenAt on a re-write while occurredAt stays where the listening was", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(10_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_793, source: "pause" });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        occurredAt: 10_000,
        writtenAt: 10_000,
      });

      // The terminal flush 15 seconds later: same position, no new listening.
      vi.setSystemTime(new Date(25_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_793, source: "pagehide-flush" });
      const afterFlush = readLocalProgress("user-a", "book-1")!;
      expect(
        afterFlush.occurredAt,
        "occurredAt moved on a write that carried no new position, which is exactly the " +
          "cross-device regression X3 measured",
      ).toBe(10_000);
      expect(
        afterFlush.writtenAt,
        "writtenAt did not move, so the record cannot say how long ago something last wrote it " +
          "— which is the whole question the device check asks",
      ).toBe(25_000);
      expect(afterFlush.source).toBe("pagehide-flush");
      // And the frozen moment still loses to a newer server record.
      expect(localWinsOver(afterFlush, new Date(20_000).toISOString())).toBe(false);

      // A write that DOES move the position moves both.
      vi.setSystemTime(new Date(30_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_794, source: "media-tick" });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        occurredAt: 30_000,
        writtenAt: 30_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances only the clocks of playback fields that changed", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(10_000));
      saveLocalPlaybackState("user-a", "book-1", {
        positionMs: 6_793,
        playbackRate: 1,
        completed: false,
      });

      vi.setSystemTime(new Date(20_000));
      saveLocalPlaybackState("user-a", "book-1", {
        positionMs: 6_793,
        playbackRate: 2,
        completed: false,
      });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        occurredAt: 10_000,
        playbackRateOccurredAt: 20_000,
        completedOccurredAt: 10_000,
      });

      vi.setSystemTime(new Date(30_000));
      saveLocalPlaybackState("user-a", "book-1", {
        positionMs: 6_793,
        playbackRate: 2,
        completed: true,
      });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        occurredAt: 10_000,
        playbackRateOccurredAt: 20_000,
        completedOccurredAt: 30_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Both fields are optional and there is no IndexedDB migration, so every
   * record written by a shipped build has to keep parsing and resuming exactly
   * as it did — including the pre-v2 bare-number form.
   */
  it("still parses and resumes a record written before provenance existed", () => {
    localStorage.setItem(KEY, JSON.stringify({ positionMs: 42_000, occurredAt: 9_000 }));
    const record = readLocalProgress("user-a", "book-1")!;
    expect(record).toStrictEqual({ positionMs: 42_000, occurredAt: 9_000 });
    expect(record.source).toBeUndefined();
    expect(record.writtenAt).toBeUndefined();
    expect(
      freshestPosition({
        local: record,
        serverPositionMs: 8_000,
        serverOccurredAt: new Date(3_000).toISOString(),
      }),
      "a record with no provenance stopped winning against an older server position",
    ).toBe(42_000);

    localStorage.setItem("chapterline:position:user-a:book-2", "7000");
    expect(readLocalProgress("user-a", "book-2")).toStrictEqual({
      positionMs: 7_000,
      occurredAt: 0,
    });
  });

  /**
   * The settings readout names ONE book, so it has to be the one written last.
   * Ordering by `occurredAt` would name the wrong one, because that field is
   * deliberately frozen on re-writes.
   */
  it("finds the most recently written book, not the most recently reached position", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(10_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 500, source: "seek" });
      vi.setSystemTime(new Date(20_000));
      saveLocalPlaybackState("user-a", "book-2", { positionMs: 900, source: "media-tick" });
      // book-1 is re-written last but at a position it already held, so its
      // `occurredAt` stays at 10_000 while its `writtenAt` becomes the newest.
      vi.setSystemTime(new Date(30_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 500, source: "visibility-flush" });

      const latest = readLatestLocalPlayback("user-a");
      expect(latest?.bookId).toBe("book-1");
      expect(latest?.state).toMatchObject({
        source: "visibility-flush",
        writtenAt: 30_000,
        occurredAt: 10_000,
      });
      expect(readLatestLocalPlayback("user-b")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The recovery path for a listen this device could not record.
 *
 * `docs/resume-durability-device-check.md` states the one question no
 * instrument here can answer: does iOS suspend BOTH the 200 ms cadence timer
 * and the media element's `timeupdate` while a PWA is backgrounded with audio
 * playing? The cost if it does is measured — the both-writers-dead row in
 * `tests/resume` loses 9644 ms of a 9500 ms session, all of it, scaling with
 * the length of the listen.
 *
 * These cover the predicate and the projection maths. The three behavioural
 * assertions — resumes at the recorded position and never forward, the offer
 * appears for the real signature, the offer does NOT appear after an ordinary
 * background — are `tests/resume/suspension-recovery.spec.ts`, in WebKit.
 */
describe("detectSuspendedSession", () => {
  const DURATION_MS = 3_600_000;
  const WRITTEN_AT = 1_000_000;
  const RECORDED_MS = 1_800_000;

  /** The exact signature: hidden with audio live, and nothing wrote after. */
  function suspended(overrides: Partial<LocalPosition> = {}): LocalPosition {
    return {
      positionMs: RECORDED_MS,
      occurredAt: WRITTEN_AT,
      writtenAt: WRITTEN_AT,
      source: "visibility-flush",
      playingAtWrite: true,
      playbackRate: 1,
      ...overrides,
    };
  }

  const detect = (record: LocalPosition | null, elapsedMs: number, durationMs = DURATION_MS) =>
    detectSuspendedSession({ record, durationMs, now: WRITTEN_AT + elapsedMs });

  it("reports the gap and where playback would have reached", () => {
    const gap = detect(suspended(), 300_000);
    expect(gap).toStrictEqual({
      recordedPositionMs: RECORDED_MS,
      writtenAt: WRITTEN_AT,
      elapsedMs: 300_000,
      playbackRate: 1,
      // Five minutes at 1x. The RECORDED position is untouched and stays the
      // source of truth; this is only what is offered.
      projectedPositionMs: RECORDED_MS + 300_000,
    });
  });

  it("projects from the writer's actual smart-rewind position, not its durable floor", () => {
    const gap = detect(
      suspended({ positionMs: 60_000, positionAtWrite: 50_000 }),
      120_000,
      600_000,
    );
    expect(gap).toMatchObject({
      recordedPositionMs: 60_000,
      projectedPositionMs: 170_000,
    });
  });

  it("fires for the pagehide edge as well as the visibility edge", () => {
    expect(detect(suspended({ source: "pagehide-flush" }), 300_000)).not.toBeNull();
  });

  /**
   * The rate is part of how far the audio got. Ignoring it would under-report a
   * fast listener's loss by the same factor they chose to speed the book up by.
   */
  it("scales the projection by the rate the book was playing at", () => {
    expect(detect(suspended({ playbackRate: 1.5 }), 300_000)?.projectedPositionMs).toBe(
      RECORDED_MS + 450_000,
    );
    expect(detect(suspended({ playbackRate: 0.5 }), 300_000)?.projectedPositionMs).toBe(
      RECORDED_MS + 150_000,
    );
  });

  /**
   * A record written before rates were durable, or one holding a value no
   * player could have been at, falls back to 1x. The alternative is scaling a
   * number shown to the user by a number nobody wrote.
   */
  it("falls back to 1x rather than trusting a rate that is not one", () => {
    for (const playbackRate of [undefined, 0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const gap = detect(suspended({ playbackRate }), 300_000);
      expect(gap?.playbackRate, `rate ${String(playbackRate)}`).toBe(1);
      expect(gap?.projectedPositionMs).toBe(RECORDED_MS + 300_000);
    }
  });

  it("never projects past the end of the book", () => {
    // Four hours away, at 2x, from halfway through a one-hour book.
    const gap = detect(suspended({ playbackRate: 2 }), 4 * 3_600_000);
    expect(gap?.projectedPositionMs).toBe(DURATION_MS);
  });

  /**
   * THE HEART OF THE PREDICATE. There is one durable record per (user, book)
   * and every write overwrites it, so a record naming any writer other than the
   * hide edge is proof that something DID write after the app went away — and
   * then there is no unrecorded stretch to recover.
   */
  it("refuses every source that means something wrote after the hide edge", () => {
    for (const source of [
      "cadence-timer",
      "media-tick",
      "pause",
      "seek",
      "ended",
      "rate-change",
      "book-switch",
      "book-unload",
    ] as const) {
      expect(detect(suspended({ source }), 300_000), source).toBeNull();
    }
    expect(detect(suspended({ source: undefined }), 300_000)).toBeNull();
  });

  /**
   * A hide edge is taken on EVERY backgrounding. Only one taken while audio was
   * live can have listening behind it; closing a paused book must never offer
   * to move the user forward over content that never played.
   */
  it("refuses a hide edge taken while the book was paused", () => {
    expect(detect(suspended({ playingAtWrite: undefined }), 300_000)).toBeNull();
    expect(detect(suspended({ playingAtWrite: false }), 300_000)).toBeNull();
  });

  /** No write timestamp is no gap: there is nothing to measure the loss from. */
  it("refuses a record with no usable write timestamp", () => {
    for (const writtenAt of [undefined, 0, -1, Number.NaN]) {
      expect(detect(suspended({ writtenAt }), 300_000), String(writtenAt)).toBeNull();
    }
  });

  /**
   * The floor is what keeps this from being an interruption the user meets
   * several times a day. A gap the ordinary writers plainly covered gets
   * nothing, and the boundary is asserted on both sides.
   */
  it("says nothing about a gap too small to be worth an interruption", () => {
    expect(detect(suspended(), SUSPENSION_GAP_FLOOR_MS - 1)).toBeNull();
    expect(detect(suspended(), SUSPENSION_GAP_FLOOR_MS)).not.toBeNull();
    expect(detect(suspended(), 1_000)).toBeNull();
  });

  /**
   * The floor is stated on the PROJECTED ADVANCE, not on the wall clock, so a
   * slow listener needs proportionally longer away before the offer is worth
   * making — the same number means the same amount of content at every rate.
   */
  it("holds the floor against the content lost, not the time away", () => {
    expect(detect(suspended({ playbackRate: 0.5 }), SUSPENSION_GAP_FLOOR_MS)).toBeNull();
    expect(detect(suspended({ playbackRate: 0.5 }), SUSPENSION_GAP_FLOOR_MS * 2)).not.toBeNull();
  });

  /**
   * A book parked at its end restarts from zero (`resolveStartPosition`), so a
   * projection from its stored position describes a place the player is not
   * going to be. There is no explicit branch for it: the clamp plus the floor
   * refuse it by arithmetic, which is why the assertions below are stated as
   * behaviour rather than pointed at a line. `SUSPENSION_GAP_FLOOR_MS`'s
   * comment records that an explicit check was written and then removed for
   * being unkillable by any test.
   */
  it("refuses when there is no room left in the book to project into", () => {
    expect(detect(suspended({ positionMs: DURATION_MS }), 300_000)).toBeNull();
    expect(detect(suspended({ positionMs: DURATION_MS - 500 }), 300_000)).toBeNull();
    // Ten seconds of headroom against a five-minute gap: the clamp leaves ten
    // seconds on offer, which is under the floor.
    expect(detect(suspended({ positionMs: DURATION_MS - 10_000 }), 300_000)).toBeNull();
  });

  it("refuses a finished book, which has no unheard stretch behind it", () => {
    expect(detect(suspended({ completed: true }), 300_000)).toBeNull();
    expect(detect(suspended({ completed: false }), 300_000)).not.toBeNull();
  });

  it("refuses junk inputs rather than projecting from them", () => {
    expect(detect(null, 300_000)).toBeNull();
    expect(detect(suspended(), 300_000, 0)).toBeNull();
    expect(detect(suspended(), 300_000, Number.NaN)).toBeNull();
    // The device clock moved backwards between the write and the launch.
    expect(detect(suspended(), -300_000)).toBeNull();
  });
});

describe("the suspension record and the answer to it", () => {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips liveness, and writes nothing for a write made while paused", () => {
    saveLocalPlaybackState("user-a", "book-1", {
      positionMs: 1_000,
      source: "visibility-flush",
      playing: true,
    });
    expect(readLocalProgress("user-a", "book-1")?.playingAtWrite).toBe(true);

    saveLocalPlaybackState("user-a", "book-2", {
      positionMs: 1_000,
      source: "visibility-flush",
      playing: false,
    });
    expect(readLocalProgress("user-a", "book-2")?.playingAtWrite).toBeUndefined();
  });

  /**
   * The one field that can authorise moving a user's position forward, so only
   * a literal `true` counts. A coerced value would let a future field name
   * collision, or a hand-edited record, produce an offer out of nothing.
   */
  it("refuses to coerce anything but a literal true into liveness", () => {
    for (const playingAtWrite of ["true", 1, {}, [], "yes"]) {
      localStorage.setItem(
        "chapterline:position:user-a:book-1",
        JSON.stringify({ positionMs: 1_000, occurredAt: 5_000, playingAtWrite }),
      );
      expect(
        readLocalProgress("user-a", "book-1")?.playingAtWrite,
        JSON.stringify(playingAtWrite),
      ).toBeUndefined();
    }
  });

  /**
   * A dismissal answers ONE unrecorded stretch, identified by the hide-edge
   * write's own timestamp. A later suspension is a different loss and the
   * user's last answer said nothing about it.
   */
  it("remembers the answer per gap, not per book", () => {
    expect(readDismissedSuspensionGap("user-a", "book-1")).toBeNull();
    dismissSuspensionGap("user-a", "book-1", 1_000_000);
    expect(readDismissedSuspensionGap("user-a", "book-1")).toBe(1_000_000);
    expect(readDismissedSuspensionGap("user-a", "book-2")).toBeNull();
    expect(readDismissedSuspensionGap("user-b", "book-1")).toBeNull();
    dismissSuspensionGap("user-a", "book-1", 2_000_000);
    expect(readDismissedSuspensionGap("user-a", "book-1")).toBe(2_000_000);
  });

  /**
   * Deleting a book takes it with the position and the pause marker. A
   * re-import of the same file is matched to the same book id by fingerprint,
   * so a surviving answer would silence an offer about a book the user deleted.
   */
  it("goes with the book when the book is deleted", () => {
    saveLocalPlaybackState("user-a", "book-1", { positionMs: 1_000, source: "pause" });
    markPausedNow("user-a", "book-1");
    dismissSuspensionGap("user-a", "book-1", 1_000_000);
    clearLocalPlaybackState("user-a", "book-1");
    expect(readLocalProgress("user-a", "book-1")).toBeNull();
    expect(readMsSinceLastPause("user-a", "book-1")).toBeNull();
    expect(readDismissedSuspensionGap("user-a", "book-1")).toBeNull();
  });
});
