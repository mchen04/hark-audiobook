import { expect, it, vi } from "vitest";

import type { Transaction } from "./client";
import { SyncBusyError, syncReceipt } from "./sync-receipt";

it.each([false, true])(
  "maps a lock timeout to busy before reading a receipt (wrapped: %s)",
  async (wrapped) => {
    const timeout = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ timeout: "0" }])
      .mockRejectedValueOnce(wrapped ? new Error("Failed query", { cause: timeout }) : timeout);
    await expect(
      syncReceipt({ execute } as unknown as Transaction, "fixture-user"),
    ).rejects.toBeInstanceOf(SyncBusyError);
    // No floor/state read on a failed admission. Rollback belongs to db.transaction.
    expect(execute).toHaveBeenCalledTimes(2);
  },
);

it("does not disguise an operational database error as retryable admission", async () => {
  const fault = new Error("connection lost", { cause: { code: "08006" } });
  const execute = vi
    .fn()
    .mockResolvedValueOnce([{ timeout: "250ms" }])
    .mockRejectedValueOnce(fault);
  await expect(syncReceipt({ execute } as unknown as Transaction, "fixture-user")).rejects.toBe(
    fault,
  );
  expect(execute).toHaveBeenCalledTimes(2);
});
