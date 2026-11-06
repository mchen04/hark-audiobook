import { withKeyedLock } from "@/lib/keyed-lock";

export function withBookProjectionLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  return withKeyedLock(`chapterline-book-projection:${userId}`, operation);
}
