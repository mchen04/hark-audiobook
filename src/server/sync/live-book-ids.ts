import { liveBookDigest } from "@/lib/offline/live-book-digest";

/**
 * The complete id list a final pull page carries, or null when the device
 * proved it already holds exactly these ids. Applying a list that matches the
 * device's own set deletes nothing, so leaving it out changes no outcome.
 * Without a matching digest, the list is always sent.
 */
export async function liveBookIdsFor(
  ids: string[],
  deviceDigest: string | null,
): Promise<string[] | null> {
  if (!deviceDigest) return ids;
  return (await liveBookDigest(ids)) === deviceDigest ? null : ids;
}
