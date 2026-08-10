import { strFromU8, unzip } from "fflate";

export type DocumentKind = "pdf" | "epub" | "docx" | "text" | "markdown" | "html";

export type ExtractedDocumentChapter = {
  title: string;
  text: string;
};

export type ExtractedDocument = {
  kind: DocumentKind;
  title: string;
  author: string;
  chapters: ExtractedDocumentChapter[];
};

type SupportedDocument = {
  kind: DocumentKind;
  mimeType: string;
};

const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_UNZIPPED_TEXT_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 20_000_000;
const MAX_CHAPTERS = 10_000;

const SUPPORTED_BY_EXTENSION: Readonly<Record<string, SupportedDocument>> = {
  pdf: { kind: "pdf", mimeType: "application/pdf" },
  epub: { kind: "epub", mimeType: "application/epub+zip" },
  docx: {
    kind: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  txt: { kind: "text", mimeType: "text/plain" },
  md: { kind: "markdown", mimeType: "text/markdown" },
  markdown: { kind: "markdown", mimeType: "text/markdown" },
  html: { kind: "html", mimeType: "text/html" },
  htm: { kind: "html", mimeType: "text/html" },
};

export const DOCUMENT_FILE_ACCEPT = [
  ".pdf",
  ".epub",
  ".docx",
  ".txt",
  ".md",
  ".markdown",
  ".html",
  ".htm",
].join(",");

export const DOCUMENT_FORMAT_LABEL = "PDF, EPUB, DOCX, TXT, Markdown, or HTML";

export function detectDocument(file: Pick<File, "name" | "size">): SupportedDocument {
  if (file.size <= 0) throw new Error("The selected document is empty.");
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error("This document is too large to convert safely on this device.");
  }
  const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
  const supported = SUPPORTED_BY_EXTENSION[extension];
  if (!supported) throw new Error(`Choose an MP3 or a ${DOCUMENT_FORMAT_LABEL} document.`);
  return supported;
}

/** Extracts readable structure entirely inside the browser. */
export async function extractDocument(file: File): Promise<ExtractedDocument> {
  const supported = detectDocument(file);
  let extracted: ExtractedDocument;
  switch (supported.kind) {
    case "pdf":
      extracted = await extractPdf(file);
      break;
    case "epub":
      extracted = await extractEpub(file);
      break;
    case "docx":
      extracted = await extractDocx(file);
      break;
    case "html":
      extracted = extractHtml(await file.text(), fallbackTitle(file.name), "html");
      break;
    case "markdown":
      extracted = extractPlainText(await file.text(), fallbackTitle(file.name), "markdown");
      break;
    case "text":
      extracted = extractPlainText(await file.text(), fallbackTitle(file.name), "text");
      break;
  }
  return validateExtraction(extracted);
}

export function documentMimeType(file: Pick<File, "name" | "size">): string {
  return detectDocument(file).mimeType;
}

async function extractPdf(file: File): Promise<ExtractedDocument> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const loading = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  try {
    const pdf = await loading.promise;
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = (metadata?.info || {}) as Record<string, unknown>;
    const chapters: ExtractedDocumentChapter[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pieces: string[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str) continue;
        pieces.push(item.str, item.hasEOL ? "\n" : " ");
      }
      const text = cleanDocumentText(pieces.join(""));
      if (text) chapters.push({ title: `Page ${pageNumber}`, text });
      page.cleanup();
    }
    if (!chapters.length) {
      throw new Error("This PDF has no selectable text. Scanned PDFs need OCR before narration.");
    }
    return {
      kind: "pdf",
      title: cleanMetadata(info.Title, 300) || fallbackTitle(file.name),
      author: cleanMetadata(info.Author, 240) || "Unknown author",
      chapters,
    };
  } catch (error) {
    if (error instanceof Error && /selectable text|password/i.test(error.message)) throw error;
    throw new Error("Hark could not read this PDF. It may be damaged or password protected.", {
      cause: error,
    });
  } finally {
    await loading.destroy();
  }
}

