import { describe, expect, it } from "vitest";
import {
  type PlayerChapter,
  selectCurrentChapter,
  rewindForAbsence,
  resolveStartPosition,
} from "./player";

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
