import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { frozenBase, outsideRepository, root } from "./build.mjs";
import { bundleSizes } from "./bundles.mjs";
import {
  audioFixture,
  backButton,
  bookCard,
  booksReady,
  freshProfile,
  importAudio,
  launchChromium,
  launchWebKit,
  playButton,
  sha256,
  shellReady,
  signIn,
  sleep,
  startPath,
  startServer,
  syntheticAccount,
} from "./runtime.mjs";
import { timedClick, timingProbe } from "./sampler.mjs";

const defaults = {
  first_visit: 5,
  cold_start: 10,
  cold_relaunch_chromium: 10,
  warm_start: 10,
  playback: 10,
  transitions: 10,
  memory: 5,
};
const quantile = (sorted, fraction) => {
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
};
function aggregate(values, failures = 0) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted.length ? quantile(sorted, 0.5) : null,
    p90: sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)] : null,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    IQR: sorted.length ? quantile(sorted, 0.75) - quantile(sorted, 0.25) : null,
    n: sorted.length,
    failures,
  };
}

function compareResults(report, noise) {
  const metrics = {};
  let gain = false;
  let regression = false;
  for (const metric of Object.keys(report.aggregates.A)) {
    const a = report.aggregates.A[metric].median;
    const b = report.aggregates.B[metric].median;
    const memory = metric.endsWith("rss_kib");
    const deterministic = metric === "launch_closure_gzip_bytes";
    const informational =
      metric === "first_visit_static_transfer_bytes" || metric === "cold_start_wall_ms";
    const delta =
      noise?.aggregates?.A?.[metric]?.median !== null &&
      Number.isFinite(noise?.aggregates?.A?.[metric]?.median) &&
      Number.isFinite(noise?.aggregates?.B?.[metric]?.median)
        ? Math.abs(noise.aggregates.A[metric].median - noise.aggregates.B[metric].median)
        : null;
    const failed = report.aggregates.A[metric].failures + report.aggregates.B[metric].failures > 0;
    const threshold = deterministic
      ? a * 0.01
      : delta === null
        ? null
        : Math.max(a * (memory ? 0.05 : 0.1), 2 * delta);
    const unavailable = report.metricAvailability?.[metric];
    const status = unavailable
      ? unavailable
      : informational
        ? "reported only"
        : failed || a === null || b === null
          ? "invalid samples"
          : threshold === null
            ? "noise band unknown"
            : a - b >= threshold && a > b
              ? "gain"
              : b - a >= threshold && b > a
                ? "regression"
                : "within band";
    metrics[metric] = {
      engine: metric.includes("chromium")
        ? "Chromium"
        : metric.endsWith("_bytes") && metric !== "first_visit_static_transfer_bytes"
          ? "static"
          : "WebKit",
      A: a,
      B: b,
      delta: a !== null && b !== null ? b - a : null,
      aaMedianDelta: delta,
      threshold,
      status,
    };
    gain ||= status === "gain";
    regression ||= status === "regression";
  }
  return {
    scope: "Measurable metrics; WebKit cold start and cold-paint RSS are unavailable.",
    noiseBand: noise ? "provided A/A result" : "noise band unknown",
    metrics,
    performanceEligible:
      !!noise &&
      report.completed &&
      !report.smoke &&
      gain &&
      !regression &&
      report.samples.every((sample) => sample.ok) &&
      Object.values(metrics).every(
        (metric) => !["invalid samples", "noise band unknown"].includes(metric.status),
      ),
    checksGreen: null,
    keep: null,
    reason: "Keeping a performance change also requires all external checks to stay green.",
  };
}

