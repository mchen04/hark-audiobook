// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppNavigation, useOpenLocalLibrary } from "./app-navigation";

function LibraryButton() {
  const openLibrary = useOpenLocalLibrary();
  return (
    <button type="button" onClick={openLibrary || undefined}>
      Library
    </button>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("AppNavigation", () => {
  it("pops the real library entry behind a book", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const view = render(
      <AppNavigation pathname="/library">
        <LibraryButton />
      </AppNavigation>,
    );
    view.rerender(
      <AppNavigation pathname="/books/11111111-2222-3333-4444-555555555555">
        <LibraryButton />
      </AppNavigation>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Library" }));

    expect(back).toHaveBeenCalledTimes(1);
  });

  it("opens the shell-owned library in place for a direct book URL", () => {
    window.history.replaceState(null, "", "/books/11111111-2222-3333-4444-555555555555");
    render(
      <AppNavigation pathname="/books/11111111-2222-3333-4444-555555555555">
        <LibraryButton />
      </AppNavigation>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Library" }));

    expect(window.location.pathname).toBe("/library");
  });
});
