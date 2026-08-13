import { KestrelClient, type KestrelSynthesis } from "./client";
import { LemonadeClient, lemonadeIsAvailable } from "./lemonade";
import type { KestrelWorkerProgress } from "./protocol";

type ProgressCallback = (progress: Omit<KestrelWorkerProgress, "type" | "id">) => void;

/** Which local engine produced a book's audio. Part of its rendition identity. */
export type NarrationEngineId = "kestrel" | "lemonade";

export type NarrationEngine = {
  id: NarrationEngineId;
  initialize(onProgress?: ProgressCallback): Promise<string>;
  synthesize(text: string, seed: number, onProgress?: ProgressCallback): Promise<KestrelSynthesis>;
  close(): void;
};

/**
 * Picks the engine for one import: Lemonade when this machine is running it,
 * the in-page Kestrel worker otherwise.
 *
 * The choice is made once per book and then held, because the engine is part of
 * the rendition key. A book that started on one engine must finish on it, or its
 * chapter timings would not match the seek map written alongside them.
 *
 * Regenerating a saved book passes `required`, which is not a preference: those
 * bytes have to match a seek map that already exists, so the wrong engine is a
 * failure rather than a fallback.
 */
export async function createNarrationEngine(
  required?: NarrationEngineId,
): Promise<NarrationEngine> {
  if (required === "kestrel") return kestrelEngine();
  const lemonadeReady = await lemonadeIsAvailable();
  if (required === "lemonade") {
    if (!lemonadeReady) {
      throw new Error(
        "This book was narrated by Lemonade. Start Lemonade on this device to rebuild its audio, or import the document as a new book.",
      );
    }
    return lemonadeEngine();
  }
  return lemonadeReady ? lemonadeEngine() : kestrelEngine();
}

function lemonadeEngine(): NarrationEngine {
  const client = new LemonadeClient();
  return {
    id: "lemonade",
    initialize: () => client.initialize(),
    synthesize: (text) => client.synthesize(text),
    close: () => client.close(),
  };
}

function kestrelEngine(): NarrationEngine {
  const client = new KestrelClient();
  return {
    id: "kestrel",
    initialize: (onProgress) => client.initialize(onProgress),
    synthesize: (text, seed, onProgress) => client.synthesize(text, seed, onProgress),
    close: () => client.close(),
  };
}
