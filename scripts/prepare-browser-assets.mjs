import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const assets = [
  {
    source: "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
    target: "public/pdf.worker.min.mjs",
    sha256: "51a2fd1ea47f1a9b0814e65e0c336c739c54957795ee774e8f93cb81e8028dd1",
  },
  {
    source: "node_modules/kissfft-wasm/lib/kissfft.wasm",
    target: "public/models/kestrel/kissfft.wasm",
    sha256: "c1a03390ade32bcfc4c4143796f7510c0fec06b59d42840591ad4721fe93caf4",
  },
];

for (const asset of assets) {
  const source = resolve(asset.source);
  const target = resolve(asset.target);
  const bytes = await readFile(source);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(`Refusing to copy unexpected browser asset: ${asset.source}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}
