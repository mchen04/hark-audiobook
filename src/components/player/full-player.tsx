"use client";

import {
  ArrowCounterClockwise,
  ArrowClockwise,
  ArrowLeft,
  CaretLeft,
  CaretRight,
  Clock,
  ClockCounterClockwise,
  DotsThreeCircle,
  ListBullets,
  Pause,
  Play,
  TextAlignLeft,
  X,
} from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { titleMonogram } from "@/lib/book-monogram";

import type { BookDetails } from "@/components/book/book-details-dialog";
import { useOpenLocalLibrary } from "@/components/app-navigation";
import type { PlaybackHistorySnapshot } from "@/domain/playback-history";
import type { NextInCollection, PlayerBook } from "@/domain/player";
import type { TranscriptSentence } from "@/domain/transcript";
import { formatClock, formatDurationRounded } from "@/lib/format-time";
import { getChapterTranscript, getTranscriptChapterIndexes } from "@/lib/offline/transcript-store";
import type { SuspendedSession } from "@/lib/playback-core";

import { PlayerSheet, type PlayerSheetView } from "./chapter-sheet";
import { useCurrentChapter, usePlayback, usePlaybackTime } from "./playback-provider";
import { usePreferences } from "./preferences-provider";
import { CoverNowReading, TranscriptPane } from "./transcript-pane";
import type { SleepMode } from "./use-sleep-timer";
import { useSuspensionRecovery } from "./use-suspension-recovery";

const BookDetailsDialog = dynamic(
  () => import("@/components/book/book-details-dialog").then((mod) => mod.BookDetailsDialog),
  { ssr: false },
);

