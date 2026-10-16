import { describe, expect, it, vi } from "vitest";

import {
  cancelMediaStart,
  loadMediaSource,
  mediaTime,
  primeMediaStart,
  setMediaTime,
} from "./media-source";

function element(muted = false) {
  return Object.assign(new EventTarget(), {
    src: "",
    currentTime: 0,
    readyState: 0,
    HAVE_FUTURE_DATA: 3,
    muted,
    paused: true,
    seeking: false,
    load: vi.fn(),
    pause: vi.fn(),
  }) as unknown as HTMLAudioElement;
}

function preroll(audio: HTMLAudioElement) {
  Object.defineProperty(audio, "readyState", { value: 3, configurable: true });
  audio.dispatchEvent(new Event("canplay"));
}

describe("saved media start", () => {
  it("keeps the saved position for progress readers while the native element prerolls silently", () => {
    const audio = element();
    loadMediaSource(audio, "/book", 42);
    expect(mediaTime(audio)).toBe(42);
    expect(audio.currentTime).toBe(0);
    expect(audio.muted).toBe(true);
    preroll(audio);
    expect(audio.currentTime).toBe(42);
    expect(audio.muted).toBe(true);
    audio.dispatchEvent(new Event("seeked"));
    expect(audio.muted).toBe(false);
    audio.currentTime = 43;
    expect(mediaTime(audio)).toBe(43);
    expect(audio.load).not.toHaveBeenCalled();
  });

  it("uses a newer user seek and stays paused when the pending start settles", () => {
    const audio = element();
    loadMediaSource(audio, "/book", 42);
    setMediaTime(audio, 60);
    expect(mediaTime(audio)).toBe(60);
    expect(audio.currentTime).toBe(0);
    preroll(audio);
    expect(audio.currentTime).toBe(60);
    audio.dispatchEvent(new Event("seeked"));
    expect(audio.paused).toBe(true);
    expect(audio.muted).toBe(false);
  });

  it("discards the old target when the source changes and preserves the original mute setting", () => {
    const audio = element(true);
    loadMediaSource(audio, "/first", 42);
    loadMediaSource(audio, "/second", 18);
    preroll(audio);
    expect(audio.currentTime).toBe(18);
    audio.dispatchEvent(new Event("seeked"));
    expect(audio.muted).toBe(true);
    audio.currentTime = 19;
    expect(mediaTime(audio)).toBe(19);
  });

  it("clears pending listeners and mute when an unloaded source later emits media events", () => {
    const audio = element();
    loadMediaSource(audio, "/book", 42);
    cancelMediaStart(audio);
    preroll(audio);
    expect(audio.currentTime).toBe(0);
    expect(audio.muted).toBe(false);
    expect(mediaTime(audio)).toBe(0);
  });

  it("does not release sound for an unsettled or incorrect seek", () => {
    const audio = element();
    loadMediaSource(audio, "/book", 42);
    audio.dispatchEvent(new Event("seeked"));
    expect(audio.muted).toBe(true);
    preroll(audio);
    audio.currentTime = 0;
    audio.dispatchEvent(new Event("seeked"));
    expect(audio.muted).toBe(true);
    expect(mediaTime(audio)).toBe(42);
    audio.currentTime = 42;
    audio.dispatchEvent(new Event("seeked"));
    expect(audio.muted).toBe(false);
  });

  it("allows a pending restart at zero without waiting for a seek event that is unnecessary", () => {
    const audio = element();
    loadMediaSource(audio, "/book", 42);
    setMediaTime(audio, 0);
    preroll(audio);
    expect(audio.currentTime).toBe(0);
    expect(audio.muted).toBe(false);
    expect(mediaTime(audio)).toBe(0);
  });

  it("marks cancellation as an app pause before restoring audible output", () => {
    const audio = element();
    const paused = vi.fn();
    audio.addEventListener("hark:app-pause", paused);
    loadMediaSource(audio, "/book", 42);
    Object.defineProperty(audio, "paused", { value: false });
    vi.mocked(audio.pause).mockImplementation(() => {
      expect(audio.muted).toBe(true);
      expect(paused).toHaveBeenCalledTimes(1);
    });
    cancelMediaStart(audio);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.muted).toBe(false);
  });

  it("releases mute when a settled seek event arrives after the native clock advances", () => {
    const audio = element();
    loadMediaSource(audio, "/book", 42);
    preroll(audio);
    audio.currentTime = 42.4;
    audio.dispatchEvent(new Event("seeked"));
    expect(audio.muted).toBe(false);
    expect(mediaTime(audio)).toBe(42.4);
  });

  it("accepts the native duration when it clamps the saved start", () => {
    const audio = element();
    Object.assign(audio, { duration: 40 });
    loadMediaSource(audio, "/book", 42);
    preroll(audio);
    expect(audio.currentTime).toBe(40);
    audio.dispatchEvent(new Event("seeked"));
    expect(audio.muted).toBe(false);
    expect(mediaTime(audio)).toBe(40);
  });

  it("clears a native default start once before early play and retains the chosen rate", () => {
    const audio = element();
    Object.assign(audio, {
      src: "/book",
      currentTime: 42,
      playbackRate: 1.75,
      getAttribute: () => "/book",
    });
    vi.mocked(audio.load).mockImplementation(() => {
      audio.playbackRate = 1;
    });
    primeMediaStart(audio);
    expect(audio.currentTime).toBe(0);
    expect(mediaTime(audio)).toBe(42);
    expect(audio.playbackRate).toBe(1.75);
    expect(audio.muted).toBe(true);
    expect(audio.load).toHaveBeenCalledTimes(1);
    primeMediaStart(audio);
    expect(audio.load).toHaveBeenCalledTimes(1);
    preroll(audio);
    audio.dispatchEvent(new Event("seeked"));
    expect(audio.currentTime).toBe(42);
    expect(audio.muted).toBe(false);
  });

  it("does not reprime a warm source when its paused ready state drops", () => {
    const audio = element();
    Object.assign(audio, { getAttribute: () => "/book", playbackRate: 1 });
    loadMediaSource(audio, "/book", 42, false);
    Object.defineProperty(audio, "readyState", { value: 4, configurable: true });
    audio.dispatchEvent(new Event("canplaythrough"));
    Object.defineProperty(audio, "readyState", { value: 2, configurable: true });
    const seek = vi.fn();
    let currentTime = 42;
    Object.defineProperty(audio, "currentTime", {
      get: () => currentTime,
      set: (value) => {
        currentTime = value;
        seek(value);
      },
      configurable: true,
    });
    primeMediaStart(audio);
    expect(audio.load).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
    expect(audio.currentTime).toBe(42);
    expect(audio.muted).toBe(false);
  });

  it("leaves a playing element alone while it waits for data", () => {
    const audio = element();
    Object.assign(audio, {
      src: "/book",
      currentTime: 42,
      paused: false,
      getAttribute: () => "/book",
    });
    primeMediaStart(audio);
    expect(audio.load).not.toHaveBeenCalled();
    expect(audio.currentTime).toBe(42);
    expect(audio.muted).toBe(false);
  });
});
