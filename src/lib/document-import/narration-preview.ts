/**
 * Listening to a narration while it is still being made.
 *
 * The import pipeline holds every chunk as raw samples the moment the engine
 * returns it, so a preview needs none of the durable machinery: no media store,
 * no service worker, no seek map, and no registered book. It is deliberately
 * separate from playback proper — there is no scrubbing, no chapter jumping and
 * no resume here, because those belong to a book with a committed timeline.
 *
 * The scheduling is kept free of Web Audio so it can be tested against a fake
 * clock; `browserNarrationSink` is the only part that touches an AudioContext.
 */

export type NarrationSink = {
  /** Seconds on the audio clock. Monotonic, and not the wall clock. */
  now: () => number;
  /** Queues samples to begin at an absolute time on that clock. */
  play: (audio: Float32Array, at: number) => void;
};

export type NarrationPreviewOptions = {
  sink: NarrationSink;
  sampleRate: number;
  /**
   * How much audio must be queued before listening is worth offering. Below
   * this the first underrun arrives almost immediately, which sounds broken
   * rather than merely early.
   */
  readySeconds?: number;
  /** Scheduling margin, so a chunk is never queued for a moment already gone. */
  leadSeconds?: number;
};

const DEFAULT_READY_SECONDS = 20;
const DEFAULT_LEAD_SECONDS = 0.15;

export function createNarrationPreview(options: NarrationPreviewOptions) {
  const { sink, sampleRate } = options;
  const readySeconds = options.readySeconds ?? DEFAULT_READY_SECONDS;
  const leadSeconds = options.leadSeconds ?? DEFAULT_LEAD_SECONDS;

  const pending: Float32Array[] = [];
  let listening = false;
  let scheduledUntil = 0;
  let producedSeconds = 0;
  let underruns = 0;

  const schedule = (audio: Float32Array) => {
    const now = sink.now();
    // Falling behind is not an error worth throwing: the engine is slower than
    // playback on this machine. Resume just ahead of the clock and count it, so
    // the caller can stop offering something this device cannot sustain.
    if (scheduledUntil < now) {
      if (scheduledUntil > 0) underruns += 1;
      scheduledUntil = now + leadSeconds;
    }
    sink.play(audio, scheduledUntil);
    scheduledUntil += audio.length / sampleRate;
  };

  return {
    /** Every chunk the engine produces, whether or not anyone is listening. */
    enqueue(audio: Float32Array): void {
      producedSeconds += audio.length / sampleRate;
      if (listening) schedule(audio);
      else pending.push(audio);
    },

    /** True once there is enough queued that starting will not stutter at once. */
    isReady(): boolean {
      return !listening && this.bufferedSeconds() >= readySeconds;
    },

    /**
     * Unplayed audio in hand. Before listening starts that is everything held;
     * afterwards it is however far the schedule runs past the clock.
     */
    bufferedSeconds(): number {
      if (!listening) return pending.reduce((total, audio) => total + audio.length / sampleRate, 0);
      return Math.max(0, scheduledUntil - sink.now());
    },

    /** Starts playback from the beginning of what has been narrated so far. */
    start(): void {
      if (listening) return;
      listening = true;
      scheduledUntil = sink.now() + leadSeconds;
      for (const audio of pending) schedule(audio);
      pending.length = 0;
    },

    /** How far ahead of the listener the engine is running. */
    stats(): { listening: boolean; producedSeconds: number; underruns: number } {
      return { listening, producedSeconds, underruns };
    },
  };
}

export type NarrationPreview = ReturnType<typeof createNarrationPreview>;

/**
 * A sink backed by a real AudioContext.
 *
 * Constructed only from a user gesture, because Safari — and every browser on
 * iOS — will not let audio start otherwise.
 */
export function browserNarrationSink(sampleRate: number): NarrationSink & { close: () => void } {
  const context = new AudioContext({ sampleRate });
  void context.resume();
  return {
    now: () => context.currentTime,
    play: (audio, at) => {
      const buffer = context.createBuffer(1, audio.length, sampleRate);
      // `set` rather than `copyToChannel`, which narrows to a Float32Array over
      // a plain ArrayBuffer and would reject the engine's samples.
      buffer.getChannelData(0).set(audio);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start(at);
    },
    close: () => void context.close(),
  };
}
