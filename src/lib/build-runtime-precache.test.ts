import { describe, expect, it } from "vitest";

import {
  collectModelOnlyChunkNames,
  collectRuntimeChunkNames,
} from "../../scripts/build-runtime-precache-core.mjs";

describe("document runtime precache graph", () => {
  it("includes offline-route lazy chunks and every literal worker dependency", () => {
    const sources = new Map([
      ["document-entry.js", '"hark-kestrel"; load("static/chunks/kestrel-worker.js")'],
      ["kestrel-worker.js", 'load("static/chunks/kestrel-runtime.js")'],
      ["kestrel-runtime.js", "Kestrel runtime"],
      [
        "offline-player.js",
        'load("static/chunks/document-import.js"); load("static/chunks/turbopack-offline.js")',
      ],
      ["document-import.js", "document importer"],
      ["book-details.js", "lazy player dialog"],
      ["turbopack-offline.js", "worker runtime"],
      ["unrelated.js", "settings only"],
    ]);
    const offlineRouteManifests = [
      '"/_next/static/chunks/offline-player.js"',
      '"static/chunks/book-details.js"',
    ];

    expect(collectRuntimeChunkNames(sources, offlineRouteManifests)).toEqual([
      "book-details.js",
      "document-entry.js",
      "document-import.js",
      "kestrel-runtime.js",
      "kestrel-worker.js",
      "offline-player.js",
      "turbopack-offline.js",
    ]);
  });

  it("rejects a dependency named by the selected runtime graph but absent from the build", () => {
    const sources = new Map([
      ["document-entry.js", '"hark-kestrel"; load("static/chunks/missing.js")'],
    ]);

    expect(() => collectRuntimeChunkNames(sources, [])).toThrow(
      "The document runtime references a missing build chunk: missing.js",
    );
  });

  it("defers only chunks the Kestrel worker alone reaches", () => {
    const worker = (entries: string[]) =>
      `e.b(t,"static/chunks/turbopack-worker-boot.js",[${entries.map((e) => `"static/chunks/${e}"`).join(",")}],a)`;
    const sources = new Map([
      [
        "import.js",
        `${worker(["kestrel-entry.js", "turbopack-k.js"])}; ${worker(["hash-entry.js"])}`,
      ],
      ["kestrel-entry.js", 'MARKER; load("static/chunks/ort.js"); load("static/chunks/shared.js")'],
      ["turbopack-k.js", "runtime"],
      ["ort.js", "onnxruntime"],
      ["shared.js", "shared helpers"],
      ["hash-entry.js", 'load("static/chunks/shared.js")'],
      ["turbopack-worker-boot.js", "bootstrap"],
    ]);
    const selected = [...sources.keys()];

    expect(collectModelOnlyChunkNames(sources, selected, "MARKER")).toEqual([
      "kestrel-entry.js",
      "ort.js",
      "turbopack-k.js",
    ]);
    expect(() => collectModelOnlyChunkNames(sources, selected, "ABSENT")).toThrow(
      "Kestrel worker entry",
    );
  });
});
