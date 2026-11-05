import { PREFERENCES_DEFAULTS_VERSION, type PlayerPreferences } from "@/domain/preferences";

export type PreferenceWritePolicy = {
  patch: Partial<PlayerPreferences>;
  smartRewindExplicit?: boolean;
};

export function applyPreferenceWritePolicy(
  request: Partial<PlayerPreferences>,
  defaultsVersionHeader: string | null,
): PreferenceWritePolicy {
  const patch = { ...request };
  if (patch.smartRewind === undefined) return { patch };
  if (defaultsVersionHeader !== String(PREFERENCES_DEFAULTS_VERSION)) return { patch };
  return { patch, smartRewindExplicit: patch.smartRewind };
}

export function resolveSmartRewind(
  row: Pick<PlayerPreferences, "smartRewind"> & { smartRewindExplicit: boolean },
): boolean {
  return row.smartRewindExplicit && row.smartRewind;
}

export function serializePlayerPreferences(
  row: PlayerPreferences & { smartRewindExplicit: boolean },
): PlayerPreferences {
  return {
    skipBackMs: row.skipBackMs,
    skipForwardMs: row.skipForwardMs,
    smartRewind: resolveSmartRewind(row),
    autoplayNextInCollection: row.autoplayNextInCollection,
  };
}
