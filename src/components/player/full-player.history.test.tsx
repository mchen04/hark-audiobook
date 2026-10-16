// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SleepMode } from "./use-sleep-timer";

import type { PlayerBook } from "@/domain/player";

const { playback, timeState } = vi.hoisted(() => ({
  timeState: {
    currentTimeMs: 5_000,
    currentChapter: null as {
      id: string;
      position: number;
      title: string;
      startMs: number;
      endMs: number;
    } | null,
  },
  playback: {
    userId: "user-1",
    book: null,
    isPlaying: false,
    playbackRate: 1,
    history: [],
    historyNotice: null,
    sleepMode: null as SleepMode,
    lastEndedAt: 0,
    loadBook: vi.fn(),
    toggle: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    restoreHistoryPosition: vi.fn(),
    moveToChapter: vi.fn(),
    skip: vi.fn(),
    setPlaybackRate: vi.fn(),
    setSleepMinutes: vi.fn(),
    setSleepAtChapterEnd: vi.fn(),
    clearSleep: vi.fn(),
    markFinished: vi.fn(),
    restart: vi.fn(),
    unloadBook: vi.fn(),
  },
}));

vi.mock("./playback-provider", () => ({
  usePlayback: () => playback,
  usePlaybackTime: () => timeState.currentTimeMs,
  usePlaybackDerived: <T,>(derive: () => T) => derive(),
  useCurrentChapter: () => timeState.currentChapter,
}));
vi.mock("./preferences-provider", () => ({
  usePreferences: () => ({
    preferences: {
      skipBackMs: 15_000,
      skipForwardMs: 30_000,
      smartRewind: true,
      autoplayNextInCollection: false,
    },
    updatePreferences: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { FullPlayer } from "./full-player";

const playerBook: PlayerBook = {
  id: "book-1",
  title: "Test Book",
  author: "Test Author",
  durationMs: 60_000,
  mediaUrl: "/offline-media/test",
  coverUrl: null,
  chapters: [
    { id: "one", position: 0, title: "One", startMs: 0, endMs: 30_000 },
    { id: "two", position: 1, title: "Two", startMs: 30_000, endMs: 60_000 },
  ],
  initialPositionMs: 5_000,
  initialProgressOccurredAt: null,
  initialPlaybackRate: 1,
  completed: false,
};
const emptyHistorySnapshot = { entries: [], capturedAt: "2026-07-12T18:30:00.000Z" };

afterEach(cleanup);

describe("full player history wiring", () => {
  beforeEach(() => {
    for (const value of Object.values(playback)) {
      if (typeof value === "function" && "mockClear" in value) value.mockClear();
    }
    playback.sleepMode = null;
    timeState.currentChapter = playerBook.chapters[0]!;
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("routes every visible playback control through the recorded provider actions", () => {
    const { rerender } = render(
      <FullPlayer playerBook={playerBook} historySnapshot={emptyHistorySnapshot} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Back 15 seconds" }));
    expect(playback.skip).toHaveBeenCalledWith(-15_000);
    fireEvent.click(screen.getByRole("button", { name: "Forward 30 seconds" }));
    expect(playback.skip).toHaveBeenCalledWith(30_000);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(playback.toggle).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("slider", { name: "Audiobook position" }), {
      target: { value: "12000" },
    });
    expect(playback.seek).toHaveBeenCalledWith(12_000);
    fireEvent.change(screen.getByRole("combobox", { name: "Playback speed" }), {
      target: { value: "1.5" },
    });
    expect(playback.setPlaybackRate).toHaveBeenCalledWith(1.5);
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }));
    expect(playback.moveToChapter).toHaveBeenCalledWith(playerBook.chapters[1], "next");

    timeState.currentChapter = playerBook.chapters[1]!;
    rerender(<FullPlayer playerBook={playerBook} historySnapshot={emptyHistorySnapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous chapter" }));
    expect(playback.moveToChapter).toHaveBeenCalledWith(playerBook.chapters[0], "previous");

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("dialog", { name: "Playback history" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("compact player options", () => {
  it("keeps the native speed picker and uses multiplication signs", () => {
    render(<FullPlayer playerBook={playerBook} />);
    const speed = screen.getByRole("combobox", { name: "Playback speed" });
    expect(speed.tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: "1×" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "1.25×" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "1x" })).not.toBeInTheDocument();
  });

  it("shows compact sleep labels, accessible state and the selected preset", () => {
    playback.sleepMode = null;
    const view = render(<FullPlayer playerBook={playerBook} />);
    expect(view.container.querySelector(".sleep-menu summary")).toHaveAccessibleName("Sleep timer");
    expect(screen.getByText("Sleep", { exact: true })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Turn off", hidden: true }),
    ).not.toBeInTheDocument();
    playback.sleepMode = { kind: "time", endsAt: Date.now() + 12 * 60_000, minutes: 15 };
    view.rerender(<FullPlayer playerBook={playerBook} />);
    const summary = view.container.querySelector(".sleep-menu summary")!;
    expect(summary).toHaveAccessibleName("Sleep timer, 12 minutes left");
    expect(summary).toHaveTextContent("12m");
    fireEvent.click(summary);
    expect(screen.getByRole("button", { name: "15m" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "30m" }));
    expect(playback.setSleepMinutes).toHaveBeenCalledWith(30);
    expect(view.container.querySelector(".sleep-menu")).not.toHaveAttribute("open");
    playback.sleepMode = { kind: "chapter" };
    view.rerender(<FullPlayer playerBook={playerBook} />);
    expect(summary).toHaveAccessibleName("Sleep timer, chapter end");
    expect(summary).toHaveTextContent("Chapter end");
    fireEvent.click(summary);
    expect(screen.getByRole("button", { name: "End of chapter" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(playback.clearSleep).toHaveBeenCalled();
  });
});
