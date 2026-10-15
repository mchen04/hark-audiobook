import assert from "node:assert/strict";

import {
  PREFERENCES_DEFAULTS_HEADER,
  PREFERENCES_DEFAULTS_VERSION,
  PREFERENCES_WRITE_ID_HEADER,
} from "../../src/domain/preferences.ts";

import {
  audioFixture,
  failureMessage,
  bookCard,
  booksReady,
  importAudio,
  playerReady,
  playAndPause,
  shellReady,
  signIn,
  syntheticAccount,
} from "../../scripts/bench/runtime.mjs";
import {
  observe,
  offlineRanges,
  persisted,
  position,
  positionNear,
  rangeEvidence,
} from "./helpers.mjs";
import { PROBE_PATH, startLatencyProxy } from "../../scripts/bench/proxy.mjs";

export async function checkPlayback(context, target, report) {
  const proxy = await startLatencyProxy(target);
  const origin = proxy.origin;
  let page;
  try {
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
      prototype.setActionHandler = function (action, handler) {
        original.call(this, action, handler);
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
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    const witness = observe(page);
    report.network = witness.evidence;
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
      await invoke(action, details);
      await positionNear(page, expected, `${action} does not reach ${expected}s within 0.25s.`);
      const paused = await page.locator("audio").evaluate((audio) => audio.paused);
      assert.equal(paused, true, "A Media Session seek must keep the paused state");
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
    await invoke("pause");
    await page.waitForFunction(
      () =>
        document.querySelector("audio").paused && navigator.mediaSession.playbackState === "paused",
    );
    const saved = await position(page);
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
    await positionNear(page, saved, "Offline reload changes the saved position.");
    report.offlineReloadSeconds = await position(page);
    report.offlineSaved = await persisted(page, account.id, bookId, saved, false);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await booksReady(page);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await playerReady(page);
    await positionNear(page, saved, "Browser forward changes the saved position.");
    report.forwardSeconds = await position(page);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await booksReady(page);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await playerReady(page);
    await positionNear(page, saved, "Browser back/forward changes the saved position.");
    report.backForwardSeconds = await position(page);
    report.range = await rangeEvidence(page, report.saved.download.offlineMediaUrl);
    report.offlinePlayback = {
      ...(await playAndPause(page)),
      source: await page.locator("audio").evaluate((audio) => audio.currentSrc),
    };
    report.offlineMediaResponses = offlineRanges(witness.evidence, offlineMediaStart);
    await witness.clean();
    return report;
  } catch (error) {
    throw new Error(failureMessage(error));
  } finally {
    proxy.setOffline(false);
    await page?.close().catch(() => {});
    await proxy.close();
  }
}
