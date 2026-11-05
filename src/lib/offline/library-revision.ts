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

export function notifyLibraryChanged(): void {
  revision++;
  try {
    changesChannel()?.postMessage(null);
  } catch {}
}
