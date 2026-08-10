type ChapterIdentity = {
  position: number;
  title: string;
  startMs: number;
  endMs: number;
};

type MediaIdentity = {
  fingerprint: string;
  fingerprintKind: string;
  renditionKey: string;
  durationMs: number;
};

/** True only when an idempotent replay describes the bytes already behind the book id. */
export function isSameLocalRegistration(
  incoming: MediaIdentity & { chapters: readonly ChapterIdentity[] },
  stored: (MediaIdentity & { chapters: readonly ChapterIdentity[] }) | null,
): boolean {
  return Boolean(
    stored &&
    incoming.fingerprint === stored.fingerprint &&
    incoming.fingerprintKind === stored.fingerprintKind &&
    incoming.renditionKey === stored.renditionKey &&
    incoming.durationMs === stored.durationMs &&
    incoming.chapters.length === stored.chapters.length &&
    incoming.chapters.every((chapter, index) => {
      const expected = stored.chapters[index];
      return (
        chapter.position === expected?.position &&
        chapter.title === expected.title &&
        chapter.startMs === expected.startMs &&
        chapter.endMs === expected.endMs
      );
    }),
  );
}
