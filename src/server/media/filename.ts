const acceptedSources: Readonly<Record<string, ReadonlySet<string>>> = {
  mp3: new Set(["audio/mpeg", "audio/mp3"]),
  pdf: new Set(["application/pdf"]),
  epub: new Set(["application/epub+zip"]),
  docx: new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]),
  txt: new Set(["text/plain"]),
  md: new Set(["text/markdown", "text/plain"]),
  markdown: new Set(["text/markdown", "text/plain"]),
  html: new Set(["text/html"]),
  htm: new Set(["text/html"]),
};

export function validateUploadMetadata(filename: string, mimeType: string): string {
  const decoded = decodeFilename(filename);
  const extension = decoded.toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
  const acceptedMimeTypes = acceptedSources[extension];
  if (!acceptedMimeTypes) {
    throw new Error("Choose an MP3, PDF, EPUB, DOCX, TXT, Markdown, or HTML file.");
  }
  const normalizedMimeType = mimeType.toLowerCase();
  if (
    normalizedMimeType !== "application/octet-stream" &&
    !acceptedMimeTypes.has(normalizedMimeType)
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
