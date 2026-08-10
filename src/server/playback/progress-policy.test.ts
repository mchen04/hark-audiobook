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
  expect(result.playbackRate.accept).toBe(true);
  expect(result.completed.accept).toBe(true);
  expect(result.merged).toMatchObject({ positionMs: 50_000, playbackRate: 2 });
});

it("does not unfinish a remotely completed book when a stale device only changes speed", () => {
  const result = mergeProgressFields(
    {
      positionMs: 600_000,
      playbackRate: 1,
      completed: true,
      eventOccurredAt: new Date("2026-07-09T19:59:55.000Z"),
      playbackRateOccurredAt: new Date("2026-07-09T19:59:40.000Z"),
      completedOccurredAt: new Date("2026-07-09T19:59:55.000Z"),
      stateOccurredAt: new Date("2026-07-09T19:59:55.000Z"),
    },
    {
      positionMs: 15_000,
      playbackRate: 2,
      // `setPlaybackRate` carries the stale activeBook.completed value.
      completed: false,
      eventOccurredAt: new Date("2026-07-09T19:58:00.000Z"),
      playbackRateOccurredAt: new Date("2026-07-09T20:00:00.000Z"),
      completedOccurredAt: new Date("2026-07-09T19:59:54.000Z"),
      stateOccurredAt: new Date("2026-07-09T20:00:00.000Z"),
    },
    now,
    600_000,
  );

  expect(result.merged.positionMs).toBe(600_000);
  expect(result.merged.playbackRate).toBe(2);
  expect(result.merged.completed).toBe(true);
});

it("keeps accepting the combined clock written by older clients", () => {
  const result = mergeProgressFields(
    {
      positionMs: 50_000,
      playbackRate: 1,
      completed: false,
      eventOccurredAt: new Date("2026-07-09T19:59:40.000Z"),
      stateOccurredAt: new Date("2026-07-09T19:59:40.000Z"),
    },
    {
      positionMs: 50_000,
      playbackRate: 1.5,
      completed: true,
      eventOccurredAt: new Date("2026-07-09T19:59:40.000Z"),
      stateOccurredAt: new Date("2026-07-09T19:59:55.000Z"),
    },
    now,
    100_000,
  );

  expect(result.playbackRate.accept).toBe(true);
  expect(result.completed.accept).toBe(true);
  expect(result.merged).toMatchObject({ playbackRate: 1.5, completed: true });
});

it("preserves the legacy two-second tolerance for a combined state clock", () => {
  const result = mergeProgressFields(
    {
      positionMs: 50_000,
      playbackRate: 1,
      completed: false,
      eventOccurredAt: new Date("2026-07-09T19:59:55.000Z"),
      stateOccurredAt: new Date("2026-07-09T19:59:55.000Z"),
    },
    {
      positionMs: 10_000,
      playbackRate: 1.5,
      completed: true,
      eventOccurredAt: new Date("2026-07-09T19:58:00.000Z"),
      stateOccurredAt: new Date("2026-07-09T19:59:54.000Z"),
    },
    now,
    100_000,
  );

  expect(result.position.accept).toBe(false);
  expect(result.playbackRate.accept).toBe(true);
  expect(result.completed.accept).toBe(true);
  expect(result.merged).toMatchObject({
    positionMs: 50_000,
    playbackRate: 1.5,
    completed: true,
  });
});

it("falls back from nullable new columns to the legacy row clock per field", () => {
  const result = mergeProgressFields(
    {
      positionMs: 600_000,
      playbackRate: 1,
      completed: true,
      eventOccurredAt: new Date("2026-07-09T19:59:55.000Z"),
      playbackRateOccurredAt: null,
      completedOccurredAt: null,
      stateOccurredAt: new Date("2026-07-09T19:59:55.000Z"),
    },
    {
      positionMs: 15_000,
      playbackRate: 2,
      completed: false,
      eventOccurredAt: new Date("2026-07-09T19:58:00.000Z"),
      playbackRateOccurredAt: new Date("2026-07-09T20:00:00.000Z"),
      completedOccurredAt: new Date("2026-07-09T19:59:54.000Z"),
    },
    now,
    600_000,
  );

  expect(result.merged).toMatchObject({
    positionMs: 600_000,
    playbackRate: 2,
    completed: true,
    completedOccurredAt: new Date("2026-07-09T19:59:55.000Z"),
  });
});

it("retains combined-tuple semantics when a legacy client supplies only one state clock", () => {
  const result = mergeProgressFields(
    {
      positionMs: 600_000,
      playbackRate: 1,
      completed: true,
      eventOccurredAt: new Date("2026-07-09T19:59:55.000Z"),
      stateOccurredAt: new Date("2026-07-09T19:59:55.000Z"),
    },
    {
      positionMs: 15_000,
      playbackRate: 2,
      completed: false,
      eventOccurredAt: new Date("2026-07-09T19:58:00.000Z"),
      stateOccurredAt: new Date("2026-07-09T20:00:00.000Z"),
    },
    now,
    600_000,
  );

  // With no per-field clock, the server cannot distinguish a rate-only write
  // from an intentional restart. Treating the old clock as a tuple preserves
  // both legacy operations; independent clients no longer have this ambiguity.
  expect(result.merged).toMatchObject({ positionMs: 600_000, playbackRate: 2, completed: false });
});
