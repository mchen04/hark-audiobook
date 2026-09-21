// Derive the tracked summary from raw objective evidence, never hand-entered passes.
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = ".data/objective";
const json = (file) => JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function launch(file) {
  const log = readFileSync(`${root}/${file}`, "utf8");
  const rows = [
    ...log.matchAll(
      /^([ABCD]) (.+?)\s+(\d+)ms\s+(\d+)ms\s+(\d+)ms\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w+)\s+(\d+)$/gm,
    ),
  ].map((m) => ({
    profile: m[1],
    description: m[2],
    p50Ms: Number(m[3]),
    p95Ms: Number(m[4]),
    maxMs: Number(m[5]),
    timeouts: Number(m[6]),
    documentHits: Number(m[7]),
    apiHits: Number(m[8]),
    assetHits: Number(m[9]),
    postgresQueries: Number(m[10]),
    marker: m[11],
    cards: Number(m[12]),
  }));
  if (rows.length !== 4) throw new Error(`Missing launch profiles in ${file}`);
  return { raw: `${root}/${file}`, profiles: rows };
}

function phase(name, launchLog) {
  const source = json(`${name}/source-metrics.json`);
  const library = json(`${name}/library/measurements.json`);
  const core = json(`${name}/core/measurements.json`);
  if ([...library.steps, ...core.steps].some((step) => step.outcome !== "pass"))
    throw new Error(`Incomplete ${name} browser measurements`);
  const resources = library.startup.resources;
  const sumBodies = (items) => items.reduce((n, r) => n + r.decodedBodySize, 0);
  const retainedFiles = [
    "src/components/library/use-library-books.ts",
    "src/lib/offline/mirror.ts",
    "src/domain/library.ts",
    "src/lib/offline/library-revision.ts",
  ];
  return {
    commit: source.commit,
    source: {
      method: source.method,
      app: source.app,
      testsAndHarness: source.tests,
      css: source.css,
      generatedDrizzleJson: source.generated,
      complexity: source.complexity,
      retainedLibraryComplexity: source.functions
        .filter((f) => retainedFiles.includes(f.file))
        .reduce((n, f) => n + f.complexity, 0),
      retainedLibraryComplexityFiles: retainedFiles,
      bundle: source.bundle,
    },
    launch: launch(`${name}/${launchLog}`),
    library: {
      searchMedianMs: median(library.search.map((s) => s.searchMs)),
      searchClearMedianMs: median(library.search.map((s) => s.roundtripMs)),
      idbTransactionsPerSearchClear: library.search.map((s) => s.transactions),
      initialScriptInitiatorDecodedBytes: sumBodies(
        resources.filter((r) => r.initiatorType === "script"),
      ),
      initialAllJsDecodedBytes: sumBodies(resources.filter((r) => /\.js(?:\?|$)/.test(r.name))),
      mainPageHeapAtStartup: library.startup.performance.JSHeapUsedSize,
      mainPageHeapAfterSearch: library.performance.JSHeapUsedSize,
      errors: library.errors,
    },
    core: {
      steps: core.steps.map(({ name, outcome, elapsedMs }) => ({ name, outcome, elapsedMs })),
      warmReloadsMs: core.warmLaunches,
      errors: core.errors,
    },
  };
}

const checks = [
  "baseline/build",
  "baseline/unit",
  "baseline/unit-node26-compatible",
  "baseline/launch-pinned",
  "baseline/browser-library",
  "baseline/browser-core-v4",
  "final/verify-quick-final",
  "final/integrity-complete",
  "final/cache-invalidation-settled-red",
  "final/integrity-final",
  "final/iphone-final",
  "final/iphone-autoplay-corrected",
  "final/resume-composed-repeat",
  "final/launch-final",
  "final/browser-library-final",
  "final/browser-core-final",
].map((prefix) => {
  const result = json(`${prefix}.json`);
  return {
    record: `${root}/${prefix}.json`,
    hostname: result.hostname,
    code: result.code,
    elapsedMs: result.elapsedMs,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  };
});

const report = {
  hostname: "mbp-old",
  baseline: phase("baseline", "launch-pinned.log"),
  final: phase("final", "launch-final.log"),
  checks,
  limitations: [
    "Desktop Chromium/WebKit with mobile emulation; no physical iOS proof.",
    "Launch: 24 persistent Chromium launches, frozen 16ms CPU calibration reference; WebKit capability probe fails.",
    "Core and search elapsed times include Playwright and screenshots where present; identical baseline/final script.",
    "Tiny document narration includes uncached model weights; not a long-document or thermal benchmark.",
    "Main-page heap snapshots have no forced GC and exclude workers, WASM and process memory; no memory reduction claim.",
    "Decoded resource bodies are not compressed network transfer; all-build bundle includes lazy runtimes.",
    "Two genuine hidden/background T1 rows remain uncovered; other resume rows distinguish synthetic lifecycle events and real process kills.",
    "Full final integrity matrix uses trace=off after the recorded traced run; assertions and drift thresholds are unchanged.",
  ],
};
writeFileSync("docs/evidence/architecture-metrics.json", JSON.stringify(report, null, 2) + "\n");

function evidenceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const file = `${directory}/${name}`;
    if (statSync(file).isDirectory()) return evidenceFiles(file);
    return /\.(json|jsonl|log|png|zip)$/.test(file) && !file.endsWith("/server.log") ? [file] : [];
  });
}
const artifacts = [];
for (const file of [
  ...evidenceFiles(`${root}/baseline`),
  ...evidenceFiles(`${root}/final`),
].sort()) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  artifacts.push({ file, bytes: statSync(file).size, sha256: digest.digest("hex") });
}
writeFileSync(
  "docs/evidence/architecture-artifacts.json",
  JSON.stringify(
    { method: "Raw JSON, logs, screenshots and traces; active server log excluded.", artifacts },
    null,
    2,
  ) + "\n",
);
console.log(`Derived metrics and ${artifacts.length} artifact checksums from recorded outcomes`);
