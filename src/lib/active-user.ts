import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import {
  isAccountDeletionFenced,
  subscribeAccountDeletionFence,
} from "@/lib/account-deletion-fence";

const ACTIVE_USER_CHANGED_EVENT = "chapterline:active-user-changed";
let bootstrappedServerUserId: string | null = null;

export function readActiveUserId(): string | null {
  if (typeof localStorage === "undefined") return null;
  const userId = localStorage.getItem(ACTIVE_USER_KEY);
  return userId && !isAccountDeletionFenced(userId) ? userId : null;
}

export function subscribeActiveUser(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACTIVE_USER_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(ACTIVE_USER_CHANGED_EVENT, onChange);
  const unsubscribeFence = subscribeAccountDeletionFence(onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(ACTIVE_USER_CHANGED_EVENT, onChange);
    unsubscribeFence();
  };
}

export function rememberActiveUserId(userId: string): void {
  if (isAccountDeletionFenced(userId)) return;
  bootstrappedServerUserId = userId;
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(ACTIVE_USER_KEY, userId);
  notifyThisDocument();
}

export function serverUserNeedsBootstrap(userId: string): boolean {
  return !isAccountDeletionFenced(userId) && bootstrappedServerUserId !== userId;
}

export function forgetActiveUserId(userId: string): void {
  if (typeof localStorage === "undefined") return;
  if (localStorage.getItem(ACTIVE_USER_KEY) !== userId) return;
  localStorage.removeItem(ACTIVE_USER_KEY);
  notifyThisDocument();
}

function notifyThisDocument(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ACTIVE_USER_CHANGED_EVENT));
}
