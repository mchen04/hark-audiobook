import type { FingerprintWorkerResponse } from "./media-hash";
import { throwIfAborted } from "./abort";

export type MediaFingerprintKind = "sample-v1" | "sha256-v1";

const SAMPLE_BYTES = 1024 * 1024;

export async function fingerprintMedia(
  file: File,
  kind: MediaFingerprintKind,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if (kind === "sample-v1") return sampleFingerprint(file, signal);
  if (typeof Worker !== "undefined") {
    try {
      return await workerSha256(file, onProgress, signal);
    } catch {
      throwIfAborted(signal);
      return inlineSha256(file, onProgress, signal);
    }
  }
  return inlineSha256(file, onProgress, signal);
}

async function inlineSha256(
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const { fullSha256 } = await import("./media-hash");
  return fullSha256(file, onProgress, signal);
}

function workerSha256(
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./media-fingerprint.worker.ts", import.meta.url));
    let settled = false;
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      complete();
    };
    const abort = () =>
      settle(() => {
        try {
          throwIfAborted(signal);
        } catch (error) {
          reject(error);
        }
      });
    worker.onmessage = (event: MessageEvent<FingerprintWorkerResponse>) => {
      const response = event.data;
      if (response.type === "progress") onProgress?.(response.fraction);
      else if (response.type === "done") settle(() => resolve(response.digest));
      else settle(() => reject(new Error(response.message)));
    };
    worker.onerror = () => settle(() => reject(new Error("The file could not be fingerprinted.")));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    worker.postMessage(file);
  });
}

async function sampleFingerprint(file: File, signal?: AbortSignal) {
  throwIfAborted(signal);
  const head = await file.slice(0, SAMPLE_BYTES).arrayBuffer();
  throwIfAborted(signal);
  const tail = await file.slice(Math.max(0, file.size - SAMPLE_BYTES)).arrayBuffer();
  throwIfAborted(signal);
  const sizeBytes = new TextEncoder().encode(String(file.size));
  const combined = new Uint8Array(sizeBytes.length + head.byteLength + tail.byteLength);
  combined.set(sizeBytes, 0);
  combined.set(new Uint8Array(head), sizeBytes.length);
  combined.set(new Uint8Array(tail), sizeBytes.length + head.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  throwIfAborted(signal);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
