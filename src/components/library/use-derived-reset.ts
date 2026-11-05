"use client";

import { useCallback, useState } from "react";

export function useSeedFollowingValue<T>(seed: T): [T, (value: T) => void] {
  const [choice, setChoice] = useState<{ from: T; value: T } | null>(null);
  const value = choice?.from === seed ? choice.value : seed;
  const set = useCallback((next: T) => setChoice({ from: seed, value: next }), [seed]);
  return [value, set];
}

export function usePageWindow(key: string): { pages: number; showMore: () => void } {
  const [pagination, setPagination] = useState({ key: "", pages: 1 });
  const pages = pagination.key === key ? pagination.pages : 1;
  const showMore = useCallback(() => setPagination({ key, pages: pages + 1 }), [key, pages]);
  return { pages, showMore };
}
