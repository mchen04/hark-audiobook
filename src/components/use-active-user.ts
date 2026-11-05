"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  readActiveUserId,
  rememberActiveUserId,
  serverUserNeedsBootstrap,
  subscribeActiveUser,
} from "@/lib/active-user";
import { readPendingAccountDeletion } from "@/lib/account-deletion-fence";

export function useActiveUserId(serverUserId?: string): string | null {
  const stored = useSyncExternalStore(
    subscribeActiveUser,
    readActiveUserId,
    () => serverUserId ?? null,
  );
  const needsBootstrap = !!serverUserId && serverUserNeedsBootstrap(serverUserId);
  const userId = needsBootstrap ? serverUserId : stored;

  useEffect(() => {
    if (!serverUserId || !serverUserNeedsBootstrap(serverUserId)) return;
    rememberActiveUserId(serverUserId);
  }, [serverUserId]);

  useEffect(() => {
    if (userId) return;
    if (readPendingAccountDeletion()) return;
    const timer = window.setTimeout(() => window.location.replace("/login"), 0);
    return () => window.clearTimeout(timer);
  }, [userId]);

  return userId;
}
