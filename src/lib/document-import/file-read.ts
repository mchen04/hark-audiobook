import { throwIfAborted } from "@/lib/abort";

/** Reads a size-bounded Blob incrementally so cancellation stops further I/O. */
export async function readFileBytes(file: File, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  const reader = file.stream().getReader();
  const bytes = new Uint8Array(file.size);
  let offset = 0;
  const cancel = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      throwIfAborted(signal);
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > bytes.byteLength) {
        throw new Error("The document changed while Hark was reading it.");
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    if (offset !== bytes.byteLength) throw new Error("Hark could not read the complete document.");
    return bytes;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Streaming UTF-8 decode bounds both peak work and cancellation latency. */
export async function readFileText(
  file: File,
  maxCharacters: number,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let characters = 0;
  const cancel = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      throwIfAborted(signal);
      if (chunk.done) break;
      const part = decoder.decode(chunk.value, { stream: true });
      characters += part.length;
      if (characters > maxCharacters) {
        throw new Error("This document is too long to convert safely on this device.");
      }
      parts.push(part);
    }
    const tail = decoder.decode();
    if (characters + tail.length > maxCharacters) {
      throw new Error("This document is too long to convert safely on this device.");
    }
    parts.push(tail);
    return parts.join("");
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
