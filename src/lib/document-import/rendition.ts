import type { PlayerBook } from "@/domain/player";
import type { NarrationEngineId } from "@/lib/kestrel/engine";
import { KESTREL_BUNDLE_REVISION } from "@/lib/kestrel/manifest";

export const NARRATION_CHUNK_CHARACTERS = 320;
export const GENERATED_MP3_BITRATE = 64_000;
export const KESTREL_VOICE_ID = "af_heart";

const DOCUMENT_EXTRACTION_REVISION = "extract-v2";
const SENTENCE_SPLITTER_REVISION = "split-v1";

/**
 * Both engines narrate Kokoro's `af_heart`, but they are different builds of it:
 * Hark's own split-graph export against `onnxruntime-web`, and stock
 * `kokoro-onnx` served by Lemonade. Their samples are not interchangeable, so
 * the engine names itself here. Without it, a device regenerating a book on the
 * other engine would produce a timeline that no longer matches the saved seek
 * map, and `assertSameRenditionTimeline` would refuse the bytes it had just
 * spent minutes generating.
 */
const ENGINE_REVISIONS: Record<NarrationEngineId, string> = {
  kestrel: "kestrel-fast-v1",
  lemonade: "lemonade-kokoro-v1",
};

const ENGINE_LABELS: Record<NarrationEngineId, string> = {
  kestrel: "Kestrel Fast · af_heart",
  lemonade: "Lemonade · Kokoro af_heart",
};

export function renditionKeyFor(engine: NarrationEngineId): string {
  return [
    ENGINE_REVISIONS[engine],
    KESTREL_BUNDLE_REVISION.slice(0, 16),
    DOCUMENT_EXTRACTION_REVISION,
    SENTENCE_SPLITTER_REVISION,
    `chunk${NARRATION_CHUNK_CHARACTERS}`,
    KESTREL_VOICE_ID,
    `mp3-cbr${GENERATED_MP3_BITRATE / 1_000}k`,
  ].join(":");
}

export function narratorLabelFor(engine: NarrationEngineId): string {
  return ENGINE_LABELS[engine];
}

/**
 * The engine that produced a saved book, or null when no engine in this build
 * can reproduce it — an older narration whose recipe has since changed.
 */
export function engineForRenditionKey(renditionKey: string): NarrationEngineId | null {
  const engines = Object.keys(ENGINE_REVISIONS) as NarrationEngineId[];
  return engines.find((engine) => renditionKeyFor(engine) === renditionKey) ?? null;
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
