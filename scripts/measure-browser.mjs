// Real production PWA measurements; no routes, model stubs, or synthetic audio events.
// Usage: node scripts/measure-browser.mjs baseline|final core|library
import { chromium, devices, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "./lib/env-file.mjs";
import { assertLocalDatabase } from "./lib/assert-local-database.mjs";
loadEnvFile(".env.test");
assertLocalDatabase(process.env.DATABASE_URL);
const [phase, mode = "core"] = process.argv.slice(2);
if (!["baseline", "final"].includes(phase) || !["core", "library"].includes(mode))
  throw new Error("Expected phase and mode");
const output = path.resolve(`.data/objective/${phase}/${mode}`);
mkdirSync(output, { recursive: true });
const origin = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices["iPhone 15"],
  serviceWorkers: "allow",
  extraHTTPHeaders: { "x-forwarded-for": "198.51.100.110" },
});
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
await page.addInitScript(() => {
  window.__measurement = { transactions: 0, longTasks: [] };
  const original = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    window.__measurement.transactions++;
    return original.apply(this, args);
  };
  new PerformanceObserver((list) => {
    window.__measurement.longTasks.push(
      ...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })),
    );
  }).observe({ type: "longtask", buffered: true });
});
const report = {
  phase,
  mode,
  browser: browser.version(),
  viewport: "iPhone 15 emulation, Chromium, unthrottled",
  steps: [],
  requests: [],
  errors: [],
};
const save = () =>
  writeFileSync(`${output}/measurements.json`, JSON.stringify(report, null, 2) + "\n");
