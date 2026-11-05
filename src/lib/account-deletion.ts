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
  writePendingAccountDeletion(pending);
  forgetActiveUserId(userId);
}

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
    await purgeAccount(pending.userId);
  } catch {
    return { ok: false, phase: "final-purge" };
  }
  clearPendingAccountDeletion(pending.userId);
  return { ok: true };
}

export function abandonExpiredAccountDeletion(): void {
  const pending = readPendingAccountDeletion();
  if (!pending) return;
  clearPendingAccountDeletion(pending.userId);
}
