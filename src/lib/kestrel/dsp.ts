import { getKestrelFftWorkspace } from "./fft";

export const KESTREL_SAMPLE_RATE = 24_000;
const FFT_SIZE = 1_200;
const HOP_SIZE = 300;
const FREQUENCY_BINS = FFT_SIZE / 2 + 1;
const HARMONICS = 64;
const ALIAS_LIMIT_HZ = KESTREL_SAMPLE_RATE / 2 - 2 * (KESTREL_SAMPLE_RATE / FFT_SIZE);
const NOISE_SCALE = 1 / Math.sqrt(0.375 * FFT_SIZE);

export type KestrelSpectralFrames = {
  f0: Float32Array;
  filterMagnitude: Float32Array;
  filterPhase: Float32Array;
  noiseEnvelope: Float32Array;
  trueFrameCount: number;
  seed: number;
};

/** Reconstructs Kestrel's source-filter spectrogram and centered ISTFT. */
export async function renderKestrelAudio(input: KestrelSpectralFrames): Promise<Float32Array> {
  const frameCount = input.f0.length;
  validateFrames(input, frameCount);
  if (frameCount === 0 || input.trueFrameCount === 0) return new Float32Array();

  const window = periodicHann();
  const excitation = harmonicExcitation(input.f0);
  const noise = gaussianNoise(frameCount * HOP_SIZE + FFT_SIZE, input.seed);
  const output = new Float32Array((frameCount + FFT_SIZE / HOP_SIZE - 1) * HOP_SIZE);
  const envelope = new Float32Array(output.length);

  const fft = await getKestrelFftWorkspace(FFT_SIZE);
  const timeData = fft.time;
  const harmonicData = fft.harmonicSpectrum;
  const noiseData = fft.noiseSpectrum;
  const combinedData = fft.combinedSpectrum;
  const reconstructedData = fft.reconstructed;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const centeredStart = frame * HOP_SIZE - FFT_SIZE / 2;
    for (let sample = 0; sample < FFT_SIZE; sample += 1) {
      const sourceIndex = centeredStart + sample;
      timeData[sample] =
        (sourceIndex >= 0 && sourceIndex < excitation.length ? excitation[sourceIndex]! : 0) *
        window[sample]!;
    }
    fft.forwardHarmonic();

    const noiseStart = frame * HOP_SIZE;
    for (let sample = 0; sample < FFT_SIZE; sample += 1) {
      timeData[sample] = noise[noiseStart + sample]! * window[sample]!;
    }
    fft.forwardNoise();

    const frameOffset = frame * FREQUENCY_BINS;
    for (let bin = 0; bin < FREQUENCY_BINS; bin += 1) {
      const complexOffset = bin * 2;
      const magnitude = input.filterMagnitude[frameOffset + bin]!;
      const phase = input.filterPhase[frameOffset + bin]!;
      const cosine = Math.cos(phase);
      const sine = Math.sin(phase);
      const sourceReal = harmonicData[complexOffset]!;
      const sourceImaginary = harmonicData[complexOffset + 1]!;
      const noiseGain = input.noiseEnvelope[frameOffset + bin]! * NOISE_SCALE;
      combinedData[complexOffset] =
        magnitude * (sourceReal * cosine - sourceImaginary * sine) +
        noiseGain * noiseData[complexOffset]!;
      combinedData[complexOffset + 1] =
        magnitude * (sourceReal * sine + sourceImaginary * cosine) +
        noiseGain * noiseData[complexOffset + 1]!;
    }
    // KISS allocates n complex slots for its real transform even though only
    // n/2+1 bins are meaningful. Clear the unused tail before the inverse.
    combinedData.fill(0, FREQUENCY_BINS * 2);
    fft.inverseCombined();

    const outputStart = frame * HOP_SIZE;
    for (let sample = 0; sample < FFT_SIZE; sample += 1) {
      const index = outputStart + sample;
      const gain = window[sample]!;
      output[index] = output[index]! + reconstructedData[sample]! * gain;
      envelope[index] = envelope[index]! + gain * gain;
    }
  }

  const trim = FFT_SIZE / 2;
  const length = input.trueFrameCount * HOP_SIZE;
  const audio = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const source = trim + index;
    audio[index] = output[source]! / Math.max(envelope[source]!, 1e-8);
  }
  return audio;
}

function validateFrames(input: KestrelSpectralFrames, frameCount: number): void {
  if (
    !Number.isInteger(input.trueFrameCount) ||
    input.trueFrameCount < 0 ||
    input.trueFrameCount > frameCount
  ) {
    throw new Error("Kestrel returned an invalid frame count.");
  }
  const expected = frameCount * FREQUENCY_BINS;
  if (
    input.filterMagnitude.length !== expected ||
    input.filterPhase.length !== expected ||
    input.noiseEnvelope.length !== expected
  ) {
    throw new Error("Kestrel returned inconsistent spectral frames.");
  }
}

function periodicHann(): Float32Array {
  return Float32Array.from(
    { length: FFT_SIZE },
    (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / FFT_SIZE),
  );
}

function harmonicExcitation(f0: Float32Array): Float32Array {
  const result = new Float32Array(f0.length * HOP_SIZE);
  let phaseStart = 0;
  for (let frame = 0; frame < f0.length; frame += 1) {
    const frequency = Math.max(0, f0[frame]!);
    const firstPhase = modulo(
      phaseStart - (2 * Math.PI * frequency * (FFT_SIZE / 2)) / KESTREL_SAMPLE_RATE,
      2 * Math.PI,
    );
    if (frequency > 10) {
      const activeHarmonics = Math.min(HARMONICS, Math.ceil(ALIAS_LIMIT_HZ / frequency) - 1);
      for (let harmonic = 1; harmonic <= activeHarmonics; harmonic += 1) {
        const step = (2 * Math.PI * frequency * harmonic) / KESTREL_SAMPLE_RATE;
        let cosine = Math.cos(harmonic * firstPhase + step * (FFT_SIZE / 2));
        let sine = Math.sin(harmonic * firstPhase + step * (FFT_SIZE / 2));
        const stepCosine = Math.cos(step);
        const stepSine = Math.sin(step);
        const amplitude = 1 / harmonic;
        const offset = frame * HOP_SIZE;
        for (let sample = 0; sample < HOP_SIZE; sample += 1) {
          result[offset + sample] = result[offset + sample]! + cosine * amplitude;
          const nextCosine = cosine * stepCosine - sine * stepSine;
          sine = sine * stepCosine + cosine * stepSine;
          cosine = nextCosine;
        }
      }
    }
    phaseStart += (2 * Math.PI * frequency * HOP_SIZE) / KESTREL_SAMPLE_RATE;
  }
  return result;
}

function gaussianNoise(length: number, seed: number): Float32Array {
  const result = new Float32Array(length);
  let state = seed >>> 0 || 0x6d2b79f5;
  const uniform = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let index = 0; index < length; index += 2) {
    const radius = Math.sqrt(-2 * Math.log(Math.max(uniform(), Number.EPSILON)));
    const angle = 2 * Math.PI * uniform();
    result[index] = radius * Math.cos(angle);
    if (index + 1 < length) result[index + 1] = radius * Math.sin(angle);
  }
  return result;
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
