import {
  browserNarrationSink,
  createNarrationPreview,
  type NarrationPreview,
} from "./narration-preview";

export type NarrationPreviewHandle = Pick<
  NarrationPreview,
  "enqueue" | "isReady" | "start" | "bufferedSeconds" | "stats"
> & {
  close: () => void;
};

/**
 * The preview bound to a real AudioContext, kept in its own module so the
 * library screen can load it lazily alongside the import pipeline rather than
 * shipping Web Audio to every launch.
 */
export function createBrowserNarrationPreview(sampleRate: number): NarrationPreviewHandle {
  const sink = browserNarrationSink(sampleRate);
  const preview = createNarrationPreview({ sink, sampleRate });
  return {
    enqueue: (audio) => preview.enqueue(audio),
    isReady: () => preview.isReady(),
    start: () => preview.start(),
    bufferedSeconds: () => preview.bufferedSeconds(),
    stats: () => preview.stats(),
    close: () => sink.close(),
  };
}
