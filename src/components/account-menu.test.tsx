// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";

import { AccountMenu } from "./account-menu";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const auth = vi.hoisted(() => ({
  signOut: vi.fn(async () => undefined),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: auth.signOut },
}));

beforeEach(() => {
  cleanup();
  router.replace.mockClear();
  router.refresh.mockClear();
  auth.signOut.mockClear();
  localStorage.clear();
});

async function clickSignOut(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Sign out/ }));
  });
}

describe("account menu sign-out", () => {
  it("leaves the active-user key for the purge to own", async () => {
    localStorage.setItem(ACTIVE_USER_KEY, "user-a");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    render(<AccountMenu email="a@hark.test" />);

    await clickSignOut();

    expect(
      removeItem.mock.calls.map(([key]) => key),
      "the sign-out call site cleared the key the purge needs to read",
    ).not.toContain(ACTIVE_USER_KEY);
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(router.refresh).not.toHaveBeenCalled();
    removeItem.mockRestore();
  });

  it("moves to the login page after the purge-owned durable notice is recorded", async () => {
    render(<AccountMenu email="a@hark.test" />);

    await clickSignOut();

    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