async function extractEpub(file: File): Promise<ExtractedDocument> {
  const archive = await unzipSelected(file, (name) =>
    /(^|\/)(container\.xml|[^/]+\.(?:opf|ncx|xhtml|html|htm|xml))$/i.test(name),
  );
  const container = parseXml(readEntry(archive, "META-INF/container.xml"), "EPUB container");
  const packagePath = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!packagePath) throw new Error("This EPUB does not name a package document.");
  const packageDocument = parseXml(readEntry(archive, packagePath), "EPUB package");
  const packageDirectory = packagePath.includes("/")
    ? packagePath.slice(0, packagePath.lastIndexOf("/") + 1)
    : "";
  const manifest = new Map<string, string>();
  for (const item of packageDocument.querySelectorAll("manifest > item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest.set(id, resolveArchivePath(packageDirectory, href));
  }
  const orderedPaths = Array.from(packageDocument.querySelectorAll("spine > itemref"), (item) =>
    manifest.get(item.getAttribute("idref") || ""),
  ).filter((path): path is string => Boolean(path));
  const paths = orderedPaths.length
    ? orderedPaths
    : Object.keys(archive)
        .filter((path) => /\.(?:xhtml|html|htm)$/i.test(path))
        .sort();
  const chapters: ExtractedDocumentChapter[] = [];
  for (const path of paths) {
    const bytes = lookupEntry(archive, path);
    if (!bytes) continue;
    const document = parseMarkup(strFromU8(bytes));
    const text = extractBodyText(document);
    if (!text) continue;
    chapters.push({
      title:
        cleanDocumentText(document.querySelector("h1, h2, h3")?.textContent || "").slice(0, 500) ||
        `Chapter ${chapters.length + 1}`,
      text,
    });
  }
  return {
    kind: "epub",
    title: xmlMetadata(packageDocument, "title", 300) || fallbackTitle(file.name),
    author: xmlMetadata(packageDocument, "creator", 240) || "Unknown author",
    chapters,
  };
}

async function extractDocx(file: File): Promise<ExtractedDocument> {
  const archive = await unzipSelected(
    file,
    (name) => name === "word/document.xml" || name === "docProps/core.xml",
  );
  const document = parseXml(readEntry(archive, "word/document.xml"), "Word document");
  const core = lookupEntry(archive, "docProps/core.xml");
  const metadata = core ? parseXml(strFromU8(core), "Word metadata") : null;
  const chapters: ExtractedDocumentChapter[] = [];
  let title = "Full document";
  let paragraphs: string[] = [];
  const commit = () => {
    const text = cleanDocumentText(paragraphs.join("\n\n"));
    if (text) chapters.push({ title: cleanTitle(title, chapters.length), text });
    paragraphs = [];
  };

  for (const paragraph of Array.from(document.getElementsByTagName("w:p"))) {
    const text = Array.from(paragraph.getElementsByTagName("w:t"), (node) => node.textContent || "")
      .join("")
      .trim();
    if (!text) continue;
    const style = paragraph.getElementsByTagName("w:pStyle")[0];
    const styleName = style?.getAttribute("w:val") || style?.getAttribute("val") || "";
    if (/^(?:title|heading[1-3])$/i.test(styleName) || looksLikeChapterHeading(text)) {
      if (paragraphs.length) commit();
      title = text;
    } else {
      paragraphs.push(text);
    }
  }
  commit();
  return {
    kind: "docx",
    title: (metadata && xmlMetadata(metadata, "title", 300)) || fallbackTitle(file.name),
    author: (metadata && xmlMetadata(metadata, "creator", 240)) || "Unknown author",
    chapters,
  };
}

function extractHtml(source: string, title: string, kind: "html"): ExtractedDocument {
  const document = parseMarkup(source);
  const chapters: ExtractedDocumentChapter[] = [];
  let chapterTitle = "Full document";
  let paragraphs: string[] = [];
  const commit = () => {
    const text = cleanDocumentText(paragraphs.join("\n\n"));
    if (text) chapters.push({ title: cleanTitle(chapterTitle, chapters.length), text });
    paragraphs = [];
  };
  for (const element of document.body.querySelectorAll("h1, h2, h3, p, li, blockquote, pre")) {
    if (element.matches("p") && element.closest("li, blockquote") !== null) continue;
    const text = cleanDocumentText(element.textContent || "");
    if (!text) continue;
    if (element.matches("h1, h2, h3")) {
      if (paragraphs.length) commit();
      chapterTitle = text;
    } else {
      paragraphs.push(text);
    }
  }
  commit();
  return {
    kind,
    title: cleanMetadata(document.querySelector("title")?.textContent, 300) || title,
    author:
      cleanMetadata(
        document.querySelector('meta[name="author" i]')?.getAttribute("content"),
        240,
      ) || "Unknown author",
    chapters,
  };
}

