// API-only cost probe for the existing sync-verifier disposable fixture.
// Run the sync project once to establish its cached session. No signup, bucket
// reset or credential output; creates/deletes only its own newly named book.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { assertLocalDatabase } from "./lib/assert-local-database.mjs";
import { loadEnvFile, DEFAULT_TEST_ENV_FILE } from "./lib/env-file.mjs";

const [output] = process.argv.slice(2);
if (!output) throw new Error("Expected output JSON path");
loadEnvFile(process.env.HARK_ENV_FILE ?? DEFAULT_TEST_ENV_FILE);
assertLocalDatabase(process.env.DATABASE_URL, { context: "Sync receipt cost probe" });
const origin = "http://localhost:3000";
const state = JSON.parse(
  readFileSync(path.join(tmpdir(), "hark-sync-verifier-session.json"), "utf8"),
);
const cookie = state.cookies
  .filter((entry) => entry.domain === "localhost")
  .map((entry) => `${entry.name}=${entry.value}`)
  .join("; ");
const client = postgres(process.env.DATABASE_URL, { max: 1 });
const bookId = randomUUID();
const timings = [];
let created = false;
let stage = "session validation";
try {
  const call = async (method, target, data) => {
    const start = performance.now();
    const response = await fetch(origin + target, {
      method,
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = await response.json();
    return { status: response.status, body, elapsedMs: performance.now() - start };
  };
  const session = await call("GET", "/api/auth/get-session");
  if (session.status !== 200 || session.body?.user?.email !== "sync-verifier@hark.test") {
    throw new Error("fixture session missing; run the sync project first");
  }
  const userId = session.body.user.id;
  stage = "fixture registration";
  const result = await call("POST", "/api/books/local", {
    bookId,
    fileName: "receipt-cost.mp3",
    byteSize: 1000,
    durationMs: 600000,
    fingerprint: createHash("sha256").update(bookId).digest("hex"),
    fingerprintKind: "sha256-v1",
    title: "Disposable receipt cost probe",
    author: "Fixture",
    narrator: null,
    chapterDiagnostic: null,
    chapters: [{ position: 0, title: "Fixture", startMs: 0, endMs: 600000 }],
  });
  if (result.status !== 201) throw new Error("registration failed");
  created = true;
  stage = "progress samples";
  for (let index = 1; index <= 35; index++) {
    const sample = await call("PATCH", `/api/books/${bookId}/progress`, {
      deviceId: "receipt-cost-probe-0001",
      deviceSequence: index,
      positionMs: index * 1000,
      playbackRate: 1,
      completed: false,
      eventOccurredAt: new Date().toISOString(),
    });
    if (sample.status !== 200 || sample.body.kind !== "saved")
      throw new Error("progress not saved");
    timings.push(sample.elapsedMs);
  }
  stage = "read-only receipt query plan";
  const plan = await client`explain (analyze, buffers, format json)
    select greatest(clock_timestamp(),
      (select max(updated_at) from books where owner_id=${userId}) + interval '1 microsecond',
      (select max(updated_at) from playback_states where user_id=${userId}) + interval '1 microsecond',
      (select max(deleted_at) from book_tombstones where owner_id=${userId}) + interval '1 microsecond'
    )::text as value`;
  const sorted = timings.slice(5).sort((a, b) => a - b);
  writeFileSync(
    output,
    JSON.stringify(
      {
        origin,
        apiOnly: true,
        syntheticMetadataOnly: true,
        createdBookId: bookId,
        warmups: timings.slice(0, 5),
        measuredMs: timings.slice(5),
        samples: sorted.length,
        medianMs: (sorted[14] + sorted[15]) / 2,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        receiptSelectPlan: plan,
      },
      null,
      2,
    ) + "\n",
  );
} catch {
  // Do not serialize session cookies, database errors or their connection text.
  throw new Error(`Disposable sync cost probe failed at ${stage}.`);
} finally {
  let deletionStatus = 200;
  if (created) {
    const response = await fetch(`${origin}/api/books/${bookId}`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: origin },
    });
    deletionStatus = response.status;
  }
  await client.end();
  if (deletionStatus !== 200) throw new Error(`Fixture-only deletion returned ${deletionStatus}`);
}
