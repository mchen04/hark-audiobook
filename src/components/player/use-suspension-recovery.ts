"use client";

import { useCallback, useEffect, useState } from "react";

import {
  detectSuspendedSession,
  dismissSuspensionGap,
  readDismissedSuspensionGap,
  readLocalProgress,
  type SuspendedSession,
} from "@/lib/playback-core";

export function useSuspensionRecovery({
  userId,
  bookId,
  durationMs,
}: {
  userId: string;
  bookId: string;
  durationMs: number;
}): { gap: SuspendedSession | null; dismiss: () => void } {
  const [gap, setGap] = useState<SuspendedSession | null>(null);

  useEffect(() => {
    const detected = detectSuspendedSession({
      record: readLocalProgress(userId, bookId),
      durationMs,
    });
    const answered =
      detected !== null && readDismissedSuspensionGap(userId, bookId) === detected.writtenAt;
    const next = answered ? null : detected;
    let live = true;
    queueMicrotask(() => {
      if (live) setGap(next);
    });
    return () => {
      live = false;
    };
  }, [bookId, durationMs, userId]);

  const dismiss = useCallback(() => {
    if (gap) dismissSuspensionGap(userId, bookId, gap.writtenAt);
    setGap(null);
  }, [bookId, gap, userId]);

  return { gap, dismiss };
}
