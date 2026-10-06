import type { KestrelSpectralFrames } from "./dsp";
import type { KestrelRenderRequest, KestrelRenderResponse } from "./protocol";

export type AudioRenderer = (frames: KestrelSpectralFrames) => Promise<Float32Array>;

type RenderWorker = Pick<Worker, "postMessage" | "terminate"> & {
  onmessage: ((event: MessageEvent<KestrelRenderResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

/** Chunks inferred ahead of their audio; bounds the spectral frames held in memory. */
export const RENDER_AHEAD = 2;

/** How long a new renderer may take to load before chunks render inline instead. */
export const RENDERER_START_TIMEOUT_MS = 5_000;

/**
 * Renders audio in a second worker so it overlaps the next chunk's inference.
 * Work goes to that worker only after it reports it has loaded. The same
 * renderer runs inline wherever the worker cannot start, never reports ready,
 * or stops.
 */
export function createAudioRenderer(
  startWorker: () => RenderWorker,
  renderInline: AudioRenderer,
  fft: Uint8Array,
  startTimeoutMs = RENDERER_START_TIMEOUT_MS,
): AudioRenderer {
  let worker: RenderWorker;
  try {
    worker = startWorker();
  } catch {
    return renderInline;
  }

  const unavailable = new Error("Kestrel's audio renderer stopped.");
  const pending = new Map<number, (audio: Promise<Float32Array>) => void>();
  const unsent: KestrelRenderRequest[] = [{ type: "configure", fft: fft.slice() }];
  let state: "starting" | "ready" | "failed" = "starting";
  let nextId = 1;

  const fail = () => {
    if (state === "failed") return;
    state = "failed";
    clearTimeout(startTimer);
    worker.terminate();
    unsent.length = 0;
    for (const settle of pending.values()) settle(Promise.reject(unavailable));
    pending.clear();
  };
  const startTimer = setTimeout(fail, startTimeoutMs);

  worker.onmessage = (event) => {
    const response = event.data;
    if (response.type === "ready") {
      if (state !== "starting") return;
      state = "ready";
      clearTimeout(startTimer);
      for (const message of unsent.splice(0)) worker.postMessage(message);
      return;
    }
    const settle = pending.get(response.id);
    if (!settle) return;
    pending.delete(response.id);
    settle(
      response.type === "rendered"
        ? Promise.resolve(response.audio)
        : Promise.reject(new Error(response.message)),
    );
  };
  worker.onerror = (event) => {
    event.preventDefault();
    fail();
  };

  return (frames) => {
    if (state === "failed") return renderInline(frames);
    return new Promise<Float32Array>((resolve) => {
      const id = nextId++;
      pending.set(id, (audio) =>
        resolve(
          audio.catch((error: unknown) => {
            if (error === unavailable) return renderInline(frames);
            throw error;
          }),
        ),
      );
      const message: KestrelRenderRequest = { type: "render", id, frames };
      if (state === "ready") worker.postMessage(message);
      else unsent.push(message);
    });
  };
}

/**
 * Infers chunks one after another while earlier chunks render. `inferred`
 * settles when the last chunk is inferred, so the next request can start;
 * `audio` settles with every chunk's audio in chunk order. At most
 * RENDER_AHEAD chunks of one request wait to render.
 */
export function synthesizeInOrder(
  count: number,
  infer: (index: number) => Promise<KestrelSpectralFrames>,
  render: AudioRenderer,
  onRendered: (index: number) => void,
): { inferred: Promise<void>; audio: Promise<Float32Array[]> } {
  const rendered: Promise<Float32Array>[] = [];
  const inferred = (async () => {
    for (let index = 0; index < count; index += 1) {
      if (index >= RENDER_AHEAD) await rendered[index - RENDER_AHEAD];
      const audio = render(await infer(index)).then((samples) => {
        onRendered(index);
        return samples;
      });
      // Awaited through `audio`; this only keeps an early failure from surfacing as unhandled.
      audio.catch(() => undefined);
      rendered.push(audio);
    }
  })();
  const audio = inferred.then(() => Promise.all(rendered));
  inferred.catch(() => undefined);
  return { inferred, audio };
}
