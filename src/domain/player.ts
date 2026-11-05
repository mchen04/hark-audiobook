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
