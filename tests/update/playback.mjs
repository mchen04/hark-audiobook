import assert from "node:assert/strict";

import {
  PREFERENCES_DEFAULTS_HEADER,
  PREFERENCES_DEFAULTS_VERSION,
  PREFERENCES_WRITE_ID_HEADER,
} from "../../src/domain/preferences.ts";

import {
  audioFixture,
  bookCard,
  booksReady,
  importAudio,
  playerReady,
  shellReady,
  signIn,
  syntheticAccount,
} from "../../scripts/bench/runtime.mjs";
import { observe, offlineRanges, persisted, position, rangeEvidence, until } from "./helpers.mjs";
import { PROBE_PATH, startLatencyProxy } from "../../scripts/bench/proxy.mjs";

export async function checkPlayback(context, origin, report) {
  const proxy = await startLatencyProxy(origin);
  try {
    return await playback(context, proxy, report);
  } finally {
    await proxy.close();
  }
}

async function playback(context, proxy, report) {
  const origin = proxy.origin;
  const account = await syntheticAccount();
  const fixture = await audioFixture();
  report.fixture = fixture;
  report.engine = "WebKit";
  report.version = context.browser().version();
  report.scope =
    "Same live page: Media Session, persisted exact position, offline reload, browser history, ranges. Hard-kill resume belongs to resume-durability.";
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    if (!navigator.mediaSession) throw new Error("Media Session is unavailable.");
    const prototype = Object.getPrototypeOf(navigator.mediaSession);
    const original = prototype.setActionHandler;
    window.__harkMediaHandlers = {};
    window.__harkMediaRegistrations = [];
    prototype.setActionHandler = function (action, handler) {
      try {
        original.call(this, action, handler);
      } catch (error) {
        window.__harkMediaRegistrations.push({
          action,
          registered: !!handler,
          error: String(error),
        });
        throw error;
      }
      window.__harkMediaRegistrations.push({ action, registered: !!handler });
      window.__harkMediaHandlers[action] = handler;
    };
  });
  await signIn(context, origin, account);
  const preferences = await context.request.patch(`${origin}/api/preferences/v2`, {
    headers: {
      origin,
      [PREFERENCES_DEFAULTS_HEADER]: String(PREFERENCES_DEFAULTS_VERSION),
      [PREFERENCES_WRITE_ID_HEADER]: crypto.randomUUID(),
    },
    data: { skipBackMs: 10000, skipForwardMs: 45000, smartRewind: false },
  });
  assert.equal(preferences.status(), 200, "Synthetic account preference write");
  report.preferences = { skipBackSeconds: 10, skipForwardSeconds: 45, smartRewind: false };
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const witness = observe(page);
  report.network = witness.evidence;
  report.actions = [];
  try {
    await page.goto(`${origin}/library`, { waitUntil: "domcontentloaded" });
    await booksReady(page);
    const bookPath = await importAudio(page, fixture);
    const bookId = bookPath.split("/").at(-1);
    report.bookId = bookId;
    await bookCard(page).click();
    await playerReady(page);
    await page.getByRole("button", { name: "Back 10 seconds", exact: true }).waitFor();
    await page.getByRole("button", { name: "Forward 45 seconds", exact: true }).waitFor();
    await page.waitForFunction(() =>
      ["play", "pause", "seekforward", "seekbackward", "seekto"].every(
        (action) => typeof window.__harkMediaHandlers[action] === "function",
      ),
    );
    const invoke = async (action, details = {}) => {
      await page.evaluate(
        ({ action, details }) => {
          const handler = window.__harkMediaHandlers[action];
          if (typeof handler !== "function")
            throw new Error(`Missing Media Session action: ${action}`);
          handler({ action, ...details });
        },
        { action, details },
      );
    };
    const seek = async (action, expected, details) => {
      const before = await position(page);
      await invoke(action, details);
      await until(
        async () => Math.abs((await position(page)) - expected) <= 0.25,
        `${action} does not reach ${expected}s within 0.25s.`,
      );
      const paused = await page.locator("audio").evaluate((audio) => audio.paused);
      assert.equal(paused, true, "A Media Session seek must keep the paused state");
      report.actions.push({
        action,
        details,
        beforeSeconds: before,
        expectedSeconds: expected,
        actualSeconds: await position(page),
        paused,
      });
    };
    await seek("seekto", 123.4, { seekTime: 123.4 });
    await seek("seekforward", 168.4);
    await seek("seekbackward", 158.4);
    await seek("seekforward", 165.65, { seekOffset: 7.25 });
    await seek("seekbackward", 163.15, { seekOffset: 2.5 });
    await seek("seekto", 234.567, { seekTime: 234.567, fastSeek: false });
    const beforePlay = await position(page);
    await invoke("play");
    await page.waitForFunction((before) => {
      const audio = document.querySelector("audio");
      return (
        !audio.paused &&
        audio.currentTime >= before + 0.8 &&
        navigator.mediaSession.playbackState === "playing"
      );
    }, beforePlay);
    report.actions.push({
      action: "play",
      beforeSeconds: beforePlay,
      actualSeconds: await position(page),
      playbackState: "playing",
    });
    await invoke("pause");
    await page.waitForFunction(
      () =>
        document.querySelector("audio").paused && navigator.mediaSession.playbackState === "paused",
    );
    const saved = await position(page);
    report.actions.push({ action: "pause", actualSeconds: saved, playbackState: "paused" });
    report.metadata = await page.evaluate(() => ({
      title: navigator.mediaSession.metadata?.title,
      artist: navigator.mediaSession.metadata?.artist,
      playbackState: navigator.mediaSession.playbackState,
    }));
    report.saved = await persisted(page, account.id, bookId, saved);
    await shellReady(page);
    await witness.quiet();
    const offlineMediaStart = witness.evidence.mediaResponses.length;
    proxy.setOffline(true);
    report.offlineControl = await page.evaluate(async (probe) => {
      try {
        await fetch(probe, { cache: "no-store" });
        return { reachable: true };
      } catch (error) {
        return { reachable: false, error: String(error) };
      }
    }, PROBE_PATH);
    assert.equal(report.offlineControl.reachable, false, "The offline network control must fail");
    await page.reload({ waitUntil: "domcontentloaded" });
    await playerReady(page);
    await until(
      async () => Math.abs((await position(page)) - saved) <= 0.25,
      "Offline reload changes the saved position.",
    );
    report.offlineReloadSeconds = await position(page);
    report.offlineSaved = await persisted(page, account.id, bookId, saved, false);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await booksReady(page);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await playerReady(page);
    await until(
      async () => Math.abs((await position(page)) - saved) <= 0.25,
      "Browser forward changes the saved position.",
    );
    report.forwardSeconds = await position(page);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await booksReady(page);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await playerReady(page);
    await until(
      async () => Math.abs((await position(page)) - saved) <= 0.25,
      "Browser back/forward changes the saved position.",
    );
    report.backForwardSeconds = await position(page);
    report.range = await rangeEvidence(page, report.saved.download.offlineMediaUrl);
    const start = await position(page);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction((start) => {
      const audio = document.querySelector("audio");
      return !audio.paused && audio.currentTime >= start + 0.2;
    }, start);
    report.offlinePlayback = {
      startSeconds: start,
      advancedSeconds: await position(page),
      source: await page.locator("audio").evaluate((audio) => audio.currentSrc),
    };
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    report.offlineMediaResponses = offlineRanges(witness.evidence, offlineMediaStart);
    await witness.clean();
    return report;
  } finally {
    report.registrations = await page
      .evaluate(() => window.__harkMediaRegistrations)
      .catch(() => null);
    proxy.setOffline(false);
    await page.close().catch(() => {});
  }
}
