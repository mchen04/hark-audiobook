// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import {
  clearPendingAccountDeletion,
  writePendingAccountDeletion,
} from "@/lib/account-deletion-fence";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

import { SessionRedirect } from "./session-redirect";

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
