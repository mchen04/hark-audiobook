import { beforeEach, expect, it, vi } from "vitest";

const { query, verify } = vi.hoisted(() => ({ query: vi.fn(), verify: vi.fn() }));
vi.mock("../sync/harness/app", () => ({ sql: () => query }));
vi.mock("better-auth/crypto", () => ({ verifyPassword: verify }));

import { findRetainedAccount, RETAINED_CREDENTIAL_DIAGNOSTIC } from "./retained-auth";

beforeEach(() => {
  query.mockReset();
  verify.mockReset().mockResolvedValue(true);
});

async function diagnostic() {
  const error: unknown = await findRetainedAccount("disposable-input").catch(
    (caught: unknown) => caught,
  );
  // Only booleans are printed on failure; an accidentally leaky implementation
  // must not turn this negative test into a credential logger.
  expect(error instanceof Error).toBe(true);
  const message = (error as Error).message;
  expect(message.includes("disposable-input")).toBe(false);
  expect(message.includes("disposable-hash")).toBe(false);
  return message;
}

it("only an absent user permits registration; a verified fixture is reused", async () => {
  query.mockResolvedValueOnce([]);
  await expect(findRetainedAccount("disposable-input")).resolves.toBeUndefined();
  expect(verify).not.toHaveBeenCalled();
  query
    .mockResolvedValueOnce([{ id: "fixture" }])
    .mockResolvedValueOnce([{ password: "disposable-hash" }]);
  await expect(findRetainedAccount("disposable-input")).resolves.toEqual({ id: "fixture" });
  expect(verify).toHaveBeenCalledTimes(1);
});

it("reports the exact actual mismatch diagnostic without appending credentials", async () => {
  query
    .mockResolvedValueOnce([{ id: "fixture" }])
    .mockResolvedValueOnce([{ password: "disposable-hash" }]);
  verify.mockResolvedValue(false);
  const message = await diagnostic();
  expect(message === RETAINED_CREDENTIAL_DIAGNOSTIC).toBe(true);
});

it.each([{ rows: [] }, { rows: [{ password: null }] }])(
  "diagnoses a partial identity instead of a password mismatch: %j",
  async ({ rows }) => {
    query.mockResolvedValueOnce([{ id: "fixture" }]).mockResolvedValueOnce(rows);
    const message = await diagnostic();
    expect(message).toContain("credential is missing");
    expect(message).toContain("separate new disposable database");
    expect(message).not.toContain("Restore the matching");
    expect(verify).not.toHaveBeenCalled();
  },
);

it.each(["identity read", "credential read"])(
  "diagnoses an operational %s failure without leaking raw errors",
  async (stage) => {
    if (stage === "credential read") query.mockResolvedValueOnce([{ id: "fixture" }]);
    query.mockRejectedValueOnce(
      Object.assign(new Error("disposable-input disposable-hash"), { code: "ECONNREFUSED" }),
    );
    const message = await diagnostic();
    expect(message).toContain("database read failed");
    expect(message).toContain("ECONNREFUSED");
    expect(message).not.toContain("credential mismatch");
  },
);

it("diagnoses verifier rejection as operational, preserving safe error category only", async () => {
  query
    .mockResolvedValueOnce([{ id: "fixture" }])
    .mockResolvedValueOnce([{ password: "disposable-hash" }]);
  verify.mockRejectedValue(new TypeError("disposable-input disposable-hash"));
  const message = await diagnostic();
  expect(message).toContain("credential verification failed");
  expect(message).toContain("TypeError");
  expect(message).not.toContain("credential mismatch");
});
