// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, expect, it, vi } from "vitest";

import { SignOutNotice } from "./sign-out-notice";

const report = vi.hoisted(() => ({
  value: null as null | {
    undelivered: Array<{ kind: string; entityId: string; queuedAt: number }>;
    purgeFailed: boolean;
  },
}));

vi.mock("@/lib/auth-client", () => ({
  peekSignOutReport: () => report.value,
  takeSignOutReport: () => {
    const value = report.value;
    report.value = null;
    return value;
  },
  describeSignOutReport: (value: typeof report.value) =>
    value?.purgeFailed ? "Some account data remains on this device." : "Two changes were lost.",
}));

beforeEach(() => {
  cleanup();
  report.value = null;
});

it("shows a purge warning after the account provider has already unmounted", async () => {
  report.value = { undelivered: [], purgeFailed: true };
  render(<SignOutNotice />);

  expect(await screen.findByRole("alert")).toHaveTextContent("account data remains");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dismiss" })));
  expect(screen.queryByRole("alert")).toBeNull();
});
