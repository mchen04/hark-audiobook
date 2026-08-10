export function parseXml(source: string, label: string): XMLDocument {
  const document = new DOMParser().parseFromString(source, "application/xml");
  if (document.querySelector("parsererror")) throw new Error(`The ${label} is malformed.`);
  return document;
}

export function parseMarkup(source: string): Document {
  const document = new DOMParser().parseFromString(source, "text/html");
  stripNonNarrativeMarkup(document);
  return document;
}

export function extractBodyText(document: Document): string {
  return cleanDocumentText(
    extractNarrativeBlocks(document)
      .map(({ text }) => text)
      .join("\n\n"),
  );
}

export type NarrativeBlock = { kind: "heading" | "text"; text: string };

const BLOCK_ELEMENTS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

/** A single DOM walk captures mixed container/text markup without duplicates. */
export function extractNarrativeBlocks(document: Document): NarrativeBlock[] {
  stripNonNarrativeMarkup(document);
  const blocks: NarrativeBlock[] = [];
  let inline: string[] = [];
  const flush = () => {
    const text = cleanDocumentText(inline.join(""));
    if (text) blocks.push({ kind: "text", text });
    inline = [];
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      inline.push(node.textContent || "");
      return;
    }
    if (!(node instanceof Element)) return;
    if (/^H[1-3]$/.test(node.tagName)) {
      flush();
      const text = cleanDocumentText(node.textContent || "");
      if (text) blocks.push({ kind: "heading", text });
      return;
    }
    if (node.tagName === "BR") {
      flush();
      return;
    }
    const block = BLOCK_ELEMENTS.has(node.tagName);
    if (block) flush();
    for (const child of node.childNodes) visit(child);
    if (block) flush();
  };
  for (const child of document.body.childNodes) visit(child);
  flush();
  return blocks;
}

export function cleanMetadata(value: unknown, maxLength: number): string {
  return typeof value === "string" ? cleanDocumentText(value).slice(0, maxLength) : "";
}

export function cleanDocumentText(value: string): string {
  return value
    .replace(/\u00ad/g, "")
    .replace(/([\p{L}])-[ \t]*\n[ \t]*([\p{Ll}])/gu, "$1$2")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanTitle(value: string, index: number): string {
  return cleanDocumentText(value).slice(0, 500) || `Chapter ${index + 1}`;
}

export function looksLikeChapterHeading(value: string): boolean {
  if (!value || value.length > 160) return false;
  const ordinal =
    "(?:\\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)";
  return new RegExp(
    `^(?:(?:chapter|part|book|section)(?:\\s+${ordinal})?(?:\\s*[:—–-]\\s*.+)?|(?:prologue|epilogue|introduction)(?:\\s*[:—–-]\\s*.+)?)$`,
    "i",
  ).test(value);
}

export function fallbackTitle(filename: string): string {
  return cleanDocumentText(filename.replace(/\.[^.]+$/, "")) || "Untitled document";
}

function stripNonNarrativeMarkup(document: Document): void {
  document
    .querySelectorAll(
      'script, style, noscript, svg, nav, template, iframe, object, canvas, audio, video, form, [hidden], [aria-hidden="true" i]',
    )
    .forEach((element) => element.remove());
}
