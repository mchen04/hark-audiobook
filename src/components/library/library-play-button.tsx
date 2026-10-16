"use client";

import { Pause, Play } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";

import { usePlayback } from "@/components/player/playback-provider";
import type { OfflineBook } from "@/lib/offline/db";
import { asOfflinePlayerBook } from "@/lib/offline/library";
import {
  detectSuspendedSession,
  readDismissedSuspensionGap,
  readLocalProgress,
} from "@/lib/playback-core";

export function LibraryPlayButton({
  record,
  title,
  resume = false,
}: {
  record: OfflineBook;
  title: string;
  resume?: boolean;
}) {
  const playback = usePlayback();
  const router = useRouter();
  const book = asOfflinePlayerBook(record);
  const playing = playback.book?.id === book.id && playback.isPlaying;

  function activate() {
    const gap = detectSuspendedSession({
      record: readLocalProgress(playback.userId, book.id),
      durationMs: book.durationMs,
    });
    if (gap && readDismissedSuspensionGap(playback.userId, book.id) !== gap.writtenAt) {
      router.push(`/books/${book.id}`);
      return;
    }
    if (playing) playback.toggle();
    else playback.loadBook(book, true);
  }

  return (
    <button
      type="button"
      className={resume ? "continue-play" : "book-play-button"}
      aria-label={`${playing ? "Pause" : resume ? "Resume" : "Play"} ${title}`}
      onClick={activate}
    >
      {playing ? (
        <Pause size={resume ? 24 : 19} weight="fill" aria-hidden="true" />
      ) : (
        <Play size={resume ? 24 : 19} weight="fill" aria-hidden="true" />
      )}
    </button>
  );
}
