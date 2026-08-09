import { describe, expect, it } from "vitest";

import { decideProgressUpdate, mergeProgressFields } from "./progress-policy";

const now = new Date("2026-07-09T20:00:00.000Z");

describe("decideProgressUpdate", () => {
  it("accepts the first progress event", () => {
    expect(decideProgressUpdate(null, now, now).accept).toBe(true);
  });

  it("rejects a stale offline event after a newer device has listened", () => {
    const result = decideProgressUpdate(
      { eventOccurredAt: new Date("2026-07-09T19:59:30.000Z") },
      new Date("2026-07-09T19:50:00.000Z"),
      now,
    );
    expect(result).toMatchObject({ accept: false, reason: "stale-event" });
  });

  it("allows small clock differences and intentional current rewinds", () => {
    const result = decideProgressUpdate(
      { eventOccurredAt: new Date("2026-07-09T19:59:59.000Z") },
      new Date("2026-07-09T19:59:58.000Z"),
      now,
    );
    expect(result.accept).toBe(true);
  });

  it("bounds a far-future device clock", () => {
    const result = decideProgressUpdate(null, new Date("2026-07-10T20:00:00.000Z"), now);
    expect(result.occurredAt.toISOString()).toBe("2026-07-09T20:05:00.000Z");
  });

  it("rejects an invalid timestamp", () => {
    expect(decideProgressUpdate(null, new Date(Number.NaN), now).reason).toBe("invalid-time");
  });
});

it("merges a newer rate without rewinding a newer cross-device position", () => {
  const result = mergeProgressFields(
    {
      positionMs: 50_000,
      playbackRate: 1,
      completed: false,
      eventOccurredAt: new Date("2026-07-09T19:59:50.000Z"),
      stateOccurredAt: new Date("2026-07-09T19:59:40.000Z"),
    },
    {
      positionMs: 10_000,
      playbackRate: 2,
      completed: false,
      eventOccurredAt: new Date("2026-07-09T19:59:30.000Z"),
      stateOccurredAt: new Date("2026-07-09T19:59:55.000Z"),
    },
    now,
    100_000,
  );

  expect(result.position.accept).toBe(false);
  expect(result.state.accept).toBe(true);
  expect(result.merged).toMatchObject({ positionMs: 50_000, playbackRate: 2 });
});
