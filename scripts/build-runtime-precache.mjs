import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const chunksDirectory = resolve(".next/static/chunks");
const output = resolve("public/chapterline-runtime-assets.json");
const filenames = (await readdir(chunksDirectory))
  .filter((filename) => /\.(?:js|css)$/.test(filename))
  .sort();
const available = new Set(filenames);
const sources = new Map();
for (const filename of filenames.filter((candidate) => candidate.endsWith(".js"))) {
  sources.set(filename, await readFile(join(chunksDirectory, filename), "utf8"));
}

const queue = filenames.filter((filename) => sources.get(filename)?.includes("hark-kestrel"));
if (queue.length === 0) throw new Error("The built Kestrel runtime entry could not be found.");
const selected = new Set(queue);
const dependencyPattern = /(?:\/?_next\/)?static\/chunks\/([A-Za-z0-9_.-]+\.(?:js|css))/g;
while (queue.length > 0) {
  const filename = queue.shift();
  const source = sources.get(filename);
  if (!source) continue;
  for (const match of source.matchAll(dependencyPattern)) {
    const dependency = match[1];
    if (!available.has(dependency)) {
      throw new Error(`The Kestrel runtime references a missing build chunk: ${dependency}`);
    }
    if (selected.has(dependency)) continue;
    selected.add(dependency);
    queue.push(dependency);
  }
}

if (![...selected].some((filename) => /^turbopack-worker-.+\.js$/.test(filename))) {
  throw new Error("The Kestrel module-worker bootstrap is absent from the runtime closure.");
}
const selectedSource = [...selected].map((filename) => sources.get(filename) || "").join("\n");
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

const records = [];
for (const filename of [...selected].sort()) {
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
};
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Prepared ${manifest.assets.length} document-runtime chunks (${Math.ceil(manifest.byteSize / 1024)} KiB).`,
);
