import {
  DEFAULT_PREFERENCES,
  isPreferenceWriteId,
  type PlayerPreferences,
  PREFERENCES_DEFAULTS_HEADER,
  PREFERENCES_DEFAULTS_VERSION,
  PREFERENCES_LEGACY_REPLAY_HEADER,
  PREFERENCES_WRITE_ID_HEADER,
  SKIP_BOUNDS_MS,
} from "@/domain/preferences";
import { assertAccountWritable, isAccountWriteFenced } from "@/lib/account-deletion-fence";

const activePreferenceWrites = new Map<string, Promise<void>>();
const armedReconnectRetries = new Map<string, () => void>();

type CachedPreferences = {
  preferences: PlayerPreferences;
  defaultsVersion: number;
  revision: number;
  pendingRevision: number | null;
  pendingSeriesId: string | null;
  pendingWriteId: string | null;
  pendingPatch: Partial<PlayerPreferences> | null;
  legacyPendingPreferences: PlayerPreferences | null;
  legacyPendingWriteId: string | null;
  pendingSince: number;
};

export type PendingPreferenceWrite = {
  kind: "preferences";
  entityId: string;
  queuedAt: number;
};

export function readCachedPreferences(userId: string): PlayerPreferences {
  return readCache(userId).preferences;
}

const EMPTY_CACHE: CachedPreferences = {
  preferences: DEFAULT_PREFERENCES,
  defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
  revision: 0,
  pendingRevision: null,
  pendingSeriesId: null,
  pendingWriteId: null,
  pendingPatch: null,
  legacyPendingPreferences: null,
  legacyPendingWriteId: null,
  pendingSince: 0,
};

