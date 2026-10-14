import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { analyzeFrames, attachSampler } from "../../scripts/bench/sampler.mjs";
import { recordScenarios } from "../../scripts/bench/scenarios.mjs";

test.use({ video: "on" });

test("the frame sampler detects all five flicker types", async ({ context, page }) => {
  const sampler = await attachSampler(context);
  await page.goto(
    `data:text/html,${encodeURIComponent('<header class="app-header" style="height:60px">Header</header><h1>Sampler control</h1><section data-launch-ready="books"><div class="book-grid"><article class="book-item">Book</article></div></section>')}`,
  );
  await page.waitForTimeout(150);
  await page.locator("h1").evaluate((element) => {
    element.style.visibility = "hidden";
  });
  await page.waitForTimeout(150);
  await page.locator("h1").evaluate((element) => {
    element.style.visibility = "visible";
  });
  await page.waitForTimeout(150);
  await page.locator("h1").evaluate((element) => {
    element.style.transform = "translateY(12px)";
  });
  await page.waitForTimeout(150);
  await page.locator("section").evaluate((element) => {
    element.remove();
  });
  await page.waitForTimeout(150);
  const saved = await page.locator("body").innerHTML();
  await page.locator("body").evaluate((element) => {
    element.innerHTML = "";
  });
  await page.waitForTimeout(150);
  await page.locator("body").evaluate((element, html) => {
    element.innerHTML = html;
  }, saved);
  await page.waitForTimeout(150);
  await page.locator("body").evaluate((element) => {
    element.insertAdjacentHTML(
      "beforeend",
      '<section data-launch-ready="empty">Bring your first audiobook.</section>',
    );
  });
  await page.waitForTimeout(150);
  await page.locator("section").evaluate((element) => {
    element.setAttribute("data-launch-ready", "books");
    element.innerHTML = '<div class="book-grid"><article class="book-item">Book</article></div>';
  });
  await page.waitForTimeout(150);
  const events = analyzeFrames(await sampler.read(context));
  expect(events.some((event) => event.kind === "blink" && event.landmark === "mainHeading")).toBe(
    true,
  );
  expect(
    events.some((event) => event.kind === "layout-jump" && event.landmark === "mainHeading"),
  ).toBe(true);
  expect(events.some((event) => event.kind === "state-regression")).toBe(true);
  expect(events.some((event) => event.kind === "blank-after-first-paint")).toBe(true);
  console.log(
    JSON.stringify({ controlEventKinds: [...new Set(events.map((event) => event.kind))] }),
  );
  const empty = events.find((event) => event.kind === "false-empty");
  expect(empty?.emptyFrames).toBeGreaterThan(0);
  expect(empty?.emptyDurationMs).toBeGreaterThan(0);
});

test("library and player retain their visible landmarks across launches and navigation", async ({
  baseURL,
  context,
}) => {
  test.setTimeout(175000);
  expect(baseURL).toBeTruthy();
  const output = mkdtempSync(path.join(tmpdir(), "hark-flicker-regression-"));
  const summary = await recordScenarios({
    context,
    origin: baseURL!,
    output,
  });
  console.log("Frame evidence:", output);
  expect(
    summary.scenarios.filter((scenario) => scenario.failure || scenario.errors.length),
    "All scenarios must complete without page errors",
  ).toEqual([]);
  expect(
    summary.events,
    "A visible landmark must not blink, move, or regress without navigation",
  ).toEqual([]);
});
