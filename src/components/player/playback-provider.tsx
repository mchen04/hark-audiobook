"use client";

import { mediaTime, setMediaTime, loadMediaSource, clearMediaSeek } from "./media-source";

import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { PlaybackHistoryEntry, PlaybackHistorySnapshot } from "@/domain/playback-history";
import type { PlayerBook, PlayerChapter } from "@/domain/player";
import { rememberActiveUserId } from "@/lib/active-user";
import {
  PROGRESS_CONFLICT_EVENT,
  UNLOAD_PLAYER_EVENT,
  type UnloadPlayerDetail,
} from "@/lib/app-keys";
import { createListeningTracker, queueListeningSession } from "@/lib/listening-tracker";
import { bootstrapPlaybackState, markPausedNow, readMsSinceLastPause } from "@/lib/playback-core";
import { resolveStartPosition, rewindForAbsence, selectCurrentChapter } from "@/domain/player";

import { readAudioSession } from "./audio-session";
import {
  APP_PAUSE_EVENT,
  APP_POSITION_EVENT,
  consumeAppPause,
  hasAppPause,
  pauseWithIntent,
} from "./pause-intent";

import { createTimeStore, type PlaybackTimeStore } from "./playback-time-store";
import { usePreferencesRef } from "./preferences-provider";
import type { ProgressConflictDetail } from "./progress-persister";
import {
  setMediaSessionPlaybackState,
  syncMediaSessionPosition,
  useMediaSession,
} from "./use-media-session";
import { usePlaybackHistoryLog } from "./use-playback-history-log";
import { useProgressPersistence } from "./use-progress-persistence";
import { type SleepMode, useSleepTimer } from "./use-sleep-timer";
import { useTabArbitration } from "./use-tab-arbitration";
import { useTransportActions } from "./use-transport-actions";

type PlaybackContextValue = {
  userId: string;
  book: PlayerBook | null;
  isPlaying: boolean;
  playbackRate: number;
  history: PlaybackHistoryEntry[];
  historyNotice: string | null;
  sleepMode: SleepMode;

  lastEndedAt: number;
  loadBook: (
    book: PlayerBook,
    autoplay?: boolean,
    historySnapshot?: PlaybackHistorySnapshot,
  ) => void;
  toggle: () => void;
  pause: () => void;
  seek: (positionMs: number) => void;
  restoreHistoryPosition: (positionMs: number) => void;
  moveToChapter: (chapter: PlayerChapter, direction: "previous" | "next") => void;
  skip: (deltaMs: number) => void;
  setPlaybackRate: (rate: number) => void;
  setSleepMinutes: (minutes: number) => void;
  setSleepAtChapterEnd: () => void;
  clearSleep: () => void;
  markFinished: () => void;
  restart: () => void;
  unloadBook: () => void;
};

const PlaybackContext = createContext<PlaybackContextValue | null>(null);
const PlaybackTimeContext = createContext<PlaybackTimeStore | null>(null);

