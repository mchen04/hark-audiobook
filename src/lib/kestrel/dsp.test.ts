import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import { renderKestrelAudio } from "./dsp";
import { configureKestrelFftRuntime, getKestrelFftWorkspace } from "./fft";

beforeAll(async () => {
  const wasm = await readFile("node_modules/kissfft-wasm/lib/kissfft.wasm");
  configureKestrelFftRuntime(wasm);
});

describe("Kestrel browser DSP", () => {
  it("round-trips a real signal through the vendored KISS FFT runtime", async () => {
    const fft = await getKestrelFftWorkspace(1_200);
    const expected = Float32Array.from({ length: 1_200 }, (_, index) =>
      Math.cos((2 * Math.PI * 10 * index) / 1_200),
    );
    fft.time.set(expected);

    fft.forwardHarmonic();
    fft.combinedSpectrum.set(fft.harmonicSpectrum);
    fft.inverseCombined();

    const maxError = expected.reduce(
      (error, value, index) => Math.max(error, Math.abs(value - fft.reconstructed[index]!)),
      0,
    );
    expect(maxError).toBeLessThan(1e-5);
  });

  it("renders finite, deterministic audio at the true unpadded frame length", async () => {
    const frameCount = 8;
    const bins = 601;
    const input = {
      f0: new Float32Array(frameCount).fill(180),
      filterMagnitude: new Float32Array(frameCount * bins).fill(0.01),
      filterPhase: new Float32Array(frameCount * bins),
      noiseEnvelope: new Float32Array(frameCount * bins).fill(0.001),
      trueFrameCount: 5,
      seed: 42,
    };

    const first = await renderKestrelAudio(input);
    const second = await renderKestrelAudio(input);

    expect(first).toHaveLength(5 * 300);
    expect(first).toEqual(second);
    expect(first.every(Number.isFinite)).toBe(true);
    expect(first.some((sample) => Math.abs(sample) > 1e-6)).toBe(true);
  });

  it("rejects inconsistent model output before touching the FFT runtime", async () => {
    await expect(
      renderKestrelAudio({
        f0: new Float32Array(2),
        filterMagnitude: new Float32Array(1),
        filterPhase: new Float32Array(1),
        noiseEnvelope: new Float32Array(1),
        trueFrameCount: 2,
        seed: 1,
      }),
    ).rejects.toThrow(/inconsistent spectral frames/i);
  });
});
