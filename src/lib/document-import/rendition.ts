import type { PlayerBook } from "@/domain/player";
import { KESTREL_BUNDLE_REVISION } from "@/lib/kestrel/manifest";

export const NARRATION_CHUNK_CHARACTERS = 320;
export const GENERATED_MP3_BITRATE = 64_000;
export const KESTREL_VOICE_ID = "af_heart";

const DOCUMENT_EXTRACTION_REVISION = "extract-v2";
const SENTENCE_SPLITTER_REVISION = "split-v1";

/** Keep this recipe byte-for-byte stable for existing Kestrel books. */
export const NARRATION_RENDITION_KEY = [
  "kestrel-fast-v1",
  KESTREL_BUNDLE_REVISION.slice(0, 16),
  DOCUMENT_EXTRACTION_REVISION,
  SENTENCE_SPLITTER_REVISION,
  `chunk${NARRATION_CHUNK_CHARACTERS}`,
  KESTREL_VOICE_ID,
  `mp3-cbr${GENERATED_MP3_BITRATE / 1_000}k`,
].join(":");

export const NARRATOR_LABEL = "Kestrel Fast · af_heart";
export const UNAVAILABLE_RENDITION_MESSAGE =
  "This saved narration was made with an older engine. It still plays on devices that have its completed audio. Hark cannot rebuild it without changing its timing.";

/** Unknown and legacy Lemonade recipes must never reuse a Kestrel timeline. */
export function canRegenerateRendition(key: string): boolean {
  return key === NARRATION_RENDITION_KEY;
}

/** Refuses to attach bytes whose seek map differs from the saved rendition. */
export function assertSameRenditionTimeline(
  generated: Pick<PlayerBook, "durationMs" | "chapters">,
  canonical: Pick<PlayerBook, "durationMs" | "chapters">,
): void {
  const matches =
    generated.durationMs === canonical.durationMs &&
    generated.chapters.length === canonical.chapters.length &&
    generated.chapters.every((chapter, index) => {
      const expected = canonical.chapters[index];
      return (
        expected?.position === chapter.position &&
        expected.title === chapter.title &&
        expected.startMs === chapter.startMs &&
        expected.endMs === chapter.endMs
      );
    });
  if (!matches) {
    throw new Error(
      "This device generated different chapter timing for the saved rendition, so Hark did not replace its audio.",
    );
  }
}
