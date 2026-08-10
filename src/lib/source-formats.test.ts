import { describe, expect, it } from "vitest";

import { BOOK_FILE_ACCEPT, isDocumentSource, sourceFormatForFilename } from "./source-formats";

describe("source format registry", () => {
  it("owns extension detection and the upload accept list", () => {
    expect(sourceFormatForFilename("BOOK.MARKDOWN")?.id).toBe("markdown");
    expect(sourceFormatForFilename("book.mp3")?.id).toBe("mp3");
    expect(BOOK_FILE_ACCEPT).toContain(".pdf");
    expect(BOOK_FILE_ACCEPT).toContain("audio/mpeg");
  });

  it("does not infer that an unknown non-MP3 source is a document", () => {
    expect(isDocumentSource("book.bin", "application/octet-stream")).toBe(false);
    expect(isDocumentSource("book", "application/pdf")).toBe(true);
    expect(isDocumentSource("book.mp3", "application/pdf")).toBe(false);
  });
});
