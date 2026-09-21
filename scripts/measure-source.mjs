// Same source scope in both phases: src TS/TSX (excluding tests) + public/sw.js.
// ESLint's classic McCabe complexity, max:0, reports every function separately.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ESLint } from "eslint";
import nextTypeScript from "eslint-config-next/typescript";
import ts from "typescript";

const destination = process.argv[2];
if (!destination) throw new Error("Expected JSON output path");
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
const src = walk("src");
const isTest = (file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
const app = [...src.filter((file) => /\.tsx?$/.test(file) && !isTest(file)), "public/sw.js"];
const tests = [...src.filter(isTest), ...walk("tests").filter((file) => /\.[jt]sx?$/.test(file))];
const css = src.filter((file) => file.endsWith(".css"));
function counts(files) {
  let physical = 0;
  let nonblank = 0;
  let code = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const lines = source.trimEnd().split("\n");
    physical += lines.length;
    nonblank += lines.filter((line) => line.trim()).length;
    // TypeScript scanner removes comments without treating strings as comments.
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, source);
    const occupied = new Set();
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
      const from = sf.getLineAndCharacterOfPosition(scanner.getTokenPos()).line;
      const to = sf.getLineAndCharacterOfPosition(scanner.getTextPos() - 1).line;
      for (let line = from; line <= to; line++) occupied.add(line);
    }
    code += occupied.size;
  }
  return { files: files.length, physical, nonblank, code };
}
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    ...nextTypeScript,
    {
      files: ["**/*.{js,ts,tsx}"],
      rules: { complexity: ["warn", { max: 0, variant: "classic" }] },
    },
  ],
});
const functions = (await eslint.lintFiles(app)).flatMap((result) =>
  result.messages
    .filter((message) => message.ruleId === "complexity")
    .map((message) => ({
      file: path.relative(process.cwd(), result.filePath),
      line: message.line,
      complexity: Number(message.message.match(/complexity of (\d+)/)?.[1]),
      message: message.message,
    })),
);
if (!functions.length || functions.some((f) => !f.complexity))
  throw new Error("Invalid complexity measurement");
const assets = walk(".next/static")
  .filter((file) => /\.(js|css|wasm)$/.test(file))
  .map((file) => {
    const buffer = readFileSync(file);
    return { file, bytes: buffer.length, gzip: gzipSync(buffer).length };
  });
const report = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  method:
    "App src TS/TSX excluding test/spec plus public/sw.js; token-occupied code lines exclude comments/blank lines; ESLint classic complexity per function including short-circuit and optional paths. CSS, tests, generated separately. Bundle is all build static JS/CSS/WASM, not initial transfer.",
  app: counts(app),
  tests: counts(tests),
  css: counts(css),
  generated: counts(walk("drizzle/meta").filter((file) => file.endsWith(".json"))),
  complexity: {
    functions: functions.length,
    total: functions.reduce((n, f) => n + f.complexity, 0),
    max: Math.max(...functions.map((f) => f.complexity)),
    above10: functions.filter((f) => f.complexity > 10).length,
  },
  bundle: {
    files: assets.length,
    bytes: assets.reduce((n, f) => n + f.bytes, 0),
    gzip: assets.reduce((n, f) => n + f.gzip, 0),
  },
  functions,
  assets,
};
writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, functions: undefined, assets: undefined }, null, 2));
