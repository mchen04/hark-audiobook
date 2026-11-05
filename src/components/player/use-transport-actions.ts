"use client";

import { mediaTime, setMediaTime, loadMediaSource } from "./media-source";

import { RefObject, useMemo, useRef } from "react";

import type { PlaybackAction } from "@/domain/playback-history";
import type { PlayerBook, PlayerChapter } from "@/domain/player";
import type { PlaybackWriteSource } from "@/lib/playback-core";

import type { PlaybackTimeStore } from "./playback-time-store";

import { pauseWithIntent, APP_POSITION_EVENT } from "./pause-intent";
import { configurePlaybackAudioSession } from "./audio-session";

export function useTransportActions({
  audioRef,
  activeBookRef,
  suppressNextPauseRef,
  timeStore,
  persistProgress,
  saveDurableState,
  markPositionChanged,
  recordAction,
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  activeBookRef: RefObject<PlayerBook | null>;
  suppressNextPauseRef: RefObject<boolean>;
  timeStore: PlaybackTimeStore;
  persistProgress: (
    source: PlaybackWriteSource,
    positionMs: number,
    completed?: boolean,
    bookOverride?: PlayerBook,
  ) => Promise<void>;

  saveDurableState: (
    source: PlaybackWriteSource,
    positionMs?: number,
    completed?: boolean,
    bookOverride?: PlayerBook,
  ) => void;
  markPositionChanged: () => void;
  recordAction: (
    action: PlaybackAction,
    positionMs?: number,
    previousPositionMs?: number | null,
    description?: string | null,
  ) => void;
}) {
  const seekPersistTimerRef = useRef<number | null>(null);

  return useMemo(() => {
    const cancelSeekPersist = () => {
      if (seekPersistTimerRef.current !== null) {
        window.clearTimeout(seekPersistTimerRef.current);
        seekPersistTimerRef.current = null;
      }
    };

    const persistSeekSoon = () => {
      cancelSeekPersist();
      seekPersistTimerRef.current = window.setTimeout(() => {
        seekPersistTimerRef.current = null;
        const audio = audioRef.current;
        if (audio && activeBookRef.current) void persistProgress("seek", mediaTime(audio) * 1000);
      }, 800);
    };
    const seekWithAction = (
      positionMs: number,
      action: PlaybackAction,
      description: string | null = null,
    ) => {
      const audio = audioRef.current;
      const activeBook = activeBookRef.current;
      if (!audio || !activeBook) return;
      audio.dispatchEvent(new Event(APP_POSITION_EVENT));
      const bounded = Math.min(Math.max(positionMs, 0), activeBook.durationMs);
      const previousPositionMs = mediaTime(audio) * 1000;
      setMediaTime(audio, bounded / 1000);

      const settledMs = settledPositionMs(audio, bounded);
      timeStore.write(settledMs);

      markPositionChanged();
      saveDurableState("seek", settledMs);
      persistSeekSoon();
      recordAction(action, settledMs, previousPositionMs, description);
    };

    const play = () => {
      const audio = audioRef.current;
      const book = activeBookRef.current;
      if (!audio || !book) return;
      configurePlaybackAudioSession();
      let position = timeStore.read() / 1000;
      if (Number.isFinite(audio.duration) && audio.duration - position < 1) {
        position = 0;
        timeStore.write(0);
      }
      const source = audio.getAttribute("src");
      if (audio.error || audio.networkState === audio.NETWORK_EMPTY || !source) {
        const rate = audio.playbackRate;
        loadMediaSource(audio, book.mediaUrl, position);
        audio.playbackRate = rate;
      } else if (Math.abs(mediaTime(audio) - position) > 0.25) {
        setMediaTime(audio, position);
      }
      const sourceAtPlay = audio.src;
      audio
        .play()
        .then(() => {
          if (
            audioRef.current !== audio ||
            activeBookRef.current !== book ||
            audio.src !== sourceAtPlay
          )
            return;
          const intended = timeStore.read() / 1000;
          if (audio.ended || (audio.currentTime < 0.25 && intended > 0.5)) {
            setMediaTime(audio, intended);
          }
        })
        .catch(() => undefined);
    };

    return {
      cancelSeekPersist,
      actions: {
        play,
        toggle() {
          const audio = audioRef.current;
          if (!audio) return;
          if (audio.paused) play();
          else pauseWithIntent(audio);
        },
        pause() {
          if (audioRef.current) pauseWithIntent(audioRef.current);
        },
        seek(positionMs: number) {
          seekWithAction(positionMs, "seek");
        },
        restoreHistoryPosition(positionMs: number) {
          seekWithAction(positionMs, "history_restore");
        },
        moveToChapter(chapter: PlayerChapter, direction: "previous" | "next") {
          seekWithAction(
            chapter.startMs,
            direction === "previous" ? "previous_chapter" : "next_chapter",
            chapter.title,
          );
        },
        skip(deltaMs: number) {
          seekWithAction(
            mediaTime(audioRef.current) * 1000 + deltaMs,
            deltaMs < 0 ? "skip_back" : "skip_forward",
            `${Math.round(Math.abs(deltaMs) / 1000)} seconds`,
          );
        },
        markFinished() {
          const audio = audioRef.current;
          const activeBook = activeBookRef.current;
          if (!audio || !activeBook) return;
          cancelSeekPersist();
          if (!audio.paused) suppressNextPauseRef.current = true;
          pauseWithIntent(audio);
          setMediaTime(audio, activeBook.durationMs / 1000);
          timeStore.write(activeBook.durationMs);
          markPositionChanged();
          void persistProgress("ended", activeBook.durationMs, true);
          recordAction("finished", activeBook.durationMs);
        },
        restart() {
          const audio = audioRef.current;
          if (!audio || !activeBookRef.current) return;
          cancelSeekPersist();
          const previousPositionMs = mediaTime(audio) * 1000;
          audio.dispatchEvent(new Event(APP_POSITION_EVENT));
          setMediaTime(audio, 0);
          timeStore.write(0);
          markPositionChanged();
          void persistProgress("seek", 0, false);
          recordAction("restarted", 0, previousPositionMs);
        },
      },
    };
  }, [
    activeBookRef,
    audioRef,
    markPositionChanged,
    persistProgress,
    recordAction,
    saveDurableState,
    suppressNextPauseRef,
    timeStore,
  ]);
}

function settledPositionMs(audio: HTMLAudioElement, requestedMs: number): number {
  if (audio.readyState < audio.HAVE_METADATA) return requestedMs;
  const settled = mediaTime(audio) * 1000;
  return Number.isFinite(settled) && settled >= 0 ? settled : requestedMs;
}
