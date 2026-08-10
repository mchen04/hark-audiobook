// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";

import { AccountMenu } from "./account-menu";

/**
 * The sign-out call site — `docs/local-first.md` section 11.
 *
 * Two properties, both of which this component got wrong:
 *
 *  1. It must NOT clear `chapterline:active-user` itself. That key is the only
 *     record of whose data is on this device, and the purge reads it. Clearing
 *     it here raced the purge across a dynamic import and won, and the purge
 *     then read `null` and swept nothing but the page cache.
 *  2. It may navigate only because the auth hook durably records any warning
 *     for the login page, which survives this provider subtree being revoked.
 */

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const auth = vi.hoisted(() => ({
  signOut: vi.fn(async () => undefined),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: auth.signOut },
}));

beforeEach(() => {
  // Vitest runs without globals, so testing-library's automatic cleanup hook
  // never registers; without this every render stacks up in one document.
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
