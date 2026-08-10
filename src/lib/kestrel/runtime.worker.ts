import * as ort from "onnxruntime-web/webgpu";

import { KESTREL_ASSETS, loadKestrelAssets } from "./assets";
import { KESTREL_SAMPLE_RATE, renderKestrelAudio } from "./dsp";
import { configureKestrelFftRuntime } from "./fft";
import type { KestrelWorkerRequest, KestrelWorkerResponse } from "./protocol";
import { prepareKestrelText, type KestrelTextChunk } from "./text";

type Sessions = {
  encode: ort.InferenceSession;
  frames: ort.InferenceSession;
  decoder: ort.InferenceSession;
  voice: Float32Array;
  backend: "webgpu" | "wasm";
};

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<KestrelWorkerRequest>) => void) | null;
  postMessage: (message: KestrelWorkerResponse, transfer?: Transferable[]) => void;
};

let sessionsPromise: Promise<Sessions> | null = null;
let requestTail = Promise.resolve();

workerScope.onmessage = (event) => {
  const request = event.data;
  requestTail = requestTail.then(() => handleRequest(request)).catch(() => undefined);
};

async function handleRequest(request: KestrelWorkerRequest): Promise<void> {
  try {
    const sessions = await getSessions(request.id);
    if (request.type === "initialize") {
      post({ type: "initialized", id: request.id, backend: sessions.backend });
      return;
    }

    post({ type: "progress", id: request.id, stage: "phonemes", fraction: 0 });
    const chunks = await prepareKestrelText(request.text);
    if (chunks.length === 0) throw new Error("This section does not contain readable text.");
    post({ type: "progress", id: request.id, stage: "phonemes", fraction: 1 });

    const parts: Float32Array[] = [];
    let totalSamples = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const audio = await synthesizeChunk(sessions, chunks[index]!, request.seed + index);
      parts.push(audio);
      totalSamples += audio.length;
      post({
        type: "progress",
        id: request.id,
        stage: "speech",
        fraction: (index + 1) / chunks.length,
      });
    }

    const audio = concatenate(parts, totalSamples);
    workerScope.postMessage(
      {
        type: "synthesized",
        id: request.id,
        audio,
        sampleRate: KESTREL_SAMPLE_RATE,
      },
      [audio.buffer],
    );
  } catch (error) {
    post({
      type: "error",
      id: request.id,
      message: friendlyError(error),
    });
  }
}

function getSessions(requestId: number): Promise<Sessions> {
  sessionsPromise ??= initializeSessions(requestId).catch((error) => {
    sessionsPromise = null;
    throw error;
  });
  return sessionsPromise;
}

async function initializeSessions(requestId: number): Promise<Sessions> {
  ort.env.logLevel = "error";
  // This runtime already lives in a dedicated worker. A second ORT proxy and
  // cross-origin-isolation-only pthreads add overhead without more parallelism.
  ort.env.wasm.proxy = false;
  ort.env.wasm.numThreads = 1;

  const assets = await loadKestrelAssets(({ loadedBytes, totalBytes }) =>
    post({
      type: "progress",
      id: requestId,
      stage: "model",
      fraction: loadedBytes / totalBytes,
      loadedBytes,
      totalBytes,
    }),
  );
  configureKestrelFftRuntime(assets.fft);

  const voice = readVoice(assets.voice);
  const canUseWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
  if (canUseWebGpu) {
    try {
      return await createSessions(
        "webgpu",
        ["webgpu", "wasm"],
        assets.prosodyEncode,
        assets.prosodyFrames,
        assets.decoderHead,
        assets,
        voice,
      );
    } catch {
      // Unsupported WebGPU operators and driver limits vary by device. WASM
      // executes the same graph and remains the universal local fallback.
    }
  }
  return createSessions(
    "wasm",
    ["wasm"],
    assets.prosodyEncode,
    assets.prosodyFrames,
    assets.decoderHead,
    assets,
    voice,
  );
}

async function createSessions(
  backend: "webgpu" | "wasm",
  executionProviders: ort.InferenceSession.ExecutionProviderConfig[],
  encodeGraph: Uint8Array,
  framesGraph: Uint8Array,
  decoderGraph: Uint8Array,
  assets: Awaited<ReturnType<typeof loadKestrelAssets>>,
  voice: Float32Array,
): Promise<Sessions> {
  const common = {
    executionProviders,
    graphOptimizationLevel: "all" as const,
    executionMode: "sequential" as const,
  };
  const prosodyExternalData = [
    {
      path: externalPathFor("prosody"),
      data: assets.prosody,
    },
  ];
  const encode = await ort.InferenceSession.create(encodeGraph, {
    ...common,
    externalData: prosodyExternalData,
  });
  try {
    const frames = await ort.InferenceSession.create(framesGraph, {
      ...common,
      externalData: prosodyExternalData,
    });
    try {
      const decoder = await ort.InferenceSession.create(decoderGraph, {
        ...common,
        externalData: [
          { path: externalPathFor("decoder"), data: assets.decoder },
          { path: externalPathFor("head"), data: assets.head },
        ],
      });
      return { encode, frames, decoder, voice, backend };
    } catch (error) {
      await frames.release();
      throw error;
    }
  } catch (error) {
    await encode.release();
    throw error;
  }
}

