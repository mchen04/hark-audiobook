import { strFromU8, unzip } from "fflate";

import { throwIfAborted } from "@/lib/abort";

import { cleanMetadata } from "./document-text";

const MAX_UNZIPPED_TEXT_BYTES = 128 * 1024 * 1024;

export async function unzipSelected(
  file: File,
  include: (name: string) => boolean,
  signal?: AbortSignal,
): Promise<Record<string, Uint8Array>> {
  throwIfAborted(signal);
  const compressed = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);
  const selection = createArchiveEntrySelector(include);
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(
      compressed,
      { filter: (entry) => !signal?.aborted && selection.include(entry) },
      (error, result) => {
        try {
          throwIfAborted(signal);
          if (selection.exceeded()) {
            reject(new Error("This document expands beyond Hark's on-device safety limit."));
          } else if (error) reject(error);
          else resolve(result);
        } catch (abort) {
          reject(abort);
        }
      },
    );
  }).catch((error) => {
    throwIfAborted(signal);
    if (error instanceof Error && /expands beyond/i.test(error.message)) throw error;
    throw new Error("Hark could not open this document archive.", { cause: error });
  });
  const expandedBytes = Object.values(entries).reduce(
    (total, entry) => total + entry.byteLength,
    0,
  );
  if (expandedBytes > MAX_UNZIPPED_TEXT_BYTES) {
    throw new Error("This document expands beyond Hark's on-device safety limit.");
  }
  return entries;
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
