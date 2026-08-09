import { beforeEach, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

const transcript = vi.hoisted(() => ({
  deleteAll: vi.fn(),
}));

vi.mock("./transcript-store", () => ({
  deleteAllTranscriptsForUser: transcript.deleteAll,
}));

import { clearLocalDataForUser } from "./library";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new FakeIDBFactory());
  vi.stubGlobal("localStorage", {
    length: 0,
    key: () => null,
    removeItem: () => undefined,
  });
  vi.stubGlobal("caches", {
    open: vi.fn(async () => ({ delete: vi.fn(async () => true) })),
  });
  transcript.deleteAll.mockReset();
});

it("reports transcript cleanup failure instead of declaring the account purge complete", async () => {
  transcript.deleteAll.mockRejectedValue(new Error("transcript transaction failed"));

  await expect(clearLocalDataForUser("user-a")).rejects.toThrow(/transcript transaction failed/);
});
