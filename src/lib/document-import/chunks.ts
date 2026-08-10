import { NARRATION_CHUNK_CHARACTERS } from "./rendition";

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
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    return Array.from(segmenter.segment(text), ({ segment }) => segment.trim()).filter(Boolean);
  }
  return (text.match(/[^.!?]+(?:[.!?]+|$)/g) || [text]).map((part) => part.trim()).filter(Boolean);
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
