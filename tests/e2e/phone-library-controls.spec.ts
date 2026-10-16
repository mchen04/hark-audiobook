import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

import { closeSql, resetAccount, sharedSession } from "../sync/harness/app";

test.afterAll(closeSql);

for (const width of [320, 393]) {
  test(`phone library exposes download removal through its ${width}px controls`, async ({
    browser,
    context,
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 852 });
    const { account, storageState } = await sharedSession(browser);
    await resetAccount(account.userId);
    await context.addCookies(storageState.cookies);
    await page.goto("/library");
    await expect(page.locator('[data-launch-ready="empty"]')).toBeVisible();
    const audioPath = info.outputPath("phone-removal.mp3");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=15",
      "-metadata",
      "title=Phone Removal",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "32k",
      "-y",
      audioPath,
    ]);
    await page.getByLabel("Choose an audiobook or document to import").setInputFiles(audioPath);
    await expect(page.getByRole("link", { name: "Phone Removal", exact: true })).toBeVisible();
    const grid = page.getByRole("button", { name: "Grid view", exact: true });
    const list = page.getByRole("button", { name: "List view", exact: true });
    await expect(list).toBeVisible();
    for (const control of [grid, list]) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    const search = (await page.getByRole("searchbox").boundingBox())!;
    const sort = page.getByRole("combobox", { name: "Sort books" });
    const sortBox = (await sort.boundingBox())!;
    expect(search.width).toBeGreaterThanOrEqual(60);
    expect(search.x + search.width).toBeLessThanOrEqual(sortBox.x);
    expect(sortBox.x + sortBox.width).toBeLessThanOrEqual((await grid.boundingBox())!.x);
    await sort.selectOption("title");
    await expect(sort).toHaveValue("title");
    await list.click();
    await expect(list).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Remove download of Phone Removal" }).click();
    await expect(page.locator(".book-offdevice")).toBeVisible();
    await expect(page.getByRole("button", { name: "Play Phone Removal", exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({ path: info.outputPath(`phone-${width}-controls.png`), fullPage: true });
  });
}
