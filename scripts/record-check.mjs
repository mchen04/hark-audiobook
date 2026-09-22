// Capture an exact command, raw combined output, elapsed time and exit status.
// Usage: node scripts/record-check.mjs .data/objective/baseline/unit pnpm test
import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const [destination, command, ...args] = process.argv.slice(2);
if (!destination || !command) throw new Error("Expected output prefix and command arguments");
mkdirSync(path.dirname(destination), { recursive: true });
const log = createWriteStream(`${destination}.log`);
const startedAt = new Date().toISOString();
const start = performance.now();
const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
child.on("error", (error) => log.write(String(error)));
child.on("close", (code, signal) => {
  const result = {
    command: [command, ...args],
    cwd: process.cwd(),
    hostname: os.hostname(),
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - start),
    code,
    signal,
    log: `${destination}.log`,
  };
  log.end();
  writeFileSync(`${destination}.json`, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = code ?? 1;
});
