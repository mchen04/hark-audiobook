import { throwIfAborted } from "@/lib/abort";
import { PDF_WORKER_ASSET } from "@/lib/kestrel/manifest";

import { cleanDocumentText, cleanMetadata, fallbackTitle } from "../document-text";
import type { ExtractedDocument, ExtractedDocumentChapter } from "../types";

export async function extractPdf(file: File, signal?: AbortSignal): Promise<ExtractedDocument> {
  const pdfjs = await import("pdfjs-dist");
  throwIfAborted(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_ASSET.url;
  const loading = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const cancelLoading = () => void loading.destroy().catch(() => undefined);
  signal?.addEventListener("abort", cancelLoading, { once: true });
  try {
    throwIfAborted(signal);
    const pdf = await loading.promise;
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = (metadata?.info || {}) as Record<string, unknown>;
    const chapters: ExtractedDocumentChapter[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      throwIfAborted(signal);
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
    throwIfAborted(signal);
    if (error instanceof Error && /selectable text|password/i.test(error.message)) throw error;
    throw new Error("Hark could not read this PDF. It may be damaged or password protected.", {
      cause: error,
    });
  } finally {
    signal?.removeEventListener("abort", cancelLoading);
    await loading.destroy().catch(() => undefined);
  }
}
