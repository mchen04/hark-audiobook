import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  outsideRepository,
  prepareBuild,
  prepareWorktree,
  root,
} from "../../scripts/bench/build.mjs";
import {
  audioFixture,
  backButton,
  bookCard,
  booksReady,
  freshProfile,
  importAudio,
  launchChromium,
  launchWebKit,
  playerReady,
  processSnapshot,
  sha256,
  shellReady,
  signIn,
  startPath,
  startServer,
  syntheticAccount,
} from "../../scripts/bench/runtime.mjs";
import {
  observe,
  offlineRanges,
  persisted,
  position,
  rangeEvidence,
  storage,
  until,
} from "./helpers.mjs";

function buildInfo(directory) {
  const staticDirectory = path.join(directory, ".next/static");
  const assets = Object.fromEntries(
    readdirSync(staticDirectory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [
          `/_next/static/${path.relative(staticDirectory, file)}`,
          sha256(readFileSync(file)),
        ];
      }),
  );
  const buildId = readFileSync(path.join(directory, ".next/BUILD_ID"), "utf8").trim();
  const html = readFileSync(path.join(directory, ".next/server/app/offline.html"), "utf8");
  assert(html.includes(buildId), "Built offline HTML must identify its build");
  const sourceFiles = execFileSync(
    "git",
    ["ls-files", "-z", "src", "public", "drizzle", "next.config.ts"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => file && existsSync(path.join(directory, file)));
  const receipt = path.join(directory, "benchmark-build.json");
  return {
    directory,
    source: existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : null,
    applicationSourceSha256: sha256(
      Buffer.concat(
        sourceFiles.flatMap((file) => [
          Buffer.from(file),
          readFileSync(path.join(directory, file)),
        ]),
      ),
    ),
    buildId,
    assets,
    offlineHtmlSha256: sha256(html),
    serviceWorkerSha256: sha256(readFileSync(path.join(directory, "public/sw.js"))),
  };
}

