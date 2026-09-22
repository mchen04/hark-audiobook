// An in-memory invalidation hint, never a source of book or account data.
// Other tabs send only a signal; readers still query their own account indexes.
let revision = 0;
let channel: BroadcastChannel | null | undefined;

function changesChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  try {
    channel = new BroadcastChannel("chapterline:library-changed");
    channel.addEventListener("message", () => revision++);
  } catch {
    channel = null;
  }
  return channel;
}

export function libraryRevision(): number {
  changesChannel();
  return revision;
}

/** Call only after the durable mirror transaction has committed. */
export function notifyLibraryChanged(): void {
  revision++;
  try {
    changesChannel()?.postMessage(null);
  } catch {
    // A notification failure cannot undo or reject an already committed write.
  }
}
