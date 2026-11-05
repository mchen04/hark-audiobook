"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useOpenLocalLibrary } from "@/components/app-navigation";
import { UNLOAD_PLAYER_EVENT, type UnloadPlayerDetail } from "@/lib/app-keys";
import { replayQueuedMutations } from "@/lib/offline-sync";
import { removeOfflineBook } from "@/lib/offline/deletion-journal";
import { commitBookDeletion } from "@/lib/offline/outbox";
import { clearLocalPlaybackState } from "@/lib/playback-core";
import { getDeviceId } from "@/lib/device-id";

export function useDeleteBook(
  userId: string,
  bookId: string,
  onError: (message: string) => void,
  mediaFingerprint?: string | null,
  mediaRenditionKey?: string | null,
) {
  const router = useRouter();
  const openLocalLibrary = useOpenLocalLibrary();
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function deleteBook() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setDeleting(true);
    try {
      await commitBookDeletion(
        { userId, deviceId: getDeviceId() },
        bookId,
        mediaFingerprint,
        mediaRenditionKey,
      );
    } catch {
      setDeleting(false);
      setConfirming(false);
      onError("This device could not record the deletion. Try again.");
      return;
    }
    window.dispatchEvent(
      new CustomEvent<UnloadPlayerDetail>(UNLOAD_PLAYER_EVENT, { detail: { userId, bookId } }),
    );
    clearLocalPlaybackState(userId, bookId);
    await removeOfflineBook(userId, bookId, { clearPlaybackHistory: true }).catch(() => {
      onError("The book was deleted, but device cleanup will retry automatically.");
    });
    void replayQueuedMutations(userId).catch(() => undefined);
    if (openLocalLibrary) openLocalLibrary();
    else router.push("/library");
  }

  return {
    deleteBook,
    deleting,
    deleteLabel: deleting
      ? "Deleting"
      : confirming
        ? "Tap again to permanently delete"
        : "Delete this book",
  };
}