export function PlaybackProvider({ children, userId }: { children: ReactNode; userId: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeBookRef = useRef<PlayerBook | null>(null);
  const trackerRef = useRef(createListeningTracker(queueListeningSession(userId)));
  const suppressNextPauseRef = useRef(false);
  const interruptionRef = useRef<{ bookId: string; startedAt: number } | null>(null);
  const timeStore = useMemo(() => createTimeStore(), []);
  const [book, setBook] = useState<PlayerBook | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setRateState] = useState(1);
  const [lastEndedAt, setLastEndedAt] = useState(0);

  const preferencesRef = usePreferencesRef();
  const announcePlaying = useTabArbitration(audioRef);
  const {
    persistProgress,
    onListeningTick,
    markInProgress,
    saveDurableState,
    markPositionChanged,
    resetPositionChanged,
    reconcileCompletion,
  } = useProgressPersistence(userId, audioRef, activeBookRef);
  const { history, historyNotice, recordAction, hydrateHistory, clearHistory, clearHistoryNotice } =
    usePlaybackHistoryLog(userId, audioRef, activeBookRef);
  const {
    sleepMode,
    setSleepMinutes: setSleepMinutesTarget,
    setSleepAtChapterEnd: setSleepAtChapterEndTarget,
    clearSleep: clearSleepTarget,
    clearChapterSleep,
    onSeek: onSleepSeek,
    onTimeUpdate: onSleepTick,
  } = useSleepTimer(audioRef);

  useEffect(() => {
    activeBookRef.current = book;
  }, [book]);

  useEffect(() => {
    rememberActiveUserId(userId);
  }, [userId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    let observedPlaying = false;
    const clearInterruption = () => {
      interruptionRef.current = null;
    };
    const markInterruption = () => {
      const activeBook = activeBookRef.current;
      if (!activeBook || audio.ended || interruptionRef.current) return;
      interruptionRef.current = { bookId: activeBook.id, startedAt: Date.now() };
    };
    const audioSession = readAudioSession();
    const onAudioSessionChange = () => {
      if (audioSession?.state !== "interrupted" || !observedPlaying || hasAppPause(audio)) return;
      markInterruption();
      observedPlaying = false;
      const positionMs = mediaTime(audio) * 1000;
      timeStore.write(positionMs);
      saveDurableState("pause", positionMs);
      void persistProgress("pause", positionMs);
      if (activeBookRef.current) {
        markPausedNow(userId, activeBookRef.current.id);
        trackerRef.current.end(activeBookRef.current.id, positionMs);
      }
      setIsPlaying(false);
      setMediaSessionPlaybackState("paused");
      if (activeBookRef.current)
        syncMediaSessionPosition(audio, activeBookRef.current.durationMs, { current: "" });
    };
    const updateTime = () => {
      if (activeBookRef.current) onSleepTick(audio);
      const positionMs = mediaTime(audio) * 1000;
      timeStore.write(positionMs);

      if (!audio.paused) onListeningTick(positionMs);
    };
    const updateSleepChapter = () => {
      const activeBook = activeBookRef.current;
      if (activeBook) onSleepSeek(mediaTime(audio) * 1000, activeBook.chapters);
    };
    const markPlaying = () => {
      consumeAppPause(audio);
      suppressNextPauseRef.current = false;
      const interruption = interruptionRef.current;
      clearInterruption();
      const activeBook = activeBookRef.current;
      if (
        interruption &&
        activeBook &&
        interruption.bookId === activeBook.id &&
        preferencesRef.current.smartRewind
      ) {
        const rewindMs = rewindForAbsence(Date.now() - interruption.startedAt);
        if (rewindMs > 0) {
          setMediaTime(audio, Math.max(0, mediaTime(audio) * 1000 - rewindMs) / 1000);
          timeStore.write(mediaTime(audio) * 1000);
          markPausedNow(userId, interruption.bookId);
        }
      }
      observedPlaying = true;
      markInProgress();
      setIsPlaying(true);
      trackerRef.current.begin(mediaTime(audio) * 1000);
      announcePlaying();
      setMediaSessionPlaybackState("playing");
      recordAction("play");
    };
    const markPaused = () => {
      const appPaused = consumeAppPause(audio);
      if (appPaused || audio.ended) clearInterruption();
      else markInterruption();
      observedPlaying = false;
      timeStore.write(mediaTime(audio) * 1000);
      setIsPlaying(false);
      setMediaSessionPlaybackState("paused");
      if (suppressNextPauseRef.current) {
        suppressNextPauseRef.current = false;
        return;
      }
      const positionMs = mediaTime(audio) * 1000;

      if (activeBookRef.current) {
        markPausedNow(userId, activeBookRef.current.id);
        trackerRef.current.end(activeBookRef.current.id, positionMs);
      }
      void persistProgress("pause", positionMs);
      recordAction("pause", positionMs);
    };
    const markEnded = () => {
      clearInterruption();
      observedPlaying = false;
      setIsPlaying(false);
      const endPositionMs = activeBookRef.current?.durationMs || mediaTime(audio) * 1000;
      if (activeBookRef.current) trackerRef.current.end(activeBookRef.current.id, endPositionMs);
      markPositionChanged();
      void persistProgress("ended", endPositionMs, true);
      recordAction("finished", endPositionMs);
      setLastEndedAt(Date.now());
    };
    const reconcileElement = () => {
      if (!activeBookRef.current) return;
      timeStore.write(mediaTime(audio) * 1000);
      const playing = !audio.paused && !audio.ended && !audio.error;
      observedPlaying = playing;
      if (playing) clearInterruption();
      setIsPlaying(playing);
      setMediaSessionPlaybackState(playing ? "playing" : "paused");
    };
    const reconcileVisible = () => {
      if (document.visibilityState === "visible") reconcileElement();
    };
    const markError = () => {
      const activeBook = activeBookRef.current;
      if (!activeBook) return;
      const positionMs = mediaTime(audio) * 1000;
      pauseWithIntent(audio);
      saveDurableState("pause", positionMs);
      trackerRef.current.end(activeBook.id, positionMs);
      reconcileElement();
    };

    audio.addEventListener(APP_PAUSE_EVENT, clearInterruption);
    audio.addEventListener(APP_POSITION_EVENT, clearInterruption);
    audioSession?.addEventListener("statechange", onAudioSessionChange);
    audio.addEventListener("timeupdate", updateTime);
    audio.addEventListener("seeking", updateSleepChapter);
    audio.addEventListener("play", markPlaying);
    audio.addEventListener("pause", markPaused);
    audio.addEventListener("ended", markEnded);
    audio.addEventListener("error", markError);
    window.addEventListener("pageshow", reconcileElement);
    document.addEventListener("visibilitychange", reconcileVisible);
    return () => {
      clearMediaSeek(audio);
      audio.removeEventListener(APP_PAUSE_EVENT, clearInterruption);
      audio.removeEventListener(APP_POSITION_EVENT, clearInterruption);
      audioSession?.removeEventListener("statechange", onAudioSessionChange);
      audio.removeEventListener("timeupdate", updateTime);
      audio.removeEventListener("seeking", updateSleepChapter);
      audio.removeEventListener("play", markPlaying);
      audio.removeEventListener("pause", markPaused);
      audio.removeEventListener("ended", markEnded);
      audio.removeEventListener("error", markError);
      window.removeEventListener("pageshow", reconcileElement);
      document.removeEventListener("visibilitychange", reconcileVisible);
    };
  }, [
    announcePlaying,
    markInProgress,
    markPositionChanged,
    onListeningTick,
    onSleepTick,
    onSleepSeek,
    persistProgress,
    preferencesRef,
    recordAction,
    saveDurableState,
    timeStore,
    userId,
  ]);

  const { actions: transport, cancelSeekPersist } = useTransportActions({
    audioRef,
    activeBookRef,
    suppressNextPauseRef,
    timeStore,
    persistProgress,
    saveDurableState,
    markPositionChanged,
    recordAction,
  });

  const actions = useMemo(() => {
    return {
      loadBook(nextBook: PlayerBook, autoplay = false, historySnapshot?: PlaybackHistorySnapshot) {
        const audio = audioRef.current;
        if (!audio) return;
        if (activeBookRef.current?.id !== nextBook.id) {
          clearChapterSleep();
          const previousBook = activeBookRef.current;
          if (previousBook) {
            const previousPositionMs = mediaTime(audio) * 1000;
            if (!audio.paused) suppressNextPauseRef.current = true;

            saveDurableState("book-switch", previousPositionMs, undefined, previousBook);
            void persistProgress("book-switch", previousPositionMs, undefined, previousBook);
            cancelSeekPersist();
            pauseWithIntent(audio);
            trackerRef.current.end(previousBook.id, previousPositionMs);
          } else {
            cancelSeekPersist();
          }
          trackerRef.current.reset();

          const bootstrap = bootstrapPlaybackState(userId, nextBook);
          const resolvedBook = bootstrap.book;
          const { startAtMs, appliedRewindMs } = resolveStartPosition({
            storedPositionMs: bootstrap.storedPositionMs,
            durationMs: resolvedBook.durationMs,
            smartRewindEnabled: preferencesRef.current.smartRewind,
            msSinceLastPause: readMsSinceLastPause(userId, resolvedBook.id),
          });

          if (appliedRewindMs > 0) markPausedNow(userId, resolvedBook.id);
          const startRate = resolvedBook.initialPlaybackRate;

          loadMediaSource(audio, resolvedBook.mediaUrl, startAtMs / 1000);
          audio.playbackRate = startRate;
          activeBookRef.current = resolvedBook;

          resetPositionChanged();
          setBook(resolvedBook);
          clearHistory();
          timeStore.write(startAtMs);
          setRateState(startRate);
          recordAction(
            "opened",
            startAtMs,
            null,
            appliedRewindMs > 0
              ? `Smart rewind ${Math.round(appliedRewindMs / 1000)} seconds`
              : null,
          );
        } else if (activeBookRef.current.mediaUrl !== nextBook.mediaUrl) {
          const wasPlaying = !audio.paused;
          const positionMs = Math.min(mediaTime(audio) * 1000, nextBook.durationMs);
          const rate = audio.playbackRate;
          if (wasPlaying) {
            suppressNextPauseRef.current = true;
            pauseWithIntent(audio);
          }
          const refreshedBook = bootstrapPlaybackState(userId, nextBook).book;
          loadMediaSource(audio, refreshedBook.mediaUrl, positionMs / 1000);
          audio.playbackRate = rate;
          activeBookRef.current = refreshedBook;
          setBook(refreshedBook);
          timeStore.write(positionMs);
          setRateState(rate);
          if (wasPlaying && !autoplay) transport.play();
        }
        hydrateHistory(nextBook.id, historySnapshot);
        if (autoplay) transport.play();
      },
      setPlaybackRate(rate: number) {
        const bounded = Math.min(3, Math.max(0.5, rate));
        if (audioRef.current) audioRef.current.playbackRate = bounded;
        setRateState(bounded);

        markPositionChanged();
        void persistProgress("rate-change", mediaTime(audioRef.current) * 1000);
        recordAction("playback_rate", undefined, null, `${bounded}×`);
      },
      setSleepMinutes(minutes: number) {
        setSleepMinutesTarget(minutes);
        recordAction("sleep_timer", undefined, null, `${minutes} minutes`);
      },
      setSleepAtChapterEnd() {
        const activeBook = activeBookRef.current;
        const audio = audioRef.current;
        if (activeBook && audio) {
          setSleepAtChapterEndTarget(mediaTime(audio) * 1000, activeBook.chapters);
          recordAction("sleep_timer", undefined, null, "End of chapter");
        }
      },
      clearSleep() {
        clearSleepTarget();
        recordAction("sleep_timer_cleared");
      },
      unloadBook() {
        clearSleepTarget();
        const audio = audioRef.current;

        if (audio && activeBookRef.current) {
          const positionMs = mediaTime(audio) * 1000;
          saveDurableState("book-unload", positionMs);
          void persistProgress("book-unload", positionMs);
        }
        cancelSeekPersist();
        if (audio) {
          pauseWithIntent(audio);
          clearMediaSeek(audio);
          audio.removeAttribute("src");
          audio.load();
        }
        resetPositionChanged();
        activeBookRef.current = null;
        setBook(null);
        clearHistory();
        clearHistoryNotice();
        timeStore.write(0);
        setIsPlaying(false);
      },
    };
  }, [
    cancelSeekPersist,
    clearHistory,
    clearHistoryNotice,
    clearChapterSleep,
    clearSleepTarget,
    hydrateHistory,
    markPositionChanged,
    persistProgress,
    preferencesRef,
    recordAction,
    resetPositionChanged,
    saveDurableState,
    setSleepAtChapterEndTarget,
    setSleepMinutesTarget,
    timeStore,
    transport,
    userId,
  ]);

  useEffect(() => {
    const unloadDeletedBook = (event: Event) => {
      const detail = (event as CustomEvent<UnloadPlayerDetail>).detail;
      if (detail?.userId !== userId || detail.bookId !== activeBookRef.current?.id) return;
      actions.unloadBook();
    };
    window.addEventListener(UNLOAD_PLAYER_EVENT, unloadDeletedBook);
    return () => window.removeEventListener(UNLOAD_PLAYER_EVENT, unloadDeletedBook);
  }, [actions, userId]);

  useEffect(() => {
    const reconcile = (event: Event) => {
      const detail = (event as CustomEvent<ProgressConflictDetail>).detail;
      if (detail.userId !== userId || activeBookRef.current?.id !== detail.bookId) return;
      reconcileCompletion(detail);
      const audio = audioRef.current;
      if (audio) {
        setMediaTime(audio, detail.positionMs / 1000);
        audio.playbackRate = detail.playbackRate;
      }
      timeStore.write(detail.positionMs);
      setRateState(detail.playbackRate);
    };
    window.addEventListener(PROGRESS_CONFLICT_EVENT, reconcile);
    return () => window.removeEventListener(PROGRESS_CONFLICT_EVENT, reconcile);
  }, [reconcileCompletion, timeStore, userId]);

  useMediaSession({
    audioRef,
    book,
    preferencesRef,
    play: transport.play,
    pause: transport.pause,
    seek: transport.seek,
    skip: transport.skip,
  });

  const value = useMemo<PlaybackContextValue>(
    () => ({
      userId,
      book,
      isPlaying,
      playbackRate,
      history,
      historyNotice,
      sleepMode,
      lastEndedAt,
      ...transport,
      ...actions,
    }),
    [
      userId,
      book,
      isPlaying,
      playbackRate,
      history,
      historyNotice,
      sleepMode,
      lastEndedAt,
      transport,
      actions,
    ],
  );

  return (
    <PlaybackContext.Provider value={value}>
      <PlaybackTimeContext.Provider value={timeStore}>
        {children}
        <audio ref={audioRef} preload="metadata" className="visually-hidden" />
      </PlaybackTimeContext.Provider>
    </PlaybackContext.Provider>
  );
}

export function usePlayback() {
  const context = useContext(PlaybackContext);
  if (!context) throw new Error("usePlayback must be used inside PlaybackProvider");
  return context;
}

export function usePlaybackTime(): number {
  const store = useContext(PlaybackTimeContext);
  if (!store) throw new Error("usePlaybackTime must be used inside PlaybackProvider");
  return useSyncExternalStore(store.subscribe, store.read, readServerTime);
}

export function usePlaybackTimeDerived<T extends string | number | boolean | null>(
  derive: (timeMs: number) => T,
): T {
  const store = useContext(PlaybackTimeContext);
  if (!store) throw new Error("usePlaybackTimeDerived must be used inside PlaybackProvider");
  return useSyncExternalStore(
    store.subscribe,
    () => derive(store.read()),
    () => derive(0),
  );
}

export function useCurrentChapter(): PlayerChapter | null {
  const { book } = usePlayback();
  const store = useContext(PlaybackTimeContext);
  if (!store) throw new Error("useCurrentChapter must be used inside PlaybackProvider");
  return useSyncExternalStore(
    store.subscribe,
    () => (book ? selectCurrentChapter(book.chapters, store.read()) : null),
    readServerChapter,
  );
}

const readServerTime = () => 0;
const readServerChapter = () => null;
