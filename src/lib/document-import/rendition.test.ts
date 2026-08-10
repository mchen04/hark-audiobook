import { describe, expect, it } from "vitest";

import { assertSameRenditionTimeline, KESTREL_RENDITION_KEY } from "./rendition";

const timeline = {
  durationMs: 2_000,
  chapters: [
    { id: "book:0", position: 0, title: "One", startMs: 0, endMs: 1_000 },
    { id: "book:1", position: 1, title: "Two", startMs: 1_000, endMs: 2_000 },
  ],
};

describe("document rendition timeline", () => {
  it("identifies the deterministic extractor and sentence splitter", () => {
    expect(KESTREL_RENDITION_KEY).toContain(":extract-v2:split-v1:");
  });
  it("accepts the exact saved seek map", () => {
    expect(() => assertSameRenditionTimeline(timeline, structuredClone(timeline))).not.toThrow();
  });

  it.each([
    ["duration", { ...timeline, durationMs: 2_001 }],
    [
      "chapter boundaries",
      {
        ...timeline,
        chapters: [timeline.chapters[0]!, { ...timeline.chapters[1]!, startMs: 999 }],
      },
    ],
    [
      "chapter titles",
      {
        ...timeline,
        chapters: [timeline.chapters[0]!, { ...timeline.chapters[1]!, title: "Changed" }],
      },
    ],
  ])("rejects a changed %s", (_name, canonical) => {
    expect(() => assertSameRenditionTimeline(timeline, canonical)).toThrow(
      /different chapter timing/i,
    );
  });
});
