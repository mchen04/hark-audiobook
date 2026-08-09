// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, expect, it, vi } from "vitest";

const deletion = vi.hoisted(() => ({
  finish: vi.fn(),
  abandon: vi.fn(),
  pending: true,
}));

vi.mock("@/lib/account-deletion", () => ({
  finishPendingAccountDeletion: deletion.finish,
  abandonExpiredAccountDeletion: deletion.abandon,
}));
vi.mock("@/lib/account-deletion-fence", () => ({
  readPendingAccountDeletion: () => (deletion.pending ? { userId: "user-a" } : null),
  subscribeAccountDeletionFence: () => () => undefined,
}));

import { PendingAccountDeletionRunner } from "./pending-account-deletion-runner";

beforeEach(() => {
  deletion.pending = true;
  deletion.finish.mockReset();
});

it("shows a stable account-wide status while the settings provider is torn down", () => {
  deletion.finish.mockReturnValue(new Promise(() => undefined));

  render(<PendingAccountDeletionRunner />);

  expect(screen.getByRole("heading", { name: "Deleting your account…" })).toBeInTheDocument();
  expect(deletion.finish).toHaveBeenCalledOnce();
});

it("explains how to recover when the server intent expired", async () => {
  deletion.finish.mockResolvedValue({ ok: false, phase: "expired" });

  render(<PendingAccountDeletionRunner />);

  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Return to sign in" })).toBeInTheDocument(),
  );
  expect(screen.getByText(/deletion request expired/i)).toBeInTheDocument();
});
