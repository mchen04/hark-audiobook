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

  expect(account.purge).toHaveBeenCalledTimes(2);
  expect(account.purge).toHaveBeenCalledWith("user-a");
  expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(account.forget).toHaveBeenCalledWith("user-a");
  expect(localStorage.getItem(PENDING_ACCOUNT_DELETION_KEY)).toBe(null);
});

it("sweeps again after commit so a writer in the commit gap cannot survive deletion", async () => {
  const positionKey = "chapterline:position:user-a:book-a";
  const sweep = async () => {
    localStorage.removeItem(positionKey);
    return undefined;
  };
  account.purge.mockImplementation(sweep);
  rememberPendingAccountDeletion("user-a", "token-a-with-enough-entropy-123456789");
  const fetchFn = vi.fn<typeof fetch>(async () => {
    // The real failure was the playing provider's cadence (and, in a peer tab,
    // a completed pull) writing after the first sweep but before commit.
    localStorage.setItem(positionKey, JSON.stringify({ positionMs: 4_321 }));
    return Response.json({ deleted: true });
  });

  await expect(finishPendingAccountDeletion(fetchFn)).resolves.toStrictEqual({ ok: true });

  expect(account.purge).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem(positionKey)).toBeNull();
  expect(localStorage.getItem(PENDING_ACCOUNT_DELETION_KEY)).toBeNull();
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
  expect(account.purge, "a post-commit sweep must close the writer gap").toHaveBeenCalledOnce();
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

it("keeps the fence recoverable when the server intent expired", async () => {
  rememberPendingAccountDeletion("user-a", "token-a-with-enough-entropy-123456789");
  const fetchFn = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ error: "expired" }, { status: 410 }));

  await expect(finishPendingAccountDeletion(fetchFn)).resolves.toStrictEqual({
    ok: false,
    phase: "expired",
  });
  expect(JSON.parse(localStorage.getItem(PENDING_ACCOUNT_DELETION_KEY) || "null").phase).toBe(
    "purged",
  );
});
