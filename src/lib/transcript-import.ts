import type { IAudioMetadata } from "music-metadata";

import {
  interpretTranscriptBytes,
  MAX_COMPRESSED_TRANSCRIPT_BYTES,
  maxDecompressedTranscriptBytes,
  TRANSCRIPT_GEOB_DESCRIPTION,
  TranscriptParseError,
  type BookTranscript,
} from "@/domain/transcript";

type GeobFrame = {
  type?: string;
  filename?: string;
  description?: string;
  data?: Uint8Array;
};

export async function extractTranscript(
  metadata: IAudioMetadata,
  durationMs: number,
): Promise<BookTranscript | null> {
  const frame = findTranscriptFrame(metadata);
  if (!frame) return null;
  if (!frame.data || frame.data.byteLength === 0) {
    throw new TranscriptParseError("Transcript rejected: empty GEOB payload");
  }
  if (frame.data.byteLength > MAX_COMPRESSED_TRANSCRIPT_BYTES) {
    throw new TranscriptParseError(
      `Transcript rejected: compressed frame of ${frame.data.byteLength} bytes exceeds the cap`,
    );
  }
  const bytes = await gunzip(frame.data, maxDecompressedTranscriptBytes(durationMs));
  return interpretTranscriptBytes(bytes, durationMs);
}

function findTranscriptFrame(metadata: IAudioMetadata): GeobFrame | null {
  for (const [tagType, tags] of Object.entries(metadata.native)) {
    if (!tagType.startsWith("ID3v2.")) continue;
    for (const tag of tags) {
      if (tag.id !== "GEOB") continue;
      const value = tag.value as GeobFrame | null;
      if (value && value.description === TRANSCRIPT_GEOB_DESCRIPTION) return value;
    }
  }
  return null;
}

async function gunzip(compressed: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new TranscriptParseError("Transcript rejected: gzip decoding is unavailable");
  }
  let oversized = false;
  try {
    const stream = new Response(new Uint8Array(compressed)).body!.pipeThrough(
      new DecompressionStream("gzip"),
    );
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        oversized = true;
        await reader.cancel();
        throw new Error("oversized");
      }
      chunks.push(value);
    }
    if (total === 0) throw new Error("empty");
    const inflated = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      inflated.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return inflated;
  } catch {
    throw new TranscriptParseError(
      oversized
        ? "Transcript rejected: decompressed size exceeds the cap for this duration"
        : "Transcript rejected: invalid gzip payload",
    );
  }
}
