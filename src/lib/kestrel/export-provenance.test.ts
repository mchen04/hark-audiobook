import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Kestrel export provenance", () => {
  it("pins independent model and exporter revisions", () => {
    const root = path.resolve(__dirname, "../../..");
    const manifest = JSON.parse(
      readFileSync(path.join(root, "src/lib/kestrel/asset-manifest.json"), "utf8"),
    ) as {
      kestrelModelRevision?: string;
      kestrelSourceRevision?: string;
      kestrelExporter?: {
        script: string;
        sha256: string;
        pythonVersion: string;
        dependencies: Record<string, string>;
      };
    };

    expect(manifest.kestrelSourceRevision).toBeUndefined();
    expect(manifest.kestrelModelRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.kestrelExporter).toMatchObject({
      script: "scripts/export-kestrel-onnx.py",
      pythonVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      dependencies: {
        numpy: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        onnx: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      },
    });
    const exporter = manifest.kestrelExporter;
    expect(exporter).toBeDefined();
    if (!exporter) return;
    const digest = createHash("sha256")
      .update(readFileSync(path.join(root, exporter.script)))
      .digest("hex");
    expect(exporter.sha256).toBe(digest);
  });
});
