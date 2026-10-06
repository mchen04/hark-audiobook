import { describe, expect, it } from "vitest";

import { liveBookDigest } from "@/lib/offline/live-book-digest";

import { liveBookIdsFor } from "./live-book-ids";

const ids = ["0b8d6b2e-0000-4000-8000-000000000001", "0b8d6b2e-0000-4000-8000-000000000002"];

describe("liveBookIdsFor", () => {
  it("omits the list when the device holds exactly these ids", async () => {
    expect(await liveBookIdsFor(ids, await liveBookDigest([...ids].reverse()))).toBeNull();
  });

  it("sends the list when the device holds a different set", async () => {
    expect(await liveBookIdsFor(ids, await liveBookDigest([ids[0]!]))).toEqual(ids);
    expect(await liveBookIdsFor(ids, await liveBookDigest([...ids, "extra"]))).toEqual(ids);
  });

  it("sends the list without a matching digest", async () => {
    expect(await liveBookIdsFor(ids, null)).toEqual(ids);
    expect(await liveBookIdsFor(ids, "malformed")).toEqual(ids);
  });
});
