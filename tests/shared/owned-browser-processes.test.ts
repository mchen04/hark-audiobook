import { expect, it } from "vitest";
import {
  attributeBrowserProcesses,
  type BrowserProcess,
  type RenderEngine,
} from "../../scripts/lib/owned-browser-processes.mjs";

const webkit = "/b/webkit/pw_run.sh";
const chromium = "/b/chromium/chrome";
const row = (
  pid: number,
  parent: number,
  executable: string,
  responsible = pid,
): BrowserProcess => ({
  pid,
  parent,
  executable,
  responsible,
  rssKiB: 100,
});
const attribute = (
  platform: string,
  engine: RenderEngine,
  processes: BrowserProcess[],
  mainPid?: number,
) =>
  attributeBrowserProcesses({
    platform,
    engine,
    processes,
    mainPid,
    nodePid: 10,
    executable: engine === "webkit" ? webkit : chromium,
  });

it("takes Linux descendants of our browser, including nested launch wrappers", () => {
  const result = attribute("linux", "webkit", [
    row(11, 10, "/bin/sh /b/webkit/pw_run.sh"),
    row(12, 11, "/b/webkit/MiniBrowser"),
    row(13, 12, "/b/webkit/WebKitWebProcess"),
    row(20, 1, "/b/webkit/MiniBrowser"),
    row(21, 20, "/b/webkit/WebKitWebProcess"),
  ]);
  expect(result.status).toBe("owned");
  expect(result.processes.map((p) => p.pid)).toEqual([12, 13]);
  expect(result.renderers.map((p) => p.pid)).toEqual([13]);
});
it.each(["webkit", "chromium"] as const)(
  "takes owned Linux %s renderers whose command starts with a wrapper",
  (engine) => {
    const main = engine === "webkit" ? "/b/webkit/MiniBrowser" : chromium;
    const renderer =
      engine === "webkit" ? "/b/webkit/WebKitWebProcess" : chromium + " --type=renderer";
    const command = "/usr/bin/bwrap -- " + renderer;
    const result = attribute("linux", engine, [
      row(12, 10, main),
      row(13, 12, command),
      row(20, 1, main),
      row(21, 20, command),
    ]);
    expect(result.status).toBe("owned");
    expect(result.processes.map((p) => p.pid)).toEqual([12, 13]);
    expect(result.renderers.map((p) => p.pid)).toEqual([13]);
  },
);
it.each(["linux", "darwin"])("takes only our Chromium processes on %s", (platform) => {
  const result = attribute(platform, "chromium", [
    row(12, 10, chromium),
    row(13, 12, chromium + " --type=renderer", 12),
    row(14, 12, chromium + "_crashpad_handler --monitor-self", 12),
    row(20, 1, chromium),
    row(21, 20, chromium + " --type=renderer", 20),
  ]);
  expect(result.mains.map((p) => p.pid)).toEqual([12]);
  expect(result.processes.map((p) => p.pid)).toEqual([12, 13, 14]);
});
it("uses macOS responsibility for reparented XPCs and isolates browsers launched later", () => {
  const processes = [
    row(11, 10, "/bin/sh /b/webkit/pw_run.sh"),
    row(12, 11, "/b/webkit/Playwright.app/Contents/MacOS/Playwright"),
    row(13, 1, "/b/webkit/com.apple.WebKit.WebContent", 12),
    row(14, 1, "/b/webkit/com.apple.WebKit.Networking", 12),
    row(20, 1, "/b/webkit/Playwright.app/Contents/MacOS/Playwright"),
    row(21, 1, "/b/webkit/com.apple.WebKit.WebContent", 20),
  ];
  expect(attribute("darwin", "webkit", processes).processes.map((p) => p.pid)).toEqual([
    12, 13, 14,
  ]);
});
it("refuses shared responsible ancestors and never falls back to global renderers", () => {
  const result = attribute("darwin", "webkit", [
    row(12, 10, "/b/webkit/Playwright.app/Contents/MacOS/Playwright", 1),
    row(13, 1, "/b/webkit/com.apple.WebKit.WebContent", 1),
    row(20, 99, "/b/webkit/Playwright.app/Contents/MacOS/Playwright", 1),
  ]);
  expect(result.status).toBe("ambiguous");
  expect(result.processes).toEqual([]);
});
it("can select one of two owned browser instances", () => {
  const result = attribute(
    "darwin",
    "webkit",
    [
      row(12, 10, "/b/webkit/Playwright.app/Contents/MacOS/Playwright"),
      row(13, 1, "/b/webkit/com.apple.WebKit.WebContent", 12),
      row(20, 10, "/b/webkit/Playwright.app/Contents/MacOS/Playwright"),
      row(21, 1, "/b/webkit/com.apple.WebKit.WebContent", 20),
    ],
    12,
  );
  expect(result.processes.map((p) => p.pid)).toEqual([12, 13]);
});
it("reports missing ownership even if foreign renderers exist", () => {
  expect(
    attribute("linux", "webkit", [
      row(20, 1, "/b/webkit/MiniBrowser"),
      row(21, 20, "/b/webkit/WebKitWebProcess"),
    ]).status,
  ).toBe("missing");
});

it("refuses attribution when our main has no renderer but a foreign browser does", () => {
  const result = attribute("linux", "webkit", [
    row(12, 10, "/b/webkit/MiniBrowser"),
    row(20, 1, "/b/webkit/MiniBrowser"),
    row(21, 20, "/b/webkit/WebKitWebProcess"),
  ]);
  expect(result.status).toBe("missing");
  expect(result.processes).toEqual([]);
  expect(result.reason).toContain("No owned webkit renderer");
});
