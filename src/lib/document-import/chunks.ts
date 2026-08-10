const TARGET_CHARS = 320;

/** Small sentence-aware units bound Kestrel's peak tensors and first-audio latency. */
export function chunkNarrationText(text: string): string[] {
  const sentences = segmentSentences(text);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences.flatMap(splitLongSentence)) {
    if (current && current.length + 1 + sentence.length > TARGET_CHARS) {
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
  if (sentence.length <= TARGET_CHARS) return [sentence];
  const words = sentence.split(/\s+/);
  const parts: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > TARGET_CHARS) {
      if (current) parts.push(current);
      for (let offset = 0; offset < word.length; offset += TARGET_CHARS) {
        parts.push(word.slice(offset, offset + TARGET_CHARS));
      }
      current = "";
    } else if (current && current.length + 1 + word.length > TARGET_CHARS) {
      parts.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) parts.push(current);
  return parts;
}