async function scenario(engine, previous, next, report, save) {
  const result = {
    engine,
    scope:
      engine === "WebKit"
        ? "One non-persistent context and one live WebContent process; no browser relaunch claim"
        : "Persistent profile with real browser process relaunches",
    ok: false,
    steps: [],
    networks: [],
    previousBuildLaunches: 0,
    launchCountDefinition:
      "Launches after the server switch; excludes initial previous-build preparation",
  };
  report.engines.push(result);
  let server;
  let handle;
  let page;
  let witness;
  let webContentPid;
  let account;
  let bookId;
  let saved;
  let oldGeneration;
  let closedBrowser;
  const profile = engine === "Chromium" ? freshProfile() : null;
  result.profile = profile;
  const open = async () => {
    handle = engine === "WebKit" ? await launchWebKit() : await launchChromium(profile);
    result.version = handle.version;
    page = engine === "WebKit" ? await handle.newPage() : handle.context.pages()[0];
    page.setDefaultTimeout(15000);
    witness = observe(page);
    result.networks.push(witness.evidence);
    if (engine === "WebKit") webContentPid = handle.pageProcess(page).pid;
  };
  const pidProof = () => {
    if (engine !== "WebKit") return null;
    const renderers = handle
      .rss()
      .processes.filter((process) => process.executable.includes("WebContent"));
    assert.deepEqual(
      renderers.map((process) => process.pid),
      [webContentPid],
      "The only owned WebContent PID must remain unchanged",
    );
    assert.equal(handle.pageProcess(page).pid, webContentPid);
    return {
      pid: webContentPid,
      ownedWebContentPids: renderers.map((process) => process.pid),
      unchanged: true,
    };
  };
  const closeBrowser = async () => {
    await witness.quiet();
    await witness.clean();
    const pid = handle.pid;
    await handle.context.close();
    handle = null;
    await until(
      () => !processSnapshot().some((process) => process.pid === pid),
      "Owned Chromium browser PID does not exit.",
    );
    closedBrowser = { pid, exited: true, graceful: true };
    return closedBrowser;
  };
  const launch = async (expected) => {
    if (engine === "Chromium") {
      if (handle) await closeBrowser();
      await open();
      assert.notEqual(handle.pid, closedBrowser.pid, "Chromium must use a new browser PID");
      result.browserRelaunches ??= [];
      result.browserRelaunches.push({ ...closedBrowser, newPid: handle.pid });
    } else await witness.quiet();
    const staticResponseStart = witness.evidence.staticResponses.length;
    const navigate = () =>
      page.goto(`http://127.0.0.1:3400${startPath}`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    const response = await (engine === "WebKit" ? handle.capture(navigate) : navigate());
    assert(response, "Launch must have a document response");
    const html = await response.text();
    const ids = [previous.buildId, next.buildId].filter((id) => html.includes(id));
    assert.equal(ids.length, 1, "Served HTML must prove exactly one known build ID");
    if (expected) assert.equal(ids[0], expected, "Served document build ID");
    if (ids[0] === previous.buildId) result.previousBuildLaunches++;
    const validation = await booksReady(page);
    const proof = {
      buildId: ids[0],
      htmlSha256: sha256(html),
      responseStatus: response.status(),
      staticResponseStart,
      fromServiceWorker: response.fromServiceWorker(),
      generation: response.headers()["x-chapterline-shell-generation"] ?? null,
      scriptPaths: [...new Set(html.match(/\/_next\/static\/[^"'\s\\]+/g) || [])],
      validation,
      webContent: pidProof(),
    };
    result.launches ??= [];
    result.launches.push(proof);
    return proof;
  };
  const step = async (name, action) => {
    const entry = { name, ok: false, evidence: {}, failure: null };
    result.steps.push(entry);
    save();
    try {
      if (engine === "WebKit") await handle.capture(() => action(entry.evidence));
      else await action(entry.evidence);
      entry.evidence.webContent = pidProof();
      await witness.clean();
      entry.ok = true;
    } catch (error) {
      entry.failure = String(error);
      throw error;
    } finally {
      save();
      console.log(`${engine} ${name}: ${entry.ok ? "PASS" : entry.failure}`);
    }
  };
  try {
    server = await startServer(previous.directory, 3400);
    await open();
    account = await syntheticAccount(previous.directory);
    await signIn(handle.context, server.origin, account);
    await step("prepare-previous", async (evidence) => {
      await page.goto(`${server.origin}/library`, { waitUntil: "domcontentloaded" });
      await booksReady(page);
      const bookPath = await importAudio(page, report.fixture);
      bookId = bookPath.split("/").at(-1);
      result.bookId = bookId;
      await bookCard(page).click();
      await playerReady(page);
      await page.getByRole("slider", { name: "Audiobook position" }).fill("123000");
      await until(
        async () => Math.abs((await position(page)) - 123) <= 0.25,
        "Initial seek must reach 123s",
      );
      const start = await position(page);
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await page.waitForFunction(
        (start) =>
          !document.querySelector("audio").paused &&
          document.querySelector("audio").currentTime >= start + 1,
        start,
      );
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      saved = await position(page);
      evidence.requestedSeekSeconds = 123;
      result.savedSeconds = saved;
      evidence.saved = await persisted(page, account.id, bookId, saved);
      await backButton(page).click();
      await booksReady(page);
      await shellReady(page);
      await witness.quiet();
      const snapshot = await storage(page, account.id, bookId);
      const shell = snapshot.caches.find(
        (cache) =>
          cache.name.startsWith("chapterline-shell-") &&
          cache.launchHtml?.includes(previous.buildId),
      );
      assert(
        shell?.launchHtml.includes(previous.buildId),
        "Prepared shell must belong to previous build",
      );
      oldGeneration = shell.generation;
      result.previousGeneration = oldGeneration;
      evidence.storage = snapshot;
    });
    await step("switch-and-open-lazy-routes", async (evidence) => {
      if (engine === "Chromium") {
        evidence.closedPrevious = await closeBrowser();
      } else await witness.quiet();
      await server.close();
      server = await startServer(next.directory, 3400);
      const absent = Object.keys(previous.assets).filter((url) => !(url in next.assets));
      assert(absent.length > 0, "Real builds must have different static asset names");
      const missing = await fetch(`${server.origin}${absent[0]}`);
      evidence.previousAssetAbsent = {
        path: absent[0],
        status: missing.status,
        previousSha256: previous.assets[absent[0]],
      };
      assert.equal(
        missing.status,
        404,
        "The next server must not have previous build's unique chunk",
      );
      evidence.document = await launch();
      const start = witness.evidence.staticResponses.length;
      await bookCard(page).click();
      await playerReady(page);
      evidence.player = {
        positionSeconds: await position(page),
        staticResponseCount: witness.evidence.staticResponses.length - start,
      };
      await backButton(page).click();
      await booksReady(page);
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
      await witness.quiet();
      evidence.lazyStaticResponses = witness.evidence.staticResponses.slice(start);
      assert(
        evidence.lazyStaticResponses.some((response) => response.pathname.endsWith(".js")),
        "Lazy routes must request JavaScript after the server switch",
      );
      for (const response of evidence.lazyStaticResponses)
        assert(
          [previous.assets[response.pathname], next.assets[response.pathname]].includes(
            response.sha256,
          ),
          "Lazy chunk bytes must match a real build",
        );
      await page.getByRole("link", { name: "Library", exact: true }).click();
      await booksReady(page);
    });
    await step("stage-next-and-launch", async (evidence) => {
      const staged = await until(async () => {
        const snapshot = await storage(page, account.id, bookId);
        const live = snapshot.caches.find(
          (cache) =>
            cache.name.startsWith("chapterline-shell-") && cache.launchHtml?.includes(next.buildId),
        );
        return live?.launchHtml.includes(next.buildId) ? snapshot : null;
      }, "The app does not stage the next shell after launch paint.");
      evidence.stagedStorage = staged;
      evidence.workerBytesChanged = previous.serviceWorkerSha256 !== next.serviceWorkerSha256;
      evidence.document = await launch(next.buildId);
      assert(result.previousBuildLaunches <= 1, "At most one launch may show the previous build");
      await shellReady(page);
      await witness.quiet();
      await until(
        async () =>
          !(await storage(page, account.id, bookId)).caches.some(
            (cache) => cache.name === oldGeneration,
          ),
        "Old shell generation survives after its document client leaves.",
      );
      evidence.cleanedStorage = await storage(page, account.id, bookId);
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
      await witness.quiet();
      const openPlayer = () =>
        page.goto(`http://127.0.0.1:3400/books/${bookId}`, { waitUntil: "domcontentloaded" });
      const playerResponse = await (engine === "WebKit"
        ? handle.capture(openPlayer)
        : openPlayer());
      const playerHtml = await playerResponse.text();
      assert(
        playerHtml.includes(next.buildId) && !playerHtml.includes(previous.buildId),
        "The next player document must identify the next build",
      );
      evidence.nextPlayerDocument = {
        buildId: next.buildId,
        htmlSha256: sha256(playerHtml),
        status: playerResponse.status(),
      };
      await playerReady(page);
      evidence.nextPlayerSeconds = await position(page);
      await witness.quiet();
      evidence.nextStaticResponses = witness.evidence.staticResponses.slice(
        evidence.document.staticResponseStart,
      );
      for (const response of evidence.nextStaticResponses)
        assert.equal(
          response.sha256,
          next.assets[response.pathname],
          "Next chunk bytes must match the next build",
        );
      evidence.readyStorage = await storage(page, account.id, bookId);
    });
    await step("true-offline-next-and-media", async (evidence) => {
      await witness.quiet();
      if (engine === "Chromium") evidence.closedOnline = await closeBrowser();
      await server.close();
      server = null;
      evidence.serverReachable = await fetch("http://127.0.0.1:3400/login", {
        signal: AbortSignal.timeout(1000),
      }).then(
        () => true,
        () => false,
      );
      assert.equal(evidence.serverReachable, false, "True offline requires no server listener");
      const offlineMediaStart = engine === "Chromium" ? 0 : witness.evidence.mediaResponses.length;
      evidence.document = await launch(next.buildId);
      await bookCard(page).click();
      await playerReady(page);
      await until(
        async () => Math.abs((await position(page)) - saved) <= 0.25,
        "Offline player does not resume within 0.25s",
      );
      evidence.resumeSeconds = await position(page);
      evidence.storage = await persisted(page, account.id, bookId, saved, false);
      assert(evidence.storage.download, "Local book record must survive rollover");
      assert(
        evidence.storage.caches.some((cache) => cache.name === "chapterline-media-v2"),
        "Media cache must survive rollover",
      );
      evidence.range = await rangeEvidence(page, evidence.storage.download.offlineMediaUrl);
      const start = await position(page);
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await page.waitForFunction(
        (start) =>
          !document.querySelector("audio").paused &&
          document.querySelector("audio").currentTime >= start + 0.2,
        start,
      );
      evidence.playback = { startSeconds: start, advancedSeconds: await position(page) };
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      evidence.mediaResponses = offlineRanges(witness.evidence, offlineMediaStart);
    });
    result.ok = true;
  } catch (error) {
    result.failure = String(error);
  } finally {
    if (handle) {
      if (engine === "WebKit") await handle.close();
      else await handle.context.close();
    }
    await server?.close();
    save();
  }
  return result;
}

const { values } = parseArgs({
  args: process.argv.slice(process.argv[2] === "--" ? 3 : 2),
  options: {
    previous: { type: "string" },
    "next-dir": { type: "string" },
    out: { type: "string" },
  },
});
if (!values.previous || !values.out)
  throw new Error("Supply --previous <git-ref> and --out <external.json>.");
const output = outsideRepository(values.out);
mkdirSync(path.dirname(output), { recursive: true });
const report = { ok: false, fixture: null, previous: null, next: null, engines: [], failure: null };
const save = () => writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
try {
  const commit = execFileSync("git", ["rev-parse", `${values.previous}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const previousDirectory = path.join(
    tmpdir(),
    "builds",
    `${commit.startsWith("e4525ac") ? "base" : "previous"}-${commit.slice(0, 7)}`,
  );
  const previous = await prepareBuild(commit, previousDirectory);
  const next = values["next-dir"]
    ? { directory: outsideRepository(values["next-dir"], true) }
    : await prepareWorktree();
  report.previous = { ...previous, ...buildInfo(previous.directory) };
  report.next = { ...next, ...buildInfo(next.directory) };
  assert.notEqual(
    report.previous.buildId,
    report.next.buildId,
    "Rollover needs two distinct real builds",
  );
  report.fixture = await audioFixture();
  for (const engine of ["WebKit", "Chromium"])
    await scenario(engine, report.previous, report.next, report, save);
  report.ok = report.engines.every((engine) => engine.ok);
} catch (error) {
  report.failure = String(error);
} finally {
  save();
  console.log(
    JSON.stringify(
      {
        output,
        ok: report.ok,
        engines: report.engines.map(({ engine, ok, failure, previousBuildLaunches }) => ({
          engine,
          ok,
          failure,
          previousBuildLaunches,
        })),
      },
      null,
      2,
    ),
  );
  if (!report.ok) process.exitCode = 1;
}
