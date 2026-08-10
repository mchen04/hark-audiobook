// @vitest-environment jsdom

import { File as NodeFile } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";

import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { createArchiveEntrySelector, runAbortableUnzip } from "./archive";
import { detectDocument, documentMimeType, extractDocument } from "./extract";

describe("document detection", () => {
  it.each([
    ["book.pdf", "application/pdf"],
    ["book.epub", "application/epub+zip"],
    ["book.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["book.txt", "text/plain"],
    ["book.md", "text/markdown"],
    ["book.html", "text/html"],
  ])("recognizes %s", (name, mimeType) => {
    const file = sourceFile(["text"], name);
    expect(detectDocument(file)).toBeDefined();
    expect(documentMimeType(file)).toBe(mimeType);
  });

  it("rejects empty, oversized, and unsupported sources before parsing", () => {
    expect(() => detectDocument(sourceFile([], "empty.txt"))).toThrow(/empty/i);
    expect(() => detectDocument({ name: "huge.txt", size: 8 * 1024 * 1024 + 1 })).toThrow(
      /too large/i,
    );
    expect(() => detectDocument(sourceFile(["text"], "book.rtf"))).toThrow(/Choose an MP3/i);
  });
});

describe("local document extraction", () => {
  it("rejects cumulative selected archive expansion before inflating it", () => {
    const selector = createArchiveEntrySelector(() => true);

    expect(selector.include({ name: "one.xhtml", originalSize: 20 * 1024 * 1024 })).toBe(true);
    expect(selector.include({ name: "two.xhtml", originalSize: 20 * 1024 * 1024 })).toBe(false);
    expect(selector.exceeded()).toBe(true);
  });

  it("honors a canceled extraction job", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      extractDocument(sourceFile(["Never read"], "canceled.txt"), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("terminates archive workers immediately when extraction is canceled", async () => {
    const controller = new AbortController();
    let terminated = false;
    const pending = runAbortableUnzip(
      new Uint8Array([1]),
      { filter: () => true },
      controller.signal,
      () => () => {
        terminated = true;
      },
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(terminated).toBe(true);
  });

  it("does not retain an abort listener after synchronous archive completion", async () => {
    const signal = new AbortController().signal;
    const observe = vi.spyOn(signal, "addEventListener");

    await expect(
      runAbortableUnzip(new Uint8Array([1]), {}, signal, (_data, _options, complete) => {
        complete(null, {});
        return () => undefined;
      }),
    ).resolves.toEqual({});

    expect(observe).not.toHaveBeenCalled();
  });

  it("preserves the chapter boundaries used by the browser import holdout", async () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../../tests/fixtures/documents/tiny-book.txt"),
    );

    const document = await extractDocument(sourceFile([source], "tiny-book.txt"));

    expect(document.chapters.map(({ title }) => title)).toEqual(["Chapter One", "Chapter Two"]);
  });

  it("turns Markdown headings into ordered chapters", async () => {
    const document = await extractDocument(
      sourceFile(["# Opening\n\nFirst paragraph.\n\n## Next\n\nSecond paragraph."], "notes.md"),
    );

    expect(document).toMatchObject({
      kind: "markdown",
      title: "notes",
      author: "Unknown author",
      chapters: [
        { title: "Opening", text: "First paragraph." },
        { title: "Next", text: "Second paragraph." },
      ],
    });
  });

  it("removes executable and navigation markup from HTML", async () => {
    const document = await extractDocument(
      sourceFile(
        [
          '<html><head><title>Safe title</title><meta name="author" content="A. Writer">',
          "<script>stolen()</script></head><body><nav>Menu</nav><h1>Start</h1>",
          "<p>Readable prose.</p><style>.secret{}</style></body></html>",
        ],
        "book.html",
      ),
    );

    expect(document.title).toBe("Safe title");
    expect(document.author).toBe("A. Writer");
    expect(document.chapters).toEqual([{ title: "Start", text: "Readable prose." }]);
  });

  it("keeps direct, nested, and table prose in mixed HTML", async () => {
    const document = await extractDocument(
      sourceFile(
        [
          "<html><body><h1>Start</h1>Direct body prose.",
          "<article><div>Nested article prose.</div><p>Paragraph prose.</p>",
          "<table><tr><td>Table prose.</td></tr></table></article></body></html>",
        ],
        "mixed.html",
      ),
    );

    expect(document.chapters).toEqual([
      {
        title: "Start",
        text: "Direct body prose.\n\nNested article prose.\n\nParagraph prose.\n\nTable prose.",
      },
    ]);
  });

  it.each([
    "Introduction to algorithms is a useful course.",
    "Book clubs are popular in this neighborhood.",
  ])("does not discard ordinary prose beginning with a structural word", async (prose) => {
    const document = await extractDocument(sourceFile([prose], "sentence.txt"));
    expect(document.chapters).toEqual([{ title: "Full document", text: prose }]);
  });

  it("reads EPUB spine order and package metadata", async () => {
    const epub = zipFile("novel.epub", {
      "META-INF/container.xml": `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf" /></rootfiles></container>`,
      "OPS/book.opf": `<?xml version="1.0"?><package xmlns:dc="urn:dc"><metadata><dc:title>Vault Story</dc:title><dc:creator>Local Author</dc:creator></metadata><manifest><item id="two" href="two.xhtml"/><item id="one" href="one.xhtml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`,
      "OPS/one.xhtml": "<html><body><h1>One</h1><p>First.</p></body></html>",
      "OPS/two.xhtml": "<html><body><h1>Two</h1><p>Second.</p></body></html>",
    });

    const document = await extractDocument(epub);

    expect(document).toMatchObject({
      kind: "epub",
      title: "Vault Story",
      author: "Local Author",
      chapters: [
        { title: "One", text: "One\n\nFirst." },
        { title: "Two", text: "Two\n\nSecond." },
      ],
    });
  });

  it("does not drop mixed EPUB content when one paragraph is present", async () => {
    const epub = zipFile("mixed.epub", {
      "META-INF/container.xml": `<container><rootfiles><rootfile full-path="book.opf" /></rootfiles></container>`,
      "book.opf": `<package><metadata><title>Mixed</title></metadata><manifest><item id="one" href="one.xhtml"/></manifest><spine><itemref idref="one"/></spine></package>`,
      "one.xhtml":
        "<html><body><p>Selected paragraph.</p><div>Sibling div prose.</div><table><tr><td>Cell prose.</td></tr></table></body></html>",
    });

    const document = await extractDocument(epub);

    expect(document.chapters[0]?.text).toBe(
      "Selected paragraph.\n\nSibling div prose.\n\nCell prose.",
    );
  });

  it("uses Word heading styles as chapter boundaries", async () => {
    const docx = zipFile("draft.docx", {
      "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter One</w:t></w:r></w:p><w:p><w:r><w:t>Hello world.</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Chapter Two</w:t></w:r></w:p><w:p><w:r><w:t>Goodbye.</w:t></w:r></w:p></w:body></w:document>`,
      "docProps/core.xml": `<?xml version="1.0"?><cp:coreProperties xmlns:cp="urn:cp" xmlns:dc="urn:dc"><dc:title>Draft</dc:title><dc:creator>Writer</dc:creator></cp:coreProperties>`,
    });

    const document = await extractDocument(docx);

    expect(document).toMatchObject({
      kind: "docx",
      title: "Draft",
      author: "Writer",
      chapters: [
        { title: "Chapter One", text: "Hello world." },
        { title: "Chapter Two", text: "Goodbye." },
      ],
    });
  });
});

function zipFile(name: string, entries: Record<string, string>): File {
  const bytes = zipSync(
    Object.fromEntries(Object.entries(entries).map(([path, source]) => [path, strToU8(source)])),
  );
  return sourceFile([bytes.slice()], name);
}

function sourceFile(parts: Array<string | Uint8Array>, name: string): File {
  return new NodeFile(parts, name) as unknown as File;
}
