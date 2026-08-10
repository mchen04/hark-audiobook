import { describe, expect, it } from "vitest";

import { normalizeForSpeech, prepareKestrelText } from "./text";

describe("Kestrel text preparation", () => {
  it("normalizes typography and spoken abbreviations", () => {
    expect(normalizeForSpeech("  Dr. Chen\u0000 met Ms. Lee – twice.  ")).toBe(
      "Doctor Chen met Miss Lee - twice.",
    );
  });

  it("phonemizes English locally and preserves clause punctuation", async () => {
    const [chunk] = await prepareKestrelText("Hello world. Are you ready?");

    expect(chunk).toBeDefined();
    expect(chunk!.phonemes).toMatch(/\.[^?]*\?$/u);
    expect(chunk!.ids[0]).toBe(0n);
    expect(chunk!.ids.at(-1)).toBe(0n);
    expect(chunk!.phonemeCount).toBe(Array.from(chunk!.phonemes).length);
  });

  it("bounds phoneme chunks and retains model boundary tokens", async () => {
    const chunks = await prepareKestrelText("narration ".repeat(180));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.phonemeCount).toBeLessThanOrEqual(240);
      expect(chunk.ids.length).toBeLessThanOrEqual(242);
      expect(chunk.ids[0]).toBe(0n);
      expect(chunk.ids.at(-1)).toBe(0n);
    }
  });
});
