import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, devices, webkit } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

import { awaitAuthBudget } from "../../tests/shared/auth-budget.ts";
import { isRendererCommand } from "../../tests/shared/render-process.ts";
import { TEST_CLIENT_HEADERS } from "../../tests/shared/test-client-ip.ts";
import { envFile, root, runCommand, testEnvironment } from "./build.mjs";

const resources = new Set();
let stopping = false;
export function ownResource(close) {
  resources.add(close);
  return () => resources.delete(close);
}
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
])
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled([...resources].map((close) => close()));
    process.exit(code);
  });

const title = "Hark Benchmark Fixture";
export const startPath = "/library?source=pwa";
export const headers = TEST_CLIENT_HEADERS.launch;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function startServer(directory, port, measureTransfers = false) {
  if (![3100, 3200, 3300, 3400].includes(port))
    throw new Error("Harness port must be 3100, 3200, 3300 or 3400.");
  const origin = `http://127.0.0.1:${port}`;
  const occupied = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(500) }).then(
    () => true,
    () => false,
  );
  if (occupied) throw new Error(`Port ${port} already has a server.`);
  const logDirectory = mkdtempSync(path.join(tmpdir(), "hark-server-"));
  const { openSync, closeSync } = await import("node:fs");
  const logPath = path.join(logDirectory, "server.log");
  const log = openSync(logPath, "w");
  const child = spawn(
    process.execPath,
    [
      ...(measureTransfers
        ? ["--import", path.join(import.meta.dirname, "server-transfer.mjs")]
        : []),
      "scripts/run-standalone.mjs",
    ],
    {
      cwd: directory,
      env: {
        ...testEnvironment(),
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        BETTER_AUTH_URL: origin,
      },
      stdio: measureTransfers ? ["ignore", log, log, "ipc"] : ["ignore", log, log],
    },
  );
  closeSync(log);
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  const close = async () => {
    release();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  };
  const release = ownResource(close);
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null)
        throw new Error(`Standalone server failed; inspect ${logPath}`);
      if (
        await fetch(`${origin}/login`, { signal: AbortSignal.timeout(1000) }).then(
          (r) => r.ok,
          () => false,
        )
      )
        return {
          origin,
          close,
          logPath,
          pid: child.pid,
          transfers: async (reset = false) => {
            if (!measureTransfers) throw new Error("Transfer meter is not enabled.");
            const id = randomUUID();
            return new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                child.off("message", receive);
                reject(new Error("Transfer meter timed out."));
              }, 5000);
              const receive = (message) => {
                if (message.id === id) {
                  clearTimeout(timeout);
                  child.off("message", receive);
                  resolve(message.records);
                }
              };
              child.on("message", receive);
              child.send({ type: reset ? "bench-reset" : "bench-read", id });
            });
          },
        };
      await sleep(200);
    }
    throw new Error(`Server readiness timed out; inspect ${logPath}`);
  } catch (error) {
    await close();
    throw error;
  }
}

