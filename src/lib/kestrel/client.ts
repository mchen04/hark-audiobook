import type {
  KestrelWorkerProgress,
  KestrelWorkerRequest,
  KestrelWorkerResponse,
} from "./protocol";

type ProgressCallback = (progress: Omit<KestrelWorkerProgress, "type" | "id">) => void;

type PendingRequest = {
  resolve: (response: KestrelWorkerResponse) => void;
  reject: (error: Error) => void;
  onProgress?: ProgressCallback;
};

type RequestWithoutId = { type: "initialize" } | { type: "synthesize"; text: string; seed: number };

export type KestrelSynthesis = {
  audio: Float32Array;
  sampleRate: number;
  backend: "webgpu" | "wasm";
};

/** One book-scoped worker, so model weights are loaded once and then reused. */
export class KestrelClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private closed = false;

  constructor() {
    this.worker = new Worker(new URL("./runtime.worker.ts", import.meta.url), {
      type: "module",
      name: "hark-kestrel",
    });
    this.worker.onmessage = (event: MessageEvent<KestrelWorkerResponse>) =>
      this.handleMessage(event.data);
    this.worker.onerror = () => this.failAll("Kestrel stopped unexpectedly on this device.");
  }

  async initialize(onProgress?: ProgressCallback): Promise<"webgpu" | "wasm"> {
    const response = await this.request({ type: "initialize" }, onProgress);
    if (response.type !== "initialized") throw new Error("Kestrel returned an invalid response.");
    return response.backend;
  }

  async synthesize(
    text: string,
    seed: number,
    onProgress?: ProgressCallback,
  ): Promise<KestrelSynthesis> {
    const response = await this.request({ type: "synthesize", text, seed }, onProgress);
    if (response.type !== "synthesized") throw new Error("Kestrel returned an invalid response.");
    return response;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.failAll("Kestrel narration was canceled.");
  }

  private request(
    request: RequestWithoutId,
    onProgress?: ProgressCallback,
  ): Promise<KestrelWorkerResponse> {
    if (this.closed) return Promise.reject(new Error("Kestrel narration was canceled."));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...request, id } as KestrelWorkerRequest);
    });
  }

  private handleMessage(response: KestrelWorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if (response.type === "progress") {
      pending.onProgress?.({
        stage: response.stage,
        fraction: response.fraction,
        ...(response.loadedBytes === undefined ? {} : { loadedBytes: response.loadedBytes }),
        ...(response.totalBytes === undefined ? {} : { totalBytes: response.totalBytes }),
      });
      return;
    }
    this.pending.delete(response.id);
    if (response.type === "error") pending.reject(new Error(response.message));
    else pending.resolve(response);
  }

  private failAll(message: string): void {
    for (const request of this.pending.values()) request.reject(new Error(message));
    this.pending.clear();
  }
}
