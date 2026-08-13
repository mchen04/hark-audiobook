import { describe, expect, it } from "vitest";

import { KESTREL_SAMPLE_RATE } from "./dsp";
import { LemonadeClient, lemonadeIsAvailable } from "./lemonade";

/**
 * Runs against a real Lemonade server instead of a mocked fetch, because the
 * mocked suite can only prove Hark honors a contract it was told about. It is
 * opt-in (`HARK_LIVE_LEMONADE=1`) so CI, which has no Lemonade, stays honest
 * rather than silently skipping a gate it appears to run.
 */
const live = process.env.HARK_LIVE_LEMONADE === "1" ? describe : describe.skip;

live("Lemonade, against the running server", () => {
  it("is reachable with the Kokoro weights already downloaded", async () => {
    await expect(lemonadeIsAvailable()).resolves.toBe(true);
  });

  it("returns mono float audio at exactly the rate the encoder demands", async () => {
    const client = new LemonadeClient();
    expect(await client.initialize()).toBe("lemonade");

    const result = await client.synthesize(
      "Hark turns your documents into audiobooks without uploading them anywhere.",
    );

    expect(result.sampleRate).toBe(KESTREL_SAMPLE_RATE);
    const seconds = result.audio.length / result.sampleRate;
    expect(seconds).toBeGreaterThan(2);

    const peak = result.audio.reduce((loudest, sample) => Math.max(loudest, Math.abs(sample)), 0);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(1.001);
  }, 120_000);
});
