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
) {
  const { account, storageState } = await sharedSession(browser);
  await resetAccount(account.userId);
  await context.addCookies(storageState.cookies);
  await page.goto("/library");
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
