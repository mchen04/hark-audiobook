// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerBook } from "@/domain/player";

const { persistence } = vi.hoisted(() => ({
  persistence: {
    persistProgress: vi.fn().mockResolvedValue(undefined),
    saveDurableState: vi.fn(),
    onListeningTick: vi.fn(),
    markInProgress: vi.fn(),
    markPositionChanged: vi.fn(),
    resetPositionChanged: vi.fn(),
    reconcileCompletion: vi.fn(),
  },
}));

vi.mock("./use-progress-persistence", () => ({ useProgressPersistence: () => persistence }));
vi.mock("@/lib/playback-history", () => ({
  loadPlaybackHistory: vi.fn().mockResolvedValue([]),
  storePlaybackAction: vi.fn().mockResolvedValue("stored"),
  replayPlaybackHistory: vi.fn().mockResolvedValue(undefined),
  PLAYBACK_HISTORY_LIMIT: 50,
}));
vi.mock("@/lib/listening-tracker", () => ({
  createListeningTracker: () => ({ begin: vi.fn(), end: vi.fn(), reset: vi.fn() }),
  queueListeningSession: vi.fn(),
}));

import { PlaybackProvider, usePlayback, usePlaybackTime } from "./playback-provider";

const book: PlayerBook = {
  id: "book-1",
  title: "First book",
  author: "First author",
  durationMs: 120_000,
  mediaUrl: "/offline-media/first",
  coverUrl: "/offline-media/first-cover",
  initialPositionMs: 12_000,
  initialProgressOccurredAt: null,
  initialPlaybackRate: 1,
  completed: false,
  chapters: [
    { id: "one", position: 0, title: "One", startMs: 0, endMs: 60_000 },
    { id: "two", position: 1, title: "Two", startMs: 60_000, endMs: 120_000 },
  ],
};

const nextBook: PlayerBook = {
  ...book,
  id: "book-2",
  title: "Second book",
  mediaUrl: "/offline-media/second",
};

let paused = true;
let handlers: Map<MediaSessionAction, MediaSessionActionHandler>;
let session: {
  metadata: MediaMetadata | null;
  playbackState: MediaSessionPlaybackState;
  setActionHandler: ReturnType<typeof vi.fn>;
  setPositionState: ReturnType<typeof vi.fn>;
};

function mount() {
  const hook = renderHook(() => ({ playback: usePlayback(), time: usePlaybackTime() }), {
    wrapper: ({ children }) => <PlaybackProvider userId="user-1">{children}</PlaybackProvider>,
  });
  const audio = document.querySelector("audio")!;
  act(() => hook.result.current.playback.loadBook(book));
  return { ...hook, audio };
}

function remote(action: MediaSessionAction, details: Partial<MediaSessionActionDetails> = {}) {
  const handler = handlers.get(action);
  expect(handler, `missing ${action} handler`).toBeTypeOf("function");
  act(() => handler!({ action, ...details }));
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  paused = true;
  handlers = new Map();
  session = {
    metadata: null,
    playbackState: "none",
    setActionHandler: vi.fn((action, handler) => {
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
    }),
    setPositionState: vi.fn(),
  };
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(data: MediaMetadataInit) {
        Object.assign(this, data);
      }
    },
  );
  Object.defineProperty(navigator, "mediaSession", { configurable: true, value: session });
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => paused);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    if (paused) return;
    paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    paused = true;
    this.currentTime = 0;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaSession");
});

describe("synthetic chapter sleep navigation", () => {
  it("follows a deliberate seek into another chapter without jumping back", () => {
    const { result, audio } = mount();
    act(() => result.current.playback.setSleepAtChapterEnd());
    act(() => result.current.playback.toggle());
    act(() => result.current.playback.seek(75_000));
    act(() => audio.dispatchEvent(new Event("seeking")));
    act(() => audio.dispatchEvent(new Event("timeupdate")));
    expect(audio.currentTime).toBe(75);
    expect(audio.paused).toBe(false);
    expect(result.current.playback.sleepMode).toEqual({ kind: "chapter" });
    audio.currentTime = 120;
    act(() => audio.dispatchEvent(new Event("timeupdate")));
    expect(audio.paused).toBe(true);
    expect(result.current.playback.sleepMode).toBeNull();
  });

  it("saves and displays the chapter boundary before delivering the sleep pause", () => {
    const { result, audio } = mount();
    act(() => result.current.playback.setSleepAtChapterEnd());
    act(() => result.current.playback.toggle());
    audio.currentTime = 60.25;
    act(() => audio.dispatchEvent(new Event("timeupdate")));
    expect(persistence.persistProgress).toHaveBeenLastCalledWith("pause", 60_000);
    expect(result.current.time).toBe(60_000);
    expect(audio.currentTime).toBe(60);
  });

  it("clears the old chapter target when another book opens", () => {
    const { result } = mount();
    act(() => result.current.playback.setSleepAtChapterEnd());
    act(() => result.current.playback.loadBook(nextBook));
    expect(result.current.playback.sleepMode).toBeNull();
  });

  it("clears a minute timer on unload so it cannot pause a later book", () => {
    vi.useFakeTimers();
    const { result, audio } = mount();
    act(() => result.current.playback.setSleepMinutes(1));
    act(() => result.current.playback.unloadBook());
    expect(result.current.playback.sleepMode).toBeNull();
    act(() => result.current.playback.loadBook(nextBook, true));
    act(() => vi.advanceTimersByTime(61_000));
    expect(audio.paused).toBe(false);
  });

  it("keeps a minute deadline through a book switch without a timer reset", () => {
    const { result } = mount();
    act(() => result.current.playback.setSleepMinutes(10));
    const mode = result.current.playback.sleepMode;
    act(() => result.current.playback.loadBook(nextBook));
    expect(result.current.playback.sleepMode).toEqual(mode);
  });
});