function readCache(userId: string): CachedPreferences {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    if (!raw) return EMPTY_CACHE;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "preferences" in parsed) {
      const envelope = parsed as Partial<CachedPreferences>;
      const revision = finiteOr(envelope.revision, 0);
      const pendingRevision =
        typeof envelope.pendingRevision === "number" && Number.isFinite(envelope.pendingRevision)
          ? envelope.pendingRevision
          : null;
      const pendingWriteId =
        pendingRevision !== null && isPreferenceWriteId(envelope.pendingWriteId)
          ? envelope.pendingWriteId
          : null;
      const pendingSeriesId =
        pendingRevision !== null && isPreferenceWriteId(envelope.pendingSeriesId)
          ? envelope.pendingSeriesId
          : null;
      const storedPreferences = normalize(envelope.preferences);
      const preferences = { ...storedPreferences };
      const defaultsVersion = finiteOr(envelope.defaultsVersion, 0);
      const isLegacy = defaultsVersion < PREFERENCES_DEFAULTS_VERSION;
      if (isLegacy) {
        preferences.smartRewind = DEFAULT_PREFERENCES.smartRewind;
      }
      const savedPatch = normalizePatch(envelope.pendingPatch);
      const hasSavedPatch = Object.prototype.hasOwnProperty.call(envelope, "pendingPatch");
      const savedLegacy =
        envelope.legacyPendingPreferences && typeof envelope.legacyPendingPreferences === "object"
          ? normalize(envelope.legacyPendingPreferences)
          : null;
      let pendingPatch: Partial<PlayerPreferences> | null = null;
      let legacyPendingPreferences: PlayerPreferences | null = null;
      if (pendingRevision !== null) {
        if (isLegacy) {
          pendingPatch = savedPatch;
          legacyPendingPreferences = storedPreferences;
        } else {
          pendingPatch = hasSavedPatch ? savedPatch : savedLegacy ? null : storedPreferences;
          legacyPendingPreferences = savedLegacy;
        }
      }
      const legacyPendingWriteId =
        legacyPendingPreferences && isPreferenceWriteId(envelope.legacyPendingWriteId)
          ? envelope.legacyPendingWriteId
          : null;
      return {
        preferences,
        defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
        revision,
        pendingRevision,
        pendingSeriesId,
        pendingWriteId,
        pendingPatch,
        legacyPendingPreferences,
        legacyPendingWriteId,
        pendingSince: finiteOr(envelope.pendingSince, 0),
      };
    }
    const legacyPreferences = normalize(parsed);
    legacyPreferences.smartRewind = DEFAULT_PREFERENCES.smartRewind;
    return { ...EMPTY_CACHE, preferences: legacyPreferences };
  } catch {
    return EMPTY_CACHE;
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cachePreferences(userId: string, cached: CachedPreferences): void {
  if (isAccountWriteFenced(userId)) return;
  localStorage.setItem(cacheKey(userId), JSON.stringify(cached));
}

export async function fetchPreferences(userId: string): Promise<PlayerPreferences> {
  await flushPendingPreferences(userId);
  const before = readCache(userId);
  if (before.pendingRevision !== null) return before.preferences;
  try {
    const response = await fetch("/api/preferences", { cache: "no-store" });
    if (!response.ok) throw new Error("Preferences could not be loaded.");
    const payload = (await response.json()) as {
      preferences: unknown;
      defaultsVersion?: unknown;
    };
    const preferences = normalize(payload.preferences);
    if (payload.defaultsVersion !== PREFERENCES_DEFAULTS_VERSION) {
      preferences.smartRewind = before.preferences.smartRewind;
    }
    const latest = readCache(userId);
    if (latest.pendingRevision === null && latest.revision === before.revision) {
      cachePreferences(userId, { ...latest, preferences });
      return preferences;
    }
    return latest.preferences;
  } catch {
    return readCache(userId).preferences;
  }
}

export async function savePreferences(
  userId: string,
  current: PlayerPreferences,
  patch: Partial<PlayerPreferences>,
): Promise<PlayerPreferences> {
  assertAccountWritable(userId);
  const next = normalize({ ...current, ...patch });
  const cached = readCache(userId);
  const revision = cached.revision + 1;
  const continuingSeries = cached.pendingRevision !== null;
  const seriesId = continuingSeries
    ? (cached.pendingSeriesId ?? crypto.randomUUID())
    : crypto.randomUUID();
  const writeId = continuingSeries
    ? (cached.pendingWriteId ?? crypto.randomUUID())
    : crypto.randomUUID();
  const legacyWriteId = cached.legacyPendingPreferences
    ? (cached.legacyPendingWriteId ?? crypto.randomUUID())
    : null;
  const pendingPatch = { ...(cached.pendingPatch ?? {}), ...(normalizePatch(patch) ?? {}) };
  cachePreferences(userId, {
    preferences: next,
    defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
    revision,
    pendingRevision: revision,
    pendingSeriesId: seriesId,
    pendingWriteId: writeId,
    pendingPatch,
    legacyPendingPreferences: cached.legacyPendingPreferences,
    legacyPendingWriteId: legacyWriteId,
    pendingSince: cached.pendingRevision === null ? Date.now() : cached.pendingSince,
  });
  await enqueuePreferenceWrite(userId, seriesId).catch(() => undefined);
  armReconnectRetry(userId);
  return next;
}

export async function flushPendingPreferences(
  userId: string,
  fetchFn?: typeof fetch,
): Promise<void> {
  let cached = readCache(userId);
  if (cached.pendingRevision === null) return;
  const seriesId = cached.pendingSeriesId ?? crypto.randomUUID();
  const writeId = cached.pendingWriteId ?? crypto.randomUUID();
  const legacyWriteId = cached.legacyPendingPreferences
    ? (cached.legacyPendingWriteId ?? crypto.randomUUID())
    : null;
  if (
    cached.pendingSeriesId === null ||
    cached.pendingWriteId === null ||
    cached.legacyPendingWriteId !== legacyWriteId
  ) {
    cached = {
      ...cached,
      pendingSeriesId: seriesId,
      pendingWriteId: writeId,
      legacyPendingWriteId: legacyWriteId,
    };
    cachePreferences(userId, cached);
  }
  await enqueuePreferenceWrite(userId, seriesId, fetchFn).catch(() => undefined);
  armReconnectRetry(userId);
}

export function listPendingPreferenceWrites(userId: string): PendingPreferenceWrite[] {
  const cached = readCache(userId);
  if (cached.pendingRevision === null) return [];
  return [{ kind: "preferences", entityId: userId, queuedAt: cached.pendingSince }];
}

export function invalidatePreferenceWrites(userId: string): void {
  activePreferenceWrites.delete(userId);
  disarmReconnectRetry(userId);
}

function armReconnectRetry(userId: string): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  if (readCache(userId).pendingRevision === null) {
    disarmReconnectRetry(userId);
    return;
  }
  if (armedReconnectRetries.has(userId)) return;
  const retry = () => {
    void flushPendingPreferences(userId);
  };
  armedReconnectRetries.set(userId, retry);
  window.addEventListener("online", retry);
}

