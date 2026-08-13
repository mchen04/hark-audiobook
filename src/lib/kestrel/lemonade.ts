import type { KestrelSynthesis } from "./client";
import { KESTREL_SAMPLE_RATE } from "./dsp";

/**
 * Lemonade is AMD's local AI server. When it is running on the same machine it
 * serves stock Kokoro on the best hardware that machine has — a Ryzen AI NPU, a
 * GPU, or the CPU — through an OpenAI-compatible route on loopback.
 *
 * This is still on-device narration: loopback never leaves the machine, and the
 * document text reaches no network the user does not already own. It is an
 * alternative to running Kokoro in the page, not an alternative to running it
 * locally.
 */
const LEMONADE_ORIGIN = "http://localhost:13305";
const MODELS_URL = `${LEMONADE_ORIGIN}/api/v1/models`;
const SPEECH_URL = `${LEMONADE_ORIGIN}/api/v1/audio/speech`;

/** The model id Lemonade registers stock Kokoro under. */
export const LEMONADE_MODEL_ID = "kokoro-v1";

/** The Kokoro voice Hark narrates with, on either engine. */
export const LEMONADE_VOICE_ID = "af_heart";

/**
 * A probe must not delay an import on the overwhelmingly common machine that
 * has no Lemonade at all. A refused connection on loopback is immediate; this
 * bound only covers a server that accepts and then stalls.
 */
const PROBE_TIMEOUT_MS = 1_500;

type LemonadeModel = { id?: unknown; downloaded?: unknown };

/**
 * Whether this machine can narrate through Lemonade right now: the server
 * answers, and it already holds the Kokoro weights. A registered-but-undownloaded
 * model is deliberately not accepted — the first synthesis would otherwise
 * block on a 300 MB download with no progress to report.
 */
export async function lemonadeIsAvailable(): Promise<boolean> {
  // Any failure here means "narrate in the page instead", never "fail the
  // import" — including a stranger on this port answering with something that
  // is not JSON at all.
  try {
    const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return false;
    const models = ((await response.json()) as { data?: unknown })?.data;
    if (!Array.isArray(models)) return false;
    return models.some(
      (model: LemonadeModel) => model?.id === LEMONADE_MODEL_ID && model?.downloaded === true,
    );
  } catch {
    return false;
  }
}

/**
 * Narrates through a running Lemonade server, exposing the same surface as
 * `KestrelClient` so the import pipeline does not know which engine it holds.
 */
export class LemonadeClient {
  private readonly inFlight = new Set<AbortController>();
  private closed = false;

  /** Lemonade loads the model on first use, so there is nothing to warm here. */
  async initialize(): Promise<"lemonade"> {
    if (this.closed) throw new Error("Lemonade narration was canceled.");
    if (!(await lemonadeIsAvailable())) {
      throw new Error("Lemonade is no longer answering on this device.");
    }
    return "lemonade";
  }

  async synthesize(text: string): Promise<KestrelSynthesis> {
    if (this.closed) throw new Error("Lemonade narration was canceled.");
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      const response = await fetch(SPEECH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: LEMONADE_MODEL_ID,
          input: text,
          voice: LEMONADE_VOICE_ID,
          // Float32 mono at Hark's own sample rate, so the samples reach the
          // encoder without a resample or a decode step in between.
          response_format: "wav",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Lemonade could not narrate this passage (${response.status}).`);
      }
      return decodeFloat32Wav(await response.arrayBuffer());
    } finally {
      this.inFlight.delete(controller);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
  }
}

const RIFF = 0x46464952;
const WAVE = 0x45564157;
const FMT = 0x20746d66;
const DATA = 0x61746164;
const IEEE_FLOAT = 3;

/**
 * Reads the float32 samples out of a RIFF/WAVE buffer.
 *
 * Chunks are walked rather than assumed at fixed offsets, because a writer may
 * place `LIST` or `fact` before `data`. Anything that is not mono float32 at
 * Hark's sample rate is refused here rather than being silently resampled: a
 * wrong rate that reached the encoder would produce a book whose seek map does
 * not match its audio.
 */
export function decodeFloat32Wav(buffer: ArrayBuffer): KestrelSynthesis {
  const view = new DataView(buffer);
  if (
    buffer.byteLength < 12 ||
    view.getUint32(0, true) !== RIFF ||
    view.getUint32(8, true) !== WAVE
  ) {
    throw new Error("Lemonade returned audio Hark could not read.");
  }

  let sampleRate = 0;
  let channels = 0;
  let format = 0;
  let bitsPerSample = 0;
  let samples: Float32Array | null = null;

  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === FMT && body + 16 <= buffer.byteLength) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === DATA) {
      const length = Math.min(size, buffer.byteLength - body);
      samples = new Float32Array(length >> 2);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = view.getFloat32(body + index * 4, true);
      }
    }
    // Chunks are word-aligned: an odd size carries one trailing pad byte.
    offset = body + size + (size % 2);
  }

  if (format !== IEEE_FLOAT || bitsPerSample !== 32) {
    throw new Error("Lemonade returned audio that is not 32-bit float.");
  }
  if (channels !== 1) throw new Error("Lemonade returned audio that is not mono.");
  if (sampleRate !== KESTREL_SAMPLE_RATE) {
    throw new Error(
      `Lemonade returned ${sampleRate}Hz audio; Hark narrates at ${KESTREL_SAMPLE_RATE}Hz.`,
    );
  }
  if (!samples?.length) throw new Error("Lemonade returned no audio.");
  return { audio: samples, sampleRate };
}
