"use client";

import { useCallback, useState } from "react";

/**
 * Two flavours of "derived state with reset", named so they read as the idiom
 * they are. Neither uses an effect: a value tagged with the seed or key it was
 * made under is simply not carried across a different one.
 */

/**
 * A value that follows `seed` until the user works it themselves — and follows
 * it again the next time that URL/server seed changes.
 */
export function useSeedFollowingValue<T>(seed: T): [T, (value: T) => void] {
  const [choice, setChoice] = useState<{ from: T; value: T } | null>(null);
  const value = choice?.from === seed ? choice.value : seed;
  const set = useCallback((next: T) => setChoice({ from: seed, value: next }), [seed]);
  return [value, set];
}

/**
 * A page count that resets to 1 whenever `key` changes. A filter change resets
 * the page window without an effect: the window is simply not carried across a
 * different set of filters.
 */
export function usePageWindow(key: string): { pages: number; showMore: () => void } {
  const [pagination, setPagination] = useState({ key: "", pages: 1 });
  const pages = pagination.key === key ? pagination.pages : 1;
  const showMore = useCallback(() => setPagination({ key, pages: pages + 1 }), [key, pages]);
  return { pages, showMore };
}
