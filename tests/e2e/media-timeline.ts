import { test as base, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

type MediaEventSample = {
  event: string;
  timestamp: number;
  readyState: number;
  networkState: number;
  currentTime: number;
  muted: boolean;
  paused: boolean;
  seeking: boolean;
  ended: boolean;
  error: number | null;
  source: string;
  stack?: string;
};

export const test = base.extend<{ mediaTimeline: void }>({
  mediaTimeline: [
    async ({ context }, runTest, testInfo) => {
      const pages = new Map<Page, number>();
      const samples: Array<MediaEventSample & { page: number }> = [];
      await context.exposeBinding("harkRecordMediaEvent", ({ page }, sample: MediaEventSample) => {
        if (samples.length >= 4000) return;
        if (!pages.has(page)) pages.set(page, pages.size + 1);
        samples.push({ ...sample, page: pages.get(page)! });
      });
      await context.addInitScript(() => {
        const events = [
          "loadstart",
          "loadedmetadata",
          "loadeddata",
          "canplay",
          "canplaythrough",
          "play",
          "playing",
          "pause",
          "seeking",
          "seeked",
          "waiting",
          "stalled",
          "ended",
          "error",
          "volumechange",
          "timeupdate",
        ];
        const record = (audio: HTMLMediaElement, event: string, stack?: string) => {
          const send = (
            window as typeof window & {
              harkRecordMediaEvent: (sample: MediaEventSample) => Promise<void>;
            }
          ).harkRecordMediaEvent;
          void send({
            event,
            timestamp: performance.timeOrigin + performance.now(),
            readyState: audio.readyState,
            networkState: audio.networkState,
            currentTime: audio.currentTime,
            muted: audio.muted,
            paused: audio.paused,
            seeking: audio.seeking,
            ended: audio.ended,
            error: audio.error?.code ?? null,
            source: audio.currentSrc || audio.src,
            stack,
          }).catch(() => undefined);
        };
        for (const method of ["play", "load"] as const) {
          const original = HTMLMediaElement.prototype[method];
          Object.defineProperty(HTMLMediaElement.prototype, method, {
            configurable: true,
            value: function (this: HTMLMediaElement) {
              record(this, `call:${method}`, new Error().stack?.split("\n").slice(0, 6).join("\n"));
              return original.call(this);
            },
          });
        }
        for (const property of ["src", "currentTime", "muted"] as const) {
          const original = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, property)!;
          Object.defineProperty(HTMLMediaElement.prototype, property, {
            ...original,
            set: function (this: HTMLMediaElement, value: string | number | boolean) {
              record(
                this,
                `set:${property}:${value}`,
                new Error().stack?.split("\n").slice(0, 6).join("\n"),
              );
              original.set!.call(this, value);
            },
          });
        }
        for (const event of events) {
          document.addEventListener(
            event,
            (entry) => {
              if (entry.target instanceof HTMLMediaElement) record(entry.target, entry.type);
            },
            true,
          );
        }
      });
      try {
        await runTest();
      } finally {
        const path = testInfo.outputPath("media-timeline.json");
        await writeFile(path, JSON.stringify(samples, null, 2));
        await testInfo.attach("media-timeline", { path, contentType: "application/json" });
      }
    },
    { auto: true },
  ],
});
