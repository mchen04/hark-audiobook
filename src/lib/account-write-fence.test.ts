// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readActiveUserId, rememberActiveUserId } from "@/lib/active-user";
import { ACCOUNT_SIGN_OUT_FENCE_KEY } from "@/lib/app-keys";
import {
  assertAccountWritable,
  clearAccountSignOutFence,
  createAccountWriteScope,
  installAccountSignOutFence,
  isAccountSignOutFenced,
  reopenAccountAfterSignIn,
  withAccountPurgeLock,
  withAccountWriteLock,
} from "@/lib/account-deletion-fence";

const USER = "sign-out-fence-user";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

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

  it("lets an unconfirmed request fence recover after its owner disappears", () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    installAccountSignOutFence(USER);

    now += 2 * 60_000 + 1;

    expect(() => assertAccountWritable(USER)).not.toThrow();
    clearAccountSignOutFence(USER);
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

  it("keeps queued writes fenced when a purge outlives the stale-request timeout", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    installAccountSignOutFence(USER);

    let releasePurge!: () => void;
    let markPurgeStarted!: () => void;
    const purgeStarted = new Promise<void>((resolve) => {
      markPurgeStarted = resolve;
    });
    const purge = withAccountPurgeLock(USER, async () => {
      markPurgeStarted();
      await new Promise<void>((resolve) => {
        releasePurge = resolve;
      });
    });

    await purgeStarted;
    expect(localStorage.getItem(ACCOUNT_SIGN_OUT_FENCE_KEY)).not.toContain(USER);
    now += 2 * 60_000 + 1;
    const write = withAccountWriteLock(USER, async () => "wrote after purge");
    releasePurge();
    await purge;

    await expect(write).rejects.toThrow(/sign-out/i);
  });

  it("does not reopen a reauthenticated account until its older purge releases", async () => {
    installAccountSignOutFence(USER);
    let releasePurge!: () => void;
    let markPurgeStarted!: () => void;
    const purgeStarted = new Promise<void>((resolve) => {
      markPurgeStarted = resolve;
    });
    const purge = withAccountPurgeLock(USER, async () => {
      markPurgeStarted();
      await new Promise<void>((resolve) => {
        releasePurge = resolve;
      });
    });

    await purgeStarted;
    let reopened = false;
    const reauthentication = reopenAccountAfterSignIn(USER).then(() => {
      reopened = true;
    });
    await Promise.resolve();

    expect(reopened).toBe(false);
    expect(isAccountSignOutFenced(USER)).toBe(true);

    releasePurge();
    await Promise.all([purge, reauthentication]);
    expect(isAccountSignOutFenced(USER)).toBe(false);
  });
});
