import { afterEach, describe, expect, it, vi } from "vitest";

import { KestrelClient } from "./client";

class FailingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage() {
    queueMicrotask(() => this.onerror?.());
  }
  terminate() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("KestrelClient", () => {
  it("asks for a connection when its worker cannot load offline", async () => {
    vi.stubGlobal("Worker", FailingWorker);
    vi.stubGlobal("navigator", { onLine: false });
    await expect(new KestrelClient().initialize()).rejects.toThrow(
      "Connect once so Hark can download Kestrel to this device.",
    );
  });

  it("reports an unexpected stop when its worker fails online", async () => {
    vi.stubGlobal("Worker", FailingWorker);
    vi.stubGlobal("navigator", { onLine: true });
    await expect(new KestrelClient().initialize()).rejects.toThrow(
      "Kestrel stopped unexpectedly on this device.",
    );
  });
});
