import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("reuses a device identity saved by an earlier install", async () => {
  vi.stubGlobal("localStorage", { getItem: () => "existing-device", setItem: vi.fn() });
  const { getDeviceId } = await import("./device-id");
  expect(getDeviceId()).toBe("existing-device");
  expect(localStorage.setItem).not.toHaveBeenCalled();
});

it("keeps one identity for the session when storage is blocked", async () => {
  vi.resetModules();
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
  });
  const { getDeviceId } = await import("./device-id");
  const first = getDeviceId();
  expect(first).toMatch(/^ephemeral:/);
  expect(getDeviceId()).toBe(first);
});