export function FullPlayer({
  playerBook,
  historySnapshot,
  offlineMode = false,
  backHref = "/library",
  backLabel = "Library",
  onBack,
  autoplay = false,
  details = null,
  mediaFingerprint = null,
  mediaRenditionKey = null,
  nextInCollection = null,
}: {
  playerBook: PlayerBook;
  historySnapshot?: PlaybackHistorySnapshot;
  offlineMode?: boolean;
  backHref?: string;
  backLabel?: string;
  onBack?: () => void;
  autoplay?: boolean;
  details?: BookDetails | null;
  mediaFingerprint?: string | null;
  mediaRenditionKey?: string | null;
  nextInCollection?: NextInCollection | null;
}) {
  const router = useRouter();
  const openLocalLibrary = useOpenLocalLibrary();
  const playback = usePlayback();
  const { preferences } = usePreferences();
  const currentChapter = useCurrentChapter();
  const { loadBook } = playback;
  const recovery = useSuspensionRecovery({
    userId: playback.userId,
    bookId: playerBook.id,
    durationMs: playerBook.durationMs,
  });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sheetView, setSheetView] = useState<PlayerSheetView | null>(null);
  const mountedEndedAtRef = useRef(playback.lastEndedAt);
  const autoplayConsumedForRef = useRef<string | null>(null);
  const [transcriptBookId, setTranscriptBookId] = useState<string | null>(null);
  const [textViewBookId, setTextViewBookId] = useState<string | null>(null);
  const [chapterCues, setChapterCues] = useState<{
    bookId: string;
    chapterIndex: number;
    sentences: TranscriptSentence[];
  } | null>(null);
  const hasTranscript = transcriptBookId === playerBook.id;
  const showText = hasTranscript && textViewBookId === playerBook.id;

  useEffect(() => {
    let active = true;
    void getTranscriptChapterIndexes(playback.userId, playerBook.id)
      .then((indexes) => {
        if (active && indexes.length > 0) setTranscriptBookId(playerBook.id);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [playback.userId, playerBook.id]);

  const chapterIndexForCues = currentChapter?.position ?? -1;
  useEffect(() => {
    if (!hasTranscript || chapterIndexForCues < 0) return;
    let active = true;
    const bookId = playerBook.id;
    void getChapterTranscript(playback.userId, bookId, chapterIndexForCues)
      .then((record) => {
        if (active) {
          setChapterCues({
            bookId,
            chapterIndex: chapterIndexForCues,
            sentences: record?.sentences ?? [],
          });
        }
      })
      .catch(() => {
        if (active) setChapterCues({ bookId, chapterIndex: chapterIndexForCues, sentences: [] });
      });
    return () => {
      active = false;
    };
  }, [hasTranscript, chapterIndexForCues, playback.userId, playerBook.id]);

  const cuesReady =
    chapterCues?.bookId === playerBook.id && chapterCues.chapterIndex === chapterIndexForCues;

  useEffect(() => {
    const shouldAutoplay = autoplay && autoplayConsumedForRef.current !== playerBook.id;
    autoplayConsumedForRef.current = playerBook.id;
    loadBook(playerBook, shouldAutoplay, historySnapshot);
  }, [autoplay, historySnapshot, loadBook, playerBook]);

  const autoplayNext = preferences.autoplayNextInCollection;
  useEffect(() => {
    if (playback.lastEndedAt === mountedEndedAtRef.current) return;
    mountedEndedAtRef.current = playback.lastEndedAt;
    if (!offlineMode && autoplayNext && nextInCollection) {
      router.push(`/books/${nextInCollection.id}?autoplay=1`);
    }
  }, [autoplayNext, nextInCollection, offlineMode, playback.lastEndedAt, router]);

  const chapterIndex = currentChapter?.position ?? -1;

  function moveChapter(delta: number) {
    const target = playerBook.chapters[chapterIndex + delta];
    if (target) {
      playback.moveToChapter(target, delta < 0 ? "previous" : "next");
    }
  }

  const skipBackSeconds = Math.round(preferences.skipBackMs / 1000);
  const skipForwardSeconds = Math.round(preferences.skipForwardMs / 1000);
  const suspensionGap = recovery.gap;

  function followBackHref() {
    if (backHref === "/library" && openLocalLibrary) {
      openLocalLibrary();
      return;
    }
    router.push(backHref);
  }

  return (
    <div className="player-page">
      <div className="player-topbar" inert={sheetView ? true : undefined}>
        {onBack ? (
          <button type="button" className="icon-text-button" onClick={onBack}>
            <ArrowLeft size={19} aria-hidden="true" />
            <span>{backLabel}</span>
          </button>
        ) : (
          <button type="button" className="icon-text-button" onClick={followBackHref}>
            <ArrowLeft size={19} aria-hidden="true" />
            <span>{backLabel}</span>
          </button>
        )}
        <span>{currentChapter?.title || "Full audiobook"}</span>
        <div className="player-topbar-actions">
          {hasTranscript && (
            <button
              type="button"
              className={`icon-text-button ${showText ? "is-active" : ""}`}
              aria-pressed={showText}
              onClick={() => setTextViewBookId(showText ? null : playerBook.id)}
            >
              <TextAlignLeft size={19} aria-hidden="true" />
              <span>Text</span>
            </button>
          )}
          {details && !offlineMode && (
            <button type="button" className="icon-text-button" onClick={() => setDetailsOpen(true)}>
              <DotsThreeCircle size={19} aria-hidden="true" />
              <span>Details</span>
            </button>
          )}
        </div>
      </div>

      <div className="player-layout">
        <section
          className="player-main"
          aria-labelledby="book-title"
          inert={sheetView ? true : undefined}
        >
          <div className={`player-hero ${showText ? "has-text" : ""}`}>
            {showText ? (
              <div className="transcript-stage">
                <TranscriptPane
                  key={`${playerBook.id}:${chapterIndexForCues}`}
                  sentences={cuesReady ? chapterCues.sentences : []}
                  chapterStartMs={currentChapter?.startMs ?? 0}
                  chapterTitle={currentChapter?.title ?? ""}
                  pending={!cuesReady}
                  onSeek={playback.seek}
                />
                <button
                  type="button"
                  className="transcript-close"
                  aria-label="Show cover"
                  onClick={() => setTextViewBookId(null)}
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <CoverArt
                playerBook={playerBook}
                onFlip={hasTranscript ? () => setTextViewBookId(playerBook.id) : undefined}
              />
            )}

            <div className="player-book-copy">
              <h1 id="book-title">{playerBook.title}</h1>
              <p>{playerBook.author}</p>
              {!showText && hasTranscript && cuesReady && (
                <CoverNowReading
                  sentences={chapterCues.sentences}
                  chapterStartMs={currentChapter?.startMs ?? 0}
                />
              )}
            </div>
          </div>

          {suspensionGap && (
            <SuspensionRecovery
              gap={suspensionGap}
              onJump={() => {
                playback.seek(suspensionGap.projectedPositionMs);
                recovery.dismiss();
              }}
              onDismiss={recovery.dismiss}
            />
          )}

          <Scrubber durationMs={playerBook.durationMs} onSeek={playback.seek} />

          <div className="transport-controls">
            <button
              type="button"
              onClick={() => moveChapter(-1)}
              disabled={chapterIndex <= 0}
              aria-label="Previous chapter"
            >
              <CaretLeft size={22} weight="bold" />
            </button>
            <button
              type="button"
              onClick={() => playback.skip(-preferences.skipBackMs)}
              aria-label={`Back ${skipBackSeconds} seconds`}
              className="timed-skip"
            >
              <ArrowCounterClockwise size={34} />
              <small>{skipBackSeconds}</small>
            </button>
            <button
              type="button"
              className="main-play"
              onClick={playback.toggle}
              aria-label={playback.isPlaying ? "Pause" : "Play"}
            >
              {playback.isPlaying ? (
                <Pause size={32} weight="fill" />
              ) : (
                <Play size={32} weight="fill" />
              )}
            </button>
            <button
              type="button"
              onClick={() => playback.skip(preferences.skipForwardMs)}
              aria-label={`Forward ${skipForwardSeconds} seconds`}
              className="timed-skip"
            >
              <ArrowClockwise size={34} />
              <small>{skipForwardSeconds}</small>
            </button>
            <button
              type="button"
              onClick={() => moveChapter(1)}
              disabled={chapterIndex < 0 || chapterIndex >= playerBook.chapters.length - 1}
              aria-label="Next chapter"
            >
              <CaretRight size={22} weight="bold" />
            </button>
          </div>

          <div className="player-options">
            <label>
              <span className="visually-hidden">Playback speed</span>
              <select
                value={playback.playbackRate}
                onChange={(event) => playback.setPlaybackRate(Number(event.target.value))}
              >
                {[0.5, 0.75, 1, 1.15, 1.25, 1.5, 1.75, 2, 2.5, 3].map((rate) => (
                  <option value={rate} key={rate}>
                    {rate}×
                  </option>
                ))}
              </select>
            </label>
            <SleepMenu />
            <div className="player-sheet-tabs" aria-label="Player details">
              <button
                type="button"
                onClick={() => setSheetView("chapters")}
                aria-label="Chapters"
                aria-haspopup="dialog"
                aria-expanded={sheetView === "chapters"}
              >
                <ListBullets size={19} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setSheetView("history")}
                aria-label="History"
                aria-haspopup="dialog"
                aria-expanded={sheetView === "history"}
              >
                <ClockCounterClockwise size={19} aria-hidden="true" />
              </button>
            </div>
          </div>
          {nextInCollection && !offlineMode && (
            <p className="up-next">
              Up next in {nextInCollection.collectionName}:{" "}
              <Link href={`/books/${nextInCollection.id}`}>{nextInCollection.title}</Link>
              {preferences.autoplayNextInCollection ? " · plays automatically" : ""}
            </p>
          )}
        </section>
      </div>

      <PlayerSheet
        open={sheetView !== null}
        view={sheetView || "chapters"}
        onViewChange={setSheetView}
        onClose={() => setSheetView(null)}
        chapters={playerBook.chapters}
        history={playback.history}
        historyNotice={playback.historyNotice}
        activeChapterId={currentChapter?.id ?? null}
        isPlaying={playback.isPlaying}
        onChapterSelect={playback.seek}
        onHistoryRestore={playback.restoreHistoryPosition}
        diagnostic={details?.chapterDiagnostic}
      />
      {details && (
        <BookDetailsDialog
          details={details}
          mediaFingerprint={mediaFingerprint}
          mediaRenditionKey={mediaRenditionKey}
          open={detailsOpen}
          onClose={() => setDetailsOpen(false)}
        />
      )}
    </div>
  );
}

function SuspensionRecovery({
  gap,
  onJump,
  onDismiss,
}: {
  gap: SuspendedSession;
  onJump: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="resume-recovery"
      role="status"
      data-resume-recovery=""
      data-recorded-ms={Math.round(gap.recordedPositionMs)}
      data-projected-ms={Math.round(gap.projectedPositionMs)}
      data-elapsed-ms={Math.round(gap.elapsedMs)}
      data-playback-rate={gap.playbackRate}
    >
      <p>
        This was playing when the app closed, and about{" "}
        <strong>{formatDurationRounded(gap.elapsedMs)}</strong> went unrecorded.
      </p>
      <div className="resume-recovery-actions">
        <button type="button" className="resume-recovery-jump" onClick={onJump}>
          Jump to about {formatClock(gap.projectedPositionMs)}
        </button>
        <button
          type="button"
          className="resume-recovery-dismiss"
          aria-label="Dismiss the estimate and keep the saved place"
          onClick={onDismiss}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <small>
        An estimate from the time away and {gap.playbackRate}× speed. Your saved place is{" "}
        {formatClock(gap.recordedPositionMs)}.
      </small>
    </div>
  );
}

function CoverArt({ playerBook, onFlip }: { playerBook: PlayerBook; onFlip?: () => void }) {
  const art = playerBook.coverUrl ? (
    <Image
      className="player-cover"
      src={playerBook.coverUrl}
      alt=""
      width={320}
      height={480}
      unoptimized
      priority
    />
  ) : (
    <div className="player-cover" aria-hidden="true">
      <span>{titleMonogram(playerBook.title)}</span>
      <small>MP3</small>
    </div>
  );
  if (!onFlip) return art;
  return (
    <button type="button" className="player-cover-flip" aria-label="Show text" onClick={onFlip}>
      {art}
    </button>
  );
}

function Scrubber({
  durationMs,
  onSeek,
}: {
  durationMs: number;
  onSeek: (positionMs: number) => void;
}) {
  const currentTimeMs = usePlaybackTime();
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const shownMs = scrubMs ?? Math.min(currentTimeMs, durationMs);
  const fillPercent = durationMs ? (shownMs / durationMs) * 100 : 0;

  function commit(value: number) {
    draggingRef.current = false;
    setScrubMs(null);
    onSeek(value);
  }

  return (
    <div className={`scrubber ${scrubMs !== null ? "is-scrubbing" : ""}`}>
      <input
        type="range"
        min={0}
        max={durationMs}
        step={Math.max(1_000, Math.round(durationMs / 600 / 1000) * 1000)}
        value={shownMs}
        style={{ "--scrub-fill": `${fillPercent}%` } as React.CSSProperties}
        onPointerDown={() => {
          draggingRef.current = true;
        }}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (draggingRef.current) setScrubMs(value);
          else onSeek(value);
        }}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onPointerCancel={() => {
          draggingRef.current = false;
          setScrubMs(null);
        }}
        aria-label="Audiobook position"
        aria-valuetext={`${formatClock(shownMs)} of ${formatClock(durationMs)}`}
      />
      <div>
        <span>{formatClock(shownMs)}</span>
        <span>-{formatClock(Math.max(0, durationMs - shownMs))}</span>
      </div>
    </div>
  );
}

