export type PlayerChapter = {
  id: string;
  position: number;
  title: string;
  startMs: number;
  endMs: number;
};

export type PlayerBook = {
  id: string;
  title: string;
  author: string;
  durationMs: number;
  mediaUrl: string;
  coverUrl: string | null;
  coverThumbUrl?: string | null;
  chapters: PlayerChapter[];
  initialPositionMs: number;
  initialProgressOccurredAt: string | null;
  initialPlaybackRate: number;
  initialPlaybackRateOccurredAt?: string | null;
  completed: boolean;
  initialCompletedOccurredAt?: string | null;
};

export type NextInCollection = {
  id: string;
  title: string;
  collectionName: string;
};

export const CHAPTER_END_EPSILON_MS = 350;
const BOOK_END_EPSILON_MS = 1_000;

export function selectCurrentChapter(
  chapters: PlayerChapter[],
  currentTimeMs: number,
): PlayerChapter | null {
  const last = chapters[chapters.length - 1];
  if (!last) return null;
  if (currentTimeMs >= last.startMs) return last;
  let low = 0;
  let high = chapters.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (chapters[mid]!.startMs <= currentTimeMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate === -1) return null;
  const chapter = chapters[candidate]!;
  return currentTimeMs < chapter.endMs ? chapter : null;
}

export function rewindForAbsence(absenceMs: number): number {
  if (!Number.isFinite(absenceMs) || absenceMs < 60_000) return 0;
  if (absenceMs < 10 * 60_000) return 5_000;
  if (absenceMs < 60 * 60_000) return 15_000;
  return 30_000;
}

export function resolveStartPosition(input: {
  storedPositionMs: number;
  durationMs: number;
  smartRewindEnabled: boolean;
  msSinceLastPause: number | null;
}): { startAtMs: number; appliedRewindMs: number } {
  if (input.storedPositionMs >= input.durationMs - BOOK_END_EPSILON_MS) {
    return { startAtMs: 0, appliedRewindMs: 0 };
  }
  const appliedRewindMs =
    input.smartRewindEnabled && input.msSinceLastPause !== null
      ? rewindForAbsence(input.msSinceLastPause)
      : 0;
  return { startAtMs: Math.max(0, input.storedPositionMs - appliedRewindMs), appliedRewindMs };
}
