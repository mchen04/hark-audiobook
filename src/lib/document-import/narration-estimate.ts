import { formatDurationRounded } from "@/lib/format-time";

const NARRATED_CHARACTERS_PER_AUDIO_SECOND = 16.2;

const CHAPTER_GAP_SECONDS = 0.4;

export function estimateNarrationSeconds(characters: number, chapterCount: number): number {
  if (characters <= 0) return 0;
  const gaps = Math.max(0, chapterCount - 1) * CHAPTER_GAP_SECONDS;
  return characters / NARRATED_CHARACTERS_PER_AUDIO_SECOND + gaps;
}

const MINIMUM_SAMPLES = 2;

export function createNarrationMeter(totalCharacters: number) {
  let narratedCharacters = 0;
  let elapsedMs = 0;
  let samples = 0;

  return {
    record(characters: number, chunkElapsedMs: number): void {
      narratedCharacters += characters;
      elapsedMs += chunkElapsedMs;
      samples += 1;
    },

    remainingMs(): number | null {
      if (samples < MINIMUM_SAMPLES || elapsedMs <= 0 || narratedCharacters <= 0) return null;
      const remainingCharacters = Math.max(0, totalCharacters - narratedCharacters);
      return (remainingCharacters / narratedCharacters) * elapsedMs;
    },
  };
}

export function formatRemainingNarration(remainingMs: number | null | undefined): string | null {
  if (remainingMs === null || remainingMs === undefined) return null;
  if (remainingMs < 60_000) return null;
  return `${formatDurationRounded(remainingMs)} left`;
}