function extractPlainText(
  source: string,
  title: string,
  kind: "text" | "markdown",
): ExtractedDocument {
  const chapters: ExtractedDocumentChapter[] = [];
  let chapterTitle = "Full document";
  let lines: string[] = [];
  const commit = () => {
    const text = cleanDocumentText(lines.join("\n"));
    if (text) chapters.push({ title: cleanTitle(chapterTitle, chapters.length), text });
    lines = [];
  };
  for (const rawLine of source.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.trim();
    const markdownHeading = line.match(/^#{1,3}\s+(.+)$/)?.[1];
    if (markdownHeading || looksLikeChapterHeading(line)) {
      if (lines.some(Boolean)) commit();
      chapterTitle = markdownHeading || line;
    } else {
      lines.push(rawLine);
    }
  }
  commit();
  return { kind, title, author: "Unknown author", chapters };
}

async function unzipSelected(
  file: File,
  include: (name: string) => boolean,
): Promise<Record<string, Uint8Array>> {
  const compressed = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(
      compressed,
      {
        filter: ({ name, originalSize }) =>
          include(name) && originalSize <= MAX_UNZIPPED_TEXT_BYTES,
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  }).catch((error) => {
    throw new Error("Hark could not open this document archive.", { cause: error });
  });
  const expandedBytes = Object.values(entries).reduce(
    (total, entry) => total + entry.byteLength,
    0,
  );
  if (expandedBytes > MAX_UNZIPPED_TEXT_BYTES) {
    throw new Error("This document expands beyond Hark's on-device safety limit.");
  }
  return entries;
}

function parseXml(source: string, label: string): XMLDocument {
  const document = new DOMParser().parseFromString(source, "application/xml");
  if (document.querySelector("parsererror")) throw new Error(`The ${label} is malformed.`);
  return document;
}

function parseMarkup(source: string): Document {
  const document = new DOMParser().parseFromString(source, "text/html");
  document
    .querySelectorAll("script, style, noscript, svg, nav")
    .forEach((element) => element.remove());
  return document;
}

function extractBodyText(document: Document): string {
  document
    .querySelectorAll("script, style, noscript, svg, nav")
    .forEach((element) => element.remove());
  const blocks = Array.from(document.body.querySelectorAll("h1, h2, h3, p, li, blockquote, pre"))
    .filter((element) => !(element.matches("p") && element.closest("li, blockquote")))
    .map((element) => element.textContent || "");
  return cleanDocumentText(
    (blocks.length ? blocks : [document.body.textContent || ""]).join("\n\n"),
  );
}

function readEntry(archive: Record<string, Uint8Array>, path: string): string {
  const entry = lookupEntry(archive, path);
  if (!entry) throw new Error(`This document is missing ${path}.`);
  return strFromU8(entry);
}

function lookupEntry(archive: Record<string, Uint8Array>, path: string): Uint8Array | undefined {
  const normalized = normalizeArchivePath(path);
  return archive[normalized] || archive[decodeURIComponentSafe(normalized)];
}

function resolveArchivePath(directory: string, href: string): string {
  const withoutFragment = href.split("#", 1)[0] || "";
  return normalizeArchivePath(`${directory}${decodeURIComponentSafe(withoutFragment)}`);
}

function normalizeArchivePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function xmlMetadata(document: XMLDocument, localName: string, maxLength: number): string {
  const node = document.getElementsByTagNameNS("*", localName)[0];
  return cleanMetadata(node?.textContent, maxLength);
}

function cleanMetadata(value: unknown, maxLength: number): string {
  return typeof value === "string" ? cleanDocumentText(value).slice(0, maxLength) : "";
}

function cleanDocumentText(value: string): string {
  return value
    .replace(/\u00ad/g, "")
    .replace(/([\p{L}])-[ \t]*\n[ \t]*([\p{Ll}])/gu, "$1$2")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function cleanTitle(value: string, index: number): string {
  return cleanDocumentText(value).slice(0, 500) || `Chapter ${index + 1}`;
}

function looksLikeChapterHeading(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 160 &&
    /^(?:(?:chapter|part|book|section)\b(?:\s+[\divxlcdm]+)?|prologue\b|epilogue\b|introduction\b)/i.test(
      value,
    )
  );
}

function fallbackTitle(filename: string): string {
  return cleanDocumentText(filename.replace(/\.[^.]+$/, "")) || "Untitled document";
}
