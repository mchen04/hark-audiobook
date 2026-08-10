import { DOCUMENT_FORMAT_LABEL, sourceFormatForFilename } from "@/lib/source-formats";

export function validateUploadMetadata(filename: string, mimeType: string): string {
  const decoded = decodeFilename(filename);
  const format = sourceFormatForFilename(decoded);
  if (!format) {
    throw new Error(`Choose an MP3 or a ${DOCUMENT_FORMAT_LABEL} file.`);
  }
  const normalizedMimeType = mimeType.toLowerCase();
  if (
    normalizedMimeType !== "application/octet-stream" &&
    !format.acceptedMimeTypes.has(normalizedMimeType)
  ) {
    throw new Error("The selected file's content type does not match its filename.");
  }
  if (decoded.length > 512) throw new Error("The source filename is too long.");
  return decoded;
}

function decodeFilename(value: string): string {
  try {
    const decoded = decodeURIComponent(value).replaceAll("\\", "/").split("/").at(-1)?.trim();
    if (!decoded || decoded === "." || decoded === "..") throw new Error();
    return decoded;
  } catch {
    throw new Error("The source filename is invalid.");
  }
}
