import { describe, expect, it } from "vitest";

import { createNarrationPreview, type NarrationSink } from "./narration-preview";

const SAMPLE_RATE = 24_000;

/** One second of audio per unit, so the arithmetic in the tests stays readable. */
function seconds(count: number): Float32Array {
  return new Float32Array(SAMPLE_RATE * count);
}

function fakeSink() {
  const played: { at: number; seconds: number }[] = [];
  let clock = 0;
  const sink: NarrationSink = {
    now: () => clock,
    play: (audio, at) => played.push({ at, seconds: audio.length / SAMPLE_RATE }),
  };
  return {
    sink,
    played,
    advance: (delta: number) => {
      clock += delta;
    },
  };
}

function preview(overrides: Partial<Parameters<typeof createNarrationPreview>[0]> = {}) {
  const harness = fakeSink();
  return {
    ...harness,
    subject: createNarrationPreview({
      sink: harness.sink,
      sampleRate: SAMPLE_RATE,
      readySeconds: 20,
      leadSeconds: 0,
      ...overrides,
    }),
  };
}

describe("narration preview", () => {
  it("plays nothing until someone actually asks to listen", () => {
    const { subject, played } = preview();
    subject.enqueue(seconds(10));
    subject.enqueue(seconds(10));
    expect(played).toEqual([]);
  });

  it("offers listening only once enough is queued to survive the first seconds", () => {
    const { subject } = preview();
    subject.enqueue(seconds(10));
    expect(subject.isReady()).toBe(false);
    subject.enqueue(seconds(10));
    expect(subject.isReady()).toBe(true);
  });

  it("plays everything narrated so far, back to back, when listening starts", () => {
    const { subject, played } = preview();
    subject.enqueue(seconds(10));
    subject.enqueue(seconds(5));
    subject.start();
    expect(played).toEqual([
      { at: 0, seconds: 10 },
      { at: 10, seconds: 5 },
    ]);
  });

  it("keeps later chunks joined to the end of what is already scheduled", () => {
    const { subject, played } = preview();
    subject.enqueue(seconds(20));
    subject.start();
    subject.enqueue(seconds(5));
    expect(played.at(-1)).toEqual({ at: 20, seconds: 5 });
  });

  it("stops offering to start once it already is", () => {
    const { subject } = preview();
    subject.enqueue(seconds(30));
    subject.start();
    expect(subject.isReady()).toBe(false);
  });

  it("ignores a second request to start rather than replaying the book", () => {
    const { subject, played } = preview();
    subject.enqueue(seconds(20));
    subject.start();
    subject.start();
    expect(played).toHaveLength(1);
  });

  it("reports the buffer draining as the listener catches up", () => {
    const { subject, advance } = preview();
    subject.enqueue(seconds(20));
    subject.start();
    expect(subject.bufferedSeconds()).toBe(20);
    advance(15);
    expect(subject.bufferedSeconds()).toBe(5);
  });

  it("recovers from an engine slower than playback instead of scheduling the past", () => {
    const { subject, played, advance } = preview();
    subject.enqueue(seconds(10));
    subject.start();
    advance(25); // the listener ran out and waited
    subject.enqueue(seconds(10));

    expect(played.at(-1)!.at).toBe(25);
    expect(subject.stats().underruns).toBe(1);
  });

  it("counts no underrun for the very first chunk, which has nothing to fall behind", () => {
    const { subject, advance } = preview();
    advance(5);
    subject.enqueue(seconds(10));
    subject.start();
    expect(subject.stats().underruns).toBe(0);
  });

  it("never reports a negative buffer once the schedule is exhausted", () => {
    const { subject, advance } = preview();
    subject.enqueue(seconds(5));
    subject.start();
    advance(60);
    expect(subject.bufferedSeconds()).toBe(0);
  });

  it("tracks everything produced, whether or not it was listened to", () => {
    const { subject } = preview();
    subject.enqueue(seconds(10));
    subject.enqueue(seconds(10));
    expect(subject.stats().producedSeconds).toBe(20);
    expect(subject.stats().listening).toBe(false);
  });
});
