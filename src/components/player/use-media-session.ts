"use client";

import { mediaTime } from "./media-source";

import { RefObject, useEffect } from "react";

import type { PlayerBook } from "@/domain/player";
import type { PlayerPreferences } from "@/domain/preferences";

import { pauseWithIntent } from "./pause-intent";

/**
 * System media controls, feature-detected. A missing or partial Media Session
 * implementation never affects playback.
 */
export function useMediaSession(controls: {
  audioRef: RefObject<HTMLAudioElement | null>;
  book: PlayerBook | null;
  preferencesRef: RefObject<PlayerPreferences>;
  play: () => void;
  seek: (positionMs: number) => void;
  skip: (deltaMs: number) => void;
}) {
  const { audioRef, book, preferencesRef, play, seek, skip } = controls;

  useEffect(() => {
    const audio = audioRef.current;
    if (!("mediaSession" in navigator) || !audio || !book) return;
    const positionKey = { current: "" };
    const syncPosition = () => syncMediaSessionPosition(audio, book.durationMs, positionKey);
    const refresh = () => {
      positionKey.current = "";
      setMediaSessionPlaybackState(
        audio.paused || audio.ended || audio.error ? "paused" : "playing",
      );
      syncPosition();
    };
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", play],
      [
        "pause",
        () => {
          if (audioRef.current) pauseWithIntent(audioRef.current);
        },
      ],
      [
        "stop",
        () => {
          if (audioRef.current) pauseWithIntent(audioRef.current);
        },
      ],
      [
        "seekbackward",
        (details) =>
          skip(
            details.seekOffset ? -details.seekOffset * 1000 : -preferencesRef.current.skipBackMs,
          ),
      ],
      [
        "seekforward",
        (details) =>
          skip(
            details.seekOffset ? details.seekOffset * 1000 : preferencesRef.current.skipForwardMs,
          ),
      ],
      ["seekto", (details) => details.seekTime !== undefined && seek(details.seekTime * 1000)],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Unsupported actions are optional progressive enhancements.
      }
    }
    const events = [
      "loadedmetadata",
      "durationchange",
      "play",
      "pause",
      "seeked",
      "ratechange",
      "ended",
    ];
    for (const event of events) audio.addEventListener(event, refresh);
    audio.addEventListener("timeupdate", syncPosition);
    const refreshVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refreshVisible);
    setMediaSessionMetadata(book);
    refresh();
    return () => {
      for (const event of events) audio.removeEventListener(event, refresh);
      audio.removeEventListener("timeupdate", syncPosition);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refreshVisible);
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore unsupported action cleanup.
        }
      }
      navigator.mediaSession.metadata = null;
      setMediaSessionPlaybackState("none");
      try {
        navigator.mediaSession.setPositionState();
      } catch {
        return;
      }
    };
  }, [audioRef, book, play, preferencesRef, seek, skip]);
}

export function setMediaSessionMetadata(book: PlayerBook): void {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: book.title,
    artist: book.author,
    album: "Hark",
    artwork: book.coverUrl
      ? [{ src: book.coverUrl }]
      : [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
  });
}

export function setMediaSessionPlaybackState(state: MediaSessionPlaybackState): void {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state;
}

// OS media UIs sample position coarsely; syncing once per whole second (or
// on rate/book change) avoids thousands of redundant calls per listening
// hour. The dedup key lives in a provider-owned ref so it cannot leak across
// provider remounts.
export function syncMediaSessionPosition(
  audio: HTMLAudioElement,
  durationMs: number,
  lastSyncKeyRef: { current: string },
): void {
  if (!("mediaSession" in navigator)) return;
  const duration =
    Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : durationMs / 1000;
  const syncKey = `${duration}:${Math.floor(mediaTime(audio))}:${audio.playbackRate}`;
  if (syncKey === lastSyncKeyRef.current) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: Math.max(duration, 0.001),
      playbackRate: audio.playbackRate,
      position: Math.max(0, Math.min(mediaTime(audio), duration)),
    });
    lastSyncKeyRef.current = syncKey;
  } catch {
    // Some browsers expose Media Session without complete position support.
  }
}
