const WASM_PAGE_BYTES = 64 * 1024;

type KissFftExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  __wasm_call_ctors: () => void;
  allocate: (floatCount: number) => number;
  free: (pointer: number) => void;
  kiss_fftr_alloc: (size: number, inverse: number, memory: number, length: number) => number;
  kiss_fftr: (config: number, input: number, output: number) => void;
  kiss_fftri: (config: number, input: number, output: number) => void;
  scale: (values: number, length: number, factor: number) => void;
};

type KissFftRuntime = {
  exports: KissFftExports;
  memory: WebAssembly.Memory;
};

export type KestrelFftWorkspace = {
  time: Float32Array;
  harmonicSpectrum: Float32Array;
  noiseSpectrum: Float32Array;
  combinedSpectrum: Float32Array;
  reconstructed: Float32Array;
  forwardHarmonic: () => void;
  forwardNoise: () => void;
  inverseCombined: () => void;
};

let runtimePromise: Promise<KissFftRuntime> | null = null;
let workspacePromise: Promise<KestrelFftWorkspace> | null = null;
let runtimeBytes: Uint8Array | null = null;

export function configureKestrelFftRuntime(bytes: Uint8Array): void {
  if (runtimePromise || workspacePromise) return;
  runtimeBytes = bytes;
}

/** A single fixed-size KISS FFT workspace reused by the worker's serial render queue. */
export function getKestrelFftWorkspace(size: number): Promise<KestrelFftWorkspace> {
  workspacePromise ??= createWorkspace(size).catch((error) => {
    workspacePromise = null;
    throw error;
  });
  return workspacePromise;
}

async function createWorkspace(size: number): Promise<KestrelFftWorkspace> {
  const { exports, memory } = await loadRuntime();
  const timePointer = exports.allocate(size);
  const harmonicPointer = exports.allocate(size * 2);
  const noisePointer = exports.allocate(size * 2);
  const combinedPointer = exports.allocate(size * 2);
  const reconstructedPointer = exports.allocate(size);
  const forwardConfig = exports.kiss_fftr_alloc(size, 0, 0, 0);
  const inverseConfig = exports.kiss_fftr_alloc(size, 1, 0, 0);
  if (
    !timePointer ||
    !harmonicPointer ||
    !noisePointer ||
    !combinedPointer ||
    !reconstructedPointer ||
    !forwardConfig ||
    !inverseConfig
  ) {
    throw new Error("Kestrel could not allocate its FFT workspace.");
  }

  // Allocate every buffer before creating views: a later memory.grow would
  // detach earlier views. Rendering performs no further WASM allocations.
  const time = new Float32Array(memory.buffer, timePointer, size);
  const harmonicSpectrum = new Float32Array(memory.buffer, harmonicPointer, size * 2);
  const noiseSpectrum = new Float32Array(memory.buffer, noisePointer, size * 2);
  const combinedSpectrum = new Float32Array(memory.buffer, combinedPointer, size * 2);
  const reconstructed = new Float32Array(memory.buffer, reconstructedPointer, size);

  return {
    time,
    harmonicSpectrum,
    noiseSpectrum,
    combinedSpectrum,
    reconstructed,
    forwardHarmonic: () => exports.kiss_fftr(forwardConfig, timePointer, harmonicPointer),
    forwardNoise: () => exports.kiss_fftr(forwardConfig, timePointer, noisePointer),
    inverseCombined: () => {
      exports.kiss_fftri(inverseConfig, combinedPointer, reconstructedPointer);
      exports.scale(reconstructedPointer, size, 1 / size);
    },
  };
}

function loadRuntime(): Promise<KissFftRuntime> {
  runtimePromise ??= instantiateRuntime().catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

async function instantiateRuntime(): Promise<KissFftRuntime> {
  let memory: WebAssembly.Memory | null = null;
  const imports = {
    env: {
      emscripten_memcpy_big(destination: number, source: number, length: number) {
        new Uint8Array(memory!.buffer).copyWithin(destination, source, source + length);
        return destination;
      },
      emscripten_resize_heap(requestedBytes: number) {
        if (!memory) return 0;
        const missingBytes = requestedBytes - memory.buffer.byteLength;
        if (missingBytes <= 0) return 1;
        try {
          memory.grow(Math.ceil(missingBytes / WASM_PAGE_BYTES));
          return 1;
        } catch {
          return 0;
        }
      },
    },
    wasi_snapshot_preview1: {
      fd_close: () => 0,
      fd_seek: () => 0,
      fd_write: () => 0,
    },
  };

  if (!runtimeBytes) throw new Error("Kestrel's FFT runtime is unavailable.");
  const result = await WebAssembly.instantiate(runtimeBytes.slice().buffer, imports);
  const exports = result.instance.exports as KissFftExports;
  memory = exports.memory;
  if (!memory || typeof exports.kiss_fftr !== "function") {
    throw new Error("Kestrel's FFT runtime is invalid.");
  }
  exports.__wasm_call_ctors();
  return { exports, memory };
}
