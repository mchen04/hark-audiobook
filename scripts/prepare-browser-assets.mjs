import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const manifest = JSON.parse(await readFile(resolve("src/lib/kestrel/asset-manifest.json"), "utf8"));
const signature = `${manifest.assets.map(({ id, sha256 }) => `${id}:${sha256}`).join("\n")}\n`;
const revision = createHash("sha256").update(signature).digest("hex");
if (revision !== manifest.bundleRevision) {
  throw new Error("Kestrel's bundle revision does not match its asset manifest.");
}

const exporterBytes = await readFile(resolve(manifest.kestrelExporter.script));
const exporterDigest = createHash("sha256").update(exporterBytes).digest("hex");
if (exporterDigest !== manifest.kestrelExporter.sha256) {
  throw new Error("Kestrel's exporter does not match its pinned asset manifest.");
}

const assets = [...manifest.assets.filter((asset) => asset.source), manifest.pdfWorker];

for (const asset of assets) {
  const source = resolve(asset.source);
  const target = resolve(asset.target);
  const bytes = await readFile(source);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256 || bytes.byteLength !== asset.byteSize) {
    throw new Error(`Refusing to copy unexpected browser asset: ${asset.source}`);
  }
  if (source !== target) {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}
