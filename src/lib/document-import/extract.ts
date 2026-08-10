import { throwIfAborted } from "@/lib/abort";
import {
  DOCUMENT_FILE_ACCEPT,
  DOCUMENT_FORMAT_LABEL,
  isDocumentFormat,
  sourceFormatForFilename,
} from "@/lib/source-formats";

import { cleanDocumentText, cleanMetadata, cleanTitle, fallbackTitle } from "./document-text";
import type { ExtractedDocument } from "./types";
import { readFileText } from "./file-read";

export type { DocumentKind } from "@/lib/source-formats";
export type { ExtractedDocument, ExtractedDocumentChapter } from "./types";

const MAX_SOURCE_BYTES = {
  pdf: 96 * 1024 * 1024,
  epub: 48 * 1024 * 1024,
  docx: 48 * 1024 * 1024,
  text: 8 * 1024 * 1024,
  markdown: 8 * 1024 * 1024,
  html: 2 * 1024 * 1024,
} as const;
const MAX_EXTRACTED_CHARACTERS = 2_000_000;
const MAX_DECODED_TEXT_CHARACTERS = MAX_EXTRACTED_CHARACTERS + 100_000;
const MAX_CHAPTERS = 10_000;

export { DOCUMENT_FILE_ACCEPT, DOCUMENT_FORMAT_LABEL };

export function detectDocument(file: Pick<File, "name" | "size">) {
  if (file.size <= 0) throw new Error("The selected document is empty.");
  const format = sourceFormatForFilename(file.name);
  if (!format || !isDocumentFormat(format)) {
    throw new Error(`Choose an MP3 or a ${DOCUMENT_FORMAT_LABEL} document.`);
  }
  if (file.size > MAX_SOURCE_BYTES[format.id]) {
    throw new Error("This document is too large to convert safely on this device.");
  }
  return format;
}

/** Routes each source to its lazy format adapter; source bytes never leave this device. */
export async function extractDocument(
  file: File,
  signal?: AbortSignal,
): Promise<ExtractedDocument> {
  throwIfAborted(signal);
  const format = detectDocument(file);
  let extracted: ExtractedDocument;
  switch (format.id) {
    case "pdf":
      extracted = await import("./formats/pdf").then(({ extractPdf }) => extractPdf(file, signal));
      break;
    case "epub":
      extracted = await import("./formats/epub").then(({ extractEpub }) =>
        extractEpub(file, signal),
      );
      break;
    case "docx":
      extracted = await import("./formats/docx").then(({ extractDocx }) =>
        extractDocx(file, signal),
      );
      break;
    case "html": {
      const [{ extractHtml }, source] = await Promise.all([
        import("./formats/text"),
        readFileText(file, MAX_DECODED_TEXT_CHARACTERS, signal),
      ]);
      extracted = extractHtml(source, fallbackTitle(file.name));
      break;
    }
    case "markdown":
    case "text": {
      const [{ extractPlainText }, source] = await Promise.all([
        import("./formats/text"),
        readFileText(file, MAX_DECODED_TEXT_CHARACTERS, signal),
      ]);
      extracted = extractPlainText(source, fallbackTitle(file.name), format.id);
      break;
    }
  }
  throwIfAborted(signal);
  return validateExtraction(extracted);
}

export function documentMimeType(file: Pick<File, "name" | "size">): string {
  return detectDocument(file).mimeType;
}

function validateExtraction(document: ExtractedDocument): ExtractedDocument {
  const chapters = document.chapters
    .map((chapter, index) => ({
      title: cleanTitle(chapter.title, index),
      text: cleanDocumentText(chapter.text),
    }))
    .filter((chapter) => chapter.text.length > 0);
  const characterCount = chapters.reduce((total, chapter) => total + chapter.text.length, 0);
  if (!characterCount) throw new Error("This document does not contain readable text.");
  if (chapters.length > MAX_CHAPTERS || characterCount > MAX_EXTRACTED_CHARACTERS) {
    throw new Error("This document is too long to convert safely on this device.");
  }
  return {
    ...document,
    title: cleanMetadata(document.title, 300) || "Untitled document",
    author: cleanMetadata(document.author, 240) || "Unknown author",
    chapters,
  };
}
