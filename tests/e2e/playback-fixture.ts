import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { execFileSync } from "node:child_process";

import { resetAccount, sharedSession } from "../sync/harness/app";

export async function prepareLocalPlayback(
  browser: Browser,
  context: BrowserContext,
  page: Page,
  info: TestInfo,
  title: string,
  origin = "",
) {
  const { account, storageState } = await sharedSession(browser);
  await resetAccount(account.userId);
  await context.addCookies(storageState.cookies);
  await page.goto(`${origin}/library`);
  await expect(page.locator('[data-launch-ready="empty"]')).toBeVisible();
  const file = info.outputPath("playback.mp3");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=180",
    "-metadata",
    `title=${title}`,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "32k",
    "-y",
    file,
  ]);
  await page.getByLabel("Choose an audiobook or document to import").setInputFiles(file);
  const link = page.getByRole("link", { name: title, exact: true });
  await expect(link).toBeVisible();
  const bookPath = (await link.getAttribute("href"))!;
  await link.click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  return { account, bookPath, bookId: bookPath.split("/").pop()! };
}

export async function captureMediaActions(context: BrowserContext) {
  await context.addInitScript(() => {
    const handlers: Record<string, MediaSessionActionHandler | null> = {};
    const prototype = Object.getPrototypeOf(navigator.mediaSession);
    const original = prototype.setActionHandler;
    prototype.setActionHandler = function (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) {
      original.call(this, action, handler);
      handlers[action] = handler;
    };
    Object.assign(window, { testMediaHandlers: handlers });
  });
}

export async function mediaAction(page: Page, action: MediaSessionAction) {
  await page.evaluate((action) => {
    const handlers = (
      window as typeof window & {
        testMediaHandlers: Record<string, MediaSessionActionHandler | null>;
      }
    ).testMediaHandlers;
    if (!handlers[action]) throw new Error(`Missing ${action} handler`);
    handlers[action]!({ action });
  }, action);
}

export async function waitForLaunchShell(page: Page) {
  await page.waitForFunction(
    async () => {
      if (!navigator.serviceWorker.controller) return false;
      const response = await caches.match("/library?source=pwa");
      if (!response?.headers.get("X-Chapterline-Shell-Generation")) return false;
      const html = await response.text();
      const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s\\]+/g) || [])];
      return (
        assets.length > 0 &&
        (await Promise.all(assets.map((asset) => caches.match(asset)))).every(Boolean)
      );
    },
    undefined,
    { timeout: 60000 },
  );
}
