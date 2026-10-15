// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

import type { PlayerChapter } from "@/domain/player";

import { useSleepTimer } from "./use-sleep-timer";

const chapters: PlayerChapter[] = [
  { id: "one", position: 0, title: "One", startMs: 0, endMs: 10_000 },
  { id: "two", position: 1, title: "Two", startMs: 10_000, endMs: 20_000 },
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("synthetic suspended sleep timeout", () => {
  it("enforces an elapsed deadline on a media tick when the timeout never fires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const audio = { currentTime: 5, pause: vi.fn() } as unknown as HTMLAudioElement;
    const audioRef = { current: audio };
    const { result } = renderHook(() => useSleepTimer(audioRef));
    act(() => result.current.setSleepMinutes(1));
    vi.setSystemTime(1_061_000);
    act(() => result.current.onTimeUpdate(audio));
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(result.current.sleepMode).toBeNull();
    act(() => result.current.onTimeUpdate(audio));
    expect(audio.pause).toHaveBeenCalledOnce();
  });

  it("enforces an elapsed deadline on pageshow without starting paused audio", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const audio = { currentTime: 5, pause: vi.fn() } as unknown as HTMLAudioElement;
    const audioRef = { current: audio };
    const { result } = renderHook(() => useSleepTimer(audioRef));
    act(() => result.current.setSleepMinutes(1));
    vi.setSystemTime(1_061_000);
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(result.current.sleepMode).toBeNull();
  });

  it("cancels the outstanding timeout when the player unmounts", () => {
    vi.useFakeTimers();
    const audio = { currentTime: 5, pause: vi.fn() } as unknown as HTMLAudioElement;
    const audioRef = { current: audio };
    const { result, unmount } = renderHook(() => useSleepTimer(audioRef));
    act(() => result.current.setSleepMinutes(1));
    unmount();
    act(() => vi.advanceTimersByTime(61_000));
    expect(audio.pause).not.toHaveBeenCalled();
  });

  it("still pauses at the deadline when the ordinary timeout fires", () => {
    vi.useFakeTimers();
    const audio = { currentTime: 5, pause: vi.fn() } as unknown as HTMLAudioElement;
    const audioRef = { current: audio };
    const { result } = renderHook(() => useSleepTimer(audioRef));
    act(() => result.current.setSleepMinutes(1));
    act(() => vi.advanceTimersByTime(59_999));
    expect(audio.pause).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(result.current.sleepMode).toBeNull();
  });
});

describe("chapter-end sleep", () => {
  it("stops when a throttled tick crosses into the next chapter", () => {
    const audio = { currentTime: 9.5, pause: vi.fn() } as unknown as HTMLAudioElement;
    const audioRef = { current: audio };
    const { result } = renderHook(() => useSleepTimer(audioRef));

    act(() => result.current.setSleepAtChapterEnd(9_500, chapters));
    audio.currentTime = 10.25;
    act(() => result.current.onTimeUpdate(audio));

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.currentTime).toBe(10);
  });
});
