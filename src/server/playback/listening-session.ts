import "server-only";

import { getOwnedBook } from "@/server/books/queries";
import { db } from "@/server/db/client";
import { listeningSessions } from "@/server/db/schema";
import { isValidListeningSession } from "@/server/playback/listening-session-policy";
import { claimMutationReceipt } from "@/server/sync/mutation-receipt";

export type ListeningStretch = {
  startedAt: string;
  endedAt: string;
  startPositionMs: number;
  endPositionMs: number;
};

export type ListeningSessionOutcome = "recorded" | "duplicate" | "unknown-book" | "rejected";

export async function recordListeningSession(
  userId: string,
  bookId: string,
  stretch: ListeningStretch,
  mutationId?: string,
): Promise<ListeningSessionOutcome> {
  const startedAt = new Date(stretch.startedAt);
  const endedAt = new Date(stretch.endedAt);
  const owned = await getOwnedBook(userId, bookId);
  if (!owned?.durationMs) return "unknown-book";
  if (
    !isValidListeningSession({
      ...stretch,
      startedAt,
      endedAt,
      durationMs: owned.durationMs,
    })
  ) {
    return "rejected";
  }
  const listenedMs = endedAt.getTime() - startedAt.getTime();

  const duplicate = await db.transaction(async (transaction) => {
    if (mutationId) {
      const receipt = await claimMutationReceipt(transaction, { mutationId, userId, bookId });
      if (!receipt.claimed) return true;
    }
    await transaction.insert(listeningSessions).values({
      userId,
      bookId,
      startedAt,
      endedAt,
      startPositionMs: stretch.startPositionMs,
      endPositionMs: stretch.endPositionMs,
      listenedMs,
    });
    return false;
  });
  return duplicate ? "duplicate" : "recorded";
}

export function listeningSessionResponse(outcome: ListeningSessionOutcome): Response {
  switch (outcome) {
    case "unknown-book":
      return Response.json({ error: "Not found" }, { status: 404 });
    case "rejected":
      return Response.json({ recorded: false }, { status: 422 });
    case "duplicate":
      return Response.json({ recorded: true, duplicate: true });
    default:
      return Response.json({ recorded: true, duplicate: false }, { status: 201 });
  }
}
