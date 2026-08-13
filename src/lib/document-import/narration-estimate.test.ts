import { describe, expect, it } from "vitest";

import {
  createNarrationMeter,
  estimateNarrationSeconds,
  formatRemainingNarration,
} from "./narration-estimate";

describe("estimateNarrationSeconds", () => {
  it("predicts the two measured documents within a tolerance worth trusting", () => {
    // The Lighthouse fixture: 2,375 characters over 4 heading-split chapters
    // narrated to 151s. The demo MP3: 868 characters over 3 chapters to 52.5s.
    expect(estimateNarrationSeconds(2_375, 4)).toBeGreaterThan(140);
    expect(estimateNarrationSeconds(2_375, 4)).toBeLessThan(160);
    expect(estimateNarrationSeconds(868, 3)).toBeGreaterThan(48);
    expect(estimateNarrationSeconds(868, 3)).toBeLessThan(58);
  });

  it("counts the silence between chapters but not after the last one", () => {
    const withGaps = estimateNarrationSeconds(1_000, 5);
    const withoutGaps = estimateNarrationSeconds(1_000, 1);
    expect(withGaps - withoutGaps).toBeCloseTo(1.6, 5);
  });

  it("says nothing rather than something wrong about an empty document", () => {
    expect(estimateNarrationSeconds(0, 0)).toBe(0);
    expect(estimateNarrationSeconds(-10, 3)).toBe(0);
  });

  it("scales linearly, so a book-length estimate follows from a page-length one", () => {
    expect(estimateNarrationSeconds(540_000, 1)).toBeCloseTo(
      estimateNarrationSeconds(54_000, 1) * 10,
      3,
    );
  });
});

describe("createNarrationMeter", () => {
  it("withholds a reading until the one-time startup cost is behind it", () => {
    const meter = createNarrationMeter(1_000);
    expect(meter.progress()).toBeNull();
    meter.record(100, 6, 4_000); // first chunk carries the model load
    expect(meter.progress()).toBeNull();
    meter.record(100, 6, 1_000);
    expect(meter.progress()).not.toBeNull();
  });

  it("reports how far ahead of listening the engine is running", () => {
    const meter = createNarrationMeter(1_000);
    meter.record(100, 6, 1_000);
    meter.record(100, 6, 1_000);
    // 12s of audio produced in 2s of wall clock.
    expect(meter.progress()?.realtimeRatio).toBeCloseTo(6, 5);
  });

  it("projects the remaining wall clock from the characters left", () => {
    const meter = createNarrationMeter(1_000);
    meter.record(200, 12, 2_000);
    meter.record(200, 12, 2_000);
    // 400 of 1,000 characters took 4s, so the remaining 600 should take 6s.
    expect(meter.progress()?.remainingMs).toBeCloseTo(6_000, 5);
  });

  it("winds down to no time remaining on the last chunk", () => {
    const meter = createNarrationMeter(200);
    meter.record(100, 6, 1_000);
    meter.record(100, 6, 1_000);
    expect(meter.progress()?.remainingMs).toBe(0);
  });

  it("never projects a negative remainder when a document narrates long", () => {
    const meter = createNarrationMeter(100);
    meter.record(100, 6, 1_000);
    meter.record(100, 6, 1_000);
    expect(meter.progress()?.remainingMs).toBe(0);
  });

  it("reflects a slow engine as running behind realtime", () => {
    const meter = createNarrationMeter(1_000);
    meter.record(100, 6, 12_000);
    meter.record(100, 6, 12_000);
    expect(meter.progress()!.realtimeRatio).toBeLessThan(1);
  });
});

describe("formatRemainingNarration", () => {
  it("withholds a countdown below a minute, where the rounding would lie", () => {
    expect(formatRemainingNarration(59_000)).toBeNull();
    expect(formatRemainingNarration(0)).toBeNull();
  });

  it("counts down once there is a real wait to report", () => {
    expect(formatRemainingNarration(60_000)).toBe("1m left");
    expect(formatRemainingNarration(95 * 60_000)).toBe("1h 35m left");
  });

  it("says nothing while the meter is still warming up", () => {
    expect(formatRemainingNarration(null)).toBeNull();
    expect(formatRemainingNarration(undefined)).toBeNull();
  });
});
