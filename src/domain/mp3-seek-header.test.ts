import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findMp3SeekHeader, repairMp3SeekHeader } from "./mp3-seek-header";

const FRAME_BYTES = 192; // MPEG-2 Layer III, 64 kbps, 24 kHz, no padding.
const FRAME_SECONDS = 576 / 24_000;

type HeadOptions = {
  id3Bytes?: number;
  frames?: number;
  declaredBytes?: number;
  flags?: number;
  marker?: string;
  stereoMpeg1?: boolean;
};

/**
 * Builds the first bytes of a file the way ffmpeg + libmp3lame lay them out:
 * an ID3v2.3 tag, then one 192-byte Info frame whose seek table is followed by
 * a few ordinary frames.
 */
function buildHead({
  id3Bytes = 4_000,
  frames = 45_191_770,
  declaredBytes,
  flags = 0xf,
  marker = "Info",
  stereoMpeg1 = false,
}: HeadOptions = {}): { head: Uint8Array<ArrayBuffer>; frameOffset: number; tagOffset: number } {
  const id3 = new Uint8Array(10 + id3Bytes);
  id3.set([0x49, 0x44, 0x33, 3, 0, 0]);
  id3[6] = (id3Bytes >> 21) & 0x7f;
  id3[7] = (id3Bytes >> 14) & 0x7f;
  id3[8] = (id3Bytes >> 7) & 0x7f;
  id3[9] = id3Bytes & 0x7f;

  const frameBytes = stereoMpeg1 ? 417 : FRAME_BYTES;
  const frame = new Uint8Array(frameBytes);
  // MPEG-1 Layer III 128 kbps 44.1 kHz joint stereo, or MPEG-2 64 kbps 24 kHz mono.
  frame.set(stereoMpeg1 ? [0xff, 0xfb, 0x90, 0x40] : [0xff, 0xf3, 0x84, 0xc0]);
  const tagOffset = 4 + (stereoMpeg1 ? 32 : 9);
  frame.set(
    [...marker].map((c) => c.charCodeAt(0)),
    tagOffset,
  );
  const view = new DataView(frame.buffer);
  view.setUint32(tagOffset + 4, flags);
  view.setUint32(tagOffset + 8, frames);
  view.setUint32(tagOffset + 12, declaredBytes ?? (frames + 1) * frameBytes);
  frame.fill(0xff, tagOffset + 16, tagOffset + 116);
  view.setUint32(tagOffset + 116, 100);

  const audio = new Uint8Array(frameBytes * 3);
  for (let index = 0; index < 3; index += 1) {
    audio.set(
      stereoMpeg1 ? [0xff, 0xfb, 0x90, 0x40] : [0xff, 0xf3, 0x84, 0xc0],
      index * frameBytes,
    );
    audio.fill(0x5a, index * frameBytes + 4, (index + 1) * frameBytes);
  }

  const head = new Uint8Array(id3.length + frame.length + audio.length);
  head.set(id3);
  head.set(frame, id3.length);
  head.set(audio, id3.length + frame.length);
  return { head, frameOffset: id3.length, tagOffset: id3.length + tagOffset };
}

function flagsAt(bytes: Uint8Array, tagOffset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(tagOffset + 4);
}

describe("findMp3SeekHeader", () => {
  it("locates the Info tag behind the ID3 tag and the side info", () => {
    const { head, frameOffset, tagOffset } = buildHead({ declaredBytes: 86_885_440 });
    expect(findMp3SeekHeader(head)).toEqual({
      frameOffset,
      tagOffset,
      marker: "Info",
      flags: 0xf,
      frames: 45_191_770,
      declaredBytes: 86_885_440,
    });
  });

  it("honors the wider MPEG-1 stereo side info", () => {
    const { head, tagOffset } = buildHead({ stereoMpeg1: true, marker: "Xing" });
    expect(findMp3SeekHeader(head)?.tagOffset).toBe(tagOffset);
    expect(findMp3SeekHeader(head)?.marker).toBe("Xing");
  });

  it("returns null without a tag", () => {
    const { head } = buildHead({ marker: "Nope" });
    expect(findMp3SeekHeader(head)).toBeNull();
    expect(findMp3SeekHeader(new Uint8Array([0x49, 0x44, 0x33]))).toBeNull();
  });
});

