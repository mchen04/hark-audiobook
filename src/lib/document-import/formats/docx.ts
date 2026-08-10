import { strFromU8 } from "fflate";

import { throwIfAborted } from "@/lib/abort";

import { lookupEntry, readEntry, unzipSelected, xmlMetadata } from "../archive";
import { cleanDocumentText, cleanTitle, fallbackTitle, parseXml } from "../document-text";
import type { ExtractedDocument, ExtractedDocumentChapter } from "../types";

export async function extractDocx(file: File, signal?: AbortSignal): Promise<ExtractedDocument> {
  const archive = await unzipSelected(
    file,
    (name) => name === "word/document.xml" || name === "docProps/core.xml",
    signal,
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
    throwIfAborted(signal);
    const text = Array.from(paragraph.getElementsByTagName("w:t"), (node) => node.textContent || "")
      .join("")
      .trim();
    if (!text) continue;
    const style = paragraph.getElementsByTagName("w:pStyle")[0];
    const styleName = style?.getAttribute("w:val") || style?.getAttribute("val") || "";
    if (/^(?:title|heading[1-3])$/i.test(styleName)) {
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
