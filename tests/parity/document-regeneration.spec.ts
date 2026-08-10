import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ACCOUNT_A,
  cutNetwork,
  ensureAccount,
  network,
  openDevice,
  resetAccount,
  restoreNetwork,
  sessionFor,
  warmUp,
  type Device,
} from "./harness/app";

const SOURCE_PATH = path.join(process.cwd(), "tests/fixtures/documents/tiny-book.txt");

let device: Device | null = null;

test.afterEach(async () => {
  const net = await network();
  if (net.isCut() && device) await restoreNetwork(device.page);
  await device?.context.close();
  device = null;
});

test("an evicted document regenerates and plays with the backend transport absent", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const account = await ensureAccount(browser, ACCOUNT_A);
  await resetAccount(account.userId);
  const storageState = await sessionFor(browser, account);
  device = await openDevice(browser, {
    storageState,
    deviceId: "parity-document-regeneration-00001",
  });
  const { page } = device;
  const net = await network();
  net.restore();
  await warmUp(page);
  await page.waitForSelector("[data-import-ready]", { state: "attached", timeout: 60_000 });

  const source = readFileSync(SOURCE_PATH);
  await page.setInputFiles('input[aria-label="Choose an audiobook or document to import"]', {
    name: path.basename(SOURCE_PATH),
    mimeType: "text/plain",
    buffer: source,
  });
  const card = page.locator("article.book-item");
  await expect(card).toHaveCount(1, { timeout: 180_000 });
  await expect(card.getByText(/on this device$/)).toBeVisible({ timeout: 30_000 });
  const href = await card.locator("a.book-title").getAttribute("href");
  expect(href, "the generated document card has no player route").toMatch(/^\/books\//);

  const runtimeCoverage = await page.evaluate(async () => {
    const response = await fetch("/chapterline-runtime-assets.json", { cache: "no-store" });
    const manifest = (await response.json()) as { assets: string[] };
    const missing: string[] = [];
    for (const asset of manifest.assets) {
      if (!(await caches.match(asset))) missing.push(asset);
    }
    return { count: manifest.assets.length, missing };
  });
  expect(runtimeCoverage.count, "the build emitted no document runtime closure").toBeGreaterThan(0);
  expect(
    runtimeCoverage.missing,
    "the service worker activated without caching the complete document/player runtime graph",
  ).toStrictEqual([]);

  const removed = await page.evaluate(async () => {
    const removedCaches = (await caches.keys()).filter((name) =>
      name.startsWith("chapterline-media"),
    );
    await Promise.all(removedCaches.map((name) => caches.delete(name)));
    return removedCaches;
  });
  expect(removed.length, "the test did not evict the generated audio").toBeGreaterThan(0);

  const failedAssets: string[] = [];
  page.on("requestfailed", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/_next/")) failedAssets.push(pathname);
  });
  net.reset();
  await cutNetwork(page);

  await page.goto(`${device.origin}${href}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Attach document" })).toBeVisible({
    timeout: 60_000,
  });
  await page.setInputFiles('input[aria-label^="Attach "]', {
    name: path.basename(SOURCE_PATH),
    mimeType: "text/plain",
    buffer: source,
  });
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible({ timeout: 180_000 });

  const regeneratedMedia = await page.evaluate(async () => {
    const source = document.querySelector<HTMLAudioElement>("audio")?.getAttribute("src") ?? null;
    const cache = await caches.open("chapterline-media-v2");
    const entries = (await cache.keys()).map((request) => new URL(request.url).pathname);
    const response = source
      ? await fetch(source, { headers: { Range: "bytes=0-1" } }).catch(() => null)
      : null;
    const bytes = await response?.arrayBuffer();
    return {
      source,
      entries,
      status: response?.status ?? null,
      byteLength: bytes?.byteLength ?? 0,
    };
  });
  expect(regeneratedMedia.source, "the regenerated player has no media source").toMatch(
    /^\/offline-media\//,
  );
  expect(
    regeneratedMedia.entries,
    "the generated player points at media that was not committed to Cache Storage",
  ).toContain(regeneratedMedia.source);
  expect(regeneratedMedia.status, "the service worker could not serve the regenerated media").toBe(
    206,
  );
  expect(regeneratedMedia.byteLength, "the media range response was empty").toBe(2);

  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);

  expect(
    [...new Set(failedAssets)],
    "offline regeneration attempted to fetch an app chunk omitted from the precache graph",
  ).toStrictEqual([]);
  expect(
    net.hits(),
    "the supposedly offline regeneration reached the backend through the socket-cut proxy",
  ).toStrictEqual([]);
  expect(net.blockedCount(), "the proxy was never exercised while cut").toBeGreaterThan(0);
});
