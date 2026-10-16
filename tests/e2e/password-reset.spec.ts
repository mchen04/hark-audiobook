import { devices, expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { testAccountPassword } from "../shared/test-account-password";
import { closeSql, sql } from "../sync/harness/app";

test.afterAll(closeSql);

test("local captured reset mail redeems once, revokes old sessions and rejects invalid or expired tokens", async ({
  browser,
  context,
  page,
  baseURL,
}) => {
  test.setTimeout(180000);
  const headers = { "x-forwarded-for": "198.51.100.107" };
  await context.setExtraHTTPHeaders(headers);
  const email = `password-reset-${randomUUID()}@hark.test`;
  const oldPassword = testAccountPassword("reset-before");
  const newPassword = testAccountPassword("reset-after");
  await page.goto("/register");
  await page.getByLabel("Name", { exact: true }).fill("Reset Reader");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel(/^Password/).fill(oldPassword);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(/\/library/);
  const oldSession = await (await page.request.get("/api/auth/get-session")).json();
  expect(oldSession.user.email).toBe(email);
  const recoveryContext = await browser.newContext({
    ...devices["iPhone 15"],
    baseURL,
    extraHTTPHeaders: headers,
  });
  try {
    const recovery = await recoveryContext.newPage();
    const requestReset = async () => {
      const startedAt = Date.now();
      await recovery.goto("/forgot-password");
      await recovery.getByLabel("Email", { exact: true }).fill(email);
      await recovery.getByRole("button", { name: "Send reset link", exact: true }).click();
      await expect(recovery.getByRole("status")).toContainText("If that email has an account");
      const directory = path.join(process.cwd(), ".next/standalone/.data/mail");
      let filename = "";
      await expect
        .poll(async () => {
          const files = await readdir(directory).catch(() => []);
          filename =
            files
              .filter(
                (file) =>
                  file.endsWith(`-${email}.json`) && Number(file.split("-")[0]) >= startedAt,
              )
              .sort()
              .at(-1) ?? "";
          return !!filename;
        })
        .toBe(true);
      const capture = JSON.parse(await readFile(path.join(directory, filename), "utf8"));
      expect(capture).toMatchObject({ type: "password-reset", to: email });
      expect(new URL(capture.url).origin).toBe(new URL(baseURL!).origin);
      return capture.url as string;
    };
    const link = await requestReset();
    await recovery.goto(link);
    await recovery.getByLabel(/^New password/).fill(newPassword);
    await recovery.getByRole("button", { name: "Set new password", exact: true }).click();
    await expect(recovery).toHaveURL(/\/login$/);
    expect(await (await page.request.get("/api/auth/get-session")).json()).toBeNull();
    const [remaining] = await sql()<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM session WHERE user_id = ${oldSession.user.id}`;
    expect(remaining?.count).toBe(0);
    await recovery.getByLabel("Email", { exact: true }).fill(email);
    await recovery.getByLabel("Password", { exact: true }).fill(oldPassword);
    await recovery.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(recovery.locator(".auth-form").getByRole("alert")).toContainText(
      /invalid|password/i,
    );
    await recovery.getByLabel("Password", { exact: true }).fill(newPassword);
    await recovery.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(recovery).toHaveURL(/\/library/);
    expect((await (await recovery.request.get("/api/auth/get-session")).json()).user.id).toBe(
      oldSession.user.id,
    );
    expect(await (await page.request.get("/api/auth/get-session")).json()).toBeNull();
    await recoveryContext.clearCookies();
    await recovery.goto(link);
    await expect(recovery.locator(".auth-form").getByRole("alert")).toContainText(
      "invalid or has expired",
    );
    await expect(recovery.getByRole("link", { name: "Request a new link" })).toBeVisible();
    await recovery.goto("/reset-password");
    await expect(recovery.locator(".auth-form").getByRole("alert")).toContainText(
      "invalid or has expired",
    );
    await recovery.goto(`/reset-password?token=invalid-${randomUUID()}`);
    await recovery.getByLabel(/^New password/).fill(newPassword);
    await recovery.getByRole("button", { name: "Set new password", exact: true }).click();
    await expect(recovery.locator(".auth-form").getByRole("alert")).toContainText(
      /invalid|expired/i,
    );
    const expiredLink = await requestReset();
    const token = new URL(expiredLink).pathname.split("/").pop()!;
    const expired =
      await sql()`UPDATE verification SET expires_at = now() - interval '1 minute' WHERE identifier = ${`reset-password:${token}`} RETURNING id`;
    expect(expired).toHaveLength(1);
    await recovery.goto(expiredLink);
    await expect(recovery.locator(".auth-form").getByRole("alert")).toContainText(
      "invalid or has expired",
    );
    await recovery.getByRole("link", { name: "Request a new link" }).click();
    await expect(
      recovery.getByRole("button", { name: "Send reset link", exact: true }),
    ).toBeVisible();
  } finally {
    await recoveryContext.close();
  }
});
