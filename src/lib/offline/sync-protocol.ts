type PulledMedia = {
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  fingerprint: string;
  fingerprintKind: string;
  renditionKey?: string;
  durationMs: number;
};

type PulledChapter = {
  position: number;
  title: string;
  startMs: number;
  endMs: number;
};

export type PulledBook = {
  id: string;
  title: string;
  author: string;
  narrator: string | null;
  description: string | null;
  series: string | null;
  seriesPosition: string | null;
  chapterDiagnostic: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  media: PulledMedia | null;
  chapters: PulledChapter[];
  tagIds: string[];
};

export type PulledPlaybackState = {
  bookId: string;
  positionMs: number;
  playbackRate: number;
  completed: boolean;
  deviceId: string;
  deviceSequence: number;
  eventOccurredAt: string;
  playbackRateOccurredAt?: string;
  completedOccurredAt?: string;
  stateOccurredAt?: string;
  updatedAt: string;
};

export type PulledTag = { id: string; name: string };

export type PulledCollection = {
  id: string;
  name: string;
  updatedAt: string;
  books: { bookId: string; position: number }[];
};

type PulledPreferences = {
  skipBackMs: number;
  skipForwardMs: number;
  smartRewind: boolean;
  autoplayNextInCollection: boolean;
  updatedAt: string;
};

export type PulledListeningSession = {
  id: string;
  bookId: string;
  startedAt: string;
  endedAt: string;
  startPositionMs: number;
  endPositionMs: number;
  listenedMs: number;
};

export type PulledTombstone = {
  bookId: string;
  deletedAt: string;
};

export type PullBatch = {
  since: string | null;
  cursor: string;
  complete: boolean;
  books: PulledBook[];
  playbackStates: PulledPlaybackState[];
  tags: PulledTag[];
  collections: PulledCollection[];
  preferences: PulledPreferences | null;
  listeningSessions: PulledListeningSession[];
  liveBookIds: string[] | null;
  tombstones?: PulledTombstone[];
};

export function isPullBatch(value: unknown): value is PullBatch {
  const batch = value as PullBatch | null;
  return (
    !!batch &&
    (batch.since === null || typeof batch.since === "string") &&
    typeof batch.cursor === "string" &&
    typeof batch.complete === "boolean" &&
    Array.isArray(batch.books) &&
    batch.books.every(isPulledBook) &&
    Array.isArray(batch.playbackStates) &&
    batch.playbackStates.every(isPulledPlaybackState) &&
    Array.isArray(batch.tags) &&
    Array.isArray(batch.collections) &&
    batch.collections.every((entry) => Array.isArray(entry?.books)) &&
    Array.isArray(batch.listeningSessions) &&
    (batch.preferences === null || typeof batch.preferences === "object") &&
    (batch.liveBookIds === null ||
      (Array.isArray(batch.liveBookIds) &&
        batch.liveBookIds.every((id) => typeof id === "string"))) &&
    (batch.tombstones === undefined ||
      (Array.isArray(batch.tombstones) && batch.tombstones.every(isPulledTombstone)))
  );
}

function isPulledPlaybackState(value: unknown): value is PulledPlaybackState {
  const state = value as PulledPlaybackState | null;
  return (
    !!state &&
    typeof state.bookId === "string" &&
    typeof state.positionMs === "number" &&
    typeof state.playbackRate === "number" &&
    typeof state.completed === "boolean" &&
    typeof state.deviceId === "string" &&
    typeof state.deviceSequence === "number" &&
    typeof state.eventOccurredAt === "string" &&
    (state.playbackRateOccurredAt === undefined ||
      typeof state.playbackRateOccurredAt === "string") &&
    (state.completedOccurredAt === undefined || typeof state.completedOccurredAt === "string") &&
    (state.stateOccurredAt === undefined || typeof state.stateOccurredAt === "string") &&
    typeof state.updatedAt === "string"
  );
}

function isPulledTombstone(value: unknown): value is PulledTombstone {
  const tombstone = value as PulledTombstone | null;
  return (
    !!tombstone && typeof tombstone.bookId === "string" && typeof tombstone.deletedAt === "string"
  );
}

function isPulledBook(value: unknown): value is PulledBook {
  const book = value as PulledBook | null;
  return (
    !!book &&
    typeof book.id === "string" &&
    typeof book.title === "string" &&
    typeof book.updatedAt === "string" &&
    Array.isArray(book.chapters) &&
    Array.isArray(book.tagIds)
  );
}
