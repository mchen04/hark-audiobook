import { expect } from "@playwright/test";

import { test } from "./media-timeline";
import { closeSql } from "../sync/harness/app";
import { captureMediaActions, mediaAction, prepareLocalPlayback } from "./playback-fixture";

test.afterAll(closeSql);

test("synthetic in WebKit: an unmarked element pause preserves position and rewinds once on explicit remote resume", async ({
  browser,
  context,
  page,
}, info) => {
  await captureMediaActions(context);
  await context.addInitScript(() => {
    const now = Date.now.bind(Date);
    let offset = 0;
    Object.assign(window, {
      advanceInterruptionClock: () => {
        offset += 90000;
      },
      interruptionPlayCalls: 0,
    });
    Date.now = () => now() + offset;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const state = window as typeof window & { interruptionPlayCalls: number };
      state.interruptionPlayCalls++;
      return play.call(this);
    };
  });
  const { account, bookId } = await prepareLocalPlayback(
    browser,
    context,
    page,
    info,
    "Interruption Book",
  );
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const preferenceSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/preferences/v2") &&
      response.request().method() === "PATCH" &&
      response.ok(),
  );
  await page.getByRole("checkbox", { name: /Smart rewind/ }).check();
  await preferenceSaved;
  await page.goto(`/books/${bookId}`);
  await page.getByRole("slider", { name: "Audiobook position" }).fill("55000");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused))
    .toBe(false);
  const capability = await page.evaluate(() => {
    const session = (navigator as Navigator & { audioSession?: { type: string; state: string } })
      .audioSession;
    return {
      exposed: !!session,
      type: session?.type ?? null,
      hasState: !!session && "state" in session,
      state: session?.state ?? null,
      visibility: document.visibilityState,
    };
  });
  console.log(
    JSON.stringify({
      evidence: "synthetic in WebKit",
      audioSession: capability,
      browserVersion: browser.version(),
      project: info.project.name,
    }),
  );
  if (capability.exposed) expect(capability.type).toBe("playback");
  const pausedAt = await page.locator("audio").evaluate((audio: HTMLAudioElement) => {
    audio.pause();
    return audio.currentTime;
  });
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState)).toBe("paused");
  await expect
    .poll(() =>
      page.evaluate(
        ({ userId, bookId }) =>
          Math.round(
            JSON.parse(localStorage.getItem(`chapterline:position:${userId}:${bookId}`)!)
              .positionMs,
          ),
        { userId: account.userId, bookId },
      ),
    )
    .toBe(Math.round(pausedAt * 1000));
  const calls = await page.evaluate(
    () => (window as typeof window & { interruptionPlayCalls: number }).interruptionPlayCalls,
  );
  await page.evaluate(() => {
    (window as typeof window & { advanceInterruptionClock: () => void }).advanceInterruptionClock();
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => (window as typeof window & { interruptionPlayCalls: number }).interruptionPlayCalls,
    ),
  ).toBe(calls);
  await mediaAction(page, "play");
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeGreaterThanOrEqual(pausedAt - 5);
  expect(
    await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime),
  ).toBeLessThan(pausedAt - 3.5);
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.seeking))
    .toBe(false);
  await mediaAction(page, "pause");
  await page.locator("audio").evaluate((audio: HTMLAudioElement) => {
    const seeks: number[] = [];
    Object.assign(window, { appResumeSeeks: seeks });
    audio.addEventListener("seeking", () => seeks.push(audio.currentTime));
  });
  const appPausedAt = await page
    .locator("audio")
    .evaluate((audio: HTMLAudioElement) => audio.currentTime);
  await page.evaluate(() =>
    (window as typeof window & { advanceInterruptionClock: () => void }).advanceInterruptionClock(),
  );
  await mediaAction(page, "play");
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused))
    .toBe(false);
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime), {
      timeout: 2500,
    })
    .toBeGreaterThanOrEqual(appPausedAt);
  expect(
    await page.evaluate(
      () => (window as typeof window & { appResumeSeeks: number[] }).appResumeSeeks,
    ),
  ).toEqual([]);
});

test("real WebKit tabs transfer playback ownership and pause the prior tab", async ({
  browser,
  context,
  page,
}, info) => {
  const { bookPath } = await prepareLocalPlayback(
    browser,
    context,
    page,
    info,
    "Tab Ownership Book",
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const peer = await context.newPage();
  await peer.goto(bookPath);
  await peer.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused))
    .toBe(true);
  expect(await peer.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
    false,
  );
  console.log(
    JSON.stringify({
      evidence: "real WebKit tabs",
      first: await page.evaluate(() => document.visibilityState),
      peer: await peer.evaluate(() => document.visibilityState),
    }),
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => peer.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused))
    .toBe(true);
  expect(await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
    false,
  );
});
