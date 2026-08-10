import manifest from "./asset-manifest.json";

export const KESTREL_SOURCE_REVISION = manifest.kestrelSourceRevision;
export const KOKORO_SOURCE_REVISION = manifest.kokoroSourceRevision;
export const KESTREL_BUNDLE_REVISION = manifest.bundleRevision;

export type KestrelAssetId =
  | "prosody"
  | "decoder"
  | "head"
  | "voice"
  | "prosodyEncode"
  | "prosodyFrames"
  | "decoderHead"
  | "fft";

export type KestrelAsset = {
  id: KestrelAssetId;
  externalPath?: string;
  url: string;
  byteSize: number;
  sha256: string;
  remote: boolean;
};

const KESTREL_BASE = `https://huggingface.co/mchen04/kestrel-tts/resolve/${KESTREL_SOURCE_REVISION}`;
const KOKORO_BASE = `https://huggingface.co/prince-canuma/Kokoro-82M/resolve/${KOKORO_SOURCE_REVISION}`;

export const KESTREL_ASSET_MANIFEST: readonly KestrelAsset[] = manifest.assets.map((asset) => {
  const remote = "remotePath" in asset;
  const url = remote
    ? `${asset.id === "voice" ? KOKORO_BASE : KESTREL_BASE}/${asset.remotePath}?download=true`
    : asset.url;
  return {
    id: asset.id as KestrelAssetId,
    ...(asset.externalPath ? { externalPath: asset.externalPath } : {}),
    url,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
    remote,
  };
});

export const PDF_WORKER_ASSET = manifest.pdfWorker;
