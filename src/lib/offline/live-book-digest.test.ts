import { describe, expect, it } from "vitest";

import { liveBookDigest } from "./live-book-digest";

describe("liveBookDigest", () => {
  it("depends on the set of ids, not their order", async () => {
    const ids = ["b-2", "a-1", "c-3"];
    expect(await liveBookDigest(ids)).toBe(await liveBookDigest([...ids].reverse()));
  });

  it("changes when one id is added, removed or replaced", async () => {
    const base = await liveBookDigest(["a-1", "b-2"]);
    expect(await liveBookDigest(["a-1", "b-2", "c-3"])).not.toBe(base);
    expect(await liveBookDigest(["a-1"])).not.toBe(base);
    expect(await liveBookDigest(["a-1", "b-3"])).not.toBe(base);
  });

  it("is 32 bytes of unpadded base64url, even for an empty library", async () => {
    expect(await liveBookDigest([])).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
