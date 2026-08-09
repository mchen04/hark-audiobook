import { PENDING_ACCOUNT_DELETION_KEY } from "@/lib/app-keys";

export type PendingAccountDeletion = {
  userId: string;
  deleteToken: string;
  phase: "prepared" | "purged" | "committed";
  createdAt: number;
};

const FENCE_CHANGED_EVENT = "chapterline:account-deletion-fence-changed";

/** The durable, origin-wide barrier installed before any account bytes are swept. */
export function readPendingAccountDeletion(): PendingAccountDeletion | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const parsed = JSON.parse(
      localStorage.getItem(PENDING_ACCOUNT_DELETION_KEY) || "null",
    ) as Partial<PendingAccountDeletion> | null;
    if (
      !parsed ||
      typeof parsed.userId !== "string" ||
      typeof parsed.deleteToken !== "string" ||
      (parsed.phase !== "prepared" && parsed.phase !== "purged" && parsed.phase !== "committed") ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }
    return parsed as PendingAccountDeletion;
  } catch {
    return null;
  }
}

export function writePendingAccountDeletion(pending: PendingAccountDeletion): void {
  localStorage.setItem(PENDING_ACCOUNT_DELETION_KEY, JSON.stringify(pending));
  notifyThisDocument();
}

export function clearPendingAccountDeletion(userId: string): void {
  if (readPendingAccountDeletion()?.userId !== userId) return;
  localStorage.removeItem(PENDING_ACCOUNT_DELETION_KEY);
  notifyThisDocument();
}

export function isAccountDeletionFenced(userId: string): boolean {
  return readPendingAccountDeletion()?.userId === userId;
}

export function assertAccountWritable(userId: string): void {
  if (isAccountDeletionFenced(userId)) {
    throw new Error(`Account deletion is in progress for ${userId}.`);
  }
}

/** Same-document custom event plus peer-document `storage` events. */
export function subscribeAccountDeletionFence(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === PENDING_ACCOUNT_DELETION_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(FENCE_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(FENCE_CHANGED_EVENT, onChange);
  };
}

function notifyThisDocument(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(FENCE_CHANGED_EVENT));
}
