import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  collectModelOnlyChunkNames,
  collectRuntimeChunkNames,
} from "./build-runtime-precache-core.mjs";

const chunksDirectory = resolve(".next/static/chunks");
const output = resolve("public/chapterline-runtime-assets.json");
const offlineRouteManifestPaths = [
  resolve(".next/server/app/offline/page_client-reference-manifest.js"),
  resolve(".next/server/app/offline/page/react-loadable-manifest.json"),
];
const filenames = (await readdir(chunksDirectory))
  .filter((filename) => /\.(?:js|css)$/.test(filename))
  .sort();
const sources = new Map();
for (const filename of filenames) {
  sources.set(filename, await readFile(join(chunksDirectory, filename), "utf8"));
}
const selected = collectRuntimeChunkNames(
  sources,
  await Promise.all(offlineRouteManifestPaths.map((path) => readFile(path, "utf8"))),
);

if (!selected.some((filename) => /^turbopack-worker-.+\.js$/.test(filename))) {
  throw new Error("The Kestrel module-worker bootstrap is absent from the runtime closure.");
}
const selectedSource = selected.map((filename) => sources.get(filename) || "").join("\n");
for (const [feature, marker] of [
  ["document entry", "This document does not contain readable text."],
  ["EPUB adapter", "EPUB container"],
  ["DOCX adapter", "Word document"],
  ["HTML adapter", "extractNarrativeBlocks"],
  ["PDF adapter", "GlobalWorkerOptions"],
  ["MP3 encoder", "@mediabunny/mp3-encoder loaded"],
  ["ONNX runtime", "onnxruntime"],
]) {
  if (!selectedSource.includes(marker)) {
    throw new Error(`The ${feature} is absent from the document runtime closure.`);
  }
}

// Only the Kestrel worker loads this runtime, and it is useless until the model
// weights exist; the service worker caches these once the model bundle is verified.
const modelOnly = collectModelOnlyChunkNames(
  sources,
  selected,
  "Kestrel's voice tensor is invalid.",
);
if (!modelOnly.some((filename) => (sources.get(filename) || "").includes("onnxruntime"))) {
  throw new Error("The ONNX runtime is not among the model-only chunks.");
}

const records = [];
for (const filename of selected) {
  const path = join(chunksDirectory, filename);
  const bytes = await readFile(path);
  records.push({
    url: `/_next/static/chunks/${filename}`,
    byteSize: (await stat(path)).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const signature = records
  .map(({ url, byteSize, sha256 }) => `${url}:${byteSize}:${sha256}`)
  .join("\n");
const manifest = {
  version: 1,
  revision: createHash("sha256").update(signature).digest("hex"),
  byteSize: records.reduce((total, record) => total + record.byteSize, 0),
  assets: records.map(({ url }) => url),
  // A subset of `assets`. Service workers that know this field cache it only
  // once the verified Kestrel bundle exists; older ones cache all of `assets`.
  deferredUntilModel: modelOnly.map((filename) => `/_next/static/chunks/${filename}`),
};
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Prepared ${manifest.assets.length} document-runtime chunks (${Math.ceil(manifest.byteSize / 1024)} KiB), ` +
    `${manifest.deferredUntilModel.length} deferred until the model is present.`,
);
