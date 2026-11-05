import { renderKestrelAudio, type KestrelSpectralFrames } from "./dsp";
import { configureKestrelFftRuntime } from "./fft";
import type { KestrelRenderRequest, KestrelRenderResponse } from "./protocol";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<KestrelRenderRequest>) => void) | null;
  postMessage: (message: KestrelRenderResponse, transfer?: Transferable[]) => void;
};

let renderTail = Promise.resolve();

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type === "configure") {
    configureKestrelFftRuntime(request.fft);
    return;
  }
  renderTail = renderTail.then(() => render(request.id, request.frames));
};

workerScope.postMessage({ type: "ready" });

async function render(id: number, frames: KestrelSpectralFrames): Promise<void> {
  try {
    const audio = await renderKestrelAudio(frames);
    workerScope.postMessage({ type: "rendered", id, audio }, [audio.buffer]);
  } catch (error) {
    workerScope.postMessage({
      type: "render-error",
      id,
      message: error instanceof Error ? error.message : "Kestrel could not render audio.",
    });
  }
}