page.on("pageerror", (e) => report.errors.push(String(e)));
context.on("request", (r) => {
  const u = new URL(r.url());
  if (u.protocol.startsWith("http"))
    report.requests.push({
      method: r.method(),
      url: u.origin + u.pathname,
      bytes: r.postDataBuffer()?.length || 0,
    });
});
async function shot(name) {
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}
async function step(name, action) {
  const started = performance.now();
  try {
    const detail = await action();
    report.steps.push({ name, elapsedMs: performance.now() - started, outcome: "pass", detail });
    save();
    console.log(`PASS ${name}: ${Math.round(performance.now() - started)}ms`);
    return detail;
  } catch (e) {
    report.steps.push({
      name,
      elapsedMs: performance.now() - started,
      outcome: "fail",
      error: String(e),
    });
    await shot("failure").catch(() => {});
    save();
    throw e;
  }
}
async function ready() {
  await expect(page.locator("[data-launch-ready]")).toBeAttached({ timeout: 60000 });
}
async function performanceState() {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(
    metrics
      .filter((m) => ["JSHeapUsedSize", "TaskDuration", "ScriptDuration", "Nodes"].includes(m.name))
      .map((m) => [m.name, m.value]),
  );
}
try {
  if (mode === "library") {
    await step("sign-in-seeded-1000-book-library", async () => {
      await page.goto(`${origin}/login`);
      await page.getByLabel("Email").fill(process.env.HARK_TEST_ACCOUNT_EMAIL);
      await page.getByLabel("Password").fill(process.env.HARK_TEST_ACCOUNT_PASSWORD);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL(/\/library/);
      await ready();
      await expect(page.locator("article.book-item")).toHaveCount(50, { timeout: 60000 });
      await page.waitForTimeout(2000);
      await shot("1000-books");
      report.startup = {
        performance: await performanceState(),
        resources: await page.evaluate(() =>
          performance.getEntriesByType("resource").map((r) => ({
            name: r.name,
            transferSize: r.transferSize,
            decodedBodySize: r.decodedBodySize,
            initiatorType: r.initiatorType,
          })),
        ),
      };
    });
    const samples = [];
    for (let i = 0; i < 7; i++) {
      const before = await page.evaluate(() => window.__measurement.transactions);
      const start = performance.now();
      await page
        .getByRole("searchbox", { name: "Search your library" })
        .fill(`no-match-objective-${i}`);
      await expect(page.getByRole("heading", { name: "No matching books" })).toBeVisible();
      const searchMs = performance.now() - start;
      await page.getByRole("searchbox", { name: "Search your library" }).fill("");
      await expect(page.locator("article.book-item")).toHaveCount(50);
      samples.push({
        searchMs,
        roundtripMs: performance.now() - start,
        transactions: (await page.evaluate(() => window.__measurement.transactions)) - before,
      });
    }
    report.search = samples;
    report.performance = await performanceState();
    await shot("search-recovered");
  } else {
    const unique = Date.now();
    await step("register-and-empty-library", async () => {
      await page.goto(`${origin}/register`);
      await page.getByLabel("Name").fill("Objective disposable");
      await page.getByLabel("Email").fill(`objective-${phase}-${unique}@hark.test`);
      await page.getByLabel(/Password/).fill(`Objective-only-${unique}!`);
      await page.getByRole("button", { name: "Create account" }).click();
      await page.waitForURL(/\/library/);
      await ready();
      await shot("empty");
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await page.reload();
      await ready();
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      report.startup = {
        performance: await performanceState(),
        resources: await page.evaluate(() =>
          performance.getEntriesByType("resource").map((r) => ({
            name: r.name,
            transferSize: r.transferSize,
            decodedBodySize: r.decodedBodySize,
            initiatorType: r.initiatorType,
          })),
        ),
      };
    });
    await step("invalid-mp3-error", async () => {
      await page.setInputFiles('input[aria-label="Choose an audiobook or document to import"]', {
        name: "broken.mp3",
        mimeType: "audio/mpeg",
        buffer: Buffer.from("Not an MP3"),
      });
      await expect(page.getByRole("alert")).toBeVisible();
      await shot("import-error");
      await page.getByRole("button", { name: "Dismiss error" }).click();
    });
    await step("mp3-import", async () => {
      await page.setInputFiles(
        'input[aria-label="Choose an audiobook or document to import"]',
        "tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3",
      );
      await expect(
        page.getByRole("link", { name: "iPhone Downloads Test", exact: true }),
      ).toBeVisible({ timeout: 60000 });
      await shot("mp3-imported");
      return performanceState();
    });
    await step("playback-and-resume", async () => {
      await page.getByRole("link", { name: "iPhone Downloads Test", exact: true }).click();
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect
        .poll(() => page.locator("audio").evaluate((a) => a.currentTime))
        .toBeGreaterThan(0.2);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.getByRole("slider", { name: "Audiobook position" }).fill("2000");
      await page.getByRole("combobox", { name: /Playback speed/ }).selectOption("1.5");
      await shot("player");
      await page.reload();
      await expect(page.getByRole("slider", { name: "Audiobook position" })).toHaveValue("2000");
      return performanceState();
    });
    await step("offline-relaunch-and-play", async () => {
      await context.setOffline(true);
      await page.goto(`${origin}/library`);
      await ready();
      const reachable = await page.evaluate(() =>
        fetch("/api/sync/pull?objective-proof=1").then(
          () => true,
          () => false,
        ),
      );
      if (reachable) throw new Error("Offline control reached API");
      await page.getByRole("link", { name: "iPhone Downloads Test", exact: true }).click();
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect
        .poll(() => page.locator("audio").evaluate((a) => a.currentTime))
        .toBeGreaterThan(2.2);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await shot("offline-player");
      await context.setOffline(false);
      await page.goto(`${origin}/library`);
      await ready();
    });
    await step("live-document-narration", async () => {
      const start = performance.now();
      await page.setInputFiles(
        'input[aria-label="Choose an audiobook or document to import"]',
        "tests/fixtures/documents/tiny-book.txt",
      );
      await expect(page.getByRole("progressbar", { name: /Narrating tiny-book/ })).toBeVisible();
      await shot("narration-progress");
      await expect(page.locator("article.book-item")).toHaveCount(2, { timeout: 300000 });
      await shot("narration-complete");
      return { ms: performance.now() - start, performance: await performanceState() };
    });
    report.warmLaunches = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await page.reload();
      await ready();
      report.warmLaunches.push(performance.now() - start);
    }
    report.performance = await performanceState();
    report.instrumentation = await page.evaluate(() => window.__measurement);
  }
} finally {
  save();
  await context.tracing.stop({ path: `${output}/trace.zip` });
  await browser.close();
}
