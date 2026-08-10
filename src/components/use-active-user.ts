"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  readActiveUserId,
  rememberActiveUserId,
  serverUserNeedsBootstrap,
  subscribeActiveUser,
} from "@/lib/active-user";
import { readPendingAccountDeletion } from "@/lib/account-deletion-fence";

/**
 * The account this device is signed into.
 *
 * The server supplies it whenever it rendered the page. A warm launch is
 * served from Cache Storage and never reaches the server, so the device's own
 * `ACTIVE_USER_KEY` answers instead — and when there is no active user, the
 * only honest destination is `/login` (design contract section 8).
 */
export function useActiveUserId(serverUserId?: string): string | null {
  // `useSyncExternalStore` is what makes reading device storage safe under a
  // prerendered document: hydration uses the server's answer and the device's
  // answer arrives in the render straight after, with no markup mismatch.
  const stored = useSyncExternalStore(
    subscribeActiveUser,
    readActiveUserId,
    () => serverUserId ?? null,
  );
  // A live server render bootstraps an empty browser profile once. After that,
  // the device store is authoritative: keeping `serverUserId` as a permanent
  // fallback made a peer tab ignore sign-out forever.
  const needsBootstrap = !!serverUserId && serverUserNeedsBootstrap(serverUserId);
  const userId = needsBootstrap ? serverUserId : stored;

  useEffect(() => {
    if (!serverUserId || !serverUserNeedsBootstrap(serverUserId)) return;
    rememberActiveUserId(serverUserId);
  }, [serverUserId]);

  useEffect(() => {
    if (userId) return;
    // Deletion owns this transition. Sending the fenced document to /login
    // while its authenticated server render still exists can bounce it back to
    // /library and bootstrap the identity the fence is revoking.
    if (readPendingAccountDeletion()) return;
    // The hydration render always reports "no user" — it is the server's
    // answer, not the device's. Letting the task queue turn over first means
    // the device has answered before anyone is sent to the login page.
    const timer = window.setTimeout(() => window.location.replace("/login"), 0);
    return () => window.clearTimeout(timer);
  }, [userId]);

  return userId;
}
