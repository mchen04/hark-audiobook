import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("service-worker runtime bundle", () => {
  it("precaches every local content-addressed document/Kestrel asset", () => {
    const root = path.resolve(__dirname, "../..");
    const serviceWorker = readFileSync(path.join(root, "public/sw.js"), "utf8");
    const manifest = JSON.parse(
      readFileSync(path.join(root, "src/lib/kestrel/asset-manifest.json"), "utf8"),
    ) as {
      assets: Array<{ remotePath?: string; url: string }>;
      pdfWorker: { url: string };
    };
    const declaration = serviceWorker.match(/const RUNTIME_ASSETS = (\[[^;]+\]);/)?.[1];
    expect(declaration, "the runtime precache declaration is missing").toBeTruthy();
    if (!declaration) return;

    const cached = new Function(`return ${declaration};`)() as string[];
    const expected = [
      ...manifest.assets.filter((asset) => !asset.remotePath).map((asset) => asset.url),
      manifest.pdfWorker.url,
    ];
    expect(cached).toEqual(expected);
    expect(serviceWorker).toContain("RUNTIME_ASSETS.includes(url.pathname)");
  });
});
