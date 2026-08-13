import {
  browserNarrationSink,
  createNarrationPreview,
  type NarrationPreview,
} from "./narration-preview";

export type NarrationPreviewHandle = NarrationPreview & { close: () => void };

/**
 * The preview bound to a real AudioContext, kept in its own module so the
 * library screen can load it lazily alongside the import pipeline rather than
 * shipping Web Audio to every launch.
 */
export function createBrowserNarrationPreview(sampleRate: number): NarrationPreviewHandle {
  const sink = browserNarrationSink(sampleRate);
  return { ...createNarrationPreview({ sink, sampleRate }), close: sink.close };
}
