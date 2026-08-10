import { phonemize } from "phonemizer";

const MAX_PHONEMES = 240;

// Kokoro's published vocabulary. Kestrel was distilled against the same token
// ids; unsupported eSpeak symbols are deliberately dropped, as in Kestrel's
// Python implementation.
const VOCAB: Readonly<Record<string, number>> = {
  ";": 1,
  ":": 2,
  ",": 3,
  ".": 4,
  "!": 5,
  "?": 6,
  "—": 9,
  "…": 10,
  '"': 11,
  "(": 12,
  ")": 13,
  "“": 14,
  "”": 15,
  " ": 16,
  "̃": 17,
  ʣ: 18,
  ʥ: 19,
  ʦ: 20,
  ʨ: 21,
  ᵝ: 22,
  "ꭧ": 23,
  A: 24,
  I: 25,
  O: 31,
  Q: 33,
  S: 35,
  T: 36,
  W: 39,
  Y: 41,
  ᵊ: 42,
  a: 43,
  b: 44,
  c: 45,
  d: 46,
  e: 47,
  f: 48,
  h: 50,
  i: 51,
  j: 52,
  k: 53,
  l: 54,
  m: 55,
  n: 56,
  o: 57,
  p: 58,
  q: 59,
  r: 60,
  s: 61,
  t: 62,
  u: 63,
  v: 64,
  w: 65,
  x: 66,
  y: 67,
  z: 68,
  ɑ: 69,
  ɐ: 70,
  ɒ: 71,
  æ: 72,
  β: 75,
  ɔ: 76,
  ɕ: 77,
  ç: 78,
  ɖ: 80,
  ð: 81,
  ʤ: 82,
  ə: 83,
  ɚ: 85,
  ɛ: 86,
  ɜ: 87,
  ɟ: 90,
  ɡ: 92,
  ɥ: 99,
  ɨ: 101,
  ɪ: 102,
  ʝ: 103,
  ɯ: 110,
  ɰ: 111,
  ŋ: 112,
  ɳ: 113,
  ɲ: 114,
  ɴ: 115,
  ø: 116,
  ɸ: 118,
  θ: 119,
  œ: 120,
  ɹ: 123,
  ɾ: 125,
  ɻ: 126,
  ʁ: 128,
  ɽ: 129,
  ʂ: 130,
  ʃ: 131,
  ʈ: 132,
  ʧ: 133,
  ʊ: 135,
  ʋ: 136,
  ʌ: 138,
  ɣ: 139,
  ɤ: 140,
  χ: 142,
  ʎ: 143,
  ʒ: 147,
  ʔ: 148,
  ˈ: 156,
  ˌ: 157,
  ː: 158,
  ʰ: 162,
  ʲ: 164,
  "↓": 169,
  "→": 171,
  "↗": 172,
  "↘": 173,
  ᵻ: 177,
};

export type KestrelTextChunk = {
  phonemes: string;
  ids: BigInt64Array;
  phonemeCount: number;
};

export async function prepareKestrelText(text: string): Promise<KestrelTextChunk[]> {
  const normalized = normalizeForSpeech(text);
  if (!normalized) return [];
  const clauses = splitClauses(normalized);
  const phonemeParts: string[] = [];
  for (const { words, punctuation } of clauses) {
    const rendered = (await phonemize(words, "en-us")).join(" ");
    const cleaned = normalizePhonemes(rendered);
    if (cleaned) phonemeParts.push(`${cleaned}${punctuation}`.trim());
  }
  return packPhonemes(phonemeParts.join(" "));
}

export function normalizeForSpeech(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–]/g, "-")
    .replace(/\bDr\./gi, "Doctor")
    .replace(/\bMr\./gi, "Mister")
    .replace(/\bMrs\./gi, "Misses")
    .replace(/\bMs\./gi, "Miss")
    .replace(/\bSt\./gi, "Saint")
    .replace(/\s+/g, " ")
    .trim();
}

function splitClauses(text: string): Array<{ words: string; punctuation: string }> {
  const pieces = text.match(/[^.!?;:,—…]+(?:[.!?;:,—…]+|$)/gu) || [text];
  return pieces.flatMap((piece) => {
    const match = piece.trim().match(/^(.*?)([.!?;:,—…]+)?$/u);
    const words = match?.[1]?.trim();
    if (!words) return [];
    const punctuation = canonicalPunctuation(match?.[2] || "");
    return [{ words, punctuation }];
  });
}

function canonicalPunctuation(value: string): string {
  if (value.includes("?")) return "?";
  if (value.includes("!")) return "!";
  if (value.includes("…")) return "…";
  if (value.includes(".")) return ".";
  if (value.includes(";")) return ";";
  if (value.includes(":")) return ":";
  if (value.includes("—")) return "—";
  return value ? "," : "";
}

function normalizePhonemes(value: string): string {
  return value
    .replaceAll("ʲ", "j")
    .replaceAll("r", "ɹ")
    .replaceAll("x", "k")
    .replaceAll("ɬ", "l")
    .replace(/\s+/g, " ")
    .trim();
}

function packPhonemes(value: string): KestrelTextChunk[] {
  const symbols = Array.from(value);
  const chunks: string[] = [];
  let start = 0;
  while (start < symbols.length) {
    let end = Math.min(symbols.length, start + MAX_PHONEMES);
    if (end < symbols.length) {
      const space = symbols.lastIndexOf(" ", end);
      if (space > start + Math.floor(MAX_PHONEMES / 2)) end = space;
    }
    const chunk = symbols.slice(start, end).join("").trim();
    if (chunk) chunks.push(chunk);
    start = end;
    while (symbols[start] === " ") start += 1;
  }

  return chunks.map((phonemes) => {
    const tokenIds = Array.from(phonemes, (symbol) => VOCAB[symbol]).filter(
      (token): token is number => token !== undefined,
    );
    return {
      phonemes,
      phonemeCount: Array.from(phonemes).length,
      ids: BigInt64Array.from([0, ...tokenIds, 0], BigInt),
    };
  });
}
