// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { readActiveUserId, rememberActiveUserId } from "@/lib/active-user";
import {
  assertAccountWritable,
  clearAccountSignOutFence,
  createAccountWriteScope,
  installAccountSignOutFence,
  isAccountSignOutFenced,
  withAccountPurgeLock,
  withAccountWriteLock,
} from "@/lib/account-deletion-fence";

const USER = "sign-out-fence-user";

beforeEach(() => localStorage.clear());

describe("account sign-out write fence", () => {
  it("blocks new writes without revoking the identity the purge still needs", () => {
    rememberActiveUserId(USER);

    installAccountSignOutFence(USER);

    expect(isAccountSignOutFenced(USER)).toBe(true);
    expect(readActiveUserId()).toBe(USER);
    expect(() => assertAccountWritable(USER)).toThrow(/sign-out/i);

    clearAccountSignOutFence(USER);
    expect(() => assertAccountWritable(USER)).not.toThrow();
  });

  it("cancels an active writer before the purge takes the account lock", async () => {
    const scope = createAccountWriteScope(USER);
    const order: string[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const write = withAccountWriteLock(USER, async () => {
      order.push("write-started");
      markStarted();
      await new Promise<void>((resolve) => {
        scope.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      order.push("write-cancelled");
    }).finally(scope.release);

    await started;
    installAccountSignOutFence(USER);
    const purge = withAccountPurgeLock(USER, async () => {
      order.push("purge-started");
    });

    await Promise.all([write, purge]);
    expect(order).toStrictEqual(["write-started", "write-cancelled", "purge-started"]);
  });
});
