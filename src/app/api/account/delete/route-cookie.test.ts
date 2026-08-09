import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

it("delegates deletion-cookie expiry to Better Auth's configured cookie name", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

  expect(source).toContain("auth.api.signOut");
  expect(source).not.toContain('"Set-Cookie": "chapterline.session_token=');
});
