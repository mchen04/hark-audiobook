"use client";

import { mediaTime } from "./media-source";

import { RefObject, useEffect, useRef, useState } from "react";

import type { PlayerBook } from "@/domain/player";
import { replayQueuedMutations } from "@/lib/offline-sync";
import type { PlaybackWriteSource } from "@/lib/playback-core";

import { createProgressPersister, type ProgressPersister } from "./progress-persister";

export function useProgressPersistence(
  userId: string,
  audioRef: RefObject<HTMLAudioElement | null>,
  activeBookRef: RefObject<PlayerBook | null>,
): ProgressPersister {
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  // eslint-disable-next-line react-hooks/refs
  const [persister] = useState(() =>
    createProgressPersister({
      getUserId: () => userIdRef.current,
      getAudio: () => audioRef.current,
      getActiveBook: () => activeBookRef.current,
    }),
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const start = persister.startCadence;
    const stop = persister.stopCadence;
    audio.addEventListener("play", start);
    audio.addEventListener("pause", stop);
    audio.addEventListener("ended", stop);
    if (!audio.paused) start();
    return () => {
      stop();
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", stop);
      audio.removeEventListener("ended", stop);
    };
  }, [audioRef, persister]);

  useEffect(() => {
    const flush = (source: PlaybackWriteSource) => {
      const audio = audioRef.current;
      if (!audio || !activeBookRef.current) return;
      void persister.persistProgress(source, mediaTime(audio) * 1000);
    };
    const flushIfHiding = () => {
      if (document.visibilityState !== "hidden") return;
      flush("visibility-flush");
    };
    const flushOnPagehide = () => flush("pagehide-flush");
    document.addEventListener("visibilitychange", flushIfHiding);
    window.addEventListener("pagehide", flushOnPagehide);
    const replay = () => void replayQueuedMutations(userId);
    if (navigator.onLine) replay();
    window.addEventListener("online", replay);
    return () => {
      document.removeEventListener("visibilitychange", flushIfHiding);
      window.removeEventListener("pagehide", flushOnPagehide);
      window.removeEventListener("online", replay);
    };
  }, [activeBookRef, audioRef, persister, userId]);

  return persister;
}
