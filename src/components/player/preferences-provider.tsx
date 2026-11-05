"use client";

import {
  createContext,
  ReactNode,
  RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DEFAULT_PREFERENCES, type PlayerPreferences } from "@/domain/preferences";
import { afterLaunchPaint } from "@/lib/launch-revalidation";
import { fetchPreferences, readCachedPreferences, savePreferences } from "@/lib/preferences";

type PreferencesContextValue = {
  preferences: PlayerPreferences;
  updatePreferences: (patch: Partial<PlayerPreferences>) => void;
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

const FALLBACK_PREFERENCES_REF: RefObject<PlayerPreferences> = Object.freeze({
  current: DEFAULT_PREFERENCES,
});
const PreferencesRefContext = createContext<RefObject<PlayerPreferences>>(FALLBACK_PREFERENCES_REF);

export function PreferencesProvider({ children, userId }: { children: ReactNode; userId: string }) {
  const preferencesRef = useRef<PlayerPreferences>(DEFAULT_PREFERENCES);
  const [preferences, setPreferences] = useState<PlayerPreferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void fetchPreferences(userId)
        .then((fresh) => {
          if (active) setPreferences(fresh);
        })
        .catch(() => undefined);
    };
    void Promise.resolve()
      .then(() => {
        if (active) setPreferences(readCachedPreferences(userId));
      })
      .catch(() => undefined);
    const cancelRevalidation = afterLaunchPaint(refresh);
    window.addEventListener("online", refresh);
    return () => {
      active = false;
      cancelRevalidation();
      window.removeEventListener("online", refresh);
    };
  }, [userId]);

  const updatePreferences = useCallback(
    (patch: Partial<PlayerPreferences>) => {
      const current = preferencesRef.current;
      const next = { ...current, ...patch };
      preferencesRef.current = next;
      setPreferences(next);
      void savePreferences(userId, current, patch);
    },
    [userId],
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({ preferences, updatePreferences }),
    [preferences, updatePreferences],
  );

  return (
    <PreferencesContext.Provider value={value}>
      <PreferencesRefContext.Provider value={preferencesRef}>
        {children}
      </PreferencesRefContext.Provider>
    </PreferencesContext.Provider>
  );
}

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error("usePreferences must be used inside PreferencesProvider");
  return context;
}

export function usePreferencesRef(): RefObject<PlayerPreferences> {
  return useContext(PreferencesRefContext);
}
