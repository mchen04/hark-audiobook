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
        for (const event of events) {
          document.addEventListener(
            event,
            (entry) => {
              const audio = entry.target;
              if (!(audio instanceof HTMLMediaElement)) return;
              const record = (
                window as typeof window & {
                  harkRecordMediaEvent: (sample: MediaEventSample) => Promise<void>;
                }
              ).harkRecordMediaEvent;
              void record({
                event: entry.type,
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
              }).catch(() => undefined);
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
