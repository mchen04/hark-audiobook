"use client";

import { useCallback, useState } from "react";
import { usePathname } from "next/navigation";

const BOOK_PATH = /^\/books\/([0-9a-fA-F-]{36})\/?$/;

export function useOfflineBookRoute(): {
  bookId: string | null;
  leavePlayer: () => void;
} {
  const bookId = bookIdFromPath(usePathname());
  const [cameFromLibrary] = useState(openedFromLibrary);

  const leavePlayer = useCallback(() => {
    if (cameFromLibrary) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", "/library");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [cameFromLibrary]);

  return { bookId, leavePlayer };
}

function bookIdFromPath(pathname: string): string | null {
  return BOOK_PATH.exec(pathname)?.[1] || null;
}

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
