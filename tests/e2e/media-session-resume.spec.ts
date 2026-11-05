import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
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

test("simulated lock-screen resume stays audible with discarded buffers for five cycles", async ({
  browser,
  context,
  page,
}, info) => {
  await captureMediaActions(context);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    const readiness = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "readyState")!;
    const play = HTMLMediaElement.prototype.play;
    const samples: unknown[] = [];
    Object.assign(window, { resumeSamples: samples });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
      configurable: true,
      get() {
        return Math.min(1, readiness.get!.call(this));
      },
    });
    HTMLMediaElement.prototype.play = function () {
      samples.push({
        phase: "play-call",
        muted: this.muted,
        volume: this.volume,
        currentTime: this.currentTime,
        readyState: this.readyState,
        nativeReadyState: readiness.get!.call(this),
        visibility: document.visibilityState,
      });
      return play.call(this);
    };
  });
  const report: Record<string, unknown> = {
    scope:
      "Simulated standalone WebKit, synthetic visibility/pagehide/freeze and forced low readyState from first load. No physical lock or speaker proof.",
    browser: browser.version(),
    project: info.project.name,
    cycles: [],
  };
  const sample = () =>
    page.locator("audio").evaluate((audio: HTMLAudioElement) => ({
      muted: audio.muted,
      volume: audio.volume,
      paused: audio.paused,
      ended: audio.ended,
      readyState: audio.readyState,
      networkState: audio.networkState,
      currentTime: audio.currentTime,
      decodedBytes:
        (audio as HTMLAudioElement & { webkitAudioDecodedByteCount?: number })
          .webkitAudioDecodedByteCount ?? null,
      decodedEnergy: (
        window as typeof window & { readAudioEnergy: () => number }
      ).readAudioEnergy(),
      playbackState: navigator.mediaSession.playbackState,
      title: navigator.mediaSession.metadata?.title,
      visibility: document.visibilityState,
    }));
  try {
    await prepareLocalPlayback(browser, context, page, info, "Resume Proof Book");
    await page.evaluate(() => {
      document.addEventListener(
        "click",
        () => {
          if ((window as typeof window & { readAudioEnergy?: () => number }).readAudioEnergy)
            return;
          const audio = document.querySelector("audio")!;
          const context = new AudioContext();
          const source = context.createMediaElementSource(audio);
          const analyser = context.createAnalyser();
          source.connect(analyser);
          analyser.connect(context.destination);
          void context.resume();
          const samples = new Float32Array(analyser.fftSize);
          Object.assign(window, {
            readAudioEnergy: () => {
              analyser.getFloatTimeDomainData(samples);
              return Math.sqrt(
                samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
              );
            },
          });
        },
        { once: true },
      );
    });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(async () => (await sample()).currentTime).toBeGreaterThan(0.5);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("slider", { name: "Audiobook position" }).fill("35000");
    for (let cycle = 0; cycle < 5; cycle++) {
      const before = await sample();
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        document.dispatchEvent(new Event("freeze"));
      });
      await mediaAction(page, "play");
      const immediate = await sample();
      (report.cycles as unknown[]).push({ cycle, before, immediate });
      await page.waitForTimeout(750);
      Object.assign((report.cycles as object[])[cycle], { afterDecode: await sample() });
      expect(immediate.muted).toBe(false);
      expect(immediate.volume).toBeGreaterThan(0);
      await expect.poll(async () => (await sample()).paused).toBe(false);
      await expect
        .poll(async () => (await sample()).currentTime)
        .toBeGreaterThan(before.currentTime + 0.5);
      const playing = await sample();
      expect(playing.currentTime).toBeLessThan(before.currentTime + 4);
      expect(playing.playbackState).toBe("playing");
      expect(playing.ended).toBe(false);
      await expect.poll(async () => (await sample()).decodedEnergy).toBeGreaterThan(0.001);
      if (before.decodedBytes !== null && playing.decodedBytes !== null)
        expect(playing.decodedBytes).toBeGreaterThan(before.decodedBytes);
      Object.assign((report.cycles as object[])[cycle], { playing });
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
  } finally {
    report.playCalls = await page.evaluate(
      () => (window as typeof window & { resumeSamples: unknown[] }).resumeSamples,
    );
    const folder = process.env.HARK_EVIDENCE_DIR ?? info.outputDir;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(folder, { recursive: true });
    const output = path.join(folder, `${info.project.name}-resume.json`);
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    await page.screenshot({ path: path.join(folder, `${info.project.name}-resume.png`) });
    await info.attach("simulated-resume", { path: output, contentType: "application/json" });
  }
});
