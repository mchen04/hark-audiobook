"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useRef } from "react";

const LocalNavigationContext = createContext<(() => void) | null>(null);

/**
 * Keeps enough route provenance to leave a player without fetching a new
 * document. When the real library entry is behind the book, pop back to it so
 * Next restores its own route tree. A direct/shared book URL has no such entry,
 * so AppShell's local library is opened with a native in-document transition.
 */
export function AppNavigation({ pathname, children }: { pathname: string; children: ReactNode }) {
  const currentPathname = useRef(pathname);
  const previousPathname = useRef<string | null>(null);

  useEffect(() => {
    if (pathname === currentPathname.current) return;
    previousPathname.current = currentPathname.current;
    currentPathname.current = pathname;
  }, [pathname]);

  const openLibrary = useCallback(() => {
    if (previousPathname.current === "/library") {
      window.history.back();
      return;
    }
    window.history.pushState(null, "", "/library");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  return (
    <LocalNavigationContext.Provider value={openLibrary}>
      {children}
    </LocalNavigationContext.Provider>
  );
}

export function useOpenLocalLibrary(): (() => void) | null {
  return useContext(LocalNavigationContext);
}
