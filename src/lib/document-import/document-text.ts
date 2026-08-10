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
  stripNonNarrativeMarkup(document);
  const blocks = Array.from(document.body.querySelectorAll("h1, h2, h3, p, li, blockquote, pre"))
    .filter((element) => !(element.matches("p") && element.closest("li, blockquote")))
    .map((element) => element.textContent || "");
  return cleanDocumentText(
    (blocks.length ? blocks : [document.body.textContent || ""]).join("\n\n"),
  );
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
  return (
    value.length > 0 &&
    value.length <= 160 &&
    /^(?:(?:chapter|part|book|section)\b(?:\s+[\divxlcdm]+)?|prologue\b|epilogue\b|introduction\b)/i.test(
      value,
    )
  );
}

export function fallbackTitle(filename: string): string {
  return cleanDocumentText(filename.replace(/\.[^.]+$/, "")) || "Untitled document";
}

function stripNonNarrativeMarkup(document: Document): void {
  document
    .querySelectorAll("script, style, noscript, svg, nav")
    .forEach((element) => element.remove());
}
