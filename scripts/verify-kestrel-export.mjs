import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const projectRoot = resolve(".");
const manifest = JSON.parse(
  await readFile(resolve(projectRoot, "src/lib/kestrel/asset-manifest.json"), "utf8"),
);
const temporaryRoot = await mkdtemp(join(tmpdir(), "hark-kestrel-export-"));

try {
  await verifyFile(
    resolve(projectRoot, manifest.kestrelExporter.script),
    undefined,
    manifest.kestrelExporter.sha256,
  );
  const weightsDir = join(temporaryRoot, "weights");
  const outputDir = join(temporaryRoot, "output");
  await mkdir(weightsDir);
  for (const id of ["prosody", "decoder", "head"]) {
    const asset = manifest.assets.find((candidate) => candidate.id === id);
    if (!asset?.remotePath || !asset.externalPath) {
      throw new Error(`Kestrel's ${id} weight is missing from the asset manifest.`);
    }
    const target = join(weightsDir, asset.externalPath);
    const url = `https://huggingface.co/mchen04/kestrel-tts/resolve/${manifest.kestrelModelRevision}/${asset.remotePath}?download=true`;
    await download(url, target);
    await verifyFile(target, asset.byteSize, asset.sha256);
  }

  const { pythonVersion, dependencies } = manifest.kestrelExporter;
  await run("uv", [
    "run",
    "--python",
    pythonVersion,
    "--with",
    `onnx==${dependencies.onnx}`,
    "--with",
    `numpy==${dependencies.numpy}`,
    "python",
    resolve(projectRoot, manifest.kestrelExporter.script),
    "--weights-dir",
    weightsDir,
    "--output-dir",
    outputDir,
  ]);
  console.log("Kestrel's pinned model weights reproduced every committed ONNX graph.");
} finally {
  if (basename(temporaryRoot).startsWith("hark-kestrel-export-")) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function download(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download pinned Kestrel asset (${response.status}): ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { flags: "wx" }));
}

async function verifyFile(file, expectedSize, expectedDigest) {
  const bytes = await readFile(file);
  if (expectedSize !== undefined && (await stat(file)).size !== expectedSize) {
    throw new Error(`${file} does not have the pinned byte size.`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedDigest) throw new Error(`${file} does not have the pinned SHA-256.`);
}

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code ?? signal}.`));
    });
  });
}
