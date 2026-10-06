import { describe, expect, it, vi } from "vitest";

import type { KestrelSpectralFrames } from "./dsp";
import type { KestrelRenderRequest, KestrelRenderResponse } from "./protocol";
import { createAudioRenderer, RENDER_AHEAD, synthesizeInOrder } from "./render-pipeline";

function frames(seed: number): KestrelSpectralFrames {
  return {
    f0: new Float32Array([seed]),
    filterMagnitude: new Float32Array(),
    filterPhase: new Float32Array(),
    noiseEnvelope: new Float32Array(),
    trueFrameCount: 1,
    seed,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("synthesizeInOrder", () => {
  it("starts the next chunk's inference while the previous chunk renders", async () => {
    const renders = [deferred<Float32Array>(), deferred<Float32Array>()];
    const inferred: number[] = [];
    const { audio: done } = synthesizeInOrder(
      2,
      async (index) => {
        inferred.push(index);
        return frames(index);
      },
      (input) => renders[input.seed]!.promise,
      () => undefined,
    );

    await settle();
    expect(inferred).toEqual([0, 1]);

    renders[1]!.resolve(new Float32Array([1]));
    renders[0]!.resolve(new Float32Array([0]));
    expect(await done).toEqual([new Float32Array([0]), new Float32Array([1])]);
  });

  it("holds at most RENDER_AHEAD chunks waiting to render", async () => {
    const renders = Array.from({ length: 5 }, () => deferred<Float32Array>());
    const inferred: number[] = [];
    const { audio: done } = synthesizeInOrder(
      5,
      async (index) => {
        inferred.push(index);
        return frames(index);
      },
      (input) => renders[input.seed]!.promise,
      () => undefined,
    );

    await settle();
    expect(inferred).toHaveLength(RENDER_AHEAD);

    renders[0]!.resolve(new Float32Array([0]));
    await settle();
    expect(inferred).toHaveLength(RENDER_AHEAD + 1);

    renders.forEach((render, index) => render.resolve(new Float32Array([index])));
    expect((await done).map((audio) => audio[0])).toEqual([0, 1, 2, 3, 4]);
  });

  it("reports each chunk once its audio exists, in chunk order", async () => {
    const reported: number[] = [];
    await synthesizeInOrder(
      3,
      async (index) => frames(index),
      async (input) => new Float32Array([input.seed]),
      (index) => reported.push(index),
    ).audio;
    expect(reported).toEqual([0, 1, 2]);
  });

  it("fails the whole request when one chunk fails to render", async () => {
    await expect(
      synthesizeInOrder(
        3,
        async (index) => frames(index),
        async (input) => {
          if (input.seed === 1) throw new Error("render failed");
          return new Float32Array([input.seed]);
        },
        () => undefined,
      ).audio,
    ).rejects.toThrow("render failed");
  });

  it("frees inference for the next request before the last chunk has rendered", async () => {
    const last = deferred<Float32Array>();
    const { inferred, audio } = synthesizeInOrder(
      2,
      async (index) => frames(index),
      async (input) => (input.seed === 1 ? last.promise : new Float32Array([0])),
      () => undefined,
    );

    await inferred;
    let finished = false;
    void audio.then(() => (finished = true));
    await settle();
    expect(finished).toBe(false);

    last.resolve(new Float32Array([1]));
    expect((await audio).map((part) => part[0])).toEqual([0, 1]);
  });
});

describe("createAudioRenderer", () => {
  function fakeWorker() {
    const posted: KestrelRenderRequest[] = [];
    const worker = {
      onmessage: null as ((event: MessageEvent<KestrelRenderResponse>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage: (message: KestrelRenderRequest) => posted.push(message),
      terminate: vi.fn(),
    };
    const reply = (response: KestrelRenderResponse) =>
      worker.onmessage?.({ data: response } as MessageEvent<KestrelRenderResponse>);
    const crash = () => worker.onerror?.({ preventDefault: () => undefined } as ErrorEvent);
    return { worker, posted, reply, crash };
  }

  it("sends work only after the worker reports it has loaded", async () => {
    const { worker, posted, reply } = fakeWorker();
    const inline = vi.fn();
    const render = createAudioRenderer(() => worker, inline, new Uint8Array([7]));

    const audio = render(frames(3));
    expect(posted).toEqual([]);
    reply({ type: "ready" });
    expect(posted.map((message) => message.type)).toEqual(["configure", "render"]);
    reply({ type: "rendered", id: 1, audio: new Float32Array([3]) });

    expect(await audio).toEqual(new Float32Array([3]));
    expect(inline).not.toHaveBeenCalled();
  });

  it("renders inline when the worker never reports it has loaded", async () => {
    vi.useFakeTimers();
    try {
      const { worker, posted, reply } = fakeWorker();
      const inline = vi.fn(async (input: KestrelSpectralFrames) => new Float32Array([input.seed]));
      const render = createAudioRenderer(() => worker, inline, new Uint8Array(), 1_000);

      const queued = render(frames(5));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await queued).toEqual(new Float32Array([5]));
      expect(worker.terminate).toHaveBeenCalledOnce();

      reply({ type: "ready" });
      expect(await render(frames(6))).toEqual(new Float32Array([6]));
      expect(posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders inline when the worker cannot start", async () => {
    const inline = vi.fn(async (input: KestrelSpectralFrames) => new Float32Array([input.seed]));
    const render = createAudioRenderer(
      () => {
        throw new Error("nested workers unsupported");
      },
      inline,
      new Uint8Array(),
    );

    expect(await render(frames(4))).toEqual(new Float32Array([4]));
    expect(inline).toHaveBeenCalledOnce();
  });

  it("finishes queued and later chunks inline after the worker stops", async () => {
    const { worker, reply, crash } = fakeWorker();
    const inline = vi.fn(async (input: KestrelSpectralFrames) => new Float32Array([input.seed]));
    const render = createAudioRenderer(() => worker, inline, new Uint8Array());

    reply({ type: "ready" });
    const queued = render(frames(1));
    crash();

    expect(await queued).toEqual(new Float32Array([1]));
    expect(await render(frames(2))).toEqual(new Float32Array([2]));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(inline).toHaveBeenCalledTimes(2);
  });

  it("reports a render error instead of retrying it inline", async () => {
    const { worker, reply } = fakeWorker();
    const inline = vi.fn();
    const render = createAudioRenderer(() => worker, inline, new Uint8Array());

    reply({ type: "ready" });
    const audio = render(frames(1));
    reply({ type: "render-error", id: 1, message: "Kestrel returned an invalid frame count." });

    await expect(audio).rejects.toThrow("invalid frame count");
    expect(inline).not.toHaveBeenCalled();
  });
});
