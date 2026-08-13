/**
 * How long a narration will be, and how long it will take to produce.
 *
 * The length is arithmetic: Kokoro's pace is a property of the voice, not of
 * the machine, so characters predict audio seconds directly. Measured across
 * two independent documents on `af_heart`, speech ran 16.0–16.8 characters per
 * audio second once inter-chapter silence is excluded; the midpoint is used, and inter-chapter silence is added
 * separately rather than being smeared into the rate.
 *
 * The *time to produce* it is not arithmetic — it depends entirely on the
 * engine and the hardware, from an NPU to a phone falling back to WASM. So it
 * is measured while narrating rather than assumed.
 */

import { formatDurationRounded } from "@/lib/format-time";

const NARRATED_CHARACTERS_PER_AUDIO_SECOND = 16.2;

/** Matches `CHAPTER_SILENCE_SAMPLES` in the import pipeline. */
const CHAPTER_GAP_SECONDS = 0.4;

/** Roughly how much audio a document will produce, before narrating any of it. */
export function estimateNarrationSeconds(characters: number, chapterCount: number): number {
  if (characters <= 0) return 0;
  const gaps = Math.max(0, chapterCount - 1) * CHAPTER_GAP_SECONDS;
  return characters / NARRATED_CHARACTERS_PER_AUDIO_SECOND + gaps;
}

export type NarrationProgress = {
  /** Audio produced per second of wall clock. Above 1 is faster than listening. */
  realtimeRatio: number;
  /** Wall-clock milliseconds left, or null until there is enough signal. */
  remainingMs: number | null;
};

/**
 * Tracks narration throughput as it happens.
 *
 * A reading is only offered once `MINIMUM_SAMPLES` chunks are in, because the
 * first chunk carries one-time cost — a model load, a cold graph, a JIT warm-up
 * — and an estimate drawn from it would be wrong in the pessimistic direction
 * exactly when the user is most likely to be watching.
 */
const MINIMUM_SAMPLES = 2;

export function createNarrationMeter(totalCharacters: number) {
  let narratedCharacters = 0;
  let audioSeconds = 0;
  let elapsedMs = 0;
  let samples = 0;

  return {
    record(characters: number, producedAudioSeconds: number, chunkElapsedMs: number): void {
      narratedCharacters += characters;
      audioSeconds += producedAudioSeconds;
      elapsedMs += chunkElapsedMs;
      samples += 1;
    },

    progress(): NarrationProgress | null {
      if (samples < MINIMUM_SAMPLES || elapsedMs <= 0 || narratedCharacters <= 0) return null;
      const remainingCharacters = Math.max(0, totalCharacters - narratedCharacters);
      return {
        realtimeRatio: audioSeconds / (elapsedMs / 1000),
        remainingMs: (remainingCharacters / narratedCharacters) * elapsedMs,
      };
    },
  };
}

export type NarrationMeter = ReturnType<typeof createNarrationMeter>;

/**
 * The countdown suffix for a narration stage, or null when there is nothing
 * worth saying.
 *
 * Below a minute the answer is withheld rather than rounded up:
 * `formatDurationRounded` floors at "1m", so a short import would otherwise sit
 * on "1m left" through its final chapters and read as stuck at exactly the
 * moment it is nearly done.
 */
export function formatRemainingNarration(remainingMs: number | null | undefined): string | null {
  if (remainingMs === null || remainingMs === undefined) return null;
  if (remainingMs < 60_000) return null;
  return `${formatDurationRounded(remainingMs)} left`;
}
