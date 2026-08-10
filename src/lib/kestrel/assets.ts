import { KESTREL_ASSET_MANIFEST, KESTREL_BUNDLE_REVISION, type KestrelAsset } from "./manifest";

const MODEL_CACHE = `hark-kestrel-bundle-${KESTREL_BUNDLE_REVISION.slice(0, 16)}`;
const VERIFIED_MARKER = `/__hark/kestrel-bundle/${KESTREL_BUNDLE_REVISION}/verified`;

export const KESTREL_ASSETS = KESTREL_ASSET_MANIFEST;

export const KESTREL_DOWNLOAD_BYTES = KESTREL_ASSETS.filter((asset) => asset.remote).reduce(
  (total, asset) => total + asset.byteSize,
  0,
);
const KESTREL_BUNDLE_BYTES = KESTREL_ASSETS.reduce((total, asset) => total + asset.byteSize, 0);

export type KestrelAssetProgress = {
  loadedBytes: number;
  totalBytes: number;
};

export type KestrelAssetBundle = Record<(typeof KESTREL_ASSETS)[number]["id"], Uint8Array>;

/**
 * Fetches the immutable Kestrel weights once, verifies every byte, and keeps
 * them in Cache Storage. The source document and synthesized audio never use
 * this network path; only public model files do.
 */
export async function loadKestrelAssets(
  onProgress?: (progress: KestrelAssetProgress) => void,
): Promise<KestrelAssetBundle> {
  const cache = typeof caches === "undefined" ? null : await caches.open(MODEL_CACHE);
  const marker = cache ? await readVerifiedMarker(cache) : false;
  let completedBytes = 0;
  const entries: Array<[KestrelAsset["id"], Uint8Array]> = [];

  for (const asset of KESTREL_ASSETS) {
    let bytes: Uint8Array | null = null;
    const cached = cache ? await cache.match(asset.url) : undefined;
    if (cached) {
      const candidate = new Uint8Array(await cached.arrayBuffer());
      if (
        candidate.byteLength === asset.byteSize &&
        (marker || (await sha256(candidate)) === asset.sha256)
      ) {
        bytes = candidate;
      } else if (cache) {
        await cache.delete(asset.url);
      }
    }

    if (!bytes) {
      bytes = await download(asset, (loadedBytes) =>
        onProgress?.({
          loadedBytes: completedBytes + loadedBytes,
          totalBytes: KESTREL_BUNDLE_BYTES,
        }),
      );
      if (cache) {
        await cache.put(
          asset.url,
          new Response(bytes.slice(), {
            headers: {
              "Content-Length": String(asset.byteSize),
              "Content-Type": "application/octet-stream",
            },
          }),
        );
      }
    }

    completedBytes += asset.byteSize;
    onProgress?.({
      loadedBytes: completedBytes,
      totalBytes: KESTREL_BUNDLE_BYTES,
    });
    entries.push([asset.id, bytes]);
  }

  if (cache && !marker) {
    await cache.put(VERIFIED_MARKER, new Response(verificationSignature()));
  }
  return Object.fromEntries(entries) as KestrelAssetBundle;
}

async function download(asset: KestrelAsset, onProgress: (loadedBytes: number) => void) {
  const response = await fetch(
    asset.url,
    asset.remote
      ? { mode: "cors", credentials: "omit" }
      : { cache: "no-store", credentials: "same-origin" },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Kestrel could not download ${asset.id} (${response.status || "offline"}).`);
  }

  const bytes = new Uint8Array(asset.byteSize);
  const reader = response.body.getReader();
  let offset = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > bytes.byteLength) {
      await reader.cancel();
      throw new Error(`Kestrel's ${asset.id} file was larger than expected.`);
    }
    bytes.set(value, offset);
    offset += value.byteLength;
    onProgress(offset);
  }
  if (offset !== asset.byteSize || (await sha256(bytes)) !== asset.sha256) {
    throw new Error(`Kestrel's ${asset.id} file failed its integrity check.`);
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readVerifiedMarker(cache: Cache): Promise<boolean> {
  const response = await cache.match(VERIFIED_MARKER);
  return Boolean(response && (await response.text()) === verificationSignature());
}

function verificationSignature(): string {
  return KESTREL_ASSETS.map(({ id, sha256: digest }) => `${id}:${digest}`).join("\n");
}
