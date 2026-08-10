const KESTREL_REVISION = "cac6cb6387d00fa626f41300b4c0739c624bba91";
const KOKORO_REVISION = "e02c9eada7ce7416798af36b190a8a2dd2ecd566";

const MODEL_CACHE = "hark-kestrel-model-v1";
const VERIFIED_MARKER = "/__hark/kestrel-model-v1/verified";

type Asset = {
  id: "prosody" | "decoder" | "head" | "voice";
  externalPath: string;
  url: string;
  byteSize: number;
  sha256: string;
};

const KESTREL_BASE = `https://huggingface.co/mchen04/kestrel-tts/resolve/${KESTREL_REVISION}`;
const KOKORO_BASE = `https://huggingface.co/prince-canuma/Kokoro-82M/resolve/${KOKORO_REVISION}`;

export const KESTREL_ASSETS: readonly Asset[] = [
  {
    id: "prosody",
    externalPath: "prosody.safetensors",
    url: `${KESTREL_BASE}/kestrel_prosody.safetensors?download=true`,
    byteSize: 18_764_172,
    sha256: "19ccef888d583ae49ff3029ceff2327e513656b4903afebfd52b0fd99a68dff5",
  },
  {
    id: "decoder",
    externalPath: "decoder.safetensors",
    url: `${KESTREL_BASE}/kestrel_decode.safetensors?download=true`,
    byteSize: 12_419_656,
    sha256: "67e1efb4f7e14d91a193f38d3e2b3045fcb0c538002414b9592798154bf1d5cb",
  },
  {
    id: "head",
    externalPath: "head.safetensors",
    url: `${KESTREL_BASE}/kestrel_sf_lw58k.safetensors?download=true`,
    byteSize: 9_472_941,
    sha256: "0866c5a65e228026acba2cce37332c35460fcc00b2ab4448d048cc00e702d9d6",
  },
  {
    id: "voice",
    externalPath: "af_heart.safetensors",
    url: `${KOKORO_BASE}/voices/af_heart.safetensors?download=true`,
    byteSize: 522_339,
    sha256: "4e40b08984cd84a86b4d07960939bd85bb6b3747dd747b7de48dca3aaeab37ca",
  },
] as const;

export const KESTREL_DOWNLOAD_BYTES = KESTREL_ASSETS.reduce(
  (total, asset) => total + asset.byteSize,
  0,
);

export type KestrelAssetProgress = {
  loadedBytes: number;
  totalBytes: number;
  fromCache: boolean;
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
  const entries: Array<[Asset["id"], Uint8Array]> = [];

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
          totalBytes: KESTREL_DOWNLOAD_BYTES,
          fromCache: false,
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
      totalBytes: KESTREL_DOWNLOAD_BYTES,
      fromCache: Boolean(cached && bytes),
    });
    entries.push([asset.id, bytes]);
  }

  if (cache && !marker) {
    await cache.put(VERIFIED_MARKER, new Response(verificationSignature()));
  }
  return Object.fromEntries(entries) as KestrelAssetBundle;
}

async function download(asset: Asset, onProgress: (loadedBytes: number) => void) {
  const response = await fetch(asset.url, { mode: "cors", credentials: "omit" });
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
