import type { KestrelSpectralFrames } from "./dsp";

export type KestrelWorkerRequest =
  | { type: "initialize"; id: number }
  | { type: "synthesize"; id: number; text: string; seed: number };

export type KestrelWorkerProgress = {
  type: "progress";
  id: number;
  stage: "model" | "phonemes" | "speech";
  fraction: number;
  loadedBytes?: number;
  totalBytes?: number;
};

export type KestrelWorkerResponse =
  | KestrelWorkerProgress
  | { type: "initialized"; id: number; backend: "webgpu" | "wasm" }
  | {
      type: "synthesized";
      id: number;
      audio: Float32Array;
      sampleRate: number;
    }
  | { type: "error"; id: number; message: string };

/** Between Kestrel's worker and its audio renderer, which runs beside inference. */
export type KestrelRenderRequest =
  | { type: "configure"; fft: Uint8Array }
  | { type: "render"; id: number; frames: KestrelSpectralFrames };

export type KestrelRenderResponse =
  | { type: "ready" }
  | { type: "rendered"; id: number; audio: Float32Array }
  | { type: "render-error"; id: number; message: string };
