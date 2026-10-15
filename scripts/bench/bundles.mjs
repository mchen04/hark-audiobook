import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(path.join(directory, entry.name))
      : [path.join(directory, entry.name)],
  );
const bytes = (buffers) =>
  buffers.reduce(
    (total, buffer) => ({
      raw: total.raw + buffer.length,
      gzip: total.gzip + gzipSync(buffer, { level: 9 }).length,
      brotli:
        total.brotli +
        brotliCompressSync(buffer, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    }),
    { raw: 0, gzip: 0, brotli: 0 },
  );

export function bundleSizes(directory) {
  const next = path.join(directory, ".next");
  const html = readFileSync(path.join(next, "server/app/offline.html"), "utf8");
  const documentAssets = [...new Set(html.match(/\/_next\/static\/[^"'\s\\]+/g) || [])];
  const launchAssets = documentAssets.filter((url) => /\.(js|css)$/.test(url));
  if (!launchAssets.length) throw new Error("Launch document contains no JS/CSS references.");
  const playerManifest = walk(path.join(next, "server/app")).find(
    (file) => file.includes("/books/[") && file.endsWith("page_client-reference-manifest.js"),
  );
  if (!playerManifest) throw new Error("Player client-reference manifest missing.");
  const sandbox = {};
  runInNewContext(readFileSync(playerManifest, "utf8"), sandbox, { timeout: 1000 });
  const playerAssets = new Set();
  for (const tag of html.match(/<script\b[^>]*>/g) || []) {
    const url = tag.match(/src="([^"]+)"/)?.[1];
    if (
      url &&
      (tag.includes("noModule") || tag.includes("nomodule") || url.includes("/turbopack-"))
    )
      playerAssets.add(url);
  }
  const visit = (value) => {
    if (typeof value === "string" && /(?:^|\/)static\/.*\.(?:js|css)$/.test(value))
      playerAssets.add(value.startsWith("/_next/") ? value : `/_next/${value}`);
    else if (value && typeof value === "object")
      for (const item of Object.values(value)) visit(item);
  };
  visit(sandbox.__RSC_MANIFEST);
  if (!playerAssets.size) throw new Error("Player manifest contains no client assets.");
  const readAsset = (url) =>
    readFileSync(
      url.startsWith("/_next/")
        ? path.join(next, url.slice("/_next/".length))
        : path.join(directory, "public", url),
    );
  const closure = (urls) => ({ files: [...urls].sort(), ...bytes([...urls].map(readAsset)) });
  const runtime = JSON.parse(
    readFileSync(path.join(directory, "public/chapterline-runtime-assets.json"), "utf8"),
  );
  const worker = readFileSync(path.join(directory, "public/sw.js"), "utf8");
  const constantSource = worker.slice(0, worker.indexOf('self.addEventListener("install"'));
  const precache = runInNewContext(`${constantSource}\nPRECACHE`, {}, { timeout: 1000 });
  const installAssets = new Set([
    ...precache.filter((url) => url !== "/offline"),
    ...documentAssets,
    ...runtime.assets.filter((url) => !runtime.deferredUntilModel?.includes(url)),
  ]);
  const install = closure(installAssets);
  const offlineDocument = readFileSync(path.join(next, "server/app/offline.html"));
  const documentBytes = bytes([offlineDocument]);
  for (const key of ["raw", "gzip", "brotli"]) install[key] += documentBytes[key];
  install.files.unshift("/offline");
  const clientJs = walk(path.join(next, "static")).filter((file) => file.endsWith(".js"));
  return {
    launchClosure: closure(launchAssets),
    playerClosure: closure(playerAssets),
    totalClientJs: {
      raw: clientJs.reduce((sum, file) => sum + readFileSync(file).length, 0),
      files: clientJs.length,
    },
    swInstallClosure: install,
    compression: "sum of files compressed independently; gzip level 9, brotli quality 11",
    playerClosureSource: path.relative(directory, playerManifest),
  };
}