describe("synthetic Media Session lifecycle", () => {
  it("handles remote stop and chapter commands without losing the current position", () => {
    const { result, audio } = mount();
    act(() => result.current.playback.toggle());
    remote("stop");
    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(12);
    remote("nexttrack");
    expect(audio.currentTime).toBe(60);
    remote("previoustrack");
    expect(audio.currentTime).toBe(0);
  });

  it("publishes the saved position and rate as soon as a paused book opens", () => {
    mount();
    expect(session.metadata).toMatchObject({ title: book.title, artist: book.author });
    expect(session.playbackState).toBe("paused");
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 120,
      position: 12,
      playbackRate: 1,
    });
  });

  it("refreshes paused seeks and rate changes without waiting for timeupdate", () => {
    const { result, audio } = mount();
    act(() => result.current.playback.seek(22_250));
    act(() => audio.dispatchEvent(new Event("seeked")));
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 120,
      position: 22.25,
      playbackRate: 1,
    });
    act(() => result.current.playback.setPlaybackRate(1.5));
    act(() => audio.dispatchEvent(new Event("ratechange")));
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 120,
      position: 22.25,
      playbackRate: 1.5,
    });
  });

  it("refreshes the precise position on pause and clears playing state at the end", () => {
    const { result, audio } = mount();
    act(() => result.current.playback.toggle());
    audio.currentTime = 24.75;
    act(() => result.current.playback.pause());
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 120,
      position: 24.75,
      playbackRate: 1,
    });
    act(() => result.current.playback.toggle());
    audio.currentTime = 120;
    paused = true;
    act(() => audio.dispatchEvent(new Event("ended")));
    expect(session.playbackState).toBe("paused");
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 120,
      position: 120,
      playbackRate: 1,
    });
  });

  it("clears metadata, position and remote handlers when the book unloads", () => {
    const { result, audio } = mount();
    act(() => result.current.playback.unloadBook());
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(session.setPositionState).toHaveBeenLastCalledWith();
    expect(handlers.size).toBe(0);
    expect(audio.getAttribute("src")).toBeNull();
  });

  it("uses the current book after a switch with the same duration and position", () => {
    const { result, audio } = mount();
    act(() => audio.dispatchEvent(new Event("timeupdate")));
    session.setPositionState.mockClear();
    act(() => result.current.playback.loadBook(nextBook));
    expect(session.metadata).toMatchObject({ title: nextBook.title });
    expect(session.setPositionState).toHaveBeenCalled();
    remote("seekforward", { seekOffset: 7 });
    expect(audio.currentTime).toBe(19);
    expect(persistence.saveDurableState).toHaveBeenLastCalledWith("seek", 19_000);
  });
});

describe("synthetic media failures and foreground return", () => {
  it("stops claiming playback after a media error and retries from the same position and rate", () => {
    const { result, audio } = mount();
    act(() => result.current.playback.setPlaybackRate(1.5));
    act(() => result.current.playback.toggle());
    audio.currentTime = 28.25;
    let failure: MediaError | null = { code: 2, message: "Synthetic failed range" } as MediaError;
    Object.defineProperty(audio, "error", { configurable: true, get: () => failure });
    vi.mocked(audio.load).mockImplementation(() => {
      failure = null;
      paused = true;
      audio.currentTime = 0;
      audio.playbackRate = 1;
    });
    act(() => audio.dispatchEvent(new Event("error")));
    expect(result.current.playback.isPlaying).toBe(false);
    expect(session.playbackState).toBe("paused");
    expect(audio.paused).toBe(true);
    expect(persistence.saveDurableState).toHaveBeenCalledWith("pause", 28_250);
    act(() => result.current.playback.toggle());
    expect(audio.load).toHaveBeenCalledOnce();
    expect(audio.currentTime).toBe(28.25);
    expect(audio.playbackRate).toBe(1.5);
    expect(result.current.playback.isPlaying).toBe(true);
    expect(audio.getAttribute("src")).toBe(book.mediaUrl);
  });

  it("reconciles a missed system pause on persisted pageshow without playing or publishing stale progress", () => {
    const { result, audio } = mount();
    act(() => result.current.playback.toggle());
    audio.currentTime = 31.5;
    paused = true;
    persistence.persistProgress.mockClear();
    vi.mocked(audio.play).mockClear();
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(result.current.playback.isPlaying).toBe(false);
    expect(result.current.time).toBe(31_500);
    expect(session.playbackState).toBe("paused");
    expect(audio.play).not.toHaveBeenCalled();
    expect(persistence.persistProgress).not.toHaveBeenCalled();
  });

  it("reconciles a missed system resume when the document becomes visible without applying smart rewind", () => {
    const { result, audio } = mount();
    audio.currentTime = 33.5;
    paused = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current.playback.isPlaying).toBe(true);
    expect(result.current.time).toBe(33_500);
    expect(session.playbackState).toBe("playing");
    expect(audio.currentTime).toBe(33.5);
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("accepts a system pause and play event without a new gesture or a position jump", () => {
    const { result, audio } = mount();
    act(() => result.current.playback.toggle());
    audio.currentTime = 35.5;
    paused = true;
    act(() => audio.dispatchEvent(new Event("pause")));
    expect(result.current.playback.isPlaying).toBe(false);
    paused = false;
    act(() => audio.dispatchEvent(new Event("play")));
    expect(result.current.playback.isPlaying).toBe(true);
    expect(session.playbackState).toBe("playing");
    expect(audio.currentTime).toBe(35.5);
    remote("pause");
    remote("play");
    expect(audio.currentTime).toBe(35.5);
  });
});
