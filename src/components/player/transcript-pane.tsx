"use client";

import { memo, useCallback, useEffect, useRef } from "react";

import type { TranscriptSentence } from "@/domain/transcript";
import { activeCueIndex } from "@/domain/transcript-cues";

import { usePlaybackTimeDerived } from "./playback-provider";

const MANUAL_SCROLL_GRACE_MS = 3500;

export function TranscriptPane({
  sentences,
  chapterStartMs,
  chapterTitle,
  pending = false,
  onSeek,
}: {
  sentences: TranscriptSentence[];
  chapterStartMs: number;
  chapterTitle: string;
  pending?: boolean;
  onSeek: (positionMs: number) => void;
}) {
  const activeIndex = usePlaybackTimeDerived((timeMs) =>
    activeCueIndex(sentences, timeMs - chapterStartMs),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLButtonElement>(null);
  const manualUntilRef = useRef(0);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const update = () =>
      container.classList.toggle("is-scrollable", container.scrollHeight > container.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [sentences]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const noteManualScroll = () => {
      manualUntilRef.current = Date.now() + MANUAL_SCROLL_GRACE_MS;
    };
    container.addEventListener("wheel", noteManualScroll, { passive: true });
    container.addEventListener("touchmove", noteManualScroll, { passive: true });
    return () => {
      container.removeEventListener("wheel", noteManualScroll);
      container.removeEventListener("touchmove", noteManualScroll);
    };
  }, [sentences]);

  useEffect(() => {
    if (activeIndex < 0 || Date.now() < manualUntilRef.current) return;
    activeRowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex]);

  const seekToSentence = useCallback(
    (sentence: TranscriptSentence) => {
      manualUntilRef.current = 0;
      onSeek(chapterStartMs + sentence.startMs);
    },
    [chapterStartMs, onSeek],
  );

  if (sentences.length === 0) {
    return (
      <div className="transcript-pane transcript-pane-empty">
        {!pending && <p>No text for {chapterTitle || "this chapter"}.</p>}
      </div>
    );
  }

  return (
    <div className="transcript-pane" ref={scrollRef} aria-label="Read-along text">
      <ol className="transcript-sentences">
        {sentences.map((sentence, index) => (
          <SentenceRow
            key={index}
            sentence={sentence}
            chapterStartMs={chapterStartMs}
            isActive={index === activeIndex}
            rowRef={index === activeIndex ? activeRowRef : undefined}
            onSelect={seekToSentence}
          />
        ))}
      </ol>
    </div>
  );
}

export function CoverNowReading({
  sentences,
  chapterStartMs,
}: {
  sentences: TranscriptSentence[];
  chapterStartMs: number;
}) {
  const text = usePlaybackTimeDerived((timeMs) => {
    const index = activeCueIndex(sentences, timeMs - chapterStartMs);
    return index >= 0 ? sentences[index]!.text : "";
  });
  return text ? (
    <p className="player-now-reading" aria-hidden="true">
      {text}
    </p>
  ) : null;
}

const SentenceRow = memo(function SentenceRow({
  sentence,
  chapterStartMs,
  isActive,
  rowRef,
  onSelect,
}: {
  sentence: TranscriptSentence;
  chapterStartMs: number;
  isActive: boolean;
  rowRef?: React.RefObject<HTMLButtonElement | null>;
  onSelect: (sentence: TranscriptSentence) => void;
}) {
  return (
    <li>
      <button
        type="button"
        ref={rowRef}
        className={`transcript-sentence ${isActive ? "is-active" : ""}`}
        aria-current={isActive || undefined}
        onClick={() => onSelect(sentence)}
      >
        <span className="transcript-sentence-text">
          {isActive && sentence.words.length > 0 ? (
            <ActiveSentence sentence={sentence} chapterStartMs={chapterStartMs} />
          ) : (
            sentence.text
          )}
        </span>
      </button>
    </li>
  );
});

function ActiveSentence({
  sentence,
  chapterStartMs,
}: {
  sentence: TranscriptSentence;
  chapterStartMs: number;
}) {
  const markedIndex = usePlaybackTimeDerived((timeMs) => {
    let index = activeCueIndex(sentence.words, timeMs - chapterStartMs);
    while (index >= 0 && sentence.words[index]!.charStart >= sentence.words[index]!.charEnd) {
      index -= 1;
    }
    return index;
  });
  const word = markedIndex >= 0 ? sentence.words[markedIndex] : undefined;
  if (!word) return <>{sentence.text}</>;
  return (
    <>
      {sentence.text.slice(0, word.charStart)}
      <mark className="transcript-word">{sentence.text.slice(word.charStart, word.charEnd)}</mark>
      {sentence.text.slice(word.charEnd)}
    </>
  );
}
