import { describe, expect, it } from "vitest";

import { chunkNarrationText } from "./chunks";

describe("chunkNarrationText", () => {
  it("keeps sentences together while bounding every synthesis unit", () => {
    const sentence = "A compact sentence.";
    const chunks = chunkNarrationText(Array.from({ length: 40 }, () => sentence).join(" "));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 320)).toBe(true);
    expect(chunks.join(" ")).toBe(Array.from({ length: 40 }, () => sentence).join(" "));
  });

  it("splits a single oversized token without losing characters", () => {
    const token = "x".repeat(777);
    const chunks = chunkNarrationText(token);

    expect(chunks.map((chunk) => chunk.length)).toEqual([320, 320, 137]);
    expect(chunks.join("")).toBe(token);
  });

  it("does not change with browser Intl support or split initialisms", () => {
    const source = "The U.S.A. team arrived. Dr. Rivera welcomed them. Next came lunch.";
    const withIntl = chunkNarrationText(source);
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
    try {
      expect(chunkNarrationText(source)).toEqual(withIntl);
      expect(withIntl.join(" ")).toBe(source);
    } finally {
      if (descriptor) Object.defineProperty(Intl, "Segmenter", descriptor);
    }
  });
});
