import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { devices } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { awaitSignInBudget, burnSignInWindow } from "../../shared/sign-in-budget";
import { testAccountPassword } from "../../shared/test-account-password";
import { TEST_CLIENT_HEADERS } from "../../shared/test-client-ip";
import { assertLocalDatabase } from "../../../scripts/lib/assert-local-database.mjs";
import { DEFAULT_TEST_ENV_FILE, loadEnvFile } from "../../../scripts/lib/env-file.mjs";
import { buildDriverScript } from "../../sync/harness/driver-bundle";
import type {} from "../../sync/harness/driver-entry";
import { closeSql, resetAccount, sql } from "../../sync/harness/app";

import { startControllableNetwork, type ControllableNetwork } from "./network";

const envFile = process.env.HARK_ENV_FILE ?? DEFAULT_TEST_ENV_FILE;
loadEnvFile(envFile);

export const DATABASE_HOST = assertLocalDatabase(process.env.DATABASE_URL, {
  context: "The parity suite",
});

const APP_ORIGIN = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

export { closeSql, resetAccount, sql };

let networkPromise: Promise<ControllableNetwork> | null = null;

export function network(): Promise<ControllableNetwork> {
  networkPromise ??= startControllableNetwork(APP_ORIGIN);
  return networkPromise;
}

export async function origin(): Promise<string> {
  return (await network()).origin;
}

export async function cutNetwork(page: Page): Promise<void> {
  const net = await network();
  net.cut();
  const reached = await controlFetch(page, net.origin);
  expect(
    reached,
    "cutNetwork() was asked to remove the network but a control request still reached the " +
      "server. Every offline assertion after this point would be a lie.",
  ).toBe(false);
}

export async function restoreNetwork(page: Page): Promise<void> {
  const net = await network();
  net.restore();
  const reached = await controlFetch(page, net.origin);
  expect(reached, "restoreNetwork() left the network unreachable").toBe(true);
}

async function controlFetch(page: Page, netOrigin: string): Promise<boolean> {
  return page.evaluate(async (target) => {
    try {
      const response = await fetch(`${target}/api/sync/pull?control=1`, { cache: "no-store" });
      return response.status > 0;
    } catch {
      return false;
    }
  }, netOrigin);
}

export type Account = { email: string; password: string; name: string; userId: string };

type AccountSpec = Omit<Account, "userId">;

export const ACCOUNT_A: AccountSpec = {
  email: "parity-a@hark.test",
  password: testAccountPassword("parity-a"),
  name: "Parity A",
};

export const ACCOUNT_B: AccountSpec = {
  email: "parity-b@hark.test",
  password: testAccountPassword("parity-b"),
  name: "Parity B",
};

export async function findUserId(email: string): Promise<string | null> {
  const [row] = await sql()<{ id: string }[]>`
    SELECT id FROM "user" WHERE lower(email) = ${email.toLowerCase()}
  `;
  return row?.id ?? null;
}

export async function ensureAccount(browser: Browser, spec: AccountSpec): Promise<Account> {
  const existing = await findUserId(spec.email);
  if (existing) return { ...spec, userId: existing };

  const net = await network();
  const context = await browser.newContext({
    ...devices["iPhone 15"],
    serviceWorkers: "allow",
    extraHTTPHeaders: TEST_CLIENT_HEADERS.parity,
  });
  try {
    const page = await context.newPage();
    await page.goto(`${net.origin}/register`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Name").fill(spec.name);
    await page.getByLabel("Email").fill(spec.email);
    await page.getByLabel(/Password/).fill(spec.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/library/, { timeout: 60_000 }).catch(async (error: unknown) => {
      await failOnRateLimit(page, "sign-up");
      throw error;
    });
  } finally {
    await context.close();
  }
  const userId = await findUserId(spec.email);
  expect(userId, `no user row for ${spec.email} after registering`).toBeTruthy();
  return { ...spec, userId: userId! };
}

async function sawRateLimit(page: Page): Promise<boolean> {
  const body = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  return body.includes("Too many requests");
}

function rateLimitError(what: string): Error {
  return new Error(
    `better-auth rate-limited the ${what} for the parity suite, and waiting a full window out ` +
      "did not clear it. This is the harness hitting `src/server/auth.ts` limits, not a product " +
      "failure: something else is signing in from the parity test IP, or the on-disk test " +
      "budget no longer matches the shared database bucket.",
  );
}

async function failOnRateLimit(page: Page, what: string): Promise<void> {
  if (await sawRateLimit(page)) throw rateLimitError(what);
}

export async function signInThroughUi(page: Page, account: Account): Promise<void> {
  const net = await network();
  const attempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    await awaitSignInBudget("parity");
    await page.goto(`${net.origin}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const landed = await page.waitForURL(/\/library/, { timeout: 45_000 }).then(
      () => true,
      () => false,
    );
    if (landed) break;
    const throttled = await sawRateLimit(page);
    if (!throttled) {
      throw new Error(
        `signing ${account.email} in never reached /library. The page is at ${page.url()}.`,
      );
    }
    if (attempt >= attempts) throw rateLimitError("sign-in");
    console.log("[parity] better-auth throttled a sign-in; waiting its window out and retrying");
    burnSignInWindow("parity");
  }
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  await page.waitForTimeout(750);
  await expectActiveUser(page, account.userId);
}

export async function signOutThroughUi(page: Page): Promise<void> {
  const net = await network();
  await page.goto(`${net.origin}/settings`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Sign out/ }).click();
  await page.waitForURL(/\/login/, { timeout: 60_000 });
  await page.waitForTimeout(750);
}

export async function endSessionWithoutPurge(page: Page): Promise<void> {
  const net = await network();
  const status = await page.evaluate(async (target) => {
    const response = await fetch(`${target}/api/auth/sign-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return response.status;
  }, net.origin);
  expect(status, "the raw sign-out request did not succeed").toBeLessThan(400);
}

