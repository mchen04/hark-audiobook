import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkPlayback } from "../update/playback.mjs";

test("Media Session uses preferences and exact progress survives offline reload and history", async ({
  context,
  baseURL,
}, info) => {
  test.setTimeout(180000);
  const folder = mkdtempSync(path.join(tmpdir(), "hark-media-session-"));
  const output = path.join(folder, "report.json");
  const report: Record<string, unknown> = { ok: false, failure: null };
  try {
    expect(baseURL).toBeTruthy();
    await checkPlayback(context, baseURL!, report);
    expect(report.metadata).toEqual({
      title: "Hark Benchmark Fixture",
      artist: "Synthetic Benchmark",
      playbackState: "paused",
    });
    report.ok = true;
  } catch (error) {
    report.failure = String(error);
    throw error;
  } finally {
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output, ok: report.ok, failure: report.failure }));
    await info.attach("media-session-resume", { path: output, contentType: "application/json" });
  }
});

import { closeSql } from "../sync/harness/app";
import { captureMediaActions, mediaAction, prepareLocalPlayback } from "./playback-fixture";

test.afterAll(closeSql);

type ResumeWindow = typeof window & {
  resumeSamples: unknown[];
  muteWrites: boolean[];
  nativeMediaReadyState: (audio: HTMLMediaElement) => number;
  readAudioEnergy?: () => number;
  closeAudioObserver?: () => Promise<void>;
  observerState?: () => AudioContextState;
  observerAttachment?: { currentTime: number; playedRanges: number };
};

