"use client";

import { mediaTime, setMediaTime } from "./media-source";

import { RefObject, useCallback, useEffect, useRef, useState } from "react";

import type { PlayerChapter } from "@/domain/player";
import { CHAPTER_END_EPSILON_MS, selectCurrentChapter } from "@/lib/playback-core";

export type SleepMode =
  { kind: "time"; endsAt: number; minutes?: number } | { kind: "chapter" } | null;

import { pauseWithIntent } from "./pause-intent";

/** Sleep timer state machine: fixed durations plus stop-at-chapter-end. */
export function useSleepTimer(audioRef: RefObject<HTMLAudioElement | null>) {
  const [sleepMode, setSleepMode] = useState<SleepMode>(null);
  const sleepModeRef = useRef<SleepMode>(null);
  const timeoutRef = useRef<number | null>(null);
  const chapterEndRef = useRef<number | null>(null);

  const clearSleep = useCallback(() => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    chapterEndRef.current = null;
    sleepModeRef.current = null;
    setSleepMode(null);
  }, []);

  const setSleepMinutes = useCallback(
    (minutes: number) => {
      clearSleep();
      const mode = { kind: "time" as const, endsAt: Date.now() + minutes * 60_000, minutes };
      sleepModeRef.current = mode;
      setSleepMode(mode);
      timeoutRef.current = window.setTimeout(() => {
        clearSleep();
        if (audioRef.current) pauseWithIntent(audioRef.current);
      }, minutes * 60_000);
    },
    [audioRef, clearSleep],
  );

  const setSleepAtChapterEnd = useCallback(
    (positionMs: number, chapters: PlayerChapter[]) => {
      clearSleep();
      chapterEndRef.current = selectCurrentChapter(chapters, positionMs)?.endMs || null;
      if (chapterEndRef.current !== null) {
        sleepModeRef.current = { kind: "chapter" };
        setSleepMode(sleepModeRef.current);
      }
    },
    [clearSleep],
  );

  const clearChapterSleep = useCallback(() => {
    if (sleepModeRef.current?.kind === "chapter") clearSleep();
  }, [clearSleep]);

  const onSeek = useCallback(
    (positionMs: number, chapters: PlayerChapter[]) => {
      if (sleepModeRef.current?.kind !== "chapter") return;
      setSleepAtChapterEnd(positionMs, chapters);
    },
    [setSleepAtChapterEnd],
  );

  /** Called from the audio timeupdate loop; pauses exactly once at the boundary. */
  const onTimeUpdate = useCallback(
    (audio: HTMLAudioElement) => {
      const mode = sleepModeRef.current;
      if (mode?.kind === "time" && Date.now() >= mode.endsAt) {
        clearSleep();
        pauseWithIntent(audio);
      }
      if (mode?.kind !== "chapter") return;
      const positionMs = mediaTime(audio) * 1000;
      const targetEndMs = chapterEndRef.current;
      if (targetEndMs !== null && positionMs >= targetEndMs - CHAPTER_END_EPSILON_MS) {
        clearSleep();
        setMediaTime(audio, targetEndMs / 1000);
        pauseWithIntent(audio);
      }
    },
    [clearSleep],
  );

  useEffect(() => {
    const checkDeadline = () => {
      if (audioRef.current) onTimeUpdate(audioRef.current);
    };
    const checkVisible = () => {
      if (document.visibilityState === "visible") checkDeadline();
    };
    window.addEventListener("pageshow", checkDeadline);
    document.addEventListener("visibilitychange", checkVisible);
    return () => {
      window.removeEventListener("pageshow", checkDeadline);
      document.removeEventListener("visibilitychange", checkVisible);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, [audioRef, onTimeUpdate]);

  return {
    sleepMode,
    setSleepMinutes,
    setSleepAtChapterEnd,
    clearSleep,
    clearChapterSleep,
    onSeek,
    onTimeUpdate,
  };
}
