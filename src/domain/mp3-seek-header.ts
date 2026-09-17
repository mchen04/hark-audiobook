/**
 * Repairs the seek table an MP3 carries in its first frame.
 *
 * LAME-family encoders write a "Xing" or "Info" tag into the first MPEG frame
 * with the stream's frame count, byte count, and a 100-entry seek table (TOC).
 * Both counts are 32-bit fields. An audiobook longer than 4 GiB overflows the
 * byte count, so ffmpeg stores it modulo 2^32 and fills the TOC as if the whole
 * stream fit in that wrapped size. Browsers trust the tag: Chromium turns a seek
 * to hour 16 of a 300-hour book into a byte offset inside the first ten minutes.
 *
 * Only the tag's flags word changes. With the byte-count and TOC bits cleared,
 * every decoder falls back to the frame count for duration and to the bitrate
 * for seeking, which is exact for the constant-bitrate output these books are.
 */

const XING_FRAMES = 0x1;
const XING_BYTES = 0x2;
const XING_TOC = 0x4;
const XING_QUALITY = 0x8;

// A trailing ID3v1 or APE tag legitimately leaves the declared byte count a
// little short of the file. Anything beyond this is a broken table.
const BYTE_COUNT_TOLERANCE = 64 * 1024;
const BYTE_COUNT_TOLERANCE_RATIO = 0.01;
// How far past the ID3 tag a first frame is searched for.
const FRAME_SEARCH_WINDOW = 64 * 1024;

const BITRATES_KBPS: Record<"mpeg1" | "mpeg2", number[]> = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const SAMPLE_RATES: Record<"mpeg1" | "mpeg2" | "mpeg25", number[]> = {
  mpeg1: [44_100, 48_000, 32_000, 0],
  mpeg2: [22_050, 24_000, 16_000, 0],
  mpeg25: [11_025, 12_000, 8_000, 0],
};

export type Mp3SeekHeader = {
  /** Offset of the first MPEG frame that carries the tag. */
  frameOffset: number;
  /** Offset of the "Xing"/"Info" marker. */
  tagOffset: number;
  marker: "Xing" | "Info";
  flags: number;
  frames: number | null;
  declaredBytes: number | null;
};

export type Mp3SeekHeaderRepair =
  | { repaired: false; bytes: Uint8Array<ArrayBuffer>; reason: string }
  | {
      repaired: true;
      bytes: Uint8Array<ArrayBuffer>;
      tagOffset: number;
      declaredBytes: number;
      actualBytes: number;
      previousFlags: number;
      flags: number;
    };

/** Locates the Xing/Info tag in the first frame after any ID3v2 tags. */
export function findMp3SeekHeader(head: Uint8Array): Mp3SeekHeader | null {
  const frameOffset = findFirstFrame(head, skipId3v2(head));
  if (frameOffset === null) return null;
  const frame = parseFrameHeader(head, frameOffset);
  if (!frame) return null;
  const tagOffset = frameOffset + 4 + frame.sideInfoBytes;
  if (tagOffset + 8 > head.length) return null;
  const marker = String.fromCharCode(...head.subarray(tagOffset, tagOffset + 4));
  if (marker !== "Xing" && marker !== "Info") return null;
  const flags = readUint32(head, tagOffset + 4);
  let cursor = tagOffset + 8;
  let frames: number | null = null;
  let declaredBytes: number | null = null;
  if (flags & XING_FRAMES) {
    if (cursor + 4 > head.length) return null;
    frames = readUint32(head, cursor);
    cursor += 4;
  }
  if (flags & XING_BYTES) {
    if (cursor + 4 > head.length) return null;
    declaredBytes = readUint32(head, cursor);
  }
  return { frameOffset, tagOffset, marker, flags, frames, declaredBytes };
}

/**
 * Returns the first bytes of a file with a lying seek table disarmed. `head`
 * must start at byte 0 of the file; `fileSize` is the whole file's length.
 * The input is never mutated: a repaired result is a copy.
 */
