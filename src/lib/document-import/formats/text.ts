import {
  cleanDocumentText,
  cleanMetadata,
  cleanTitle,
  looksLikeChapterHeading,
  parseMarkup,
} from "../document-text";
import type { ExtractedDocument, ExtractedDocumentChapter } from "../types";

export function extractHtml(source: string, title: string): ExtractedDocument {
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
    kind: "html",
    title: cleanMetadata(document.querySelector("title")?.textContent, 300) || title,
    author:
      cleanMetadata(
        document.querySelector('meta[name="author" i]')?.getAttribute("content"),
        240,
      ) || "Unknown author",
    chapters,
  };
}

export function extractPlainText(
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