describe("repairMp3SeekHeader", () => {
  it("disarms a byte count that wrapped past 32 bits", () => {
    const frames = 45_191_770;
    const streamBytes = (frames + 1) * FRAME_BYTES;
    const wrapped = streamBytes % 2 ** 32;
    const { head, frameOffset, tagOffset } = buildHead({ frames, declaredBytes: wrapped });
    const fileSize = frameOffset + streamBytes;
    expect(wrapped).toBeLessThan(streamBytes);
    expect(frames * FRAME_SECONDS).toBeCloseTo(1_084_602.48, 1);

    const repair = repairMp3SeekHeader(head, fileSize);
    expect(repair.repaired).toBe(true);
    if (!repair.repaired) return;
    expect(repair).toMatchObject({
      tagOffset,
      declaredBytes: wrapped,
      actualBytes: streamBytes,
      previousFlags: 0xf,
      flags: 0x1,
    });
    expect(flagsAt(repair.bytes, tagOffset)).toBe(0x1);
    // Only the flags word changes; the frame count and every audio byte stay.
    const differences = [...repair.bytes].flatMap((byte, index) =>
      byte === head[index] ? [] : [index],
    );
    expect(differences).toEqual([tagOffset + 7]);
    expect(flagsAt(head, tagOffset)).toBe(0xf);
    expect(findMp3SeekHeader(repair.bytes)?.frames).toBe(frames);
  });

  it("keeps a table whose byte count matches the file", () => {
    const { head, frameOffset } = buildHead({ frames: 1_000 });
    const repair = repairMp3SeekHeader(head, frameOffset + 1_001 * FRAME_BYTES);
    expect(repair.repaired).toBe(false);
    expect(repair.bytes).toBe(head);
  });

  it("tolerates a trailing ID3v1 tag the byte count omits", () => {
    const { head, frameOffset } = buildHead({ frames: 1_000 });
    expect(repairMp3SeekHeader(head, frameOffset + 1_001 * FRAME_BYTES + 128).repaired).toBe(false);
  });

  it("leaves files without a table alone", () => {
    const { head } = buildHead({ marker: "Nope" });
    expect(repairMp3SeekHeader(head, 10 ** 10).repaired).toBe(false);
    expect(repairMp3SeekHeader(new Uint8Array(0), 10 ** 10).repaired).toBe(false);
  });

  it("clears the byte count even when no frame count is present", () => {
    const { head, tagOffset } = buildHead({ flags: 0x2, declaredBytes: 5 });
    const repair = repairMp3SeekHeader(head, 10 ** 10);
    expect(repair.repaired).toBe(true);
    expect(flagsAt(repair.bytes, tagOffset)).toBe(0);
  });
});

// The book that surfaced this: 693 chapters, 301 hours, 8.68 GB. When the file
// is on this machine, the repair must reproduce the hand-patched copy exactly.
const sourceMp3 = path.join(homedir(), "Downloads", "A-Practical-Guide-to-Evil-complete.mp3");
const patchedMp3 = path.join(
  homedir(),
  "Downloads",
  "A-Practical-Guide-to-Evil-complete-seek-fixed.mp3",
);

function readHead(file: string, bytes: number): Uint8Array<ArrayBuffer> {
  const buffer = new Uint8Array(bytes);
  const fd = openSync(file, "r");
  try {
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

describe.skipIf(!existsSync(sourceMp3))("A Practical Guide to Evil", () => {
  it("disarms the wrapped byte count at byte 48227", () => {
    const head = readHead(sourceMp3, 64 * 1024);
    const repair = repairMp3SeekHeader(head, statSync(sourceMp3).size);
    expect(repair).toMatchObject({
      repaired: true,
      tagOffset: 48_220,
      declaredBytes: 86_885_440,
      actualBytes: 8_676_820_032,
      previousFlags: 0xf,
      flags: 0x1,
    });
    if (!repair.repaired) return;
    expect(repair.bytes[48_227]).toBe(1);
    expect(head[48_227]).toBe(0xf);
    if (existsSync(patchedMp3)) {
      expect(Buffer.from(repair.bytes).equals(readHead(patchedMp3, 64 * 1024))).toBe(true);
    }
  });
});
