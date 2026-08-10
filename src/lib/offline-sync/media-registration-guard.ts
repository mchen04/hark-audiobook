import { withKeyedLock } from "@/lib/keyed-lock";

import { database } from "./db";
import {
  queuedMediaRegistrationIdentity,
  sameQueuedMediaRegistration,
  type QueuedMediaRegistrationIdentity,
} from "./media-registration-identity";

export type MediaRegistrationIdentity = QueuedMediaRegistrationIdentity;

/** Live registration and replay share one causal stream per source rendition. */
export function withMediaRegistrationLock<T>(
  userId: string,
  identity: MediaRegistrationIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(
    `chapterline:media-registration:${userId}:${identity.fingerprint}:${identity.renditionKey}`,
    operation,
  );
}

/** A replacement cannot register until deletion of its predecessor has settled. */
export async function hasPendingDeleteForMediaRegistration(
  userId: string,
  identity: MediaRegistrationIdentity,
): Promise<boolean> {
  const db = await database();
  let cursor = await db.transaction("mutations").store.index("by-user").openCursor(userId);
  while (cursor) {
    const row = cursor.value;
    if (
      row.kind === "delete" &&
      sameQueuedMediaRegistration(queuedMediaRegistrationIdentity(row), identity)
    ) {
      return true;
    }
    cursor = await cursor.continue();
  }
  return false;
}
