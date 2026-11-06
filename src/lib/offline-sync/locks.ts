import { withKeyedLock } from "@/lib/keyed-lock";

export const SYNC_REQUEST_TIMEOUT_MS = 15_000;

export async function withSyncRequest<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function withSyncNetworkLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  return withKeyedLock(`chapterline-sync-network:${userId}`, operation);
}

export function withBookProjectionLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  return withKeyedLock(`chapterline-book-projection:${userId}`, operation);
}
