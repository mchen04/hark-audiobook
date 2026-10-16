// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PREFERENCES } from "@/domain/preferences";

import type { PlayerBook } from "@/domain/player";

const { preferenceRef, persistence } = vi.hoisted(() => ({
  preferenceRef: {
    current: {
      smartRewind: false,
      skipBackMs: 15000,
      skipForwardMs: 30000,
      autoplayNextInCollection: false,
    },
  },
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

vi.mock("./preferences-provider", () => ({ usePreferencesRef: () => preferenceRef }));

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

import { hasAppPause } from "./pause-intent";

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
  preferenceRef.current = { ...DEFAULT_PREFERENCES };
  localStorage.clear();
  vi.clearAllMocks();
  paused = true;
  const channels = new Set<EventTarget & { name: string }>();
  vi.stubGlobal(
    "BroadcastChannel",
    class extends EventTarget {
      constructor(public name: string) {
        super();
        channels.add(this);
      }
      postMessage(data: unknown) {
        for (const channel of channels)
          if (channel !== this && channel.name === this.name)
            channel.dispatchEvent(new MessageEvent("message", { data }));
      }
      close() {
        channels.delete(this);
      }
    },
  );
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
  Reflect.deleteProperty(navigator, "audioSession");
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
  it("handles remote stop and leaves track actions unregistered", () => {
    const { result, audio } = mount();
    act(() => result.current.playback.toggle());
    remote("stop");
    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(12);
    expect(handlers.has("nexttrack")).toBe(false);
    expect(handlers.has("previoustrack")).toBe(false);
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

describe("synthetic audio session and interruption recovery", () => {
  it("selects playback audio session before the first explicit play and tolerates an unsupported setter", () => {
    const audioSession = new EventTarget();
    let type = "auto";
    Object.defineProperty(audioSession, "type", {
      configurable: true,
      get: () => type,
      set: (next) => {
        type = next;
      },
    });
    Object.defineProperty(navigator, "audioSession", { configurable: true, value: audioSession });
    const { result, audio } = mount();
    const play = vi.mocked(audio.play).getMockImplementation()!;
    vi.mocked(audio.play).mockImplementation(function (this: HTMLMediaElement) {
      expect(type).toBe("playback");
      return play.call(this);
    });
    act(() => result.current.playback.toggle());
    expect(type).toBe("playback");
    act(() => result.current.playback.pause());
    Object.defineProperty(audioSession, "type", {
      configurable: true,
      get: () => "auto",
      set: () => {
        throw new Error("Unsupported audio session");
      },
    });
    vi.mocked(audio.play).mockImplementation(play);
    act(() => result.current.playback.toggle());
    expect(audio.paused).toBe(false);
  });

  it.each([59000, 60000, 600000, 3600000])(
    "rewinds once on actual play after a synthetic %ims system pause",
    (absenceMs) => {
      vi.useFakeTimers();
      preferenceRef.current.smartRewind = true;
      const { result, audio } = mount();
      act(() => result.current.playback.toggle());
      audio.currentTime = 55.5;
      paused = true;
      act(() => audio.dispatchEvent(new Event("pause")));
      expect(persistence.persistProgress).toHaveBeenLastCalledWith("pause", 55500);
      expect(session.playbackState).toBe("paused");
      expect(session.setPositionState).toHaveBeenLastCalledWith({
        duration: 120,
        position: 55.5,
        playbackRate: 1,
      });
      vi.mocked(audio.play).mockClear();
      vi.setSystemTime(Date.now() + absenceMs);
      act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      expect(audio.play).not.toHaveBeenCalled();
      expect(audio.currentTime).toBe(55.5);
      paused = false;
      act(() => audio.dispatchEvent(new Event("play")));
      const rewind = absenceMs < 60000 ? 0 : absenceMs < 600000 ? 5 : absenceMs < 3600000 ? 15 : 30;
      expect(audio.currentTime).toBe(55.5 - rewind);
      expect(result.current.time).toBe((55.5 - rewind) * 1000);
      act(() => audio.dispatchEvent(new Event("play")));
      expect(audio.currentTime).toBe(55.5 - rewind);
    },
  );

  it("keeps exact system resume when smart rewind is disabled", () => {
    vi.useFakeTimers();
    const { result, audio } = mount();
    act(() => result.current.playback.toggle());
    audio.currentTime = 55;
    paused = true;
    act(() => audio.dispatchEvent(new Event("pause")));
    vi.setSystemTime(Date.now() + 90000);
    remote("play");
    expect(audio.currentTime).toBe(55);
  });

  it("observes an audioSession interruption without a pause event and never starts playback on active", () => {
    vi.useFakeTimers();
    preferenceRef.current.smartRewind = true;
    const audioSession = Object.assign(new EventTarget(), { type: "auto", state: "active" });
    Object.defineProperty(navigator, "audioSession", { configurable: true, value: audioSession });
    const { result, audio } = mount();
    act(() => result.current.playback.toggle());
    audio.currentTime = 55;
    paused = true;
    audioSession.state = "interrupted";
    act(() => audioSession.dispatchEvent(new Event("statechange")));
    expect(persistence.saveDurableState).toHaveBeenLastCalledWith("pause", 55000);
    expect(result.current.playback.isPlaying).toBe(false);
    expect(session.playbackState).toBe("paused");
    vi.mocked(audio.play).mockClear();
    vi.setSystemTime(Date.now() + 90000);
    audioSession.state = "active";
    act(() => audioSession.dispatchEvent(new Event("statechange")));
    expect(audio.play).not.toHaveBeenCalled();
    remote("play");
    expect(audio.currentTime).toBe(50);
  });

  it.each([
    "toggle",
    "pause",
    "remote-pause",
    "remote-stop",
    "sleep-minutes",
    "sleep-chapter",
    "tab",
    "switch",
    "unload",
    "error",
    "finished",
  ])("does not classify %s as a system interruption", (source) => {
    vi.useFakeTimers();
    preferenceRef.current.smartRewind = true;
    const { result, audio } = mount();
    act(() => result.current.playback.toggle());
    audio.currentTime = 55;
    const pause = vi.mocked(audio.pause).getMockImplementation()!;
    vi.mocked(audio.pause).mockImplementation(function (this: HTMLAudioElement) {
      expect(hasAppPause(this)).toBe(true);
      return pause.call(this);
    });
    if (source === "toggle") act(() => result.current.playback.toggle());
    if (source === "pause") act(() => result.current.playback.pause());
    if (source === "remote-pause") remote("pause");
    if (source === "remote-stop") remote("stop");
    if (source === "sleep-minutes") {
      act(() => result.current.playback.setSleepMinutes(1));
      act(() => vi.advanceTimersByTime(60000));
    }
    if (source === "sleep-chapter") {
      act(() => result.current.playback.setSleepAtChapterEnd());
      audio.currentTime = 60;
      act(() => audio.dispatchEvent(new Event("timeupdate")));
    }
    if (source === "tab") {
      const peer = new BroadcastChannel("chapterline-playback");
      act(() => peer.postMessage({ type: "playing", tabId: "other-tab" }));
      peer.close();
    }
    if (source === "switch") act(() => result.current.playback.loadBook(nextBook));
    if (source === "unload") {
      act(() => result.current.playback.unloadBook());
      act(() => result.current.playback.loadBook(nextBook));
    }
    if (source === "error") act(() => audio.dispatchEvent(new Event("error")));
    if (source === "finished") act(() => result.current.playback.markFinished());
    expect(audio.paused).toBe(true);
    const saved = audio.currentTime;
    vi.setSystemTime(Date.now() + 90000);
    paused = false;
    act(() => audio.dispatchEvent(new Event("play")));
    expect(audio.currentTime).toBe(saved);
  });

  it("cancels interruption rewind when an explicit pause arrives while already system-paused", () => {
    vi.useFakeTimers();
    preferenceRef.current.smartRewind = true;
    const { result, audio } = mount();
    act(() => result.current.playback.toggle());
    paused = true;
    audio.currentTime = 55;
    act(() => audio.dispatchEvent(new Event("pause")));
    vi.setSystemTime(Date.now() + 90000);
    remote("pause");
    remote("play");
    expect(audio.currentTime).toBe(55);
  });

  it("clamps interruption rewind at zero and preserves rate without restarting an almost-finished book", () => {
    vi.useFakeTimers();
    preferenceRef.current.smartRewind = true;
    const { result, audio } = mount();
    act(() => result.current.playback.setPlaybackRate(1.5));
    act(() => result.current.playback.toggle());
    for (const position of [3, 119.9]) {
      audio.currentTime = position;
      paused = true;
      act(() => audio.dispatchEvent(new Event("pause")));
      vi.setSystemTime(Date.now() + 90000);
      paused = false;
      act(() => audio.dispatchEvent(new Event("play")));
      expect(audio.currentTime).toBeCloseTo(Math.max(0, position - 5));
      expect(audio.playbackRate).toBe(1.5);
    }
  });
});

it("clears a canceled book-switch pause mark before a later genuine synthetic system pause", () => {
  vi.useFakeTimers();
  preferenceRef.current.smartRewind = true;
  const { result, audio } = mount();
  act(() => result.current.playback.toggle());
  vi.mocked(audio.pause).mockImplementation(() => {
    paused = true;
  });
  act(() => result.current.playback.loadBook(nextBook, true));
  audio.currentTime = 55;
  paused = true;
  act(() => audio.dispatchEvent(new Event("pause")));
  expect(persistence.persistProgress).toHaveBeenLastCalledWith("pause", 55000);
  vi.setSystemTime(Date.now() + 90000);
  paused = false;
  act(() => audio.dispatchEvent(new Event("play")));
  expect(audio.currentTime).toBe(50);
});

it("does not apply interruption rewind to a natural ended pause", () => {
  vi.useFakeTimers();
  preferenceRef.current.smartRewind = true;
  const { result, audio } = mount();
  act(() => result.current.playback.toggle());
  audio.currentTime = 120;
  paused = true;
  Object.defineProperty(audio, "ended", { configurable: true, value: true });
  act(() => audio.dispatchEvent(new Event("pause")));
  vi.setSystemTime(Date.now() + 90000);
  Object.defineProperty(audio, "ended", { configurable: true, value: false });
  paused = false;
  act(() => audio.dispatchEvent(new Event("play")));
  expect(audio.currentTime).toBe(120);
});

it("keeps a deliberate seek during a synthetic interruption when playback resumes", () => {
  vi.useFakeTimers();
  preferenceRef.current.smartRewind = true;
  const { result, audio } = mount();
  act(() => result.current.playback.toggle());
  audio.currentTime = 55;
  paused = true;
  act(() => audio.dispatchEvent(new Event("pause")));
  vi.setSystemTime(Date.now() + 90000);
  act(() => result.current.playback.seek(40000));
  remote("play");
  expect(audio.currentTime).toBe(40);
});

it("keeps native waiting and stalled recovery without reloading or starting audio", () => {
  const { result, audio } = mount();
  act(() => result.current.playback.toggle());
  audio.currentTime = 33;
  vi.mocked(audio.play).mockClear();
  vi.mocked(audio.load).mockClear();
  for (const event of ["waiting", "stalled"]) act(() => audio.dispatchEvent(new Event(event)));
  expect(audio.load).not.toHaveBeenCalled();
  expect(audio.play).not.toHaveBeenCalled();
  expect(audio.currentTime).toBe(33);
  expect(result.current.playback.isPlaying).toBe(true);
});

it("owns one auto-preloaded native element through book changes and unload", () => {
  const { result, audio } = mount();
  expect(audio.preload).toBe("auto");
  expect(audio.tagName).toBe("AUDIO");
  act(() => result.current.playback.loadBook(nextBook));
  expect(document.querySelectorAll("audio")).toHaveLength(1);
  expect(document.querySelector("audio")).toBe(audio);
  act(() => result.current.playback.unloadBook());
  expect(document.querySelector("audio")).toBe(audio);
});

it("does not carry an old interruption across a read-only reconciliation of a missed resume", () => {
  vi.useFakeTimers();
  preferenceRef.current.smartRewind = true;
  const { result, audio } = mount();
  act(() => result.current.playback.toggle());
  audio.currentTime = 55;
  paused = true;
  act(() => audio.dispatchEvent(new Event("pause")));
  vi.setSystemTime(Date.now() + 90000);
  paused = false;
  act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  expect(audio.currentTime).toBe(55);
  paused = true;
  act(() => audio.dispatchEvent(new Event("pause")));
  vi.setSystemTime(Date.now() + 10000);
  paused = false;
  act(() => audio.dispatchEvent(new Event("play")));
  expect(audio.currentTime).toBe(55);
});