function printTable(report) {
  console.log("WebKit playback metrics: from warm library.");
  console.log("cold_relaunch_playback_chromium_ms: from relaunched Chromium cold start.");
  console.log(
    "metric                           engine      A median      B median      A/B n    result",
  );
  for (const [metric, value] of Object.entries(report.compare.metrics)) {
    const show = (number) => (number === null ? "null" : number.toFixed(2));
    console.log(
      `${metric.padEnd(32)} ${value.engine.padEnd(8)} ${show(value.A).padStart(11)} ${show(value.B).padStart(13)} ${`${report.aggregates.A[metric].n}/${report.aggregates.B[metric].n}`.padStart(10)}    ${value.status}`,
    );
  }
  if (report.smoke) console.log("Smoke timings are non-evidence.");
  console.log(
    `Failures: ${report.samples.filter((sample) => !sample.ok).length}; ${report.compare.noiseBand}`,
  );
}

export async function runBenchmark({ A, B, label, output, reps, noisePath }) {
  A = outsideRepository(A, true);
  B = outsideRepository(B, true);
  const baseReceipt = JSON.parse(readFileSync(path.join(A, "benchmark-build.json"), "utf8"));
  if (
    baseReceipt.commit !== frozenBase ||
    baseReceipt.buildId !== readFileSync(path.join(A, ".next/BUILD_ID"), "utf8").trim()
  )
    throw new Error("Variant A must be the prepared frozen base build.");
  const destination = outsideRepository(output);
  mkdirSync(path.dirname(destination), { recursive: true });
  const repetitions = Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [key, reps ?? value]),
  );
  if (Object.values(repetitions).some((count) => !Number.isInteger(count) || count < 1))
    throw new Error("Repetitions must be positive integers.");
  const sysctl = (key) => execFileSync("sysctl", ["-n", key], { encoding: "utf8" }).trim();
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const report = {
    protocol: "v1.1",
    label,
    smoke: Object.entries(defaults).some(([group, count]) => repetitions[group] !== count),
    timingEvidence: "Requires a quiet host and full repetitions; smoke timings are non-evidence.",
    startedAt: new Date().toISOString(),
    host: {
      model: sysctl("hw.model"),
      cpu: sysctl("machdep.cpu.brand_string"),
      memsize: Number(sysctl("hw.memsize")),
    },
    OS: { type: os.type(), release: os.release(), arch: os.arch() },
    nodeVersion: process.version,
    playwrightVersion: JSON.parse(
      readFileSync(path.join(root, "node_modules/@playwright/test/package.json")),
    ).version,
    webkitVersion: null,
    chromiumVersion: null,
    aggregationMethod: "median and quartiles use linear interpolation; p90 uses nearest rank",
    worktree: { head: git(["rev-parse", "HEAD"]), dirty: !!git(["status", "--porcelain"]) },
    device: "iPhone 15",
    limitations: [
      "Desktop CPU without throttling; timings are not iPhone latencies.",
      "Desktop WebKit RSS is not iPhone Safari memory.",
      "JS heap unavailable in WebKit.",
      "On this host, navigation after page-process exit can terminate WebKit Networking and clear storage.",
      "WebKit Cache Storage loses entries after page-process exit; the keeper cannot make the measured PID exit.",
      "Chromium browser relaunch is supplementary and is not a WebKit or Safari result.",
    ],
    webKitDefects: [
      {
        kind: "network-process-exit-after-page-process-exit",
        probe: "network-process-exit-probe.json",
        evidence: {
          engine: "WebKit",
          version: "26.5",
          provenance:
            "Captured console output of the independent cold-then-warm probe on 2026-10-14; no app files changed.",
          definition:
            "Non-persistent context; prepared library and shell; close measured page and prove its WebContent PID exits; new page to start URL; then warm navigation.",
          pageProcessExit: {
            pid: 76325,
            exited: true,
            exitWaitMs: 10189.266791000002,
          },
          beforeWarm: {
            pagePid: 77048,
            networkPid: 76304,
            cookies: 1,
            localStorageKeys: 2,
            cacheNames: 5,
          },
          warmFailure: "page.goto: WebKit encountered an internal error",
          afterWarm: {
            remainingOwnedPids: [76302, 76324, 77048],
            cookies: 0,
            localStorageKeys: 0,
            cacheNames: 0,
            networkPid: 76304,
            networkPidGone: true,
          },
        },
      },
      {
        kind: "cache-entries-lost-after-page-process-exit",
        probe: "webkit-ephemeral-page-exit-probe.json",
        evidence: {
          engine: "WebKit",
          version: "26.5",
          before: {
            cacheNames: ["synthetic-storage-witness"],
            keys: 1,
            body: "must-survive",
            localStorage: "survive",
          },
          proof: {
            processes: [
              {
                pid: 85253,
                parent: 1,
                rssKiB: 85120,
                executable:
                  "/Users/michaelchen/Library/Caches/ms-playwright/webkit-2311/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development",
                checkedAt: "2026-10-14T11:55:52.549Z",
                exited: true,
              },
            ],
            exitObservedAt: "2026-10-14T11:55:52.708Z",
            exitWaitMs: 156.73129100000006,
            serviceWorkerRunning: "unknown",
            serviceWorkerReason: "Playwright cannot observe running WebKit service workers.",
          },
          after: {
            cacheNames: ["synthetic-storage-witness"],
            keys: 0,
            body: null,
            localStorage: "survive",
          },
        },
      },
      {
        kind: "keeper-cannot-prove-measured-pid-exit",
        probe: "webkit-keeper-probe.json",
        evidence: {
          engine: "WebKit",
          version: "26.5",
          definition: "new page process, keeper page alive",
          ok: false,
          failure: "Error: Page WebContent PID did not exit: 95001",
          keeperPid: 95035,
          measuredPidBefore: 95001,
          before: {
            shell: true,
            shellAssets: 15,
            shellAssetsComplete: true,
            audio: [
              {
                path: "/offline-media/87763c2b-e8c6-4b38-a0b6-4ca188178513/chunk/1",
                bytes: 606526,
              },
              {
                path: "/offline-media/87763c2b-e8c6-4b38-a0b6-4ca188178513/chunk/0",
                bytes: 4194304,
              },
              {
                path: "/offline-media/87763c2b-e8c6-4b38-a0b6-4ca188178513",
                bytes: 95,
              },
            ],
          },
        },
      },
    ],
    memoryAvailability: { jsHeapBytes: null, reason: "unavailable in WebKit" },
    metricAvailability: Object.fromEntries(
      ["cold_start_ms", "cold_start_wall_ms", "cold_rss_kib"].map((metric) => [
        metric,
        "not measurable in this WebKit build",
      ]),
    ),
    skippedGroups: {
      cold_start: "not measurable in this WebKit build",
    },
    warmStartReadiness:
      "Books marker, no pending requests, and 3000 ms of network quiet before navigation; includes deferred mirror revalidation.",
    playbackStartDefinition: "from warm library",
    chromiumPlaybackStartDefinition: "from relaunched Chromium cold start",
    memoryPlaybackDefinition:
      "RSS after 10 seconds of playback in the prepared live WebKit page; cold-paint RSS is not measurable.",
    repetitions,
    measurementOrder: [
      "first_visit",
      "warm_start",
      "playback",
      "transitions",
      "memory",
      "cold_relaunch_chromium",
    ],
    variants: {},
    fixture: null,
    samples: [],
    aggregates: { A: {}, B: {} },
    compare: null,
    completed: false,
  };
  const variants = {};
  const bundles = new Map();
  let interleaveIndex = 0;
  const order = (count) =>
    Array.from({ length: 2 * count }, () => ["A", "B", "B", "A"][interleaveIndex++ % 4]);
  const save = () => writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  const sample = async (variant, group, action) => {
    const state = variants[variant];
    const result = {
      variant,
      group,
      engine: group === "cold_relaunch_chromium" ? "Chromium" : "WebKit",
      repetition:
        report.samples.filter((s) => s.variant === variant && s.group === group).length + 1,
      ok: false,
      values: {},
      validation: null,
      errors: [],
      failure: null,
    };
    state.errors = result.errors;
    try {
      if (group !== "first_visit" && state.preparationFailure)
        throw new Error(`Prepared WebKit context failed: ${state.preparationFailure}`);
      await action(state, result);
      if (result.errors.length) throw new Error("Page errors occurred.");
      result.ok = true;
    } catch (error) {
      result.failure = String(error);
    }
    report.samples.push(result);
    save();
    console.log(
      `${variant} ${group} ${result.repetition}: ${result.ok ? JSON.stringify(result.values) : result.failure.split("\n")[0]}`,
    );
  };
  const launch = async (state) => {
    const handle = await launchWebKit();
    state.handle = handle;
    state.network = { pending: new Set(), changedAt: performance.now() };
    handle.context.on("request", (request) => {
      state.network.pending.add(request);
      state.network.changedAt = performance.now();
    });
    for (const event of ["requestfinished", "requestfailed"])
      handle.context.on(event, (request) => {
        state.network.pending.delete(request);
        state.network.changedAt = performance.now();
      });
    report.webkitVersion = handle.version;
    report.webkitBuild = handle.build;
    await handle.context.addInitScript(timingProbe);
    handle.context.on("page", (page) =>
      page.on("pageerror", (error) => state.errors?.push(error.message)),
    );
    return handle;
  };
  const close = async (state) => {
    await state.handle?.close();
    state.handle = null;
  };
  const navigate = async (state, pathname = startPath, page) => {
    page ??= state.handle.context.pages()[0] ?? (await state.handle.newPage());
    return state.handle.capture(async () => {
      const wall = performance.now();
      await page.goto(`${state.server.origin}${pathname}`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      const validation = await booksReady(page);
      const wallMs = performance.now() - wall;
      await page.waitForFunction(() => window.__harkTiming.books !== null);
      const painted = await page.evaluate(() => window.__harkTiming.books);
      return { page, validation: { ...validation, painted }, ms: painted.ms, wallMs };
    });
  };
  const warm = async (state) => {
    const page = state.handle.context.pages()[0];
    await booksReady(page);
    const deadline = performance.now() + 60000;
    while (state.network.pending.size || performance.now() - state.network.changedAt < 3000) {
      if (performance.now() > deadline)
        throw new Error("Prepared library requests did not settle before warm navigation.");
      await sleep(50);
    }
    const readiness = {
      pendingRequests: state.network.pending.size,
      networkQuietMs: performance.now() - state.network.changedAt,
    };
    return { ...(await navigate(state, startPath, page)), readiness };
  };
  const startChromium = async (state) => {
    const handle = await launchChromium(state.chromiumProfile);
    state.chromium = handle;
    report.chromiumVersion = handle.version;
    await handle.context.addInitScript(timingProbe);
    for (const page of handle.context.pages())
      page.on("pageerror", (error) => state.errors?.push(error.message));
    handle.context.on("page", (page) =>
      page.on("pageerror", (error) => state.errors?.push(error.message)),
    );
    return handle;
  };
  try {
    report.fixture = await audioFixture();
    for (const [name, directory] of Object.entries({ A, B })) {
      const absolute = path.resolve(directory);
      const server = await startServer(absolute, name === "A" ? 3100 : 3200, true);
      const state = {
        directory: absolute,
        server,
        chromiumProfile: freshProfile(),
        handle: null,
        account: null,
        cookies: null,
        errors: [],
      };
      variants[name] = state;
      const receiptPath = path.join(absolute, "benchmark-build.json");
      if (!bundles.has(absolute)) bundles.set(absolute, bundleSizes(absolute));
      report.variants[name] = {
        buildDir: absolute,
        buildId: readFileSync(path.join(absolute, ".next/BUILD_ID"), "utf8").trim(),
        source: existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null,
        bundles: bundles.get(absolute),
        seedScriptSha256: sha256(readFileSync(path.join(A, "scripts/seed-perf.mjs"))),
      };
      state.account = await syntheticAccount(A);
      report.variants[name].account = {
        id: state.account.id,
        email: state.account.email,
        metadataBooks: state.account.bookCount,
      };
      await launch(state);
      state.cookies = await signIn(state.handle.context, server.origin, state.account);
    }
    save();
    for (const name of order(repetitions.first_visit))
      await sample(name, "first_visit", async (state, result) => {
        if (!state.handle) await launch(state);
        try {
          await state.handle.context.addCookies(state.cookies);
          await state.server.transfers(true);
          const launchResult = await navigate(state, "/library");
          result.values.first_visit_ms = launchResult.ms;
          result.validation = launchResult.validation;
          const cutoff = await launchResult.page.evaluate(
            () => performance.timeOrigin + window.__harkTiming.books.ms,
          );
          const transfers = (await state.server.transfers()).filter(
            (transfer) => transfer.finishedAt <= cutoff,
          );
          if (transfers.some((transfer) => transfer.pipelined))
            throw new Error("Pipelined responses make socket transfer attribution ambiguous.");
          result.staticTransfers = transfers;
          result.staticTransferMethod =
            "Server socket bytes, including service-worker fetches and HTTP headers, completed by the books paint.";
          result.values.first_visit_static_transfer_bytes = transfers.reduce(
            (total, transfer) => total + transfer.wireBytes,
            0,
          );
          result.resourceTimings = await launchResult.page.evaluate(() =>
            performance
              .getEntriesByType("resource")
              .filter((resource) => new URL(resource.name).pathname.startsWith("/_next/static/"))
              .map((resource) => ({
                pathname: new URL(resource.name).pathname,
                transferSize: resource.transferSize,
                encodedBodySize: resource.encodedBodySize,
              })),
          );
        } finally {
          await close(state);
        }
      });
    for (const [name, state] of Object.entries(variants)) {
      const preparation = {
        engine: "WebKit",
        context: "non-persistent",
        ok: false,
        validation: null,
        failure: null,
        errors: [],
      };
      state.errors = preparation.errors;
      report.variants[name].preparation = preparation;
      try {
        await launch(state);
        await state.handle.context.addCookies(state.cookies);
        const ready = await navigate(state, "/library");
        preparation.validation = ready.validation;
        state.bookPath = await state.handle.capture(() => importAudio(ready.page, report.fixture));
        await shellReady(ready.page);
        if (preparation.errors.length) throw new Error("Page errors during preparation.");
        preparation.ok = true;
      } catch (error) {
        preparation.failure = String(error);
        state.preparationFailure = preparation.failure;
      } finally {
        save();
      }
    }
    for (const name of order(repetitions.warm_start))
      await sample(name, "warm_start", async (state, result) => {
        const page = state.handle.context.pages()[0];
        const pid = state.handle.pageProcess(page).pid;
        const ready = await warm(state);
        result.values.warm_start_ms = ready.ms;
        result.validation = ready.validation;
        result.readiness = ready.readiness;
        result.warmStartFrom = new URL(page.url()).pathname;
        result.pageProcess = { before: pid, after: state.handle.pageProcess(page).pid };
      });
    for (const name of order(repetitions.playback))
      await sample(name, "playback", async (state, result) => {
        const ready = await warm(state);
        result.startDefinition = "from warm library";
        result.validation = ready.validation;
        result.readiness = ready.readiness;
        const opened = await timedClick(ready.page, bookCard(ready.page), "play-enabled");
        const started = await timedClick(ready.page, playButton(ready.page), "audio");
        result.values = {
          time_to_playback_ms: started.paintedAt - opened.clickedAt,
          open_player_ms: opened.ms,
          play_start_ms: started.ms,
        };
        result.playback = started.playback;
        await ready.page.getByRole("button", { name: "Pause", exact: true }).click();
        await backButton(ready.page).click();
        await booksReady(ready.page);
      });
    for (const name of order(repetitions.transitions))
      await sample(name, "transitions", async (state, result) => {
        const page = state.handle.context.pages()[0];
        result.validation = await booksReady(page);
        result.values.library_player_ms = (await timedClick(page, bookCard(page), "player")).ms;
        result.values.player_library_ms = (await timedClick(page, backButton(page), "books")).ms;
        result.values.library_settings_ms = (
          await timedClick(
            page,
            page.getByRole("link", { name: "Settings", exact: true }),
            "settings",
          )
        ).ms;
        result.values.settings_library_ms = (
          await timedClick(page, page.getByRole("link", { name: "Library", exact: true }), "books")
        ).ms;
        await booksReady(page);
      });
    for (const name of order(repetitions.memory))
      await sample(name, "memory", async (state, result) => {
        const page = state.handle.context.pages()[0];
        result.validation = await booksReady(page);
        await timedClick(page, bookCard(page), "play-enabled");
        const playback = await timedClick(page, playButton(page), "audio");
        result.playback = playback.playback;
        const remainingPlayback =
          10000 -
          (await page.evaluate(
            (playingAt) => performance.now() - playingAt,
            playback.playingAt ?? playback.paintedAt,
          ));
        if (remainingPlayback > 0) await sleep(remainingPlayback);
        const audio = await page.evaluate(() => {
          const a = document.querySelector("audio");
          return { paused: a.paused, time: a.currentTime };
        });
        if (audio.paused || audio.time < playback.playback.before + 9)
          throw new Error("Playback did not continue for memory measurement.");
        result.playbackMemory = state.handle.rss();
        result.values = {
          playback_rss_kib: result.playbackMemory.rssKiB,
        };
        await page.getByRole("button", { name: "Pause", exact: true }).click();
        await backButton(page).click();
        await booksReady(page);
      });
    for (const state of Object.values(variants)) await close(state);
    for (const [name, state] of Object.entries(variants)) {
      const preparation = { engine: "Chromium", ok: false, errors: [], failure: null };
      state.errors = preparation.errors;
      report.variants[name].chromiumPreparation = preparation;
      try {
        const handle = await startChromium(state);
        await handle.context.addCookies(state.cookies);
        const page = handle.context.pages()[0];
        await page.goto(`${state.server.origin}/library`, { waitUntil: "domcontentloaded" });
        await booksReady(page);
        await importAudio(page, report.fixture);
        await shellReady(page);
        if (preparation.errors.length) throw new Error("Page errors during Chromium preparation.");
        await handle.context.close();
        state.chromium = null;
        const committed = await startChromium(state);
        const restoredPage = committed.context.pages()[0];
        await restoredPage.goto(`${state.server.origin}/library`, {
          waitUntil: "domcontentloaded",
        });
        await booksReady(restoredPage);
        await shellReady(restoredPage);
        preparation.profileCommitted = true;
        preparation.ok = true;
      } catch (error) {
        preparation.failure = String(error);
      }
      save();
    }
    for (const name of order(repetitions.cold_relaunch_chromium))
      await sample(name, "cold_relaunch_chromium", async (state, result) => {
        const preparation = report.variants[name].chromiumPreparation;
        if (!preparation.ok) throw new Error(`Chromium preparation failed: ${preparation.failure}`);
        result.browserRelaunch = await state.chromium.kill();
        state.chromium = null;
        const handle = await startChromium(state);
        const page = handle.context.pages()[0];
        const wall = performance.now();
        await page.goto(`${state.server.origin}${startPath}`, { waitUntil: "domcontentloaded" });
        result.validation = await booksReady(page);
        result.wallMs = performance.now() - wall;
        const painted = await page.evaluate(() => window.__harkTiming.books);
        if (!painted) throw new Error("Chromium books paint was not observed.");
        result.values.cold_relaunch_chromium_ms = painted.ms;
        result.validation.painted = painted;
        const opened = await timedClick(page, bookCard(page), "play-enabled");
        const started = await timedClick(page, playButton(page), "audio");
        result.values.cold_relaunch_playback_chromium_ms = started.paintedAt - opened.clickedAt;
        result.playback = started.playback;
        result.playbackStartDefinition = "from relaunched Chromium cold start";
        await page.getByRole("button", { name: "Pause", exact: true }).click();
      });
    report.completed = true;
  } catch (error) {
    report.fatalFailure = String(error);
    throw error;
  } finally {
    for (const state of Object.values(variants)) {
      await close(state);
      await state.chromium?.context.close();
      await state.server.close();
    }
    for (const result of report.samples)
      if (result.errors.length) {
        result.ok = false;
        result.failure ??= "Page errors occurred.";
      }
    for (const name of ["A", "B"]) {
      const samples = report.samples.filter((sample) => sample.variant === name);
      const metricGroups = {
        first_visit: ["first_visit_ms", "first_visit_static_transfer_bytes"],
        cold_start: ["cold_start_ms", "cold_start_wall_ms"],
        warm_start: ["warm_start_ms"],
        cold_relaunch_chromium: ["cold_relaunch_chromium_ms", "cold_relaunch_playback_chromium_ms"],
        playback: ["time_to_playback_ms", "open_player_ms", "play_start_ms"],
        transitions: [
          "library_player_ms",
          "player_library_ms",
          "library_settings_ms",
          "settings_library_ms",
        ],
        memory: ["cold_rss_kib", "playback_rss_kib"],
      };
      for (const [group, metrics] of Object.entries(metricGroups))
        for (const metric of metrics)
          report.aggregates[name][metric] = aggregate(
            samples
              .filter((s) => s.group === group && s.ok && Number.isFinite(s.values[metric]))
              .map((s) => s.values[metric]),
            samples.filter((s) => s.group === group && !s.ok).length,
          );
      const gzip = report.variants[name]?.bundles.launchClosure.gzip;
      report.aggregates[name].launch_closure_gzip_bytes = aggregate(
        gzip === undefined ? [] : [gzip],
      );
    }
    let noise = null;
    try {
      noise = noisePath ? JSON.parse(readFileSync(noisePath, "utf8")) : null;
      if (
        noise &&
        (!noise.completed ||
          noise.protocol !== "v1.1" ||
          noise.variants.A.buildId !== noise.variants.B.buildId ||
          noise.samples.some((sample) => !sample.ok) ||
          Object.entries(defaults).some(([group, count]) => noise.repetitions[group] !== count) ||
          noise.nodeVersion !== report.nodeVersion ||
          noise.webkitVersion !== report.webkitVersion ||
          noise.chromiumVersion !== report.chromiumVersion ||
          noise.playbackStartDefinition !== report.playbackStartDefinition ||
          noise.chromiumPlaybackStartDefinition !== report.chromiumPlaybackStartDefinition ||
          JSON.stringify(noise.measurementOrder) !== JSON.stringify(report.measurementOrder) ||
          noise.fixture.sha256 !== report.fixture.sha256 ||
          JSON.stringify(noise.host) !== JSON.stringify(report.host) ||
          JSON.stringify(noise.OS) !== JSON.stringify(report.OS))
      )
        throw new Error(
          "Noise result must be a full valid A/A run on the same host, engine and fixture.",
        );
    } catch (error) {
      report.noiseFailure = String(error);
      noise = null;
    }
    report.compare = compareResults(report, noise);
    report.finishedAt = new Date().toISOString();
    save();
    printTable(report);
    if (report.noiseFailure) console.error(report.noiseFailure);
  }
  return report;
}