function disarmReconnectRetry(userId: string): void {
  const retry = armedReconnectRetries.get(userId);
  if (!retry) return;
  armedReconnectRetries.delete(userId);
  if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
    window.removeEventListener("online", retry);
  }
}

function enqueuePreferenceWrite(
  userId: string,
  seriesId: string,
  fetchFn?: typeof fetch,
): Promise<void> {
  const previous = activePreferenceWrites.get(userId) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const send = fetchFn ?? fetch;
      let latest = readCache(userId);
      if (latest.pendingSeriesId !== seriesId) return;

      if (latest.legacyPendingPreferences && latest.legacyPendingWriteId) {
        const legacyBody = latest.legacyPendingPreferences;
        const legacyWriteId = latest.legacyPendingWriteId;
        const acknowledged = await sendPreferencePatch(send, legacyBody, false, legacyWriteId);
        if (!patchIncludes(acknowledged, legacyBody)) {
          throw new Error("The server returned a mismatched legacy preference receipt.");
        }
        latest = readCache(userId);
        if (latest.pendingSeriesId === seriesId && latest.legacyPendingWriteId === legacyWriteId) {
          cachePreferences(userId, {
            ...latest,
            legacyPendingPreferences: null,
            legacyPendingWriteId: null,
          });
        }
      }

      for (;;) {
        latest = readCache(userId);
        if (latest.pendingSeriesId !== seriesId) return;
        const body = latest.pendingPatch;
        if (!body || Object.keys(body).length === 0) break;
        const writeId = latest.pendingWriteId ?? crypto.randomUUID();
        if (latest.pendingWriteId === null) {
          latest = { ...latest, pendingWriteId: writeId };
          cachePreferences(userId, latest);
        }
        const acknowledged = await sendPreferencePatch(send, body, true, writeId);
        latest = readCache(userId);
        if (latest.pendingSeriesId !== seriesId || latest.pendingWriteId !== writeId) continue;
        const remaining = removeAcknowledgedFields(latest.pendingPatch, acknowledged);
        cachePreferences(userId, {
          ...latest,
          pendingPatch: remaining,
          pendingWriteId: remaining ? crypto.randomUUID() : null,
        });
      }

      latest = readCache(userId);
      if (
        latest.pendingSeriesId === seriesId &&
        !latest.pendingPatch &&
        !latest.legacyPendingPreferences
      ) {
        cachePreferences(userId, {
          ...latest,
          pendingRevision: null,
          pendingSeriesId: null,
          pendingWriteId: null,
          pendingPatch: null,
          legacyPendingPreferences: null,
          legacyPendingWriteId: null,
          pendingSince: 0,
        });
        disarmReconnectRetry(userId);
      }
    })
    .finally(() => {
      if (activePreferenceWrites.get(userId) === next) activePreferenceWrites.delete(userId);
    });
  activePreferenceWrites.set(userId, next);
  return next;
}

