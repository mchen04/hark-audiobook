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
    { count: 4, lastRequest: Date.now() },
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
    expect(wait).toHaveBeenCalledWith(windowMs - 10_000 + 100);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(read).toHaveBeenCalledTimes(2);
    expect(ready).toBe(true);
  },
);

it("rereads persistent storage after waiting instead of forgetting another consumer", async () => {
  const start = Date.now();
  const read = vi
    .fn()
    .mockResolvedValueOnce({ count: 5, lastRequest: start - 599_000 })
    .mockResolvedValueOnce({ count: 5, lastRequest: start })
    .mockResolvedValue(undefined);
  const wait = vi.fn();
  const pending = awaitAuthBudget("sign-up", read, wait);
  await vi.runAllTimersAsync();
  await pending;
  expect(wait.mock.calls).toEqual([[1_100], [599_000]]);
  expect(read).toHaveBeenCalledTimes(3);
});