export function repairMp3SeekHeader(
  head: Uint8Array<ArrayBuffer>,
  fileSize: number,
): Mp3SeekHeaderRepair {
  const header = findMp3SeekHeader(head);
  if (!header) return { repaired: false, bytes: head, reason: "No Xing/Info tag found." };
  if (header.declaredBytes === null) {
    return { repaired: false, bytes: head, reason: "The tag declares no byte count." };
  }
  // The Xing byte count covers the stream from the tag's own frame to the end.
  const actualBytes = fileSize - header.frameOffset;
  const tolerance = Math.max(BYTE_COUNT_TOLERANCE, actualBytes * BYTE_COUNT_TOLERANCE_RATIO);
  if (Math.abs(actualBytes - header.declaredBytes) <= tolerance) {
    return { repaired: false, bytes: head, reason: "The declared byte count matches the file." };
  }
  const flags = header.flags & ~(XING_BYTES | XING_TOC | XING_QUALITY);
  const bytes = head.slice();
  writeUint32(bytes, header.tagOffset + 4, flags);
  return {
    repaired: true,
    bytes,
    tagOffset: header.tagOffset,
    declaredBytes: header.declaredBytes,
    actualBytes,
    previousFlags: header.flags,
    flags,
  };
}

function skipId3v2(head: Uint8Array): number {
  let offset = 0;
  while (
    offset + 10 <= head.length &&
    head[offset] === 0x49 &&
    head[offset + 1] === 0x44 &&
    head[offset + 2] === 0x33 &&
    head[offset + 3]! < 0xff &&
    head[offset + 4]! < 0xff
  ) {
    const size =
      ((head[offset + 6]! & 0x7f) << 21) |
      ((head[offset + 7]! & 0x7f) << 14) |
      ((head[offset + 8]! & 0x7f) << 7) |
      (head[offset + 9]! & 0x7f);
    const footer = head[offset + 5]! & 0x10 ? 10 : 0;
    offset += 10 + size + footer;
  }
  return offset;
}

function findFirstFrame(head: Uint8Array, from: number): number | null {
  const limit = Math.min(head.length - 4, from + FRAME_SEARCH_WINDOW);
  for (let offset = from; offset <= limit; offset += 1) {
    if (head[offset] !== 0xff || (head[offset + 1]! & 0xe0) !== 0xe0) continue;
    if (parseFrameHeader(head, offset)) return offset;
  }
  return null;
}

type FrameHeader = { frameBytes: number; sideInfoBytes: number };

function parseFrameHeader(head: Uint8Array, offset: number): FrameHeader | null {
  const b1 = head[offset + 1]!;
  const b2 = head[offset + 2]!;
  const b3 = head[offset + 3]!;
  const versionBits = (b1 >> 3) & 0x3;
  const layerBits = (b1 >> 1) & 0x3;
  // Only Layer III carries a Xing/Info tag, and only Layer III is imported.
  if (versionBits === 1 || layerBits !== 1) return null;
  const version = versionBits === 3 ? "mpeg1" : versionBits === 2 ? "mpeg2" : "mpeg25";
  const bitrate = BITRATES_KBPS[version === "mpeg1" ? "mpeg1" : "mpeg2"][b2 >> 4]! * 1000;
  const sampleRate = SAMPLE_RATES[version][(b2 >> 2) & 0x3]!;
  if (!bitrate || !sampleRate) return null;
  const padding = (b2 >> 1) & 0x1;
  const mono = b3 >> 6 === 3;
  const frameBytes =
    Math.floor(((version === "mpeg1" ? 144 : 72) * bitrate) / sampleRate) + padding;
  const sideInfoBytes = version === "mpeg1" ? (mono ? 17 : 32) : mono ? 9 : 17;
  return { frameBytes, sideInfoBytes };
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) >>> 0) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function writeUint32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
