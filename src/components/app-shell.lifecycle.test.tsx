// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { PlayerBook } from "@/domain/player";
import { DEFAULT_PREFERENCES } from "@/domain/preferences";
import { rememberActiveUserId } from "@/lib/active-user";
import { ACTIVE_USER_KEY } from "@/lib/app-keys";

const { saveDurableState } = vi.hoisted(() => ({ saveDurableState: vi.fn() }));

vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));
vi.mock("@/components/account-menu", () => ({ AccountMenu: () => null }));
vi.mock("@/components/brand-mark", () => ({ BrandMark: () => null }));
vi.mock("@/components/library/library-client", () => ({ LibraryClient: () => null }));
vi.mock("@/components/player/mini-player", () => ({ MiniPlayer: () => null }));
vi.mock("@/lib/preferences", () => ({
  readCachedPreferences: () => DEFAULT_PREFERENCES,
  fetchPreferences: async () => DEFAULT_PREFERENCES,
  savePreferences: vi.fn(),
}));
vi.mock("@/lib/playback-history", () => ({
  loadPlaybackHistory: async () => [],
  storePlaybackAction: async () => "stored",
  replayPlaybackHistory: async () => undefined,
}));
vi.mock("@/lib/listening-tracker", () => ({
  createListeningTracker: () => ({ begin: vi.fn(), end: vi.fn(), reset: vi.fn() }),
  queueListeningSession: vi.fn(),
}));
vi.mock("@/components/player/use-progress-persistence", () => ({
  useProgressPersistence: (userId: string) => ({
    persistProgress: vi.fn().mockResolvedValue(undefined),
    saveDurableState: (...args: unknown[]) => saveDurableState(userId, ...args),
    onListeningTick: vi.fn(),
    markInProgress: vi.fn(),
    markPositionChanged: vi.fn(),
    resetPositionChanged: vi.fn(),
    reconcileCompletion: vi.fn(),
  }),
}));

import { AppShell } from "./app-shell";
import { usePlayback } from "./player/playback-provider";
import { usePreferences } from "./player/preferences-provider";

const book: PlayerBook = {
  id: "book-a",
  title: "Account A's book",
  author: "Author",
  durationMs: 120_000,
  mediaUrl: "/offline-media/account-a",
  coverUrl: null,
  initialPositionMs: 12_000,
  initialProgressOccurredAt: null,
  initialPlaybackRate: 1,
  completed: false,
  chapters: [],
};

function Probe() {
  const playback = usePlayback();
  const { preferences, updatePreferences } = usePreferences();
  return (
    <>
      <output aria-label="owner">{playback.userId}</output>
      <output aria-label="book">{playback.book?.id ?? "none"}</output>
      <output aria-label="skip">{preferences.skipBackMs}</output>
      <button onClick={() => playback.loadBook(book)}>Open book</button>
      <button onClick={() => playback.seek(40_000)}>Seek</button>
      <button onClick={() => updatePreferences({ skipBackMs: 45_000 })}>Set skip</button>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  rememberActiveUserId("account-a");
  saveDurableState.mockReset();
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("clears the previous account's book and preferences after an identity change", async () => {
  render(
    <AppShell>
      <Probe />
    </AppShell>,
  );
  await waitFor(() => expect(screen.getByLabelText("owner").textContent).toBe("account-a"));
  fireEvent.click(screen.getByRole("button", { name: "Open book" }));
  fireEvent.click(screen.getByRole("button", { name: "Set skip" }));
  expect(screen.getByLabelText("book").textContent).toBe(book.id);
  expect(screen.getByLabelText("skip").textContent).toBe("45000");
  const previousAudio = document.querySelector("audio");

  act(() => {
    localStorage.setItem(ACTIVE_USER_KEY, "account-b");
    window.dispatchEvent(
      new StorageEvent("storage", { key: ACTIVE_USER_KEY, newValue: "account-b" }),
    );
  });

  await waitFor(() => expect(screen.getByLabelText("owner").textContent).toBe("account-b"));
  fireEvent.click(screen.getByRole("button", { name: "Seek" }));
  expect(saveDurableState.mock.calls.some(([owner]) => owner === "account-b")).toBe(false);
  expect(screen.getByLabelText("book").textContent).toBe("none");
  expect(screen.getByLabelText("skip").textContent).toBe(String(DEFAULT_PREFERENCES.skipBackMs));
  expect(document.querySelector("audio")).not.toBe(previousAudio);
});

it("keeps the player when the same account's shell rerenders", async () => {
  const view = render(
    <AppShell>
      <Probe />
    </AppShell>,
  );
  await waitFor(() => expect(screen.getByLabelText("owner").textContent).toBe("account-a"));
  fireEvent.click(screen.getByRole("button", { name: "Open book" }));
  const audio = document.querySelector("audio");
  view.rerender(
    <AppShell>
      <Probe />
    </AppShell>,
  );

  expect(screen.getByLabelText("book").textContent).toBe(book.id);
  expect(document.querySelector("audio")).toBe(audio);
});
