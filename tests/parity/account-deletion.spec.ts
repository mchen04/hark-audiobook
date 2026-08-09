import { expect, test } from "@playwright/test";

import { testAccountPassword } from "../shared/test-account-password";
import {
  ensureAccount,
  findUserId,
  openDevice,
  signInThroughUi,
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

test("a lost deletion response leaves the server deleted and the device clean", async ({
  browser,
}) => {
  const device = await openDevice(browser);
  try {
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
  } finally {
    await device.context.close();
  }
});
