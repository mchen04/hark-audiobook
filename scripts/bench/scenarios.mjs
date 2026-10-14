import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { devices } from "@playwright/test";

import { startLatencyProxy, PROBE_PATH } from "./proxy.mjs";
import { outsideRepository, root } from "./build.mjs";
import { analyzeFrames, attachSampler } from "./sampler.mjs";
import {
  audioFixture,
  backButton,
  bookCard,
  booksReady,
  closeWebKitPages,
  importAudio,
  headers,
  launchWebKit,
  playerReady,
  shellReady,
  signIn,
  sleep,
  startPath,
  syntheticAccount,
  trackWebKitPages,
} from "./runtime.mjs";

export const scenarioNames = [
  "signed-out",
  "first-sync",
  "cold-reopen",
  "slow-reopen",
  "offline-reopen",
  "book-back",
  "history",
  "reload",
  "invalid-session",
  "settings",
];
const libraryLeaving = ["mainHeading", "firstCard"];
const playerLeaving = ["mainHeading", "playerHeading", "playButton"];

async function navigate(page, sampler, target, leaving, action, kind = "click") {
  const mark = await sampler.begin(page, target, leaving, kind);
  await action();
  if (target === "books") await booksReady(page);
  else if (target === "player") await playerReady(page);
  else if (target === "settings")
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  else if (target === "login") await page.getByLabel("Email").waitFor();
  await sampler.end(page, mark);
  await sleep(500);
}

