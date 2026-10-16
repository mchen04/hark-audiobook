import { expect, test } from "@playwright/test";

import { startControllableNetwork } from "../parity/harness/network";
import { closeSql, waitForServiceWorker } from "../sync/harness/app";
import {
  captureMediaActions,
  mediaAction,
  prepareLocalPlayback,
  waitForLaunchShell,
} from "./playback-fixture";

test.afterAll(closeSql);

test("manifest and Apple metadata publish the standalone launch contract", async ({
  page,
  request,
}) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    display: "standalone",
    start_url: "/library?source=pwa",
    scope: "/",
    theme_color: "#18181b",
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ src: "/icons/icon-192.png", sizes: "192x192", purpose: "any" }),
      expect.objectContaining({
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        purpose: "maskable",
      }),
    ]),
  );
  for (const icon of manifest.icons) {
    const image = await request.get(icon.src);
    expect(image.ok()).toBe(true);
    expect((await image.body()).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  }
  await page.goto("/login");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/icons/icon-192.png",
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute(
    "content",
    "default",
  );
  await expect(
    page.locator('meta[name="theme-color"][media="(prefers-color-scheme: light)"]'),
  ).toHaveAttribute("content", "#fafafa");
  await expect(
    page.locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]'),
  ).toHaveAttribute("content", "#0e0e10");
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /viewport-fit=cover/,
  );
});

test("standalone-mode emulation launches from the manifest and resumes from the offline cached shell", async ({
  browser,
  context,
  page,
  baseURL,
}, info) => {
  test.setTimeout(180000);
  const network = await startControllableNetwork(baseURL!);
  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const result = matchMedia(query);
        if (query === "(display-mode: standalone)")
          Object.defineProperty(result, "matches", { value: true });
        return result;
      };
      Object.assign(window, { playbackAudioContexts: 0 });
      if (window.AudioContext)
        window.AudioContext = new Proxy(window.AudioContext, {
          construct(target, args) {
            const state = window as typeof window & { playbackAudioContexts: number };
            state.playbackAudioContexts++;
            return Reflect.construct(target, args);
          },
        });
    });
    await captureMediaActions(context);
    const { bookId } = await prepareLocalPlayback(
      browser,
      context,
      page,
      info,
      "Standalone Book",
      network.origin,
    );
    await page.getByRole("slider", { name: "Audiobook position" }).fill("42000");
    await page
      .locator("audio")
      .evaluate((audio) => Object.assign(window, { persistentPlaybackElement: audio }));
    await page.getByRole("button", { name: "Library", exact: true }).click();
    expect(
      await page
        .locator("audio")
        .evaluate(
          (audio) =>
            audio ===
            (window as typeof window & { persistentPlaybackElement: HTMLAudioElement })
              .persistentPlaybackElement,
        ),
    ).toBe(true);
    await waitForServiceWorker(page);
    const manifest = await (await page.request.get("/manifest.webmanifest")).json();
    await page.goto(`${network.origin}${manifest.start_url}`);
    await expect(page).toHaveURL(/\/library\?source=pwa$/);
    expect(
      await page.evaluate(() => ({
        standalone: (navigator as Navigator & { standalone?: boolean }).standalone,
        display: matchMedia("(display-mode: standalone)").matches,
      })),
    ).toEqual({ standalone: true, display: true });
    await page.getByRole("button", { name: "Resume Standalone Book", exact: true }).click();
    const mini = page.getByRole("complementary", { name: "Now playing" });
    await expect(mini.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect
      .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeGreaterThan(42);
    await mediaAction(page, "pause");
    const saved = await page
      .locator("audio")
      .evaluate((audio: HTMLAudioElement) => audio.currentTime);
    const handlers = await page.evaluate(() =>
      Object.keys(
        (window as typeof window & { testMediaHandlers: Record<string, unknown> })
          .testMediaHandlers,
      ).sort(),
    );
    expect(handlers).toEqual(["pause", "play", "seekbackward", "seekforward", "seekto", "stop"]);
    expect(
      await page.evaluate(
        () => (window as typeof window & { playbackAudioContexts: number }).playbackAudioContexts,
      ),
    ).toBe(0);
    for (const width of [320, 393]) {
      await page.setViewportSize({ width, height: 852 });
      const play = (await mini.getByRole("button", { name: "Play", exact: true }).boundingBox())!;
      const back = (await mini
        .getByRole("button", { name: "Back 15 seconds", exact: true })
        .boundingBox())!;
      const book = (await mini.locator(".mini-book").boundingBox())!;
      expect(book.x + book.width).toBeLessThanOrEqual(back.x);
      expect(back.x + back.width).toBeLessThanOrEqual(play.x);
      expect(play.x + play.width).toBeLessThanOrEqual(width);
      expect(play.y + play.height).toBeLessThanOrEqual(852);
      await page.screenshot({ path: info.outputPath(`standalone-${width}.png`), fullPage: true });
    }
    await waitForLaunchShell(page);
    const cachedShell = await page.evaluate(async () => {
      const response = (await caches.match("/library?source=pwa"))!;
      return {
        generation: response.headers.get("X-Chapterline-Shell-Generation"),
        html: await response.text(),
      };
    });
    network.cut();
    network.reset();
    expect(
      await page.evaluate(async () =>
        fetch("/api/auth/get-session", { cache: "no-store" }).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
    const reopened = page;
    const shellResponse = await reopened.reload({ waitUntil: "domcontentloaded" });
    expect(shellResponse).not.toBeNull();
    const responseGeneration = shellResponse!.headers()["x-chapterline-shell-generation"];
    console.log(
      JSON.stringify({
        evidence: "offline shell response",
        protocolFromServiceWorker: shellResponse!.fromServiceWorker(),
        responseGeneration,
        cachedGeneration: cachedShell.generation,
      }),
    );
    expect(responseGeneration).toBe(cachedShell.generation);
    expect(await shellResponse!.text()).toBe(cachedShell.html);
    expect(
      await reopened.evaluate(
        () =>
          (navigator as Navigator & { standalone?: boolean }).standalone &&
          matchMedia("(display-mode: standalone)").matches,
      ),
    ).toBe(true);
    await expect(reopened.locator('[data-launch-ready="books"]')).toBeVisible();
    await reopened.getByRole("button", { name: "Resume Standalone Book", exact: true }).click();
    await expect(
      reopened
        .getByRole("complementary", { name: "Now playing" })
        .getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
    const resumed = await reopened
      .locator("audio")
      .evaluate((audio: HTMLAudioElement) => audio.currentTime);
    expect(resumed).toBeGreaterThanOrEqual(saved - 0.02);
    expect(resumed).toBeLessThan(saved + 2);
    expect(await reopened.evaluate(() => navigator.mediaSession.metadata?.title)).toBe(
      "Standalone Book",
    );
    await mediaAction(reopened, "pause");
    console.log(
      JSON.stringify({
        evidence:
          "standalone-mode emulation; offline document reload in the same browser context; cut proxy; zero native safe-area insets",
        saved,
        resumed,
        bookId,
      }),
    );
    expect(network.hits()).toEqual([]);
    expect(network.blockedCount()).toBeGreaterThan(0);
  } finally {
    network.restore();
    await network.close();
  }
});
