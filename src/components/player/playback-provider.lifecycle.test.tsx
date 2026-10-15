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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaSession");
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
