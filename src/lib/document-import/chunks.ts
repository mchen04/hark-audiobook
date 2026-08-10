import { NARRATION_CHUNK_CHARACTERS } from "./rendition";

const SENTENCE_ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc",
]);

/** Small sentence-aware units bound Kestrel's peak tensors and first-audio latency. */
export function chunkNarrationText(text: string): string[] {
  const sentences = segmentSentences(text);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences.flatMap(splitLongSentence)) {
    if (current && current.length + 1 + sentence.length > NARRATION_CHUNK_CHARACTERS) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function segmentSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    if (!".!?".includes(normalized[index]!)) continue;
    while (index + 1 < normalized.length && ".!?".includes(normalized[index + 1]!)) index += 1;
    let end = index + 1;
    while (end < normalized.length && /[\"'”’)]/.test(normalized[end]!)) end += 1;
    if (end < normalized.length && !/\s/.test(normalized[end]!)) continue;
    if (normalized[index] === "." && isAbbreviation(normalized.slice(start, index + 1))) continue;
    sentences.push(normalized.slice(start, end).trim());
    while (end < normalized.length && /\s/.test(normalized[end]!)) end += 1;
    start = end;
    index = end - 1;
  }
  if (start < normalized.length) sentences.push(normalized.slice(start).trim());
  return sentences;
}

function isAbbreviation(sentencePrefix: string): boolean {
  if (/(?:\b[A-Za-z]\.){2,}$/.test(sentencePrefix)) return true;
  const token = sentencePrefix.match(/([A-Za-z]+)\.$/)?.[1]?.toLowerCase();
  return !!token && SENTENCE_ABBREVIATIONS.has(token);
}

function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= NARRATION_CHUNK_CHARACTERS) return [sentence];
  const words = sentence.split(/\s+/);
  const parts: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > NARRATION_CHUNK_CHARACTERS) {
      if (current) parts.push(current);
      for (let offset = 0; offset < word.length; offset += NARRATION_CHUNK_CHARACTERS) {
        parts.push(word.slice(offset, offset + NARRATION_CHUNK_CHARACTERS));
      }
      current = "";
    } else if (current && current.length + 1 + word.length > NARRATION_CHUNK_CHARACTERS) {
      parts.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) parts.push(current);
  return parts;
}
