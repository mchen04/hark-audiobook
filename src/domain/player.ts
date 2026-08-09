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
  /** Downscaled cover for small surfaces; absent on older stored books. */
  coverThumbUrl?: string | null;
  chapters: PlayerChapter[];
  initialPositionMs: number;
  initialProgressOccurredAt: string | null;
  initialPlaybackRate: number;
  /** Absent on stored books created before playback fields had separate clocks. */
  initialPlaybackRateOccurredAt?: string | null;
  completed: boolean;
  /** Absent on stored books created before playback fields had separate clocks. */
  initialCompletedOccurredAt?: string | null;
};

export type NextInCollection = {
  id: string;
  title: string;
  collectionName: string;
};
