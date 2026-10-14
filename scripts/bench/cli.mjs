import path from "node:path";
import { parseArgs } from "node:util";

import { runBenchmark } from "./benchmark.mjs";
import { prepareBuild } from "./build.mjs";
import { startServer } from "./runtime.mjs";
import { recordScenarios, scenarioNames } from "./scenarios.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(
    [
      "ref",
      "dir",
      "a",
      "b",
      "label",
      "out",
      "reps",
      "noise",
      "url",
      "build-dir",
      "scenarios",
      "first-visit-reps",
      "warm-start-reps",
      "playback-reps",
      "transitions-reps",
      "memory-reps",
    ].map((key) => [key, { type: "string" }]),
  ),
});
const required = (...keys) => {
  for (const key of keys) if (!values[key]) throw new Error(`Missing --${key}`);
};
const number = (key) => (values[key] === undefined ? undefined : Number(values[key]));
try {
  if (positionals[0] === "prepare") {
    required("ref", "dir");
    console.log(await prepareBuild(values.ref, values.dir));
  } else if (positionals[0] === "run") {
    required("a", "b", "label", "out");
    const report = await runBenchmark({
      A: values.a,
      B: values.b,
      label: values.label,
      output: values.out,
      reps: number("reps"),
      overrides: {
        first_visit: number("first-visit-reps"),
        warm_start: number("warm-start-reps"),
        playback: number("playback-reps"),
        transitions: number("transitions-reps"),
        memory: number("memory-reps"),
      },
      noisePath: values.noise,
    });
    if (!report.completed || report.noiseFailure || report.samples.some((sample) => !sample.ok))
      process.exitCode = 1;
  } else if (positionals[0] === "record") {
    required("out");
    if (!!values.url === !!values["build-dir"])
      throw new Error("Supply exactly one of --url and --build-dir.");
    let server;
    try {
      if (values["build-dir"]) server = await startServer(path.resolve(values["build-dir"]), 3100);
      const origin = server?.origin ?? values.url;
      const url = new URL(origin);
      if (!["127.0.0.1", "localhost"].includes(url.hostname))
        throw new Error("Recorder requires a local server.");
      if (values.url) {
        const probe = await fetch(`${url.origin}/api/perf/query-count`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!probe.ok)
          throw new Error(
            "The existing server must enable HARK_REQUIRE_LOCAL_DB=1 and its local database guard.",
          );
      }
      const summary = await recordScenarios({
        origin,
        directory: values["build-dir"] ? path.resolve(values["build-dir"]) : undefined,
        output: values.out,
        names: values.scenarios ? values.scenarios.split(",") : scenarioNames,
      });
      console.log(
        JSON.stringify({
          scenarios: summary.scenarios.length,
          flickerEvents: summary.events.length,
          failures: summary.scenarios.filter(
            (scenario) => scenario.failure || scenario.errors.length,
          ).length,
        }),
      );
      if (summary.scenarios.some((scenario) => scenario.failure || scenario.errors.length))
        process.exitCode = 1;
    } finally {
      await server?.close();
    }
  } else throw new Error("Expected prepare, run or record.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
