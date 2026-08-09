"use client";

import { useCallback, useState } from "react";
import { usePathname } from "next/navigation";

const BOOK_PATH = /^\/books\/([0-9a-fA-F-]{36})\/?$/;

/**
 * The offline book route: which book, if any, this library document is
 * standing in for.
 *
 * The service worker answers a navigation it cannot fetch with the cached
 * library document, whatever URL was asked for. Sitting at a `/books/` URL
 * therefore means the user asked to play a book and the network could not
 * answer — so this device's own copy answers instead. Online the book page
 * renders and the library never mounts at that URL, which is why opening
 * a book needs no "am I online?" question anywhere.
 */
export function useOfflineBookRoute(): {
  /** The book this document was asked for, when the URL names one. */
  bookId: string | null;
  /** Returns to the library grid; see the history semantics below. */
  leavePlayer: () => void;
} {
  // Next's router owns every client navigation, including native history
  // changes. Deriving from it avoids a second route state that can get stuck on
  // the old book while the URL/header/mini-player have already moved on.
  const bookId = bookIdFromPath(usePathname());
  /** Whether the library is one history entry back; see `leavePlayer`. */
  const [cameFromLibrary] = useState(openedFromLibrary);

  /**
   * Leaving the player is a real `back()` whenever there is something to go
   * back to: the entry is popped rather than overwritten, so the book stays
   * ahead in history, forward still works, and this button and the system back
   * button agree about where the library is. The `popstate` above is what then
   * puts the grid on screen. A document opened straight at a book URL — a
   * shared link, a bookmark — has only the browser behind it, so there the URL
   * is rewritten in place rather than walking the user out of the app.
   */
  const leavePlayer = useCallback(() => {
    if (cameFromLibrary) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", "/library");
    // Native history calls are integrated with Next's router. The event also
    // keeps non-Next consumers (and the DOM-level regression test) in step.
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [cameFromLibrary]);

  return { bookId, leavePlayer };
}

/** The book this document was asked for, when the URL names one. */
function bookIdFromPath(pathname: string): string | null {
  return BOOK_PATH.exec(pathname)?.[1] || null;
}

/**
 * Whether the library itself is the entry behind this document.
 *
 * Deliberately narrower than "came from this origin": the mini player links to
 * a book from every screen that carries it, so a document opened from
 * `/settings` has Settings one entry back, and a button labelled Library that
 * went back would land somewhere it did not name.
 */
function openedFromLibrary(): boolean {
  if (typeof document === "undefined" || !document.referrer) return false;
  try {
    const referrer = new URL(document.referrer);
    if (referrer.origin !== window.location.origin) return false;
    return referrer.pathname === "/" || referrer.pathname === "/library";
  } catch {
    return false;
  }
}
