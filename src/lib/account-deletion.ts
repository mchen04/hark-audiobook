"use client";

import { PENDING_ACCOUNT_DELETION_KEY } from "@/lib/app-keys";
import { forgetActiveUserId } from "@/lib/active-user";
import { purgeAccount } from "@/lib/offline/account-purge";

type PendingDeletion = {
  userId: string;
  deleteToken: string;
  phase: "prepared" | "purged";
  createdAt: number;
};

export type AccountDeletionResult = { ok: true } | { ok: false; phase: "purge" | "commit" };

export function rememberPendingAccountDeletion(userId: string, deleteToken: string): void {
  const pending: PendingDeletion = {
    userId,
    deleteToken,
    phase: "prepared",
    createdAt: Date.now(),
  };
  localStorage.setItem(PENDING_ACCOUNT_DELETION_KEY, JSON.stringify(pending));
}

/** Purge first, then idempotently commit; every phase survives a tab crash. */
export async function finishPendingAccountDeletion(
  fetchFn: typeof fetch = fetch,
): Promise<AccountDeletionResult | null> {
  const pending = readPendingDeletion();
  if (!pending) return null;
  if (pending.phase === "prepared") {
    try {
      await purgeAccount(pending.userId, { revokeActiveUser: false });
    } catch {
      return { ok: false, phase: "purge" };
    }
    pending.phase = "purged";
    localStorage.setItem(PENDING_ACCOUNT_DELETION_KEY, JSON.stringify(pending));
  }

  // A successful first commit can lose its response after the transaction has
  // landed. The server keeps the consumed token as a short-lived "deleted"
  // receipt, so the second request receives the same successful answer.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchFn("/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phase: "commit",
        userId: pending.userId,
        deleteToken: pending.deleteToken,
      }),
    }).catch(() => null);
    if (!response) continue;
    if (!response.ok) return { ok: false, phase: "commit" };
    localStorage.removeItem(PENDING_ACCOUNT_DELETION_KEY);
    forgetActiveUserId(pending.userId);
    return { ok: true };
  }
  return { ok: false, phase: "commit" };
}

function readPendingDeletion(): PendingDeletion | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const parsed = JSON.parse(
      localStorage.getItem(PENDING_ACCOUNT_DELETION_KEY) || "null",
    ) as Partial<PendingDeletion> | null;
    if (
      !parsed ||
      typeof parsed.userId !== "string" ||
      typeof parsed.deleteToken !== "string" ||
      (parsed.phase !== "prepared" && parsed.phase !== "purged") ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }
    return parsed as PendingDeletion;
  } catch {
    return null;
  }
}
