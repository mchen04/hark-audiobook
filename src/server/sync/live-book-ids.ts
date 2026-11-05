import { liveBookDigest } from "@/lib/offline/live-book-digest";

export async function liveBookIdsFor(
  ids: string[],
  deviceDigest: string | null,
): Promise<string[] | null> {
  if (!deviceDigest) return ids;
  return (await liveBookDigest(ids)) === deviceDigest ? null : ids;
}
