// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PlayerBook } from "@/domain/player";
import { resolveStartPosition } from "@/domain/player";

import { createTimeStore } from "./playback-time-store";
import { useTransportActions } from "./use-transport-actions";

const METADATA_DURATION_MS = 60_000;

const DECODED_DURATION_MS = 52_000;

const book: PlayerBook = {
  id: "book-1",
  title: "Test Book",
  author: "Test Author",
  durationMs: METADATA_DURATION_MS,
  mediaUrl: "/offline-media/test",
  coverUrl: null,
  chapters: [],
  initialPositionMs: 0,
  initialProgressOccurredAt: null,
  initialPlaybackRate: 1,
  completed: false,
};

function clampingAudio(decodedDurationMs = DECODED_DURATION_MS) {
  let seconds = 0;
  return {
    dispatchEvent: vi.fn(),
    HAVE_METADATA: 1,
    readyState: 1,
    paused: true,
    playbackRate: 1,
    get currentTime() {
      return seconds;
    },
    set currentTime(next: number) {
      seconds = Math.min(next, decodedDurationMs / 1000);
    },
  } as unknown as HTMLAudioElement;
}

function mountTransport(audio: HTMLAudioElement) {
  const saveDurableState = vi.fn();
  const recordAction = vi.fn();
  const timeStore = createTimeStore();
  const { result } = renderHook(() =>
    useTransportActions({
      audioRef: { current: audio },
      activeBookRef: { current: book },
      suppressNextPauseRef: { current: false },
      timeStore,
      persistProgress: vi.fn().mockResolvedValue(undefined),
      saveDurableState,
      markPositionChanged: vi.fn(),
      recordAction,
    }),
  );
  return { actions: result.current.actions, saveDurableState, recordAction, timeStore };
}

describe("seeking", () => {
  it("records where the element landed, not where it was asked to go", () => {
    const audio = clampingAudio();
    const { actions, saveDurableState, recordAction, timeStore } = mountTransport(audio);

    actions.seek(59_000);

    expect(audio.currentTime * 1000).toBe(DECODED_DURATION_MS);
    expect(saveDurableState).toHaveBeenCalledWith("seek", DECODED_DURATION_MS);
    expect(timeStore.read()).toBe(DECODED_DURATION_MS);
    expect(recordAction).toHaveBeenCalledWith("seek", DECODED_DURATION_MS, 0, null);
  });

  it("does not turn a seek near the end into a restart from the beginning", () => {
    const audio = clampingAudio();
    const { saveDurableState, actions } = mountTransport(audio);

    actions.seek(59_000);
    const [, storedPositionMs] = saveDurableState.mock.calls[0] as [string, number];

    expect(
      resolveStartPosition({
        storedPositionMs,
        durationMs: METADATA_DURATION_MS,
        smartRewindEnabled: false,
        msSinceLastPause: null,
      }).startAtMs,
    ).toBe(DECODED_DURATION_MS);
  });

  it("keeps the request when the element has no metadata to clamp against", () => {
    const audio = Object.assign(new EventTarget(), {
      HAVE_METADATA: 1,
      readyState: 0,
      currentTime: 0,
    }) as unknown as HTMLAudioElement;
    const { actions, saveDurableState } = mountTransport(audio);

    actions.seek(30_000);

    expect(saveDurableState).toHaveBeenCalledWith("seek", 30_000);
  });

  it("still bounds a seek past the metadata duration", () => {
    const audio = clampingAudio(90_000);
    const { actions, saveDurableState } = mountTransport(audio);

    actions.seek(500_000);

    expect(saveDurableState).toHaveBeenCalledWith("seek", METADATA_DURATION_MS);
  });
});
