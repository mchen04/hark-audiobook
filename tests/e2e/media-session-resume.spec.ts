import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkPlayback } from "../update/playback.mjs";

test("Media Session uses preferences and exact progress survives offline reload and history", async ({
  context,
  baseURL,
}, info) => {
  test.setTimeout(180000);
  const folder = mkdtempSync(path.join(tmpdir(), "hark-media-session-"));
  const output = path.join(folder, "report.json");
  const report: Record<string, unknown> = { ok: false, failure: null };
  try {
    expect(baseURL).toBeTruthy();
    await checkPlayback(context, baseURL!, report);
    expect(report.metadata).toEqual({
      title: "Hark Benchmark Fixture",
      artist: "Synthetic Benchmark",
      playbackState: "paused",
    });
    report.ok = true;
  } catch (error) {
    report.failure = String(error);
    throw error;
  } finally {
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output, ok: report.ok, failure: report.failure }));
    await info.attach("media-session-resume", { path: output, contentType: "application/json" });
  }
});
