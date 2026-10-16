// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import {
  clearPendingAccountDeletion,
  writePendingAccountDeletion,
} from "@/lib/account-deletion-fence";

const { replace, finishDeletion } = vi.hoisted(() => ({
  replace: vi.fn(),
  finishDeletion: vi.fn(),
}));
vi.mock("@/lib/account-deletion", () => ({
  finishPendingAccountDeletion: finishDeletion,
  abandonExpiredAccountDeletion: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

import { SessionRedirect } from "./session-redirect";
import { PendingAccountDeletionRunner } from "@/components/pending-account-deletion-runner";

beforeEach(() => {
  localStorage.clear();
  replace.mockReset();
});

afterEach(cleanup);

it("persists the verified server identity before navigation can load an anonymous cached shell", () => {
  replace.mockImplementation(() => {
    expect(localStorage.getItem(ACTIVE_USER_KEY)).toBe("verified-user");
  });
  render(<SessionRedirect userId="verified-user" />);
  expect(replace).toHaveBeenCalledWith("/library");
  expect(screen.getByRole("status")).toHaveTextContent("Opening your library…");
});

it("keeps a pending account deletion closed instead of restoring its identity", () => {
  writePendingAccountDeletion({
    userId: "deleting-user",
    deleteToken: "disposable-token",
    phase: "prepared",
    createdAt: Date.now(),
  });
  render(<SessionRedirect userId="deleting-user" />);
  expect(localStorage.getItem(ACTIVE_USER_KEY)).toBeNull();
  expect(replace).not.toHaveBeenCalled();
  clearPendingAccountDeletion("deleting-user");
});

it("hands a fenced login to the working deletion runner instead of showing an endless opening status", async () => {
  finishDeletion.mockResolvedValue({ ok: false, phase: "commit" });
  writePendingAccountDeletion({
    userId: "fenced-user",
    deleteToken: "disposable-token",
    phase: "purged",
    createdAt: Date.now(),
  });
  render(
    <>
      <SessionRedirect userId="fenced-user" />
      <PendingAccountDeletionRunner />
    </>,
  );
  await screen.findByRole("heading", { name: "Deletion needs attention" });
  expect(screen.queryByText("Opening your library…")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(finishDeletion).toHaveBeenCalledTimes(2));
  expect(localStorage.getItem(ACTIVE_USER_KEY)).toBeNull();
  expect(replace).not.toHaveBeenCalled();
  clearPendingAccountDeletion("fenced-user");
});
