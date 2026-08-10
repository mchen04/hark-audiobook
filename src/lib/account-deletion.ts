"use client";

import { forgetActiveUserId } from "@/lib/active-user";
import {
  clearPendingAccountDeletion,
  readPendingAccountDeletion,
  type PendingAccountDeletion,
  writePendingAccountDeletion,
} from "@/lib/account-deletion-fence";
import { purgeAccount } from "@/lib/offline/account-purge";

export type AccountDeletionResult =
  { ok: true } | { ok: false; phase: "purge" | "commit" | "expired" | "final-purge" };

let activeFinish: Promise<AccountDeletionResult | null> | null = null;

export function rememberPendingAccountDeletion(userId: string, deleteToken: string): void {
  const pending: PendingAccountDeletion = {
    userId,
    deleteToken,
    phase: "prepared",
    createdAt: Date.now(),
  };
  // The fence is durable before the active identity is revoked. Peer tabs see
  // the storage mutation and this tab sees the custom event, so every mounted
  // provider tears down while the journal still names what must be swept.
  writePendingAccountDeletion(pending);
  forgetActiveUserId(userId);
}

/** Purge, idempotently commit, then purge again; every phase survives a crash. */
export function finishPendingAccountDeletion(
  fetchFn: typeof fetch = fetch,
): Promise<AccountDeletionResult | null> {
  if (activeFinish) return activeFinish;
  activeFinish = finishPendingAccountDeletionOnce(fetchFn).finally(() => {
    activeFinish = null;
  });
  return activeFinish;
}

async function finishPendingAccountDeletionOnce(
  fetchFn: typeof fetch,
): Promise<AccountDeletionResult | null> {
  const pending = readPendingAccountDeletion();
  if (!pending) return null;
  if (pending.phase === "prepared") {
    try {
      await purgeAccount(pending.userId);
    } catch {
      return { ok: false, phase: "purge" };
    }
    pending.phase = "purged";
    writePendingAccountDeletion(pending);
  }

  if (pending.phase === "purged") {
    // A successful first commit can lose its response after the transaction
    // landed. The server keeps a short-lived receipt, so retrying is safe.
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
      if (response.status === 410) return { ok: false, phase: "expired" };
      if (!response.ok) return { ok: false, phase: "commit" };
      pending.phase = "committed";
      writePendingAccountDeletion(pending);
      break;
    }
    if (pending.phase !== "committed") return { ok: false, phase: "commit" };
  }

  try {
    // The fence remains installed through this sweep. Cadence writes are
    // refused synchronously, and in-flight pulls abort before they commit.
    await purgeAccount(pending.userId);
  } catch {
    // `committed` is durable, so a restart retries only local cleanup even if
    // the server-side deletion receipt has expired by then.
    return { ok: false, phase: "final-purge" };
  }
  clearPendingAccountDeletion(pending.userId);
  return { ok: true };
}

/** Leaves an expired intent safely; the server session decides the next screen. */
export function abandonExpiredAccountDeletion(): void {
  const pending = readPendingAccountDeletion();
  if (!pending) return;
  clearPendingAccountDeletion(pending.userId);
}
