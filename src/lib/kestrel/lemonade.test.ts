import { afterEach, describe, expect, it, vi } from "vitest";

import { KESTREL_SAMPLE_RATE } from "./dsp";
import { decodeFloat32Wav, LemonadeClient, lemonadeIsAvailable } from "./lemonade";

function floatWav(
  samples: number[],
  options: { sampleRate?: number; channels?: number; format?: number; bits?: number } = {},
): ArrayBuffer {
  const { sampleRate = KESTREL_SAMPLE_RATE, channels = 1, format = 3, bits = 32 } = options;
  const dataBytes = samples.length * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bits / 8), true);
  view.setUint16(32, channels * (bits / 8), true);
  view.setUint16(34, bits, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  samples.forEach((sample, index) => view.setFloat32(44 + index * 4, sample, true));
  return buffer;
}

/** A writer that puts a LIST chunk between `fmt ` and `data`, which is legal. */
function wavWithLeadingListChunk(samples: number[]): ArrayBuffer {
  const base = new Uint8Array(floatWav(samples));
  const list = new Uint8Array(14);
  const listView = new DataView(list.buffer);
  "LIST".split("").forEach((char, index) => listView.setUint8(index, char.charCodeAt(0)));
  listView.setUint32(4, 6, true);
  const merged = new Uint8Array(base.length + list.length);
  merged.set(base.subarray(0, 36), 0);
  merged.set(list, 36);
  merged.set(base.subarray(36), 36 + list.length);
  return merged.buffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decodeFloat32Wav", () => {
  it("reads mono float samples at Hark's own sample rate", () => {
    const result = decodeFloat32Wav(floatWav([0, 0.5, -0.5, 1]));
    expect(result.sampleRate).toBe(KESTREL_SAMPLE_RATE);
    expect(Array.from(result.audio)).toEqual([0, 0.5, -0.5, 1]);
  });

  it("finds the data chunk behind a chunk it does not care about", () => {
    const result = decodeFloat32Wav(wavWithLeadingListChunk([0.25, -0.25]));
    expect(Array.from(result.audio)).toEqual([0.25, -0.25]);
  });

  it.each([
    ["a rate that would desync the seek map", { sampleRate: 48_000 }, /24000Hz/],
    ["stereo", { channels: 2 }, /not mono/i],
    ["integer samples", { format: 1, bits: 16 }, /not 32-bit float/i],
  ])("refuses %s rather than silently converting it", (_name, options, message) => {
    expect(() => decodeFloat32Wav(floatWav([0.1, 0.2], options))).toThrow(message);
  });

  it("refuses a buffer that is not RIFF/WAVE at all", () => {
    expect(() => decodeFloat32Wav(new ArrayBuffer(64))).toThrow(/could not read/i);
  });

  it("refuses a well-formed header carrying no samples", () => {
    expect(() => decodeFloat32Wav(floatWav([]))).toThrow(/no audio/i);
  });
});

describe("lemonadeIsAvailable", () => {
  it("accepts a server that already holds the Kokoro weights", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "kokoro-v1", downloaded: true }] }), {
          status: 200,
        }),
      ),
    );
    await expect(lemonadeIsAvailable()).resolves.toBe(true);
  });

  it("refuses a registered model the server has not downloaded yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "kokoro-v1", downloaded: false }] }), {
          status: 200,
        }),
      ),
    );
    await expect(lemonadeIsAvailable()).resolves.toBe(false);
  });

  it("reports no Lemonade when nothing is listening, rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(lemonadeIsAvailable()).resolves.toBe(false);
  });

  it("reports no Lemonade when the server answers with something else entirely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>not lemonade</html>", { status: 200 })),
    );
    await expect(lemonadeIsAvailable()).resolves.toBe(false);
  });
});

describe("LemonadeClient", () => {
  it("asks for float WAV, so the samples need no conversion downstream", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(floatWav([0.5, -0.5]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new LemonadeClient().synthesize("Hello.");

    expect(Array.from(result.audio)).toEqual([0.5, -0.5]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body).toMatchObject({
      model: "kokoro-v1",
      voice: "af_heart",
      response_format: "wav",
      input: "Hello.",
    });
  });

  it("surfaces the server's status when narration fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 503 })));
    await expect(new LemonadeClient().synthesize("Hello.")).rejects.toThrow(/503/);
  });

  it("refuses to start once the import that owns it was canceled", async () => {
    const client = new LemonadeClient();
    client.close();
    await expect(client.synthesize("Hello.")).rejects.toThrow(/canceled/i);
    await expect(client.initialize()).rejects.toThrow(/canceled/i);
  });

  it("aborts a synthesis that is still in flight when the import is canceled", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedSignal = init.signal ?? undefined;
        return new Promise(() => {});
      }),
    );

    const client = new LemonadeClient();
    void client.synthesize("Hello.");
    await Promise.resolve();
    client.close();

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("refuses to initialize when Lemonade stopped between the probe and the import", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(new LemonadeClient().initialize()).rejects.toThrow(/no longer answering/i);
  });
});
