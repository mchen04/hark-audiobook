import { describe, expect, it } from "vitest";

import { isRendererCommand } from "./render-process";

describe("isRendererCommand", () => {
  const macWebKit = "/Users/test/Library/Caches/ms-playwright/webkit-2311/pw_run.sh";
  const linuxWebKit = "/home/runner/.cache/ms-playwright/webkit-2311/pw_run.sh";
  const chromium = "/home/runner/.cache/ms-playwright/chromium-1234/chrome-linux/chrome";

  it.each([
    `${macWebKit.slice(0, -"pw_run.sh".length)}com.apple.WebKit.WebContent --type webcontent`,
    "/home/runner/.cache/ms-playwright/webkit-2311/minibrowser-gtk/bin/WebKitWebProcess 11 22",
    "/home/runner/.cache/ms-playwright/webkit-2311/minibrowser-wpe/bin/WPEWebProcess 11 22",
  ])("recognises WebKit content processes on every supported CI host", (command) => {
    const executable = command.startsWith("/Users/") ? macWebKit : linuxWebKit;
    expect(isRendererCommand(command, "webkit", executable)).toBe(true);
  });

  it("rejects helper processes and renderers from a different WebKit build", () => {
    expect(
      isRendererCommand(
        "/home/runner/.cache/ms-playwright/webkit-2311/minibrowser-gtk/bin/WebKitNetworkProcess",
        "webkit",
        linuxWebKit,
      ),
    ).toBe(false);
    expect(
      isRendererCommand(
        "/home/runner/.cache/ms-playwright/webkit-2300/minibrowser-gtk/bin/WebKitWebProcess",
        "webkit",
        linuxWebKit,
      ),
    ).toBe(false);
  });

  it("keeps Chromium scoped to its exact executable and renderer type", () => {
    expect(isRendererCommand(`${chromium} --type=renderer`, "chromium", chromium)).toBe(true);
    expect(isRendererCommand(`${chromium} --type=gpu-process`, "chromium", chromium)).toBe(false);
    expect(
      isRendererCommand(
        "/home/runner/.cache/ms-playwright/chromium-1200/chrome-linux/chrome --type=renderer",
        "chromium",
        chromium,
      ),
    ).toBe(false);
  });
});
