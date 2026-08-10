export type SourceFormatId = "mp3" | "pdf" | "epub" | "docx" | "text" | "markdown" | "html";

export type DocumentKind = Exclude<SourceFormatId, "mp3">;

export type SourceFormat = {
  id: SourceFormatId;
  extensions: readonly string[];
  mimeType: string;
  acceptedMimeTypes: ReadonlySet<string>;
};

export const SOURCE_FORMATS: readonly SourceFormat[] = [
  {
    id: "mp3",
    extensions: ["mp3"],
    mimeType: "audio/mpeg",
    acceptedMimeTypes: new Set(["audio/mpeg", "audio/mp3"]),
  },
  {
    id: "pdf",
    extensions: ["pdf"],
    mimeType: "application/pdf",
    acceptedMimeTypes: new Set(["application/pdf"]),
  },
  {
    id: "epub",
    extensions: ["epub"],
    mimeType: "application/epub+zip",
    acceptedMimeTypes: new Set(["application/epub+zip"]),
  },
  {
    id: "docx",
    extensions: ["docx"],
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    acceptedMimeTypes: new Set([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]),
  },
  {
    id: "text",
    extensions: ["txt"],
    mimeType: "text/plain",
    acceptedMimeTypes: new Set(["text/plain"]),
  },
  {
    id: "markdown",
    extensions: ["md", "markdown"],
    mimeType: "text/markdown",
    acceptedMimeTypes: new Set(["text/markdown", "text/plain"]),
  },
  {
    id: "html",
    extensions: ["html", "htm"],
    mimeType: "text/html",
    acceptedMimeTypes: new Set(["text/html"]),
  },
] as const;

const SOURCE_BY_EXTENSION = new Map(
  SOURCE_FORMATS.flatMap((format) => format.extensions.map((extension) => [extension, format])),
);

export const DOCUMENT_FORMAT_LABEL = "PDF, EPUB, DOCX, TXT, Markdown, or HTML";
export const DOCUMENT_FILE_ACCEPT = fileAccept(SOURCE_FORMATS.filter(isDocumentFormat));
export const MP3_FILE_ACCEPT = fileAccept(SOURCE_FORMATS.filter((format) => format.id === "mp3"));
export const BOOK_FILE_ACCEPT = fileAccept(SOURCE_FORMATS);

export function sourceFormatForFilename(filename: string): SourceFormat | null {
  const extension = filename.toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
  return SOURCE_BY_EXTENSION.get(extension) || null;
}

export function isDocumentFormat(format: SourceFormat): format is SourceFormat & {
  id: DocumentKind;
} {
  return format.id !== "mp3";
}

export function isDocumentSource(filename: string, mimeType?: string | null): boolean {
  const format = sourceFormatForFilename(filename);
  if (format) return isDocumentFormat(format);
  if (!mimeType) return false;
  const normalizedMimeType = mimeType.toLowerCase();
  return SOURCE_FORMATS.some(
    (candidate) =>
      isDocumentFormat(candidate) && candidate.acceptedMimeTypes.has(normalizedMimeType),
  );
}

function fileAccept(formats: readonly SourceFormat[]): string {
  return formats
    .flatMap((format) => [
      ...format.extensions.map((extension) => `.${extension}`),
      ...format.acceptedMimeTypes,
    ])
    .join(",");
}