export async function audioFixture() {
  const directory = path.join(tmpdir(), "hark-benchmark-fixture-v1");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "hark-benchmark.mp3");
  const ffmpegVersion = execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0];
  const metadata = `;FFMETADATA1\ntitle=${title}\nartist=Synthetic Benchmark\n${Array.from({ length: 5 }, (_, i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${i * 120000}\nEND=${(i + 1) * 120000}\ntitle=Tone ${i + 1}\n`).join("")}`;
  const metadataPath = path.join(directory, "chapters.txt");
  writeFileSync(metadataPath, metadata);
  const receiptPath = path.join(directory, "fixture.json");
  const previous = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null;
  if (
    !existsSync(file) ||
    previous?.ffmpegVersion !== ffmpegVersion ||
    previous?.metadataSha256 !== sha256(metadata) ||
    previous?.sha256 !== sha256(readFileSync(file))
  ) {
    await runCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=44100:duration=300",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=300",
      "-f",
      "ffmetadata",
      "-i",
      metadataPath,
      "-filter_complex",
      "[0:a][1:a]concat=n=2:v=0:a=1[a]",
      "-map",
      "[a]",
      "-map_metadata",
      "2",
      "-map_chapters",
      "2",
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-id3v2_version",
      "3",
      "-fflags",
      "+bitexact",
      "-flags:a",
      "+bitexact",
      file,
    ]);
  }
  const bytes = readFileSync(file);
  if (bytes.length <= 4 * 1024 * 1024)
    throw new Error("Audio fixture must cross the 4 MiB boundary.");
  const receipt = {
    file,
    sha256: sha256(bytes),
    byteSize: bytes.length,
    durationSeconds: 600,
    chapters: 5,
    bitrate: 64000,
    channels: 1,
    metadataSha256: sha256(metadata),
    ffmpegVersion,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export async function syntheticAccount(directory = root) {
  const env = testEnvironment();
  const email = `bench-${randomUUID()}@hark.test`;
  const password = env.HARK_TEST_ACCOUNT_PASSWORD;
  if (!password) throw new Error("Missing synthetic account password in .env.test.");
  const id = randomUUID();
  const hash = await hashPassword(password);
  const sql = postgres(env.DATABASE_URL, { max: 1 });
  try {
    await sql`insert into "user" (id, name, email, email_verified) values (${id}, 'Benchmark', ${email}, true)`;
    await sql`insert into account (id, account_id, provider_id, user_id, password) values (${randomUUID()}, ${id}, 'credential', ${id}, ${hash})`;
  } finally {
    await sql.end();
  }
  await runCommand(process.execPath, ["scripts/seed-perf.mjs", email, `--env-file=${envFile}`], {
    cwd: directory,
    env,
    stdio: "ignore",
  });
  const check = postgres(env.DATABASE_URL, { max: 1 });
  let bookCount;
  try {
    const [row] = await check`select count(*)::int as total from books where owner_id=${id}`;
    bookCount = row.total;
  } finally {
    await check.end();
  }
  if (bookCount !== 1000)
    throw new Error("Synthetic library does not contain exactly 1,000 metadata books.");
  return { email, password, id, bookCount };
}

export async function signIn(context, origin, account, ui = false) {
  const sql = postgres(testEnvironment().DATABASE_URL, { max: 1 });
  try {
    await awaitAuthBudget(
      "sign-in",
      async () => {
        const [row] =
          await sql`select count, last_request from rate_limit where key=${`${headers["x-forwarded-for"]}|/sign-in/email`}`;
        return row ? { count: row.count, lastRequest: Number(row.last_request) } : undefined;
      },
      (ms) => console.log(`Auth budget: waiting ${Math.ceil(ms / 1000)} seconds.`),
    );
  } finally {
    await sql.end();
  }
  if (ui) {
    const page = context.pages().find((p) => p.url().includes("/login"));
    if (!page) throw new Error("Login page missing.");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(/\/library/, { waitUntil: "domcontentloaded" });
  } else {
    const response = await context.request.post(`${origin}/api/auth/sign-in/email`, {
      headers: { origin, ...headers },
      data: { email: account.email, password: account.password },
    });
    if (!response.ok()) throw new Error(`Synthetic sign-in failed: HTTP ${response.status()}`);
  }
  const cookies = (await context.cookies()).filter((cookie) =>
    cookie.name.includes("session_token"),
  );
  if (!cookies.length) throw new Error("Real auth did not set a session cookie.");
  return cookies;
}

export function processSnapshot() {
  return execFileSync("ps", ["-axww", "-o", "pid=,ppid=,rss=,comm="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              rssKiB: Number(match[3]),
              executable: match[4],
            },
          ]
        : [];
    });
}

export async function launchWebKit(options = {}) {
  const before = new Set(processSnapshot().map((p) => p.pid));
  const browser = await webkit.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
  });
  const context = await browser.newContext({
    ...devices["iPhone 15"],
    serviceWorkers: "allow",
    extraHTTPHeaders: headers,
    ...options,
  });
  const close = () => browser.close();
  const release = ownResource(close);
  browser.once("disconnected", release);
  const executable = webkit.executablePath();
  const bundle = path.dirname(executable);
  const owned = new Set();
  const claim = (snapshot) => {
    for (const p of processSnapshot())
      if (!snapshot.has(p.pid) && p.executable.startsWith(bundle)) owned.add(p.pid);
  };
  claim(before);
  await context.addInitScript(() =>
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true }),
  );
  return {
    context,
    close,
    version: browser.version(),
    build: path.basename(bundle),
    ...trackWebKitPages(context, claim),
    async capture(action) {
      const snapshot = new Set(processSnapshot().map((p) => p.pid));
      try {
        return await action();
      } finally {
        claim(snapshot);
      }
    },
    rss() {
      const matched = processSnapshot().filter(
        (p) => owned.has(p.pid) && p.executable.startsWith(bundle),
      );
      if (!matched.length) throw new Error("No owned WebKit processes matched the bundle path.");
      return {
        rssKiB: matched.reduce((sum, p) => sum + p.rssKiB, 0),
        processes: matched,
        jsHeapBytes: null,
        jsHeapReason: "unavailable in WebKit",
      };
    },
  };
}

export function trackWebKitPages(context, claim = () => {}) {
  const executable = webkit.executablePath();
  const pagePids = new WeakMap();
  return {
    context,
    async newPage() {
      const snapshot = new Set(processSnapshot().map((p) => p.pid));
      const page = await context.newPage();
      claim(snapshot);
      const renderers = processSnapshot().filter(
        (p) => !snapshot.has(p.pid) && isRendererCommand(p.executable, "webkit", executable),
      );
      if (renderers.length !== 1) {
        await page.close();
        throw new Error(`Expected one new page WebContent PID; found ${renderers.length}.`);
      }
      pagePids.set(page, renderers[0]);
      return page;
    },
    pageProcess(page) {
      const renderer = pagePids.get(page);
      if (!renderer || !processSnapshot().some((p) => p.pid === renderer.pid))
        throw new Error("The page's recorded WebContent PID is no longer alive.");
      return renderer;
    },
  };
}

export async function closeWebKitPages(handle) {
  const pages = handle.context.pages();
  if (!pages.length) throw new Error("A cold start requires an existing page process.");
  const processes = pages.map((page) => handle.pageProcess(page));
  const audioSavedBefore = await pages[0].evaluate(storedAudioReady);
  const checkedAt = new Date().toISOString();
  for (const page of pages) await page.close();
  const started = performance.now();
  while (processes.some((p) => processSnapshot().some((current) => current.pid === p.pid))) {
    if (performance.now() - started > 60000)
      throw new Error(
        `Page WebContent PID did not exit: ${processes.map((p) => p.pid).join(", ")}`,
      );
    await sleep(100);
  }
  return {
    processes: processes.map((p) => ({ ...p, checkedAt, exited: true })),
    audioSavedBefore,
    exitObservedAt: new Date().toISOString(),
    exitWaitMs: performance.now() - started,
    serviceWorkerRunning: "unknown",
    serviceWorkerReason: "Playwright cannot observe running WebKit service workers.",
  };
}

export async function launchChromium(profile) {
  const executable = chromium.executablePath();
  const before = new Set(processSnapshot().map((p) => p.pid));
  const context = await chromium.launchPersistentContext(profile, {
    ...devices["iPhone 15"],
    executablePath: executable,
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    serviceWorkers: "allow",
    extraHTTPHeaders: headers,
  });
  const roots = processSnapshot().filter(
    (p) => !before.has(p.pid) && p.executable === executable && p.parent === process.pid,
  );
  if (roots.length !== 1) {
    await context.close();
    throw new Error(`Expected one owned Chromium browser PID; found ${roots.length}.`);
  }
  const pid = roots[0].pid;
  const release = ownResource(() => context.close());
  context.once("close", release);
  await context.addInitScript(() =>
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true }),
  );
  return {
    context,
    pid,
    version: context.browser().version(),
    async kill() {
      process.kill(pid, "SIGKILL");
      const deadline = Date.now() + 10000;
      while (processSnapshot().some((p) => p.pid === pid)) {
        if (Date.now() > deadline) throw new Error("Owned Chromium browser PID did not exit.");
        await sleep(100);
      }
      await context.close().catch(() => {});
      release();
      return { pid, signal: "SIGKILL", exited: true, exitObservedAt: new Date().toISOString() };
    },
  };
}

export function freshProfile() {
  return mkdtempSync(path.join(tmpdir(), "hark-chromium-"));
}

export async function booksReady(page, timeout = 60000) {
  await page.waitForFunction(
    () =>
      document.querySelector('[data-launch-ready="books"]') &&
      document.querySelectorAll(".book-grid .book-item").length > 0,
    null,
    { timeout, polling: "raf" },
  );
  return page.evaluate(() => ({
    marker: document.querySelector("[data-launch-ready]")?.getAttribute("data-launch-ready"),
    cards: document.querySelectorAll(".book-grid .book-item").length,
  }));
}

export const bookCard = (page) =>
  page.locator(".book-grid .book-item .book-title").filter({ hasText: title }).first();
export const playButton = (page) => page.getByRole("button", { name: "Play", exact: true });
export const backButton = (page) => page.getByRole("button", { name: "Library", exact: true });

export async function playerReady(page) {
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  await playButton(page).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => (b.getAttribute("aria-label") || b.textContent?.trim()) === "Play" && !b.disabled,
    ),
  );
}

export async function storedAudioReady() {
  const names = (await caches.keys()).filter((name) => name.includes("media"));
  for (const name of names) {
    const cache = await caches.open(name);
    for (const key of await cache.keys()) {
      const response = await cache.match(key);
      if (response?.headers.get("X-Chapterline-Media-Format") !== "chunked-v1") continue;
      const manifest = await response.json();
      if (
        manifest.chunkCount >= 2 &&
        (
          await Promise.all(
            Array.from({ length: manifest.chunkCount }, (_, i) =>
              cache.match(`${key.url}/chunk/${i}`),
            ),
          )
        ).every(Boolean)
      )
        return true;
    }
  }
  return false;
}

export async function importAudio(page, fixture) {
  await page.getByLabel("Sort books").selectOption("added");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /^(Add book|Choose a book)$/ }).click();
  await (await chooser).setFiles(fixture.file);
  await page.waitForFunction(
    (title) =>
      document.querySelector(".upload-error") ||
      ([...document.querySelectorAll(".book-title")].some(
        (link) => link.textContent?.trim() === title,
      ) &&
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "Add book" && !button.disabled,
        )),
    title,
    { timeout: 60000 },
  );
  const error = (await page.locator(".upload-error").count())
    ? await page.locator(".upload-error").textContent()
    : null;
  if (error) throw new Error(error.replace("Dismiss error", "").trim());
  await bookCard(page).waitFor({ timeout: 60000 });
  await bookCard(page).click();
  await playerReady(page);
  await page.waitForFunction(storedAudioReady, null, { timeout: 60000 });
  await page.evaluate(() => {
    window.__harkAudioBefore = document.querySelector("audio").currentTime;
  });
  await playButton(page).click();
  await page.waitForFunction(
    () => {
      const audio = document.querySelector("audio");
      return !audio.paused && audio.currentTime >= window.__harkAudioBefore + 0.2;
    },
    null,
    { polling: "raf", timeout: 15000 },
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const bookPath = new URL(page.url()).pathname;
  await backButton(page).click();
  await page.getByLabel("Sort books").selectOption("activity");
  await booksReady(page);
  await bookCard(page).waitFor();
  await shellReady(page);
  return bookPath;
}

export async function shellReady(page) {
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration?.active?.state !== "activated" || !navigator.serviceWorker.controller)
        return false;
      const response = await caches.match("/library?source=pwa");
      if (!response || !response.headers.get("X-Chapterline-Shell-Generation")) return false;
      const html = await response.text();
      const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s\\]+/g) || [])];
      return (
        assets.length > 0 &&
        (await Promise.all(assets.map((asset) => caches.match(asset)))).every(Boolean)
      );
    },
    null,
    { timeout: 60000 },
  );
}