export async function expectActiveUser(page: Page, userId: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("chapterline:active-user")), {
      timeout: 20_000,
      message: "the device never recorded the account it is signed into",
    })
    .toBe(userId);
}

const SESSION_CACHE = path.join(tmpdir(), "hark-parity-session-a.json");

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

let cachedState: StorageState | null = null;

export async function sessionFor(browser: Browser, account: Account): Promise<StorageState> {
  if (cachedState && (await stateWorks(browser, cachedState))) return cachedState;
  const onDisk = readCachedState();
  if (onDisk && (await stateWorks(browser, onDisk))) {
    cachedState = onDisk;
    return onDisk;
  }
  const context = await browser.newContext({
    ...devices["iPhone 15"],
    serviceWorkers: "allow",
    extraHTTPHeaders: TEST_CLIENT_HEADERS.parity,
  });
  try {
    const page = await context.newPage();
    await signInThroughUi(page, account);
    cachedState = await context.storageState();
    try {
      writeFileSync(SESSION_CACHE, JSON.stringify(cachedState), "utf8");
    } catch {}
    return cachedState;
  } finally {
    await context.close();
  }
}

function readCachedState(): StorageState | null {
  if (!existsSync(SESSION_CACHE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_CACHE, "utf8")) as StorageState;
  } catch {
    return null;
  }
}

async function stateWorks(browser: Browser, state: StorageState): Promise<boolean> {
  const net = await network();
  const context = await browser.newContext({
    storageState: state,
    extraHTTPHeaders: TEST_CLIENT_HEADERS.parity,
  });
  try {
    const response = await context.request.get(`${net.origin}/api/sync/pull`);
    return response.status() === 200;
  } catch {
    return false;
  } finally {
    await context.close();
  }
}

export async function revokeSessions(userId: string): Promise<number> {
  const rows = await sql()`DELETE FROM "session" WHERE user_id = ${userId} RETURNING id`;
  return rows.length;
}

export type Device = { context: BrowserContext; page: Page; origin: string };

export async function openDevice(
  browser: Browser,
  options: { storageState?: StorageState; deviceId?: string; withDriver?: boolean } = {},
): Promise<Device> {
  const net = await network();
  const context = await browser.newContext({
    ...devices["iPhone 15"],
    serviceWorkers: "allow",
    baseURL: net.origin,
    storageState: options.storageState,
    extraHTTPHeaders: TEST_CLIENT_HEADERS.parity,
  });
  if (options.deviceId) {
    await context.addInitScript(
      ([id]) => {
        try {
          localStorage.setItem("chapterline:device-id", id as string);
        } catch {}
      },
      [options.deviceId] as const,
    );
  }
  if (options.withDriver) {
    await context.addInitScript({ content: await buildDriverScript() });
  }
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
  });
  const page = await context.newPage();
  return { context, page, origin: net.origin };
}

export async function warmUp(page: Page): Promise<string> {
  const net = await network();
  await page.goto(`${net.origin}/library`, { waitUntil: "domcontentloaded" });
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration("/");
          return registration?.active?.state ?? "none";
        }),
      { timeout: 60_000, message: "the service worker never reached the activated state" },
    )
    .toBe("activated");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 60_000,
  });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  const controller = await page.evaluate(
    () => navigator.serviceWorker.controller?.scriptURL ?? null,
  );
  expect(controller, "no service worker is controlling the page").toContain("/sw.js");
  return controller!;
}

export async function importThroughUi(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.setInputFiles('input[aria-label="Choose an audiobook or document to import"]', {
    name,
    mimeType: "audio/mpeg",
    buffer,
  });
}

export async function apiCall(
  page: Page,
  method: string,
  path_: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ([verb, target, payload]) => {
      const response = await fetch(target as string, {
        method: verb as string,
        headers: payload === null ? undefined : { "Content-Type": "application/json" },
        body: payload === null ? undefined : (payload as string),
        cache: "no-store",
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed };
    },
    [method, path_, body === undefined ? null : JSON.stringify(body)] as const,
  );
}