async function sendPreferencePatch(
  send: typeof fetch,
  body: Partial<PlayerPreferences>,
  currentVersion: boolean,
  writeId: string,
): Promise<Partial<PlayerPreferences>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (currentVersion) {
    headers[PREFERENCES_DEFAULTS_HEADER] = String(PREFERENCES_DEFAULTS_VERSION);
  } else {
    headers[PREFERENCES_LEGACY_REPLAY_HEADER] = "1";
  }
  headers[PREFERENCES_WRITE_ID_HEADER] = writeId;
  const response = await send("/api/preferences/v2", {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Preferences could not be saved.");

  const acknowledgment = (await response.json().catch(() => null)) as {
    defaultsVersion?: unknown;
    preferences?: unknown;
    acknowledgedWriteId?: unknown;
    acknowledgedPatch?: unknown;
  } | null;
  if (acknowledgment?.defaultsVersion !== PREFERENCES_DEFAULTS_VERSION) {
    throw new Error("A predecessor server could not acknowledge the current preference write.");
  }
  if (!acknowledgment.preferences || typeof acknowledgment.preferences !== "object") {
    throw new Error("The server returned no applied preferences acknowledgment.");
  }
  if (acknowledgment.acknowledgedWriteId !== writeId) {
    throw new Error("The server did not acknowledge this preference write.");
  }
  if (!acknowledgment.acknowledgedPatch || typeof acknowledgment.acknowledgedPatch !== "object") {
    throw new Error("The server returned no idempotent preference receipt.");
  }
  return acknowledgment.acknowledgedPatch as Partial<PlayerPreferences>;
}

function patchIncludes(
  acknowledged: Partial<PlayerPreferences>,
  expected: Partial<PlayerPreferences>,
): boolean {
  return (
    Object.entries(expected) as Array<
      [keyof PlayerPreferences, PlayerPreferences[keyof PlayerPreferences]]
    >
  ).every(([key, value]) => acknowledged[key] === value);
}

function removeAcknowledgedFields(
  pending: Partial<PlayerPreferences> | null,
  acknowledged: Partial<PlayerPreferences>,
): Partial<PlayerPreferences> | null {
  if (!pending) return null;
  const remaining = { ...pending };
  for (const [key, value] of Object.entries(acknowledged) as Array<
    [keyof PlayerPreferences, PlayerPreferences[keyof PlayerPreferences]]
  >) {
    if (remaining[key] === value) delete remaining[key];
  }
  return Object.keys(remaining).length > 0 ? remaining : null;
}

function normalizePatch(value: unknown): Partial<PlayerPreferences> | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PlayerPreferences>;
  const patch: Partial<PlayerPreferences> = {};
  if (raw.skipBackMs !== undefined) {
    patch.skipBackMs = boundSkip(raw.skipBackMs, DEFAULT_PREFERENCES.skipBackMs);
  }
  if (raw.skipForwardMs !== undefined) {
    patch.skipForwardMs = boundSkip(raw.skipForwardMs, DEFAULT_PREFERENCES.skipForwardMs);
  }
  if (typeof raw.smartRewind === "boolean") patch.smartRewind = raw.smartRewind;
  if (typeof raw.autoplayNextInCollection === "boolean") {
    patch.autoplayNextInCollection = raw.autoplayNextInCollection;
  }
  return patch;
}

function normalize(value: unknown): PlayerPreferences {
  const raw = (value ?? {}) as Partial<PlayerPreferences>;
  return {
    skipBackMs: boundSkip(raw.skipBackMs, DEFAULT_PREFERENCES.skipBackMs),
    skipForwardMs: boundSkip(raw.skipForwardMs, DEFAULT_PREFERENCES.skipForwardMs),
    smartRewind:
      typeof raw.smartRewind === "boolean" ? raw.smartRewind : DEFAULT_PREFERENCES.smartRewind,
    autoplayNextInCollection:
      typeof raw.autoplayNextInCollection === "boolean"
        ? raw.autoplayNextInCollection
        : DEFAULT_PREFERENCES.autoplayNextInCollection,
  };
}

function boundSkip(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(SKIP_BOUNDS_MS.max, Math.max(SKIP_BOUNDS_MS.min, Math.round(value)))
    : fallback;
}

function cacheKey(userId: string): string {
  return `chapterline:preferences:${userId}`;
}
