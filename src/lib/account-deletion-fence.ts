import { ACCOUNT_SIGN_OUT_FENCE_KEY, PENDING_ACCOUNT_DELETION_KEY } from "@/lib/app-keys";
import { withKeyedLock } from "@/lib/keyed-lock";

export type PendingAccountDeletion = {
  userId: string;
  deleteToken: string;
  phase: "prepared" | "purged" | "committed";
  createdAt: number;
};

const DELETION_FENCE_CHANGED_EVENT = "chapterline:account-deletion-fence-changed";
const WRITE_FENCE_CHANGED_EVENT = "chapterline:account-write-fence-changed";
const SIGN_OUT_FENCE_MAX_AGE_MS = 2 * 60_000;

type PendingAccountSignOutFence = {
  userId: string;
  phase: "pending";
  createdAt: number;
};

type AccountSignOutFence = PendingAccountSignOutFence | { phase: "committed" };

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
  notifyDeletionFenceChange();
}

export function clearPendingAccountDeletion(userId: string): void {
  if (readPendingAccountDeletion()?.userId !== userId) return;
  localStorage.removeItem(PENDING_ACCOUNT_DELETION_KEY);
  notifyDeletionFenceChange();
}

export function isAccountDeletionFenced(userId: string): boolean {
  return readPendingAccountDeletion()?.userId === userId;
}

function readStoredAccountSignOutFence(): AccountSignOutFence | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(ACCOUNT_SIGN_OUT_FENCE_KEY) || "null") as {
      userId?: unknown;
      phase?: unknown;
      createdAt?: unknown;
    } | null;
    if (!parsed) return null;
    if (parsed.phase === "committed") return { phase: "committed" };
    // Records written before phases existed were unconfirmed request fences.
    if (
      (parsed.phase === undefined || parsed.phase === "pending") &&
      typeof parsed.userId === "string" &&
      typeof parsed.createdAt === "number"
    ) {
      return { userId: parsed.userId, phase: "pending", createdAt: parsed.createdAt };
    }
    return null;
  } catch {
    return null;
  }
}

function readAccountSignOutFence(): AccountSignOutFence | null {
  const fence = readStoredAccountSignOutFence();
  if (fence?.phase === "pending" && Date.now() - fence.createdAt > SIGN_OUT_FENCE_MAX_AGE_MS) {
    return null;
  }
  return fence;
}

/** A request fence may age out if the initiating document dies before auth answers. */
export function installAccountSignOutFence(userId: string): void {
  if (typeof localStorage === "undefined") return;
  const current = readStoredAccountSignOutFence();
  if (current?.phase === "committed") return;
  localStorage.setItem(
    ACCOUNT_SIGN_OUT_FENCE_KEY,
    JSON.stringify({ userId, phase: "pending", createdAt: Date.now() }),
  );
  notifyWriteFenceChange();
}

/** A confirmed account boundary stays closed until a later sign-in. */
export function commitAccountSignOutFence(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(ACCOUNT_SIGN_OUT_FENCE_KEY, JSON.stringify({ phase: "committed" }));
  notifyWriteFenceChange();
}

export function clearAccountSignOutFence(userId: string): void {
  const current = readStoredAccountSignOutFence();
  if (current?.phase !== "pending" || current.userId !== userId) return;
  localStorage.removeItem(ACCOUNT_SIGN_OUT_FENCE_KEY);
  notifyWriteFenceChange();
}

export function isAccountSignOutFenced(userId: string): boolean {
  const fence = readAccountSignOutFence();
  return fence?.phase === "committed" || fence?.userId === userId;
}

export function isAccountWriteFenced(userId: string): boolean {
  return isAccountDeletionFenced(userId) || isAccountSignOutFenced(userId);
}

export function assertAccountWritable(userId: string): void {
  if (isAccountDeletionFenced(userId)) {
    throw new Error(`Account deletion is in progress for ${userId}.`);
  }
  if (isAccountSignOutFenced(userId))
    throw new Error(`Account sign-out is in progress for ${userId}.`);
}

export type AccountWriteScope = {
  signal: AbortSignal;
  release: () => void;
};