async function synthesizeChunk(
  sessions: Sessions,
  chunk: KestrelTextChunk,
  seed: number,
): Promise<Float32Array> {
  const ids = new BigInt64Array(512);
  ids.set(chunk.ids);
  const style = styleFor(sessions.voice, chunk.phonemeCount);
  const styleTensor = new ort.Tensor("float32", style, [1, 256]);
  const encodeResults = await sessions.encode.run({
    input_ids: new ort.Tensor("int64", ids, [1, 512]),
    style: styleTensor,
  });
  const encoded = encodeResults.encoded!;
  const durations = encodeResults.durations!;
  try {
    const alignment = buildAlignment(durations.data as Float32Array, chunk.ids.length);
    const frameResults = await sessions.frames.run({
      encoded,
      style: styleTensor,
      frame_phoneme_indices: new ort.Tensor("int64", alignment.frameIndices, [
        1,
        alignment.paddedFrames80,
      ]),
      text_phoneme_indices: new ort.Tensor("int64", alignment.textIndices, [
        1,
        alignment.paddedFrames80 / 2,
      ]),
      phoneme_positions: new ort.Tensor("float32", alignment.positions, [
        1,
        alignment.paddedFrames80,
      ]),
      log_durations: new ort.Tensor("float32", alignment.logDurations, [
        1,
        alignment.paddedFrames80,
      ]),
    });
    const f0 = frameResults.f0!;
    const energy = frameResults.energy!;
    const textFeatures = frameResults.text_features!;
    const decoderStyle = new ort.Tensor("float32", style.subarray(0, 128), [1, 128]);
    try {
      const decoderResults = await sessions.decoder.run({
        text_features: textFeatures,
        f0,
        energy,
        style: decoderStyle,
      });
      try {
        return await renderKestrelAudio({
          f0: f0.data as Float32Array,
          filterMagnitude: decoderResults.filter_magnitude!.data as Float32Array,
          filterPhase: decoderResults.filter_phase!.data as Float32Array,
          noiseEnvelope: decoderResults.noise_envelope!.data as Float32Array,
          trueFrameCount: alignment.trueFrames80,
          seed,
        });
      } finally {
        Object.values(decoderResults).forEach((tensor) => tensor.dispose());
      }
    } finally {
      decoderStyle.dispose();
      Object.values(frameResults).forEach((tensor) => tensor.dispose());
    }
  } finally {
    styleTensor.dispose();
    Object.values(encodeResults).forEach((tensor) => tensor.dispose());
  }
}

function buildAlignment(durationValues: Float32Array, tokenCount: number) {
  const durations = Array.from({ length: tokenCount }, (_, index) =>
    Math.max(1, Math.min(100, Math.round(durationValues[index]!))),
  );
  const trueFrames40 = durations.reduce((total, duration) => total + duration, 0);
  const trueFrames80 = trueFrames40 * 2;
  const paddedFrames80 = Math.ceil(trueFrames80 / 256) * 256;
  const frameIndices = new BigInt64Array(paddedFrames80);
  const textIndices = new BigInt64Array(paddedFrames80 / 2);
  const positions = new Float32Array(paddedFrames80);
  const logDurations = new Float32Array(paddedFrames80);
  let cursor40 = 0;
  let cursor80 = 0;
  durations.forEach((duration, tokenIndex) => {
    for (let index = 0; index < duration; index += 1) {
      textIndices[cursor40++] = BigInt(tokenIndex);
    }
    const doubled = duration * 2;
    for (let index = 0; index < doubled; index += 1) {
      frameIndices[cursor80] = BigInt(tokenIndex);
      positions[cursor80] = doubled > 1 ? index / (doubled - 1) : 0;
      logDurations[cursor80] = Math.log(doubled);
      cursor80 += 1;
    }
  });
  return {
    frameIndices,
    textIndices,
    positions,
    logDurations,
    trueFrames80,
    paddedFrames80,
  };
}

function styleFor(voice: Float32Array, phonemeCount: number): Float32Array {
  const row = Math.max(0, Math.min(509, phonemeCount - 1));
  return voice.subarray(row * 256, (row + 1) * 256);
}

function readVoice(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength < 12) throw new Error("Kestrel's voice file is invalid.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = Number(view.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))) as {
    voice?: { dtype?: string; shape?: number[]; data_offsets?: number[] };
  };
  const tensor = header.voice;
  if (
    tensor?.dtype !== "F32" ||
    tensor.shape?.join(",") !== "510,1,256" ||
    tensor.data_offsets?.[0] !== 0 ||
    tensor.data_offsets?.[1] !== 510 * 256 * 4
  ) {
    throw new Error("Kestrel's voice tensor is invalid.");
  }
  const start = 8 + headerLength;
  const data = bytes.slice(start, start + 510 * 256 * 4);
  return new Float32Array(data.buffer);
}

function externalPathFor(id: "prosody" | "decoder" | "head"): string {
  const path = KESTREL_ASSETS.find((asset) => asset.id === id)?.externalPath;
  if (!path) throw new Error(`Kestrel's ${id} external-data path is missing.`);
  return path;
}

function concatenate(parts: Float32Array[], totalLength: number): Float32Array {
  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

function friendlyError(error: unknown): string {
  if (error instanceof Error && /Kestrel|readable text/i.test(error.message)) return error.message;
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return "Connect once so Hark can download Kestrel to this device.";
  }
  return "Kestrel could not narrate this section on this device.";
}

function post(message: KestrelWorkerResponse): void {
  workerScope.postMessage(message);
}
