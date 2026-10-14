import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertLocalDatabase } from "../lib/assert-local-database.mjs";
import { parseEnvFile } from "../lib/env-file.mjs";

export const frozenBase = "e4525ac70dd5bc3113ce3c8a76b97dcdd2d47858";
export const root = path.resolve(import.meta.dirname, "../..");
export const envFile = path.join(root, ".env.test");

export function testEnvironment() {
  const env = { ...process.env, ...parseEnvFile(readFileSync(envFile, "utf8")) };
  assertLocalDatabase(env.DATABASE_URL, { context: "The measurement harness" });
  return { ...env, HARK_ENV_FILE: envFile, HARK_REQUIRE_LOCAL_DB: "1" };
}

export function outsideRepository(target, temporary = false) {
  const absolute = path.resolve(target);
  const inside = (parent) => absolute === parent || absolute.startsWith(`${parent}${path.sep}`);
  if (inside(root) || (temporary && !inside(path.resolve(tmpdir())))) {
    throw new Error(
      temporary
        ? "Builds and profiles must be under TMPDIR."
        : "Output must be outside the repository.",
    );
  }
  return absolute;
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: options.stdio ?? "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)),
    );
  });
}

export async function prepareBuild(ref, directory) {
  const destination = outsideRepository(directory, true);
  const { execFileSync } = await import("node:child_process");
  const commit = execFileSync("git", ["rev-parse", `${ref}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const receipt = path.join(destination, "benchmark-build.json");
  if (existsSync(receipt)) {
    const saved = JSON.parse(readFileSync(receipt, "utf8"));
    if (
      saved.commit === commit &&
      existsSync(path.join(destination, ".next/standalone/server.js")) &&
      existsSync(path.join(destination, ".next/BUILD_ID"))
    )
      return saved;
    throw new Error("Existing build receipt does not match the requested complete build.");
  }
  if (existsSync(destination))
    throw new Error("Build directory already exists without a complete receipt.");
  mkdirSync(destination, { recursive: true });
  await new Promise((resolve, reject) => {
    const archive = spawn("git", ["archive", commit], {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const extract = spawn("tar", ["-xf", "-", "-C", destination], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    archive.stdout.pipe(extract.stdin);
    let finished = 0;
    for (const child of [archive, extract]) {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) reject(new Error("git archive export failed."));
        else if (++finished === 2) resolve();
      });
    }
  });
  const env = testEnvironment();
  await runCommand("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
    cwd: destination,
    env,
  });
  await runCommand("pnpm", ["build"], { cwd: destination, env });
  const saved = {
    commit,
    directory: destination,
    buildId: readFileSync(path.join(destination, ".next/BUILD_ID"), "utf8").trim(),
    preparedAt: new Date().toISOString(),
  };
  writeFileSync(receipt, `${JSON.stringify(saved, null, 2)}\n`);
  return saved;
}