export async function recordScenarios({
  origin,
  directory = root,
  output,
  names = scenarioNames,
  context,
}) {
  const destination = outsideRepository(output);
  const allowed = [path.resolve(tmpdir()), path.resolve(tmpdir(), "../evidence/codex-runs")];
  if (
    !allowed.some(
      (parent) => destination === parent || destination.startsWith(`${parent}${path.sep}`),
    )
  )
    throw new Error("Recordings must stay under TMPDIR or the evidence folder.");
  mkdirSync(destination, { recursive: true });
  for (const name of names)
    if (!scenarioNames.includes(name)) throw new Error(`Unknown scenario: ${name}`);
  const account = await syntheticAccount(directory);
  const fixture = await audioFixture();
  const proxy = await startLatencyProxy(origin);
  const videoDirectory = mkdtempSync(path.join(tmpdir(), "hark-frame-videos-"));
  const videoOptions = { recordVideo: { dir: videoDirectory, size: { width: 393, height: 852 } } };
  let warm;
  let fresh;
  let pendingVideo;
  let cookies;
  const scenarios = [];
  const reopens = ["cold-reopen", "slow-reopen", "offline-reopen"];
  const executionOrder = [
    ...names.filter((name) => !reopens.includes(name)),
    ...names.filter((name) => reopens.includes(name)),
  ];
  const preparation = { ok: false, failure: null };
  const summary = () => ({
    protocol: "v1.1",
    origin,
    engine: "WebKit",
    fixture,
    preparation,
    scenarios,
    executionOrder,
    events: scenarios.flatMap((r) => r.events.map((event) => ({ scenario: r.name, ...event }))),
  });
  const save = () =>
    writeFileSync(
      path.join(destination, "summary.json"),
      `${JSON.stringify(summary(), null, 2)}\n`,
    );
  const finishVideo = async () => {
    if (!pendingVideo) return;
    const { video, result } = pendingVideo;
    if (video) {
      const target = path.join(destination, result.name, "video.webm");
      await video.saveAs(target);
      await video.delete();
      result.video = target;
    }
    pendingVideo = null;
  };
  const createFresh = async () => {
    if (!context) return launchWebKit(videoOptions);
    const deviceContext = await context.browser().newContext({
      ...devices["iPhone 15"],
      extraHTTPHeaders: headers,
      serviceWorkers: "allow",
      ...videoOptions,
    });
    await deviceContext.addInitScript(() =>
      Object.defineProperty(navigator, "standalone", { configurable: true, value: true }),
    );
    return {
      ...trackWebKitPages(deviceContext),
      close: () => deviceContext.close(),
      version: context.browser().version(),
    };
  };
  const capture = async (name, handle, sampler, proof = null, readyPage) => {
    const page = readyPage ?? (await handle.newPage());
    page.setDefaultTimeout(15000);
    const startedAt = Date.now();
    const errors = [];
    const onError = (error) => errors.push(error.message);
    page.on("pageerror", onError);
    let failure = null;
    let control = null;
    try {
      control = await performScenario({
        name,
        page,
        sampler,
        context: handle.context,
        account,
        cookies,
        proxy,
        preparation,
      });
      if (!["signed-out", "first-sync"].includes(name) && !preparation.ok)
        throw new Error(`Prepared WebKit context failed: ${preparation.failure}`);
    } catch (error) {
      failure = String(error);
    }
    const recording = await sampler.read(handle.context);
    recording.frames = recording.frames.filter((frame) => frame.wallTime >= startedAt);
    const events = analyzeFrames(recording);
    const result = {
      name,
      failure,
      errors,
      control,
      engine: "WebKit",
      webkitVersion: handle.version,
      pageProcessColdStart: proof,
      frameCount: recording.frames.length,
      events,
      falseEmptyFrames: events
        .filter((event) => event.kind === "false-empty")
        .reduce((sum, event) => sum + event.emptyFrames, 0),
      falseEmptyMs: events
        .filter((event) => event.kind === "false-empty")
        .reduce((sum, event) => sum + event.emptyDurationMs, 0),
      video: page.video() ? path.join(destination, name, "video.webm") : null,
    };
    const folder = path.join(destination, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, "frames.json"),
      `${JSON.stringify({ ...result, ...recording }, null, 2)}\n`,
    );
    scenarios.push(result);
    pendingVideo = { video: page.video(), result };
    page.off("pageerror", onError);
    proxy.setDelay(0);
    proxy.setOffline(false);
    save();
    console.log(
      `${name}: ${events.length} flicker events, ${recording.frames.length} frames; false-empty ${result.falseEmptyFrames} frames / ${result.falseEmptyMs.toFixed(2)} ms${failure ? ", FAILED: " + failure : ""}`,
    );
    return page;
  };
  try {
    warm = context
      ? {
          ...trackWebKitPages(context),
          close: async () => {},
          version: context.browser().version(),
        }
      : await launchWebKit(videoOptions);
    if (context) {
      await context.setExtraHTTPHeaders(headers);
      await context.addInitScript(() =>
        Object.defineProperty(navigator, "standalone", { configurable: true, value: true }),
      );
    }
    cookies = await signIn(warm.context, proxy.origin, account);
    const warmSampler = await attachSampler(warm.context);
    let page = await warm.newPage();
    await page.goto(`${proxy.origin}/library`, { waitUntil: "domcontentloaded" });
    await booksReady(page);
    try {
      await importAudio(page, fixture);
      await shellReady(page);
      preparation.ok = true;
    } catch (error) {
      preparation.failure = String(error);
    }
    for (const name of executionOrder) {
      if (["signed-out", "first-sync"].includes(name)) {
        fresh = await createFresh();
        if (name === "first-sync") await fresh.context.addCookies(cookies);
        const sampler = await attachSampler(fresh.context);
        await capture(name, fresh, sampler);
        for (const current of fresh.context.pages()) await current.close();
        await finishVideo();
        await fresh.close();
        fresh = null;
      } else {
        const previousVideo = page.video();
        const hadPendingVideo = !!pendingVideo;
        let proof = null;
        let readyPage;
        if (reopens.includes(name)) proof = await closeWebKitPages(warm);
        else {
          await warmSampler.stop(page);
          readyPage = await warm.newPage();
          await readyPage.goto(`${proxy.origin}/library`, { waitUntil: "domcontentloaded" });
          await booksReady(readyPage);
          await page.close();
        }
        await finishVideo();
        if (!hadPendingVideo && previousVideo) await previousVideo.delete();
        page = await capture(name, warm, warmSampler, proof, readyPage);
        if (name === "invalid-session") await warm.context.addCookies(cookies);
      }
      save();
    }
    for (const current of warm.context.pages()) await current.close();
    await finishVideo();
    save();
    return summary();
  } finally {
    await fresh?.close();
    await warm?.close();
    await proxy.close();
    save();
  }
}

