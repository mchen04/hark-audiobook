"use client";

import {
  createContext,
  Dispatch,
  ReactNode,
  SetStateAction,
  useCallback,
  useContext,
  useState,
} from "react";

import type { SortOrder, StatusFilter } from "./library-view";

export type LibraryViewState = {
  query: string;
  status: StatusFilter;
  onDevice: boolean;
  activeTag: string | null;
  sort: SortOrder;
  view: "grid" | "list";
};

const DEFAULT_VIEW: LibraryViewState = {
  query: "",
  status: "all",
  onDevice: false,
  activeTag: null,
  sort: "activity",
  view: "grid",
};

const documentViews = new Map<string, LibraryViewState>();

const LibraryViewContext = createContext<
  { view: LibraryViewState; setView: Dispatch<SetStateAction<LibraryViewState>> } | undefined
>(undefined);

export function LibraryViewProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [record, setRecord] = useState<{ userId: string; view: LibraryViewState }>({
    userId,
    view: documentViews.get(userId) ?? DEFAULT_VIEW,
  });
  const view = documentViews.get(userId) ?? (record.userId === userId ? record.view : DEFAULT_VIEW);
  const setView: Dispatch<SetStateAction<LibraryViewState>> = useCallback(
    (next) => {
      setRecord((current) => {
        const currentView =
          documentViews.get(userId) ?? (current.userId === userId ? current.view : DEFAULT_VIEW);
        const view = typeof next === "function" ? next(currentView) : next;
        documentViews.set(userId, view);
        return {
          userId,
          view,
        };
      });
    },
    [userId],
  );

  return (
    <LibraryViewContext.Provider value={{ view, setView }}>{children}</LibraryViewContext.Provider>
  );
}

export function useLibraryViewState() {
  const state = useContext(LibraryViewContext);
  if (!state) throw new Error("useLibraryViewState must be used inside LibraryViewProvider");
  return state;
}
