import { parseBlob } from "music-metadata";
import { describe, expect, it } from "vitest";

import { mp3ParserWarmupFrame } from "./pwa-register";

describe("the MP3 parser warm-up", () => {
  it("parses as an MP3, which is what makes it resolve the parser", async () => {
    const parsed = await parseBlob(new Blob([mp3ParserWarmupFrame()], { type: "audio/mpeg" }), {
      duration: false,
    });

    expect(
      parsed.format.container,
      "the warm-up bytes are not recognised as MPEG audio, so `mpegParserLoader.load()` never " +
        "runs and the chunk the offline import needs stays on the network",
    ).toBe("MPEG");
    expect(parsed.format.codec).toBe("MPEG 1 Layer 3");
  });

  it("is one whole frame, so nothing is left waiting for more bytes", () => {
    expect(mp3ParserWarmupFrame()).toHaveLength(417);
  });
});
