import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitAuthBudget } from "./auth-budget";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

it("allows unused and expired signup budgets without sleeping", async () => {
  const wait = vi.fn();
  for (const bucket of [
    undefined,
    { count: 3, lastRequest: Date.now() },
    { count: 5, lastRequest: Date.now() - 600_000 },
  ]) {
    await awaitAuthBudget("sign-up", async () => bucket, wait);
  }
  expect(wait).not.toHaveBeenCalled();
});

it.each([
  ["sign-up", 5, 600_000],
  ["sign-in", 8, 60_000],
] as const)(
  "waits for the last accepted %s request's full idle window",
  async (operation, max, windowMs) => {
    const lastRequest = Date.now() - 10_000;
    const read = vi.fn(async () => ({ count: max, lastRequest }));
    const wait = vi.fn();
    let ready = false;
    const pending = awaitAuthBudget(operation, read, wait).then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(windowMs - 10_000);
    expect(ready).toBe(false);
    expect(wait).toHaveBeenCalledWith(windowMs - 10_000 + 1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    await pending;
    expect(read).toHaveBeenCalledTimes(2);
    expect(ready).toBe(true);
  },
);

it.each([0, 1, 500])("diagnoses renewed saturation %i ms into its single wait", async (offset) => {
  const start = Date.now();
  const read = vi
    .fn()
    .mockResolvedValueOnce({ count: 5, lastRequest: start - 599_000 })
    .mockResolvedValueOnce({ count: 5, lastRequest: start + offset })
    .mockResolvedValue(undefined);
  const wait = vi.fn();
  const pending = awaitAuthBudget("sign-up", read, wait).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  const error = await pending;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("wait limit exceeded");
  expect(wait.mock.calls).toEqual([[2_500]]);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([
  ["sign-in", 8, 60_000],
  ["sign-up", 5, 600_000],
] as const)(
  "bounds repeated saturation of the %s bucket with an actionable failure",
  async (operation, count, windowMs) => {
    let result: unknown;
    const wait = vi.fn();
    void awaitAuthBudget(operation, async () => ({ count, lastRequest: Date.now() }), wait).then(
      () => {
        result = "ready";
      },
      (error: unknown) => {
        result = error;
      },
    );
    await vi.advanceTimersByTimeAsync(windowMs + 1_500);
    expect(result instanceof Error).toBe(true);
    expect((result as Error).message).toContain("wait limit exceeded");
    expect((result as Error).message).toContain("Run suites serially");
    expect(wait.mock.calls.reduce((sum, [ms]) => sum + ms, 0)).toBeLessThanOrEqual(
      windowMs + 1_500,
    );
  },
);

it.each([
  ["sign-in", 6],
  ["sign-up", 4],
] as const)(
  "leaves headroom in the %s bucket without reserving or resetting it",
  async (operation, count) => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ count, lastRequest: Date.now() })
      .mockResolvedValue(undefined);
    let ready = false;
    const pending = awaitAuthBudget(operation, read, vi.fn()).then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    await vi.runAllTimersAsync();
    await pending;
    expect(ready).toBe(true);
  },
);

it("rejects a far-future bucket before extending the runner deadline", async () => {
  let result: unknown;
  const wait = vi.fn();
  void awaitAuthBudget(
    "sign-up",
    async () => ({ count: 5, lastRequest: Date.now() + 86_400_000 }),
    wait,
  ).catch((error: unknown) => {
    result = error;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(result instanceof Error).toBe(true);
  expect(wait).not.toHaveBeenCalled();
});
