import { strFromU8, unzip, type AsyncTerminable, type AsyncUnzipOptions } from "fflate";

import { throwIfAborted } from "@/lib/abort";

import { cleanMetadata } from "./document-text";
import { readFileBytes } from "./file-read";

const MAX_UNZIPPED_TEXT_BYTES = 32 * 1024 * 1024;

export async function unzipSelected(
  file: File,
  include: (name: string) => boolean,
  signal?: AbortSignal,
): Promise<Record<string, Uint8Array>> {
  throwIfAborted(signal);
  const compressed = await readFileBytes(file, signal);
  const selection = createArchiveEntrySelector(include);
  const entries = await runAbortableUnzip(
    compressed,
    { filter: (entry) => !signal?.aborted && selection.include(entry) },
    signal,
  ).catch((error) => {
    throwIfAborted(signal);
    if (error instanceof Error && /expands beyond/i.test(error.message)) throw error;
    throw new Error("Hark could not open this document archive.", { cause: error });
  });
  if (selection.exceeded()) {
    throw new Error("This document expands beyond Hark's on-device safety limit.");
  }
  const expandedBytes = Object.values(entries).reduce(
    (total, entry) => total + entry.byteLength,
    0,
  );
  if (expandedBytes > MAX_UNZIPPED_TEXT_BYTES) {
    throw new Error("This document expands beyond Hark's on-device safety limit.");
  }
  return entries;
}

type UnzipRunner = (
  data: Uint8Array,
  options: AsyncUnzipOptions,
  callback: (error: Error | null, result: Record<string, Uint8Array>) => void,
) => AsyncTerminable;

/** Owns fflate's worker terminator so abort rejects without retaining the archive. */
export function runAbortableUnzip(
  compressed: Uint8Array,
  options: AsyncUnzipOptions,
  signal?: AbortSignal,
  run: UnzipRunner = unzip,
): Promise<Record<string, Uint8Array>> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminate: AsyncTerminable = () => undefined;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      let abortError: unknown = new DOMException("The operation was canceled.", "AbortError");
      try {
        throwIfAborted(signal);
      } catch (error) {
        abortError = error;
      }
      try {
        terminate();
      } catch {
        // Cancellation owns the result; a worker teardown error cannot revive the job.
      }
      cleanup();
      reject(abortError);
    };
    terminate = run(compressed, options, (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    });
    if (!settled) {
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    }
  });
}

export function createArchiveEntrySelector(include: (name: string) => boolean) {
  let selectedBytes = 0;
  let limitExceeded = false;
  return {
    include(entry: { name: string; originalSize: number }): boolean {
      if (!include(entry.name)) return false;
      if (
        !Number.isSafeInteger(entry.originalSize) ||
        entry.originalSize < 0 ||
        selectedBytes + entry.originalSize > MAX_UNZIPPED_TEXT_BYTES
      ) {
        limitExceeded = true;
        return false;
      }
      selectedBytes += entry.originalSize;
      return true;
    },
    exceeded: () => limitExceeded,
  };
}

export function readEntry(archive: Record<string, Uint8Array>, path: string): string {
  const entry = lookupEntry(archive, path);
  if (!entry) throw new Error(`This document is missing ${path}.`);
  return strFromU8(entry);
}

export function lookupEntry(
  archive: Record<string, Uint8Array>,
  path: string,
): Uint8Array | undefined {
  const normalized = normalizeArchivePath(path);
  return archive[normalized] || archive[decodeURIComponentSafe(normalized)];
}

export function resolveArchivePath(directory: string, href: string): string {
  const withoutFragment = href.split("#", 1)[0] || "";
  return normalizeArchivePath(`${directory}${decodeURIComponentSafe(withoutFragment)}`);
}

export function xmlMetadata(document: XMLDocument, localName: string, maxLength: number): string {
  const node = document.getElementsByTagNameNS("*", localName)[0];
  return cleanMetadata(node?.textContent, maxLength);
}

function normalizeArchivePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