for (const observeDecoder of [false, true]) {
  const output = observeDecoder ? "decoder observer" : "native output";
  test(`simulated lock-screen resume stays audible with discarded buffers for five cycles (${output})`, async ({
    browser,
    context,
    page,
  }, info) => {
    await captureMediaActions(context);
    await context.addInitScript(
      ({ observeDecoder }) => {
        Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
        const readiness = Object.getOwnPropertyDescriptor(
          HTMLMediaElement.prototype,
          "readyState",
        )!;
        const play = HTMLMediaElement.prototype.play;
        const muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted")!;
        const testWindow = window as ResumeWindow;
        testWindow.resumeSamples = [];
        testWindow.muteWrites = [];
        testWindow.nativeMediaReadyState = (audio) => readiness.get!.call(audio);
        Object.defineProperty(HTMLMediaElement.prototype, "muted", {
          ...muted,
          set(value: boolean) {
            testWindow.muteWrites.push(value);
            muted.set!.call(this, value);
          },
        });
        Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
          configurable: true,
          get() {
            return Math.min(1, readiness.get!.call(this));
          },
        });
        HTMLMediaElement.prototype.play = function () {
          if (observeDecoder && !testWindow.readAudioEnergy) {
            const audioContext = new AudioContext();
            const source = audioContext.createMediaElementSource(this);
            const analyser = audioContext.createAnalyser();
            source.connect(analyser);
            analyser.connect(audioContext.destination);
            void audioContext.resume();
            const samples = new Float32Array(analyser.fftSize);
            testWindow.observerAttachment = {
              currentTime: this.currentTime,
              playedRanges: this.played.length,
            };
            testWindow.observerState = () => audioContext.state;
            testWindow.closeAudioObserver = () => audioContext.close();
            testWindow.readAudioEnergy = () => {
              analyser.getFloatTimeDomainData(samples);
              return Math.sqrt(
                samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
              );
            };
          }
          testWindow.resumeSamples.push({
            phase: "play-call",
            muted: this.muted,
            volume: this.volume,
            currentTime: this.currentTime,
            readyState: this.readyState,
            nativeReadyState: readiness.get!.call(this),
            observerAttached: !!testWindow.readAudioEnergy,
            visibility: document.visibilityState,
          });
          return play.call(this);
        };
      },
      { observeDecoder },
    );
    const report: Record<string, unknown> = {
      scope:
        "Simulated standalone WebKit with synthetic visibility/pagehide/freeze and forced low readyState. Each output path starts in a fresh context. The decoder tap attaches before the first play. The observer can make GStreamer report muted. No physical lock or speaker proof.",
      browser: browser.version(),
      project: info.project.name,
      output,
      cycles: [],
    };
    const sample = () =>
      page.locator("audio").evaluate((audio: HTMLAudioElement) => {
        const testWindow = window as ResumeWindow;
        return {
          muted: audio.muted,
          volume: audio.volume,
          paused: audio.paused,
          ended: audio.ended,
          readyState: audio.readyState,
          nativeReadyState: testWindow.nativeMediaReadyState(audio),
          networkState: audio.networkState,
          currentTime: audio.currentTime,
          decodedBytes:
            (audio as HTMLAudioElement & { webkitAudioDecodedByteCount?: number })
              .webkitAudioDecodedByteCount ?? null,
          decodedEnergy: testWindow.readAudioEnergy?.() ?? null,
          observerState: testWindow.observerState?.() ?? null,
          playbackState: navigator.mediaSession.playbackState,
          title: navigator.mediaSession.metadata?.title,
          visibility: document.visibilityState,
        };
      });
    try {
      await prepareLocalPlayback(browser, context, page, info, "Resume Proof Book");
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect.poll(async () => (await sample()).currentTime).toBeGreaterThan(0.5);
      if (observeDecoder)
        await expect.poll(async () => (await sample()).decodedEnergy).toBeGreaterThan(0.001);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.getByRole("slider", { name: "Audiobook position" }).fill("35000");
      for (let cycle = 0; cycle < 5; cycle++) {
        const before = await sample();
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          document.dispatchEvent(new Event("freeze"));
        });
        await mediaAction(page, "play");
        const immediate = await sample();
        (report.cycles as unknown[]).push({ observer: observeDecoder, cycle, before, immediate });
        await page.waitForTimeout(750);
        Object.assign((report.cycles as object[]).at(-1)!, { afterDecode: await sample() });
        if (!observeDecoder) {
          expect(before.muted).toBe(false);
          expect(immediate.muted).toBe(false);
        }
        expect(immediate.volume).toBeGreaterThan(0);
        await expect.poll(async () => (await sample()).paused).toBe(false);
        await expect
          .poll(async () => (await sample()).currentTime)
          .toBeGreaterThan(before.currentTime + 0.5);
        if (observeDecoder)
          await expect.poll(async () => (await sample()).decodedEnergy).toBeGreaterThan(0.001);
        const playing = await sample();
        expect(playing.currentTime).toBeLessThan(before.currentTime + 4);
        expect(playing.playbackState).toBe("playing");
        expect(playing.ended).toBe(false);
        if (!observeDecoder) expect(playing.muted).toBe(false);
        if (before.decodedBytes !== null && playing.decodedBytes !== null)
          expect(playing.decodedBytes).toBeGreaterThan(before.decodedBytes);
        Object.assign((report.cycles as object[]).at(-1)!, { playing });
        await mediaAction(page, "pause");
        expect((await sample()).playbackState).toBe("paused");
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "visible",
          });
          document.dispatchEvent(new Event("resume"));
          window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
          document.dispatchEvent(new Event("visibilitychange"));
        });
      }
      await page.getByRole("slider", { name: "Audiobook position" }).fill("70000");
      expect((await sample()).currentTime).toBeCloseTo(70, 0);
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect.poll(async () => (await sample()).currentTime).toBeGreaterThan(70.5);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      report.final = await sample();
      const audit = await page.evaluate(() => {
        const testWindow = window as ResumeWindow;
        return {
          muteWrites: testWindow.muteWrites,
          observerAttachment: testWindow.observerAttachment ?? null,
        };
      });
      Object.assign(report, audit);
      expect(audit.muteWrites).toEqual([]);
      expect(audit.observerAttachment).toEqual(
        observeDecoder ? { currentTime: 0, playedRanges: 0 } : null,
      );
    } catch (error) {
      report.failure = String(error);
      report.failureState = await sample();
      throw error;
    } finally {
      Object.assign(
        report,
        await page.evaluate(() => {
          const testWindow = window as ResumeWindow;
          return {
            playCalls: testWindow.resumeSamples,
            muteWrites: testWindow.muteWrites,
            observerAttachment: testWindow.observerAttachment ?? null,
          };
        }),
      );
      const folder = process.env.HARK_EVIDENCE_DIR ?? info.outputDir;
      mkdirSync(folder, { recursive: true });
      const name = `${info.project.name}-${observeDecoder ? "decoder" : "native"}-${info.repeatEachIndex}-resume`;
      const output = path.join(folder, `${name}.json`);
      writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
      await page.screenshot({ path: path.join(folder, `${name}.png`) });
      await info.attach("simulated-resume", { path: output, contentType: "application/json" });
      await page.evaluate(() => (window as ResumeWindow).closeAudioObserver?.());
    }
  });
}
