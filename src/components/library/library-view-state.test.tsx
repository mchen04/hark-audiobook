// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";

import { LibraryViewProvider, useLibraryViewState } from "./library-view-state";

function ViewHarness() {
  const { view, setView } = useLibraryViewState();
  return (
    <>
      <output aria-label="query">{view.query}</output>
      <button
        type="button"
        onClick={() => setView((current) => ({ ...current, query: "Aldertown" }))}
      >
        Search
      </button>
    </>
  );
}

function renderView(userId: string) {
  return render(
    <LibraryViewProvider userId={userId}>
      <ViewHarness />
    </LibraryViewProvider>,
  );
}

afterEach(cleanup);

describe("LibraryViewProvider", () => {
  it("survives a restored route tree without crossing account boundaries", () => {
    const first = renderView("view-user-a");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByLabelText("query")).toHaveTextContent("Aldertown");
    first.unmount();

    const restored = renderView("view-user-a");
    expect(screen.getByLabelText("query")).toHaveTextContent("Aldertown");
    restored.unmount();

    renderView("view-user-b");
    expect(screen.getByLabelText("query")).toBeEmptyDOMElement();
  });
});
