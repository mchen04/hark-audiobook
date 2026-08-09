// @vitest-environment jsdom

import { beforeEach, expect, it } from "vitest";

import { PENDING_ACCOUNT_DELETION_KEY } from "@/lib/app-keys";
import {
  readActiveUserId,
  rememberActiveUserId,
  serverUserNeedsBootstrap,
} from "@/lib/active-user";

import { rememberPendingAccountDeletion } from "./account-deletion";

const USER = "deleting-user-fence-test";

beforeEach(() => localStorage.clear());

it("revokes the active identity as soon as the durable deletion fence is installed", () => {
  rememberActiveUserId(USER);

  rememberPendingAccountDeletion(USER, "token-with-enough-entropy-for-the-fence-123456");

  expect(readActiveUserId()).toBeNull();
});

it("does not let a server render bootstrap a user whose deletion is pending", () => {
  localStorage.setItem(
    PENDING_ACCOUNT_DELETION_KEY,
    JSON.stringify({
      userId: USER,
      deleteToken: "token-with-enough-entropy-for-the-fence-123456",
      phase: "purged",
      createdAt: Date.now(),
    }),
  );

  expect(serverUserNeedsBootstrap(USER)).toBe(false);
  rememberActiveUserId(USER);
  expect(readActiveUserId()).toBeNull();
});