function SleepMenu() {
  const playback = usePlayback();
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const details = detailsRef.current;
      if (details?.open && !details.contains(event.target as Node)) {
        details.removeAttribute("open");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function choose(action: () => void) {
    action();
    detailsRef.current?.removeAttribute("open");
  }

  function submitCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const minutes = Number(new FormData(event.currentTarget).get("minutes"));
    if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 600) {
      choose(() => playback.setSleepMinutes(Math.round(minutes)));
    }
  }

  return (
    <details
      className={`sleep-menu${playback.sleepMode ? " sleep-active" : ""}`}
      ref={detailsRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && detailsRef.current?.open) {
          detailsRef.current.removeAttribute("open");
          detailsRef.current.querySelector("summary")?.focus();
        }
      }}
    >
      <SleepLabel mode={playback.sleepMode} />
      <div>
        <div className="sleep-presets">
          {[15, 30, 45, 60].map((minutes) => (
            <button
              type="button"
              key={minutes}
              aria-pressed={
                playback.sleepMode?.kind === "time" && playback.sleepMode.minutes === minutes
              }
              onClick={() => choose(() => playback.setSleepMinutes(minutes))}
            >
              {minutes}m
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-pressed={playback.sleepMode?.kind === "chapter"}
          onClick={() => choose(playback.setSleepAtChapterEnd)}
        >
          End of chapter
        </button>
        <form
          className="sleep-custom"
          data-active={
            playback.sleepMode?.kind === "time" &&
            !!playback.sleepMode.minutes &&
            ![15, 30, 45, 60].includes(playback.sleepMode.minutes)
          }
          onSubmit={submitCustom}
        >
          <input
            type="number"
            name="minutes"
            min={1}
            max={600}
            placeholder="Minutes"
            aria-label="Custom sleep timer minutes"
          />
          <button type="submit">Set</button>
        </form>
        {playback.sleepMode && (
          <button type="button" onClick={() => choose(playback.clearSleep)}>
            Turn off
          </button>
        )}
      </div>
    </details>
  );
}

function SleepLabel({ mode }: { mode: SleepMode }) {
  const endsAt = mode?.kind === "time" ? mode.endsAt : null;
  const subscribe = useCallback(
    (notify: () => void) => {
      if (endsAt === null) return () => undefined;
      const deadline = endsAt;
      let timer: number;
      function schedule() {
        const remaining = deadline - Date.now();
        timer = window.setTimeout(refresh, remaining > 0 ? remaining % 60_000 || 60_000 : 60_000);
      }
      function refresh() {
        window.clearTimeout(timer);
        notify();
        schedule();
      }
      schedule();
      window.addEventListener("pageshow", refresh);
      document.addEventListener("visibilitychange", refresh);
      return () => {
        window.clearTimeout(timer);
        window.removeEventListener("pageshow", refresh);
        document.removeEventListener("visibilitychange", refresh);
      };
    },
    [endsAt],
  );
  const label = useSyncExternalStore(
    subscribe,
    () => sleepLabel(mode),
    () => sleepLabel(mode),
  );
  const accessibleLabel = !mode
    ? "Sleep timer"
    : mode.kind === "chapter"
      ? "Sleep timer, chapter end"
      : `Sleep timer, ${label.slice(0, -1)} minutes left`;
  return (
    <summary aria-label={accessibleLabel}>
      <Clock size={19} aria-hidden="true" />
      <span aria-live="polite">{label}</span>
    </summary>
  );
}

function sleepLabel(mode: SleepMode): string {
  if (!mode) return "Sleep";
  if (mode.kind === "chapter") return "Chapter end";
  return `${Math.max(1, Math.ceil((mode.endsAt - Date.now()) / 60_000))}m`;
}
