import { beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";

const purge = vi.hoisted(() => ({
  order: [] as string[],
  undelivered: [] as Array<{ kind: string; entityId: string; queuedAt: number }>,
  failure: null as unknown,
  wedged: false,
  fencedAtPurge: false,
}));

vi.mock("@/lib/offline/account-purge", () => ({
  drainBeforeSignOut: async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    purge.order.push("drained");
    return purge.undelivered;
  },
  purgeOnSignOut: async (
    userId: string,
    options?: { alreadyDrained?: Array<{ kind: string; entityId: string; queuedAt: number }> },
  ) => {
    const { isAccountSignOutFenced } = await import("@/lib/account-deletion-fence");
    purge.fencedAtPurge = isAccountSignOutFenced(userId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    purge.order.push(options?.alreadyDrained ? "purged" : "purged-without-a-drain");
    return { undelivered: options?.alreadyDrained ?? [], failure: purge.failure };
  },
  purgeOnSignIn: async () => {
    if (purge.wedged) await new Promise(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    purge.order.push("purged-on-sign-in");
    return [];
  },
  purgeCachedPages: async () => {
    purge.order.push("pages-only");
  },
}));

const SIGN_OUT = "https://hark.test/api/auth/sign-out";
const USER_A = "user-a";

function fakeLocalStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

let storage: ReturnType<typeof fakeLocalStorage>;
let session: ReturnType<typeof fakeLocalStorage>;

beforeEach(async () => {
  purge.order = [];
  purge.undelivered = [];
  purge.failure = null;
  purge.wedged = false;
  purge.fencedAtPurge = false;
  storage = fakeLocalStorage();
  session = fakeLocalStorage();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", session);
  const { takeSignOutReport } = await import("@/lib/auth-client");
  takeSignOutReport();
});

async function signOutThroughHooks(): Promise<void> {
  const { authFetchHooks } = await import("@/lib/auth-client");
  await authFetchHooks.onRequest({ url: SIGN_OUT, method: "POST" });
  await authFetchHooks.onSuccess({ request: { url: SIGN_OUT } });
}

describe("sign-out hooks", () => {
  it("drains before the request and does not return until the purge has run", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);

    await signOutThroughHooks();
    purge.order.push("sign-out-returned");

    expect(
      purge.order,
      "the caller regained control while the account's data was still on the device",
    ).toStrictEqual(["drained", "purged", "sign-out-returned"]);
    expect(purge.fencedAtPurge, "the purge started before new account writes were fenced").toBe(
      true,
    );
  });

  it("reopens the account if the sign-out request itself fails", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    const { authFetchHooks } = await import("@/lib/auth-client");
    const { isAccountSignOutFenced } = await import("@/lib/account-deletion-fence");

    await authFetchHooks.onRequest({ url: SIGN_OUT, method: "POST" });
    expect(isAccountSignOutFenced(USER_A)).toBe(true);

    await authFetchHooks.onError({ request: { url: SIGN_OUT } });
    expect(isAccountSignOutFenced(USER_A)).toBe(false);
  });

  it("reports writes the drain could not deliver to whoever signed out", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    purge.undelivered = [{ kind: "metadata", entityId: "book", queuedAt: 1 }];

    await signOutThroughHooks();

    expect(
      session.getItem("chapterline:sign-out-report"),
      "the warning existed only in the provider subtree that revocation unmounts",
    ).not.toBeNull();

    const { takeSignOutReport } = await import("@/lib/auth-client");
    const report = takeSignOutReport();
    expect(report?.undelivered).toStrictEqual([
      { kind: "metadata", entityId: "book", queuedAt: 1 },
    ]);
    expect(report?.purgeFailed).toBe(false);
    expect(session.getItem("chapterline:sign-out-report")).toBe(null);
  });

  it("reports a purge that failed without failing the sign-out", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    purge.failure = new Error("Cache Storage is unavailable");

    await expect(signOutThroughHooks()).resolves.toBeUndefined();

    const { takeSignOutReport } = await import("@/lib/auth-client");
    expect(takeSignOutReport()?.purgeFailed).toBe(true);
  });

  it("consumes the report, so the same warning cannot be shown twice", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    purge.undelivered = [{ kind: "tag", entityId: "book", queuedAt: 1 }];

    await signOutThroughHooks();

    const { takeSignOutReport } = await import("@/lib/auth-client");
    expect(takeSignOutReport()?.undelivered.length).toBe(1);
    expect(takeSignOutReport()).toBe(null);
  });

  it("sweeps the page cache when no account was recorded on this device", async () => {
    await signOutThroughHooks();

    expect(purge.order).toStrictEqual(["pages-only"]);
  });

  it("does not drain on a sign-in, where the open session belongs to somebody else", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    const { authFetchHooks, whenAccountPurgeSettled } = await import("@/lib/auth-client");
    const url = "https://hark.test/api/auth/sign-in/email";

    await authFetchHooks.onRequest({ url, method: "POST" });
    await authFetchHooks.onSuccess({ request: { url }, data: { user: { id: "user-b" } } });
    await whenAccountPurgeSettled();

    expect(purge.order).toStrictEqual(["purged-on-sign-in"]);
  });
});

describe("sign-in waits for the sweep", () => {
  const SIGN_IN = "https://hark.test/api/auth/sign-in/email";

  async function signInThroughHooks(): Promise<void> {
    const { authFetchHooks } = await import("@/lib/auth-client");
    await authFetchHooks.onRequest({ url: SIGN_IN, method: "POST" });
    await authFetchHooks.onSuccess({ request: { url: SIGN_IN }, data: { user: { id: "user-b" } } });
  }

  it("does not hand control back while the previous account is still on the device", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);

    await signInThroughHooks();
    purge.order.push("sign-in-returned");

    expect(
      purge.order,
      "the incoming account was let in mid-sweep, over the departing account's data",
    ).toStrictEqual(["purged-on-sign-in", "sign-in-returned"]);
  });

  it("reopens a committed fence only after that account authenticates again", async () => {
    const { commitAccountSignOutFence, isAccountSignOutFenced } =
      await import("@/lib/account-deletion-fence");
    commitAccountSignOutFence();
    expect(isAccountSignOutFenced("user-b")).toBe(true);

    await signInThroughHooks();

    expect(isAccountSignOutFenced("user-b")).toBe(false);
  });

  it("still lets the user in when the sweep wedges, leaving it for the next sign-in", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    purge.wedged = true;
    vi.useFakeTimers();
    try {
      const { SIGN_IN_PURGE_TIMEOUT_MS } = await import("@/lib/auth-client");
      let letIn = false;
      const signIn = signInThroughHooks().then(() => {
        letIn = true;
      });

      await vi.advanceTimersByTimeAsync(SIGN_IN_PURGE_TIMEOUT_MS - 1);
      expect(letIn, "the bound opened early, before the sweep had had its chance").toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await signIn;
      expect(letIn, "a wedged storage layer locked the user out of their own account").toBe(true);
      expect(purge.order, "the wedged sweep somehow reported success").toStrictEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
