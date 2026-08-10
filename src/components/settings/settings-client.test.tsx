// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, expect, it, vi } from "vitest";

import { SettingsClient } from "./settings-client";

const EMAIL = "owner@hark.test";
const USER_ID = "user-settings-1";
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const deletion = vi.hoisted(() => ({
  remember: vi.fn(),
  finish: vi.fn(async (): Promise<{ ok: true } | { ok: false; phase: "purge" | "commit" }> => ({
    ok: true,
  })),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/account-deletion", () => ({
  rememberPendingAccountDeletion: deletion.remember,
  finishPendingAccountDeletion: deletion.finish,
}));
vi.mock("@/components/player/playback-provider", () => ({
  usePlayback: () => ({ userId: USER_ID }),
}));
vi.mock("@/components/player/preferences-provider", () => ({
  usePreferences: () => ({
    preferences: {
      skipBackMs: 15_000,
      skipForwardMs: 30_000,
      smartRewind: false,
      autoplayNextInCollection: false,
    },
    updatePreferences: vi.fn(),
  }),
}));

beforeEach(() => {
  cleanup();
  router.replace.mockClear();
  router.refresh.mockClear();
  deletion.remember.mockClear();
  deletion.finish.mockReset();
  deletion.finish.mockResolvedValue({ ok: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ deleteToken: "delete-token-with-enough-entropy-123456" })),
  );
});

async function deleteAccount(): Promise<void> {
  render(<SettingsClient email={EMAIL} />);
  fireEvent.change(screen.getByLabelText(/type your email to confirm/i), {
    target: { value: EMAIL },
  });
  fireEvent.change(screen.getByLabelText(/current password/i), {
    target: { value: "a-real-password" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /delete my account/i }));
  });
}

it("journals the verified intent before finishing local and server deletion", async () => {
  await deleteAccount();

  expect(deletion.remember).toHaveBeenCalledWith(
    USER_ID,
    "delete-token-with-enough-entropy-123456",
  );
  expect(deletion.finish).toHaveBeenCalledTimes(1);
  expect(router.replace).toHaveBeenCalledWith("/register");
  expect(router.refresh).not.toHaveBeenCalled();
});

it("does not commit server deletion when the device purge fails", async () => {
  deletion.finish.mockResolvedValueOnce({ ok: false, phase: "purge" });

  await deleteAccount();

  expect(screen.getByText(/account was not deleted/i)).toBeInTheDocument();
  expect(router.replace).not.toHaveBeenCalled();
});