async function performScenario({
  name,
  page,
  sampler,
  context,
  account,
  cookies,
  proxy,
  preparation,
}) {
  let control = null;
  if (name === "signed-out") {
    await page.goto(`${proxy.origin}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/login/, { waitUntil: "domcontentloaded" });
    await sleep(500);
    const action = await sampler.begin(page, "books", ["mainHeading"], "sign-in");
    await signIn(context, proxy.origin, account, true);
    await booksReady(page);
    await sampler.end(page, action);
  } else {
    if (name === "slow-reopen") {
      proxy.setDelay(3000);
      const started = performance.now();
      const response = await context.request.get(`${proxy.origin}${PROBE_PATH}?t=${Date.now()}`);
      control = { probeMs: performance.now() - started, status: response.status() };
      if (!response.ok() || control.probeMs < 2900) throw new Error("Socket delay did not bite.");
    }
    if (name === "offline-reopen") {
      proxy.setOffline(true);
      proxy.reset();
      control = {
        offline: true,
        probeFailed: await context.request.get(`${proxy.origin}${PROBE_PATH}`).then(
          () => false,
          () => true,
        ),
      };
      if (!control.probeFailed) throw new Error("Offline control request succeeded.");
    }
    if (name === "invalid-session") {
      await context.addCookies(
        cookies.map((cookie) => ({ ...cookie, value: "invalid-benchmark-session" })),
      );
    }
    const opening =
      ["first-sync", "cold-reopen", "slow-reopen", "offline-reopen", "invalid-session"].includes(
        name,
      ) || page.url() === "about:blank";
    const canMark = opening && (await page.evaluate(() => !!window.__harkSampler));
    const openingAction = canMark ? await sampler.begin(page, "books", [], "reopen") : null;
    if (opening) await page.goto(`${proxy.origin}${startPath}`, { waitUntil: "domcontentloaded" });
    if (name === "invalid-session") {
      await Promise.race([
        booksReady(page, 15000),
        page.waitForURL(/\/login/, { waitUntil: "domcontentloaded" }),
      ]);
      if (openingAction) await sampler.end(page, openingAction);
      await page.waitForURL(/\/login/, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Email").waitFor();
      await sleep(1000);
      return control;
    }
    await booksReady(page, 15000);
    if (openingAction) await sampler.end(page, openingAction);
    await sleep(800);
    if (["book-back", "history", "reload"].includes(name)) {
      if (!preparation.ok) throw new Error(`Audio preparation failed: ${preparation.failure}`);
      await navigate(page, sampler, "player", ["header", ...libraryLeaving], () =>
        bookCard(page).click(),
      );
      if (name === "history") {
        await navigate(
          page,
          sampler,
          "books",
          playerLeaving,
          () => page.goBack({ waitUntil: "domcontentloaded" }),
          "history-back",
        );
        await navigate(
          page,
          sampler,
          "player",
          ["header", ...libraryLeaving],
          () => page.goForward({ waitUntil: "domcontentloaded" }),
          "history-forward",
        );
      }
      if (name === "reload") {
        await navigate(
          page,
          sampler,
          "player",
          [],
          () => page.reload({ waitUntil: "domcontentloaded" }),
          "reload-player",
        );
      }
      await navigate(page, sampler, "books", playerLeaving, () => backButton(page).click());
      if (name === "reload")
        await navigate(
          page,
          sampler,
          "books",
          [],
          () => page.reload({ waitUntil: "domcontentloaded" }),
          "reload-library",
        );
    }
    if (name === "settings") {
      const target = "settings";
      await navigate(page, sampler, target, libraryLeaving, () =>
        page.getByRole("link", { name: "Settings", exact: true }).click(),
      );
      await navigate(page, sampler, "books", ["mainHeading"], () =>
        page.getByRole("link", { name: "Library", exact: true }).click(),
      );
    }
    if (name === "offline-reopen") control.hits = proxy.report();
  }
  await sleep(1000);

  return control;
}
