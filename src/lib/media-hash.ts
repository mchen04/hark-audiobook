import { createSHA256 } from "hash-wasm";

import { throwIfAborted } from "@/lib/abort";

const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export type FingerprintWorkerResponse =
  | { type: "progress"; fraction: number }
  | { type: "done"; digest: string }
  | { type: "error"; message: string };

export async function fullSha256(
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const hasher = await createSHA256();
  throwIfAborted(signal);
  hasher.init();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
    throwIfAborted(signal);
    const chunk = new Uint8Array(
      await file.slice(offset, Math.min(file.size, offset + HASH_CHUNK_BYTES)).arrayBuffer(),
    );
    throwIfAborted(signal);
    hasher.update(chunk);
    onProgress?.(Math.min(1, (offset + chunk.byteLength) / file.size));
  }
  throwIfAborted(signal);
  onProgress?.(1);
  return hasher.digest();
}
