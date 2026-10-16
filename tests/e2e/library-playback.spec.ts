import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

import { closeSql, resetAccount, sharedSession } from "../sync/harness/app";

test.afterAll(closeSql);

test("library buttons play in place, preserve saved position and keep a synthetic suspension offer", async ({
  browser,
  context,
  page,
}, info) => {
  test.setTimeout(180_000);
  const { account, storageState } = await sharedSession(browser);
  await resetAccount(account.userId);
  await context.addCookies(storageState.cookies);
  await page.addInitScript(() => {
    const calls: Array<{ position: number; duringClick: boolean }> = [];
    Object.assign(window, { libraryPlayCalls: calls });
    let duringClick = false;
    document.addEventListener(
      "click",
      () => {
        duringClick = true;
        setTimeout(() => {
          duringClick = false;
        }, 0);
      },
      true,
    );
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      calls.push({ position: this.currentTime, duringClick });
      return play.call(this);
    };
  });
  await page.goto("/library");
  await expect(page.locator('[data-launch-ready="empty"]')).toBeVisible();
  const audioPath = info.outputPath("library.mp3");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=180",
    "-metadata",
    "title=Library Journey",
    "-metadata",
    "artist=Disposable fixture",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "32k",
    "-y",
    audioPath,
  ]);
  await page.getByLabel("Choose an audiobook or document to import").setInputFiles(audioPath);
  const title = page.getByRole("link", { name: "Library Journey", exact: true });
  await expect(title).toBeVisible();
  const bookPath = (await title.getAttribute("href"))!;
  const bookId = bookPath.split("/").pop()!;
  await title.click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await page.getByRole("slider", { name: "Audiobook position" }).fill("12000");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.reload();
  const resume = page.getByRole("button", { name: "Resume Library Journey", exact: true });
  await expect(resume).toBeVisible();
  expect(
    await page
      .locator(".book-grid")
      .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length),
  ).toBe(3);
  await expect(page.locator(".book-progress-copy")).toBeHidden();
  await page.screenshot({ path: info.outputPath("iphone-library.png"), fullPage: true });
  await resume.click();
  await expect(page).toHaveURL(/\/library$/);
  const mini = page.getByRole("complementary", { name: "Now playing" });
  await expect(mini.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("iphone-mini.png"), fullPage: true });
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          libraryPlayCalls: Array<{ position: number; duringClick: boolean }>;
        }
      ).libraryPlayCalls,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.duringClick).toBe(true);
  expect(calls[0]!.position).toBeCloseTo(12, 1);
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeGreaterThan(12);
  await page.getByRole("button", { name: "Pause Library Journey", exact: true }).first().click();
  await page.reload();
  await page.getByRole("link", { name: "Continue listening Library Journey", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${bookPath}$`));
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  expect(await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
    true,
  );
  await expect(page.getByRole("combobox", { name: "Playback speed" })).toHaveValue("1");
  const speedBox = (await page.locator(".player-options > label").boundingBox())!;
  const sleepBox = (await page.locator(".sleep-menu summary").boundingBox())!;
  expect.soft(speedBox.height).toBeLessThanOrEqual(sleepBox.height + 1);
  await page.screenshot({ path: info.outputPath("iphone-player.png"), fullPage: true });
  await page.locator(".sleep-menu summary").click();
  await expect(page.getByRole("button", { name: "15m", exact: true })).toBeVisible();
  const sleepMenuBox = (await page.locator(".sleep-menu > div").boundingBox())!;
  expect.soft(sleepMenuBox.x).toBeGreaterThanOrEqual(0);
  expect.soft(sleepMenuBox.x + sleepMenuBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: info.outputPath("iphone-sleep.png"), fullPage: true });
  await page.getByRole("button", { name: "15m", exact: true }).click();
  await expect(page.locator(".sleep-menu summary")).toHaveAccessibleName(
    "Sleep timer, 15 minutes left",
  );
  await page.locator(".sleep-menu summary").click();
  await expect(page.getByRole("button", { name: "15m", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Turn off", exact: true }).click();
  const phoneViewport = page.viewportSize()!;
  for (const width of [320, 393, 560]) {
    await page.setViewportSize({ width, height: phoneViewport.height });
    await page.locator(".sleep-menu summary").click();
    await page.getByRole("button", { name: "End of chapter", exact: true }).click();
    await expect(page.locator(".sleep-menu summary")).toHaveAccessibleName(
      "Sleep timer, chapter end",
    );
    await page.locator(".sleep-menu summary").click();
    const menuBox = (await page.locator(".sleep-menu > div").boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "Turn off", exact: true }).click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: info.outputPath("desktop-player.png"), fullPage: true });
  await page.setViewportSize(phoneViewport);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.reload();
  await page.locator(".book-item").getByRole("button", { name: "Play Library Journey" }).click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(mini.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await mini.getByRole("button", { name: "Pause", exact: true }).click();
  await page.reload();
  await expect(resume).toBeVisible();
  const gapPositionMs = await page.evaluate(
    ({ userId, bookId }) => {
      const key = `chapterline:position:${userId}:${bookId}`;
      const record = JSON.parse(localStorage.getItem(key)!);
      localStorage.setItem(
        key,
        JSON.stringify({
          ...record,
          source: "visibility-flush",
          playingAtWrite: true,
          writtenAt: Date.now() - 90_000,
          positionAtWrite: record.positionMs,
          playbackRateAtWrite: 1,
          completedAtWrite: false,
        }),
      );
      return record.positionMs as number;
    },
    { userId: account.userId, bookId },
  );
  await resume.click();
  await expect(page).toHaveURL(new RegExp(`${bookPath}$`));
  await expect(page.locator(`[data-recorded-ms="${Math.round(gapPositionMs)}"]`)).toBeVisible();
  await expect(page.getByRole("button", { name: /Jump to about/ })).toBeVisible();
  expect(await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.setViewportSize({ width: 760, height: 900 });
  await page.getByRole("button", { name: "List view" }).click();
  await page.getByRole("button", { name: "Remove download of Library Journey" }).click();
  await expect(page.locator(".book-offdevice")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^(Play|Resume|Pause) Library Journey$/ }),
  ).toHaveCount(0);
  await expect(title).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: info.outputPath("desktop-list.png"), fullPage: true });
  await page.getByRole("button", { name: "Grid view" }).click();
  await expect(page.locator(".book-device-missing")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("desktop-library.png"), fullPage: true });
  await page.setViewportSize(phoneViewport);
  await page.screenshot({ path: info.outputPath("iphone-offdevice.png"), fullPage: true });
});
