import { strFromU8 } from "fflate";

import { throwIfAborted } from "@/lib/abort";

import { lookupEntry, readEntry, resolveArchivePath, unzipSelected, xmlMetadata } from "../archive";
import {
  cleanDocumentText,
  extractBodyText,
  fallbackTitle,
  parseMarkup,
  parseXml,
} from "../document-text";
import type { ExtractedDocument, ExtractedDocumentChapter } from "../types";

export async function extractEpub(file: File, signal?: AbortSignal): Promise<ExtractedDocument> {
  const archive = await unzipSelected(
    file,
    (name) => /(^|\/)(container\.xml|[^/]+\.(?:opf|ncx|xhtml|html|htm|xml))$/i.test(name),
    signal,
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
    throwIfAborted(signal);
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
