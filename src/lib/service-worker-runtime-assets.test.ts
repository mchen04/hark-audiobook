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
      bundleRevision: string;
      assets: Array<{ remotePath?: string; url: string }>;
      runtimeAssets?: Array<{ url: string }>;
      pdfWorker: { url: string };
    };
    const declaration = serviceWorker.match(/const RUNTIME_ASSETS = (\[[^;]+\]);/)?.[1];
    const modelDeclaration = serviceWorker.match(/const MODEL_RUNTIME_ASSETS = (\[[^;]+\]);/)?.[1];
    expect(declaration, "the runtime precache declaration is missing").toBeTruthy();
    expect(modelDeclaration, "the model-dependent runtime declaration is missing").toBeTruthy();
    if (!declaration || !modelDeclaration) return;

    const cached = new Function(`return ${declaration};`)() as string[];
    const modelCached = new Function(`return ${modelDeclaration};`)() as string[];
    const expected = [
      ...manifest.assets.filter((asset) => !asset.remotePath).map((asset) => asset.url),
      manifest.pdfWorker.url,
    ];
    expect(cached).toEqual(expected);
    expect(modelCached).toEqual(manifest.runtimeAssets?.map((asset) => asset.url));
    expect(serviceWorker).toContain("RUNTIME_ASSETS.includes(url.pathname)");
    expect(serviceWorker).toContain("MODEL_RUNTIME_ASSETS.includes(url.pathname)");
    expect(serviceWorker).toContain(
      `const KESTREL_BUNDLE_CACHE = "hark-kestrel-bundle-${manifest.bundleRevision.slice(0, 16)}"`,
    );
    expect(serviceWorker).toContain(`"/__hark/kestrel-bundle/${manifest.bundleRevision}/verified"`);
    expect(serviceWorker).toContain("loadBuildRuntimeAssets()");
    expect(serviceWorker).toContain("hasVerifiedKestrelBundle()");
  });

  it("pins ORT's loader and binary instead of relying on build-emitted media", () => {
    const root = path.resolve(__dirname, "../..");
    const worker = readFileSync(path.join(root, "src/lib/kestrel/runtime.worker.ts"), "utf8");
    const manifest = JSON.parse(
      readFileSync(path.join(root, "src/lib/kestrel/asset-manifest.json"), "utf8"),
    ) as { runtimeAssets?: Array<{ id: string; url: string }> };

    expect(manifest.runtimeAssets?.map(({ id }) => id)).toEqual(["ortModule", "ortWasm"]);
    expect(worker).toContain("ort.env.wasm.wasmPaths");
    for (const asset of manifest.runtimeAssets || []) expect(worker).toContain(asset.id);
  });
});
