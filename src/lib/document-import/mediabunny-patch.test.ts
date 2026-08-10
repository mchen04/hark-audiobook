import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

it("keeps append-only MP3 finalization keyed to the packet count", () => {
  const entry = fileURLToPath(import.meta.resolve("mediabunny"));
  const muxer = readFileSync(resolve(dirname(entry), "mp3/mp3-muxer.js"), "utf8");

  expect(muxer).toMatch(
    /this\.format\._options\.xingHeader === false[\s\S]+this\.frameCount === 0[\s\S]+release\(\);\s+return;/,
  );
});