/** Cancels long work in this document when any tab fences the account. */
export function createAccountWriteScope(
  userId: string,
  externalSignal?: AbortSignal,
): AccountWriteScope {
  assertAccountWritable(userId);
  const controller = new AbortController();
  const abortForFence = () => {
    if (isAccountWriteFenced(userId) && !controller.signal.aborted) {
      controller.abort(new DOMException("The account is no longer writable.", "AbortError"));
    }
  };
  const abortForCaller = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason);
  };
  const unsubscribe = subscribeAccountWriteFence(abortForFence);
  externalSignal?.addEventListener("abort", abortForCaller, { once: true });
  if (externalSignal?.aborted) abortForCaller();
  abortForFence();
  return {
    signal: controller.signal,
    release: () => {
      unsubscribe();
      externalSignal?.removeEventListener("abort", abortForCaller);
    },
  };
}

const accountLockName = (userId: string) => `chapterline-account-write:${userId}`;
const ACCOUNT_PURGE_LOCK_NAME = "chapterline-account-purge";

declare const accountWriteSlotBrand: unique symbol;
export type AccountWriteSlot = {
  readonly userId: string;
  readonly [accountWriteSlotBrand]: true;
};
const heldAccountWriteSlots = new WeakSet<AccountWriteSlot>();

/** One account-wide critical section shared by imports in every tab. */
export async function withAccountWriteLock<T>(
  userId: string,
  operation: (slot: AccountWriteSlot) => Promise<T>,
): Promise<T> {
  // Check both when the write asks to queue and when it eventually acquires
  // the lock. A stale tab must not park work behind purge and have a later
  // sign-in accidentally authorize it.
  assertAccountWritable(userId);
  return await withKeyedLock(accountLockName(userId), async () => {
    assertAccountWritable(userId);
    const slot = { userId } as AccountWriteSlot;
    heldAccountWriteSlots.add(slot);
    try {
      return await operation(slot);
    } finally {
      heldAccountWriteSlots.delete(slot);
    }
  });
}

/** Runtime proof that a caller is inside this account's current write lock. */
export function holdsAccountWriteSlot(
  slot: AccountWriteSlot | undefined,
  userId: string,
): slot is AccountWriteSlot {
  return Boolean(slot && slot.userId === userId && heldAccountWriteSlots.has(slot));
}

/** Purge uses the same lock after installing the fence and cancelling writers. */
export function withAccountPurgeLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  // Commit before waiting for the lock. A cancelled writer may itself be
  // wedged, but that must never let this barrier expire while purge queues.
  commitAccountSignOutFence();
  return withKeyedLock(ACCOUNT_PURGE_LOCK_NAME, () => {
    // Close it again while owning the global lock: another document can race
    // between the storage write above and this Web Lock request.
    commitAccountSignOutFence();
    return withKeyedLock(accountLockName(userId), operation);
  });
}

/** Reauthentication waits for any older purge before reopening this account. */
export function reopenAccountAfterSignIn(userId: string): Promise<void> {
  return withKeyedLock(ACCOUNT_PURGE_LOCK_NAME, async () => {
    const current = readStoredAccountSignOutFence();
    if (
      !current ||
      (current.phase === "pending" && current.userId !== userId) ||
      typeof localStorage === "undefined"
    ) {
      return;
    }
    localStorage.removeItem(ACCOUNT_SIGN_OUT_FENCE_KEY);
    notifyWriteFenceChange();
  });
}

/** Same-document custom event plus peer-document `storage` events. */
export function subscribeAccountDeletionFence(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === PENDING_ACCOUNT_DELETION_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(DELETION_FENCE_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(DELETION_FENCE_CHANGED_EVENT, onChange);
  };
}

export function subscribeAccountWriteFence(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === PENDING_ACCOUNT_DELETION_KEY ||
      event.key === ACCOUNT_SIGN_OUT_FENCE_KEY ||
      event.key === null
    ) {
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(WRITE_FENCE_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(WRITE_FENCE_CHANGED_EVENT, onChange);
  };
}

function notifyDeletionFenceChange(): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new Event(DELETION_FENCE_CHANGED_EVENT));
  window.dispatchEvent(new Event(WRITE_FENCE_CHANGED_EVENT));
}

function notifyWriteFenceChange(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(WRITE_FENCE_CHANGED_EVENT));
  }
}
