import { readFileSync } from "node:fs";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { mediaAssets } from "@/server/db/schema";

const migration = readFileSync(
  new URL("../../../drizzle/0028_purple_pyro.sql", import.meta.url),
  "utf8",
);

describe("rendition-key schema expansion", () => {
  it("keeps the live server's fingerprint arbiter during the expand release", () => {
    expect(migration).not.toContain('DROP INDEX "media_assets_owner_sha256_unique"');
    expect(migration).toContain('CREATE UNIQUE INDEX "media_assets_owner_sha256_rendition_unique"');

    const indexNames = getTableConfig(mediaAssets).indexes.map((index) => index.config.name);
    expect(indexNames).toContain("media_assets_owner_sha256_unique");
    expect(indexNames).toContain("media_assets_owner_sha256_rendition_unique");
  });
});
