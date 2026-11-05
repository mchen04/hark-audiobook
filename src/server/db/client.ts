import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/server/env";

import * as schema from "./schema";

const globalDatabase = globalThis as unknown as {
  sqlClient?: ReturnType<typeof postgres>;
  harkQueryCount?: number;
};

export const queryCountingEnabled = process.env.HARK_REQUIRE_LOCAL_DB === "1";

export function readQueryCount(): number {
  return globalDatabase.harkQueryCount ?? 0;
}

export function resetQueryCount(): void {
  globalDatabase.harkQueryCount = 0;
}

const sqlClient =
  globalDatabase.sqlClient ??
  postgres(env.DATABASE_URL, {
    max: process.env.NODE_ENV === "production" ? 10 : 3,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    ...(queryCountingEnabled
      ? {
          debug: () => {
            globalDatabase.harkQueryCount = (globalDatabase.harkQueryCount ?? 0) + 1;
          },
        }
      : {}),
  });

if (process.env.NODE_ENV !== "production") globalDatabase.sqlClient = sqlClient;

export const db = drizzle(sqlClient, { schema });

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
