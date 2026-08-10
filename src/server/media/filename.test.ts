import { describe, expect, it } from "vitest";

import { validateUploadMetadata } from "./filename";

describe("validateUploadMetadata", () => {
  it.each([
    ["folder%2FMy%20Book.MP3", "audio/mpeg", "My Book.MP3"],
    ["book.pdf", "application/pdf", "book.pdf"],
    ["book.epub", "application/epub+zip", "book.epub"],
    [
      "book.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "book.docx",
    ],
    ["book.txt", "text/plain", "book.txt"],
    ["book.md", "text/plain", "book.md"],
    ["book.markdown", "text/markdown", "book.markdown"],
    ["book.html", "text/html", "book.html"],
    ["book.htm", "application/octet-stream", "book.htm"],
  ])("accepts supported source %s", (filename, mimeType, expected) => {
    expect(validateUploadMetadata(filename, mimeType)).toBe(expected);
  });

  it.each([
    ["book.m4b", "audio/mp4"],
    ["book.mp3", "text/plain"],
    ["book.pdf", "text/html"],
    ["book.html", "application/pdf"],
    ["book.pdf.exe", "application/pdf"],
    ["book", "application/octet-stream"],
    ["..", "audio/mpeg"],
  ])("rejects unsupported metadata for %s", (filename, mimeType) => {
    expect(() => validateUploadMetadata(filename, mimeType)).toThrow();
  });
});
