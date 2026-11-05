import type { QueuedProgress } from "./db";

export function progressMutationKey(
  entry: Pick<QueuedProgress, "userId" | "bookId" | "deviceId">,
): string {
  return `${entry.userId}:progress:${entry.bookId}:${entry.deviceId}`;
}

export function metadataMutationKey(userId: string, bookId: string): string {
  return `${userId}:metadata:${bookId}`;
}

export function archiveMutationKey(userId: string, bookId: string): string {
  return `${userId}:archive:${bookId}`;
}

export function tagMutationKey(userId: string, bookId: string, tagName: string): string {
  return `${userId}:tag:${bookId}:${tagName.toLowerCase()}`;
}

export function collectionMutationKey(
  userId: string,
  collectionId: string,
  bookId: string,
): string {
  return `${userId}:collection:${collectionId}:${bookId}`;
}

export function eventMutationKey(
  userId: string,
  kind: "import" | "delete" | "history",
  entityId: string,
  mutationId: string,
): string {
  return `${userId}:${kind}:${entityId}:${mutationId}`;
}
