import type { Metadata } from "next";

import { requireSession } from "@/server/auth-session";

export const metadata: Metadata = { title: "Library" };

/**
 * The library is rendered from this device's mirror, so the server renders no
 * book rows into the HTML (`docs/local-first.md` section 8). The session is
 * still checked here: it is what redirects a signed-out visitor, and it is the
 * only thing this page needs the database for.
 */
export default async function LibraryPage() {
  await requireSession();
  // AppShell owns the persistent client library so a local player-to-library
  // transition never has to replace the PlaybackProvider.
  return null;
}
