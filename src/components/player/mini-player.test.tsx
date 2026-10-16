// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/library" }));
vi.mock("./playback-provider", () => ({
  usePlayback: () => ({
    book: { id: "book", title: "Hark Book", author: "Reader", durationMs: 120000 },
    isPlaying: false,
    toggle: vi.fn(),
    skip: vi.fn(),
  }),
  usePlaybackTime: () => 0,
}));
vi.mock("./preferences-provider", () => ({
  usePreferences: () => ({ preferences: { skipBackMs: 15000, skipForwardMs: 30000 } }),
}));

import { MiniPlayer } from "./mini-player";

afterEach(cleanup);

it("uses word initials matching the library and full-player covers", () => {
  render(<MiniPlayer />);
  expect(
    screen.getByRole("complementary", { name: "Now playing" }).querySelector(".mini-cover"),
  ).toHaveTextContent("HB");
});
