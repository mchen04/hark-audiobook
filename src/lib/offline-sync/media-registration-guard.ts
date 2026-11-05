import { withKeyedLock } from "@/lib/keyed-lock";

import { database } from "./db";
import {
  queuedMediaRegistrationIdentity,
  sameQueuedMediaRegistration,
  type QueuedMediaRegistrationIdentity,
} from "./media-registration-identity";

export type MediaRegistrationIdentity = QueuedMediaRegistrationIdentity;

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
