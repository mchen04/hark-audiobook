import { expect, test, type Page } from "@playwright/test";

import { PENDING_ACCOUNT_DELETION_KEY, ACTIVE_USER_KEY } from "../../src/lib/app-keys";
import { startControllableNetwork } from "../parity/harness/network";
import { closeSql, resetAccount, sharedSession, waitForServiceWorker } from "../sync/harness/app";

test.afterAll(closeSql);

async function fillSignIn(page: Page, account: { email: string; password: string }) {
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
}

test("a UI sign-in interrupted before its library response arrives recovers the cached library", async ({
  browser,
  context,
  page,
  baseURL,
}) => {
  const { account } = await sharedSession(browser);
  await resetAccount(account.userId);
  const network = await startControllableNetwork(baseURL!);
  let held: ReturnType<typeof network.holdNextResponse> | null = null;
  try {
    await page.goto(`${network.origin}/login`);
    await waitForServiceWorker(page);
    held = network.holdNextResponse("GET", "/library");
    await fillSignIn(page, account);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect(await held.upstreamStatus).toBe(200);
    await expect
      .poll(async () =>
        (await context.cookies()).some((cookie) => cookie.name.includes("session_token")),
      )
      .toBe(true);
    await expect(page.getByRole("button", { name: "Please wait", exact: true })).toBeDisabled();
    expect(await page.evaluate((key) => localStorage.getItem(key), ACTIVE_USER_KEY)).toBeNull();
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(`${network.origin}/library`, { waitUntil: "commit" });
    await expect(reopened.locator('[data-launch-ready="empty"]')).toBeVisible({ timeout: 10_000 });
    expect(await reopened.evaluate((key) => localStorage.getItem(key), ACTIVE_USER_KEY)).toBe(
      account.userId,
    );
  } finally {
    held?.release();
    await network.close();
  }
});

test("a retained session recovers after synthetic active-user storage loss", async ({
  browser,
  page,
}) => {
  const { account } = await sharedSession(browser);
  await resetAccount(account.userId);
  await page.goto("/login");
  await fillSignIn(page, account);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator('[data-launch-ready="empty"]')).toBeVisible();
  await waitForServiceWorker(page);
  expect(await page.evaluate((key) => localStorage.getItem(key), ACTIVE_USER_KEY)).toBe(
    account.userId,
  );
  const session = await page.request.get("/api/auth/get-session");
  expect(session.ok()).toBe(true);
  expect((await session.json()).user.id).toBe(account.userId);
  await page.evaluate((key) => localStorage.removeItem(key), ACTIVE_USER_KEY);
  await page.reload({ waitUntil: "commit" });
  await expect(page.locator('[data-launch-ready="empty"]')).toBeVisible({ timeout: 10_000 });
});

test("the cookie-only sign-in harness recovers a service-worker-controlled library", async ({
  browser,
  page,
  context,
}) => {
  const { account } = await sharedSession(browser);
  await resetAccount(account.userId);
  await page.goto("/login");
  await waitForServiceWorker(page);
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: { email: account.email, password: account.password },
  });
  expect(response.ok()).toBe(true);
  expect((await context.cookies()).some((cookie) => cookie.name.includes("session_token"))).toBe(
    true,
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), ACTIVE_USER_KEY)).toBeNull();
  await page.goto("/library", { waitUntil: "commit" });
  await expect(page.locator('[data-launch-ready="empty"]')).toBeVisible({ timeout: 10_000 });
});

test("a synthetic pending-deletion login exposes retry and a working return path", async ({
  browser,
  context,
  page,
}) => {
  const { account, storageState } = await sharedSession(browser);
  await resetAccount(account.userId);
  await context.addCookies(storageState.cookies);
  await context.addInitScript(
    ({ userId, key }) => {
      if (!sessionStorage.getItem("deletion-fixture-installed")) {
        localStorage.setItem(
          key,
          JSON.stringify({
            userId,
            deleteToken: "synthetic-deletion-token",
            phase: "purged",
            createdAt: Date.now(),
          }),
        );
        sessionStorage.setItem("deletion-fixture-installed", "true");
      }
    },
    { userId: account.userId, key: PENDING_ACCOUNT_DELETION_KEY },
  );
  let commits = 0;
  await page.route("**/api/account/delete", async (route) => {
    commits++;
    await route.fulfill({
      status: commits === 1 ? 503 : 410,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Deletion needs attention" })).toBeVisible();
  await expect(page.getByText("Opening your library…")).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("button", { name: "Return to sign in", exact: true })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), ACTIVE_USER_KEY)).toBeNull();
  await page.getByRole("button", { name: "Return to sign in", exact: true }).click();
  await expect(page.locator('[data-launch-ready="empty"]')).toBeVisible();
  expect(commits).toBe(2);
});
