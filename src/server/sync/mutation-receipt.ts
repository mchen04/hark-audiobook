import "server-only";

import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/server/db/client";
import { playbackActionReceipts } from "@/server/db/schema";

export type ReceiptClaim = {
  claimed: boolean;
  recordedAt: Date | null;
};

export async function claimMutationReceipt(
  transaction: Transaction,
  input: { mutationId: string; userId: string; bookId: string },
): Promise<ReceiptClaim> {
  const [inserted] = await transaction
    .insert(playbackActionReceipts)
    .values({ id: input.mutationId, userId: input.userId, bookId: input.bookId })
    .onConflictDoNothing({ target: playbackActionReceipts.id })
    .returning({ recordedAt: playbackActionReceipts.recordedAt });
  if (inserted) return { claimed: true, recordedAt: inserted.recordedAt };

  const [existing] = await transaction
    .select({ recordedAt: playbackActionReceipts.recordedAt })
    .from(playbackActionReceipts)
    .where(
      and(
        eq(playbackActionReceipts.id, input.mutationId),
        eq(playbackActionReceipts.userId, input.userId),
        eq(playbackActionReceipts.bookId, input.bookId),
      ),
    )
    .limit(1);
  return { claimed: false, recordedAt: existing?.recordedAt ?? null };
}
