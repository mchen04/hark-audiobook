import { describe, expect, it } from "vitest";

import { isSameLocalRegistration } from "./local-registration-identity";

const registration = {
  fingerprint: "f".repeat(64),
  fingerprintKind: "sha256-v1",
  renditionKey: "kestrel-fast-v1:bundle:extract-v1",
  durationMs: 2_000,
  chapters: [
    { position: 0, title: "One", startMs: 0, endMs: 1_000 },
    { position: 1, title: "Two", startMs: 1_000, endMs: 2_000 },
  ],
};

describe("local registration replay identity", () => {
  it("accepts an exact replay", () => {
    expect(isSameLocalRegistration(registration, structuredClone(registration))).toBe(true);
  });

  it.each([
    ["missing media", null],
    ["source bytes", { ...registration, fingerprint: "a".repeat(64) }],
    ["rendition recipe", { ...registration, renditionKey: "kestrel-fast-v2" }],
    ["duration", { ...registration, durationMs: 2_001 }],
    [
      "chapter map",
      {
        ...registration,
        chapters: [registration.chapters[0]!, { ...registration.chapters[1]!, startMs: 999 }],
      },
    ],
  ])("rejects changed %s", (_name, stored) => {
    expect(isSameLocalRegistration(registration, stored)).toBe(false);
  });
});
