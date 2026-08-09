// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from "vitest";

import { PENDING_ACCOUNT_DELETION_KEY } from "@/lib/app-keys";

import { finishPendingAccountDeletion, rememberPendingAccountDeletion } from "./account-deletion";

const account = vi.hoisted(() => ({
  purge: vi.fn(async () => undefined),
  forget: vi.fn(),
}));

vi.mock("@/lib/offline/account-purge", () => ({ purgeAccount: account.purge }));
vi.mock("@/lib/active-user", () => ({ forgetActiveUserId: account.forget }));

beforeEach(() => {
  localStorage.clear();
  account.purge.mockReset();
  account.purge.mockResolvedValue(undefined);
  account.forget.mockClear();
});

it("retries an idempotent commit when the successful response is lost", async () => {
  rememberPendingAccountDeletion("user-a", "token-a-with-enough-entropy-123456789");
  const fetchFn = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValueOnce(Response.json({ deleted: true }));

  await expect(finishPendingAccountDeletion(fetchFn)).resolves.toStrictEqual({ ok: true });

  expect(account.purge).toHaveBeenCalledWith("user-a", { revokeActiveUser: false });
  expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(account.forget).toHaveBeenCalledWith("user-a");
  expect(localStorage.getItem(PENDING_ACCOUNT_DELETION_KEY)).toBe(null);
});

it("resumes at commit after a crash instead of deleting the server first", async () => {
  rememberPendingAccountDeletion("user-a", "token-a-with-enough-entropy-123456789");
  const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));

  await expect(finishPendingAccountDeletion(offline)).resolves.toStrictEqual({
    ok: false,
    phase: "commit",
  });
  expect(JSON.parse(localStorage.getItem(PENDING_ACCOUNT_DELETION_KEY) || "null").phase).toBe(
    "purged",
  );

  account.purge.mockClear();
  const online = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ deleted: true }));
  await expect(finishPendingAccountDeletion(online)).resolves.toStrictEqual({ ok: true });
  expect(account.purge, "the already-completed local purge ran twice").not.toHaveBeenCalled();
});

it("never commits while the local purge is incomplete", async () => {
  rememberPendingAccountDeletion("user-a", "token-a-with-enough-entropy-123456789");
  account.purge.mockRejectedValueOnce(new Error("storage unavailable"));
  const fetchFn = vi.fn<typeof fetch>();

  await expect(finishPendingAccountDeletion(fetchFn)).resolves.toStrictEqual({
    ok: false,
    phase: "purge",
  });
  expect(fetchFn).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(PENDING_ACCOUNT_DELETION_KEY) || "null").phase).toBe(
    "prepared",
  );
});
