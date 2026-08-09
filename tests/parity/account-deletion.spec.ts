import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

import { testAccountPassword } from "../shared/test-account-password";
import {
  ensureAccount,
  findUserId,
  openDevice,
  signInThroughUi,
  sql,
  type Account,
} from "./harness/app";

const ACCOUNT = {
  email: "account-deletion-parity@hark.test",
  password: testAccountPassword("account-deletion-parity"),
  name: "Account Deletion Parity",
};

let account: Account;

test.beforeAll(async ({ browser }) => {
  account = await ensureAccount(browser, ACCOUNT);
});

test("account deletion bounds password reauthentication attempts", async ({ browser }) => {
  const device = await openDevice(browser);
  const limiterKey = `account-delete:${createHash("sha256").update(account.userId).digest("hex")}`;
  try {
    await sql()`DELETE FROM rate_limit WHERE key = ${limiterKey}`;
    await signInThroughUi(device.page, account);
    const wrongPassword = testAccountPassword("account-deletion-wrong-password");
    const attempt = () =>
      device.page.evaluate(
        async ({ confirmEmail, currentPassword }) => {
          const response = await fetch("/api/account/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phase: "prepare", confirmEmail, currentPassword }),
          });
          return { status: response.status, retryAfter: response.headers.get("Retry-After") };
        },
        { confirmEmail: account.email, currentPassword: wrongPassword },
      );

    const allowed = [];
    for (let count = 0; count < 5; count += 1) allowed.push(await attempt());
    expect(allowed.map(({ status }) => status)).toStrictEqual([403, 403, 403, 403, 403]);
    await expect(attempt()).resolves.toMatchObject({ status: 429, retryAfter: expect.any(String) });
  } finally {
    await sql()`DELETE FROM rate_limit WHERE key = ${limiterKey}`;
    await device.context.close();
  }
});

test("a lost deletion response leaves the server deleted and the device clean", async ({
  browser,
}) => {
  const device = await openDevice(browser);
  const expiredIntent = `account-delete:expired-${crypto.randomUUID()}`;
  try {
    await sql()`
      INSERT INTO verification (id, identifier, value, expires_at)
      VALUES (${expiredIntent}, ${expiredIntent}, ${"expired"}, ${new Date(0)})
    `;
    await signInThroughUi(device.page, account);
    const residueKey = `chapterline:account-delete-residue:${account.userId}`;
    await device.page.evaluate((key) => localStorage.setItem(key, "must disappear"), residueKey);

    // Browser routing cannot see a request once the service worker owns the
    // page. Wrap the page's real fetch instead: the request and database commit
    // finish, then the first successful response is lost before product code
    // can observe it. A second commit must use the server's durable receipt.
    await device.context.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await nativeFetch(input, init);
        let phase: unknown;
        try {
          phase = JSON.parse(String(init?.body ?? "null"))?.phase;
        } catch {
          phase = null;
        }
        if (
          phase === "commit" &&
          response.ok &&
          sessionStorage.getItem("hark:drop-delete-response") !== "done"
        ) {
          sessionStorage.setItem("hark:drop-delete-response", "done");
          throw new TypeError("simulated lost deletion response");
        }
        return response;
      };
    });

    await device.page.goto(`${device.origin}/settings`, { waitUntil: "domcontentloaded" });
    await device.page.getByLabel(/Type your email to confirm/i).fill(account.email);
    await device.page.getByLabel(/Current password/i).fill(account.password);
    await device.page.getByRole("button", { name: "Delete my account" }).click();
    await device.page.waitForURL(/\/register/, { timeout: 60_000 });

    expect(
      await device.page.evaluate(
        () => sessionStorage.getItem("hark:drop-delete-response") === "done",
      ),
      "the lost-response branch never ran",
    ).toBe(true);
    expect(await findUserId(account.email), "the account survived its committed deletion").toBe(
      null,
    );
    const local = await device.page.evaluate(
      (key) => ({
        residue: localStorage.getItem(key),
        activeUser: localStorage.getItem("chapterline:active-user"),
        pendingDeletion: localStorage.getItem("chapterline:pending-account-deletion"),
      }),
      residueKey,
    );
    expect(local).toStrictEqual({ residue: null, activeUser: null, pendingDeletion: null });

    const receiptId = `account-delete:${createHash("sha256").update(account.userId).digest("hex")}`;
    const [receipt] = await sql()<Array<{ id: string }>>`
      SELECT id FROM verification WHERE id = ${receiptId}
    `;
    const [legacyReceipt] = await sql()<Array<{ id: string }>>`
      SELECT id FROM verification WHERE id = ${`account-delete:${account.userId}`}
    `;
    const [expiredReceipt] = await sql()<Array<{ id: string }>>`
      SELECT id FROM verification WHERE id = ${expiredIntent}
    `;
    expect(receipt?.id).toBe(receiptId);
    expect(legacyReceipt).toBeUndefined();
    expect(expiredReceipt).toBeUndefined();
  } finally {
    await sql()`DELETE FROM verification WHERE id = ${expiredIntent}`;
    await device.context.close();
  }
});
