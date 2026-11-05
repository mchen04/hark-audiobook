import type { StoreNames } from "idb";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import {
  createAccountWriteScope,
  installAccountSignOutFence,
  isAccountWriteFenced,
  reopenAccountAfterSignIn,
  withAccountPurgeLock,
} from "@/lib/account-deletion-fence";
import { forgetActiveUserId, readActiveUserId } from "@/lib/active-user";
import {
  listQueuedMutationUserIds,
  listQueuedMutations,
  listProgressNormalizationUserIds,
  purgeDeviceSequencesForUser,
  replayQueuedMutations,
  type MutationKind,
} from "@/lib/offline-sync";
import {
  listPendingPlaybackActions,
  listPlaybackHistoryUserIds,
  replayPlaybackHistory,
} from "@/lib/playback-history";
import { flushPendingPreferences, listPendingPreferenceWrites } from "@/lib/preferences";

import { database, type OfflineDatabase } from "./db";
import { clearLocalDataForUser } from "./library";
import { purgeUser } from "./mirror";

const SHELL_CACHE_PREFIX = "chapterline-shell-";

const SIGN_OUT_DRAIN_TIMEOUT_MS = 8_000;

export type UndeliveredWrite = {
  kind: MutationKind | "playback-action" | "preferences";
  entityId: string;
  queuedAt: number;
};

export type SignOutOutcome = {
  undelivered: UndeliveredWrite[];
  failure: unknown;
};

export type PurgeOptions = {
  drainTimeoutMs?: number;
  fetchFn?: typeof fetch;
  alreadyDrained?: UndeliveredWrite[];
};

function isUserAgnosticShellEntry(url: string): boolean {
  const { pathname } = new URL(url, "https://placeholder.invalid");
  return (
    pathname === "/offline" ||
    pathname === "/library" ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/_next/static/")
  );
}

export async function purgeAccount(userId: string): Promise<void> {
  installAccountSignOutFence(userId);
  await withAccountPurgeLock(userId, async () => {
    await purgeAccountPass(userId);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const { users, failures } = await enumerateLocalUsers();
    if (failures.length) throw asPurgeFailure("the post-purge verification", failures);
    if (users.includes(userId)) {
      await purgeAccountPass(userId);
      const verified = await enumerateLocalUsers();
      if (verified.failures.length) {
        throw asPurgeFailure("the final purge verification", verified.failures);
      }
      if (verified.users.includes(userId)) {
        throw new Error("Account data was recreated while sign-out was purging it.");
      }
    }
  });
}

async function purgeAccountPass(userId: string): Promise<void> {
  const failures: unknown[] = [];
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      failures.push(new Error(`${name} failed`, { cause: error }));
    }
  };

  await step("mirror purge", () => purgeUser(userId));
  await step("page cache purge", () => purgeCachedPages());
  await step("local data purge", () => clearLocalDataForUser(userId));
  await step("deletion journal purge", () => purgeDeletionJournal(userId));
  await step("device sequence purge", () => purgeDeviceSequencesForUser(userId));
  await step("active user key", async () => forgetActiveUser(userId));

  if (failures.length) throw asPurgeFailure("the account purge", failures);
}

function forgetActiveUser(userId: string): void {
  forgetActiveUserId(userId);
}

function asPurgeFailure(what: string, failures: unknown[]): Error {
  if (failures.length === 1) return failures[0] as Error;
  return new AggregateError(failures, `${failures.length} failures during ${what}`);
}

async function purgeDeletionJournal(userId: string): Promise<void> {
  const db = await database();
  const keys = await db.getAllKeysFromIndex("deletions", "by-user", userId);
  if (!keys.length) return;
  const transaction = db.transaction("deletions", "readwrite");
  await Promise.all([...keys.map((key) => transaction.store.delete(key)), transaction.done]);
}

export async function purgeCachedPages(): Promise<void> {
  if (typeof caches === "undefined") return;
  const names = (await caches.keys()).filter((name) => name.startsWith(SHELL_CACHE_PREFIX));
  for (const name of names) {
    const cache = await caches.open(name);
    const requests = await cache.keys();
    await Promise.all(
      requests
        .filter((request) => !isUserAgnosticShellEntry(request.url))
        .map((request) => cache.delete(request)),
    );
  }
}

export async function listLocalUserIds(): Promise<string[]> {
  const { users, failures } = await enumerateLocalUsers();
  if (failures.length) throw asPurgeFailure("the device enumeration", failures);
  return users;
}

async function enumerateLocalUsers(): Promise<{ users: string[]; failures: unknown[] }> {
  const sources = await Promise.allSettled([
    listMirrorUserIds(),
    listQueuedMutationUserIds(),
    listPlaybackHistoryUserIds(),
    listProgressNormalizationUserIds(),
    Promise.resolve(listAccountLocalStorageUserIds()),
  ]);
  const found = new Set<string>();
  const failures: unknown[] = [];
  for (const source of sources) {
    if (source.status === "rejected") failures.push(source.reason);
    else for (const userId of source.value) found.add(userId);
  }
  return { users: [...found], failures };
}

async function listMirrorUserIds(): Promise<string[]> {
  const db = await database();
  const found = new Set<string>();
  const stores = [...db.objectStoreNames] as Array<StoreNames<OfflineDatabase>>;
  const transaction = db.transaction(stores, "readonly");
  await Promise.all(
    stores.map(async (store) => {
      let cursor = await transaction.objectStore(store).openCursor();
      while (cursor) {
        if (typeof cursor.value.userId === "string" && cursor.value.userId) {
          found.add(cursor.value.userId);
        }
        cursor = await cursor.continue();
      }
    }),
  );
  await transaction.done;
  return [...found];
}

const ACCOUNT_LOCAL_STORAGE_PREFIXES = [
  "chapterline:position:",
  "chapterline:playback-position:",
  "chapterline:playback-rate:",
  "chapterline:playback-completed:",
  "chapterline:last-paused-at:",
  "chapterline:suspension-dismissed:",
  "chapterline:preferences:",
] as const;

function listAccountLocalStorageUserIds(): string[] {
  if (typeof localStorage === "undefined") return [];
  const found = new Set<string>();
  const active = localStorage.getItem(ACTIVE_USER_KEY);
  if (active) found.add(active);
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    const prefix = key && ACCOUNT_LOCAL_STORAGE_PREFIXES.find((item) => key.startsWith(item));
    if (!key || !prefix) continue;
    const remainder = key.slice(prefix.length);
    const separator = remainder.indexOf(":");
    const userId = separator === -1 ? remainder : remainder.slice(0, separator);
    if (userId) found.add(userId);
  }
  return [...found];
}

export async function purgeOnSignOut(
  userId: string,
  options: PurgeOptions = {},
): Promise<SignOutOutcome> {
  const drained = options.alreadyDrained ?? (await drainBeforeSignOut(userId, options));
  const undelivered = mergeUndelivered(drained, await listUndeliveredWrites(userId));
  const failure = await purgeAccount(userId).then(
    () => null,
    (error: unknown) => error,
  );
  return { undelivered, failure };
}

async function listUndeliveredWrites(userId: string): Promise<UndeliveredWrite[]> {
  const [queued, actions] = await Promise.all([
    listQueuedMutations(userId).catch(() => []),
    listPendingPlaybackActions(userId).catch(() => []),
  ]);
  return [
    ...queued.map((mutation) => ({
      kind: mutation.kind,
      entityId: mutation.entityId,
      queuedAt: mutation.queuedAt,
    })),
    ...actions.map((action) => ({
      kind: "playback-action" as const,
      entityId: action.bookId,
      queuedAt: Date.parse(action.occurredAt) || 0,
    })),
    ...listPendingPreferenceWrites(userId),
  ];
}

function mergeUndelivered(
  first: UndeliveredWrite[],
  second: UndeliveredWrite[],
): UndeliveredWrite[] {
  const merged = new Map<string, UndeliveredWrite>();
  for (const write of [...first, ...second]) {
    merged.set(`${write.kind}:${write.entityId}:${write.queuedAt}`, write);
  }
  return [...merged.values()];
}

export async function drainBeforeSignOut(
  userId: string,
  options: PurgeOptions = {},
): Promise<UndeliveredWrite[]> {
  const [queued, actions] = await Promise.all([
    listQueuedMutations(userId).catch(() => []),
    listPendingPlaybackActions(userId).catch(() => []),
  ]);
  const preferences = listPendingPreferenceWrites(userId);
  if (!queued.length && !actions.length && !preferences.length) return [];

  const timeoutMs = options.drainTimeoutMs ?? SIGN_OUT_DRAIN_TIMEOUT_MS;
  const deadline = performance.now() + timeoutMs;
  let finished = false;
  const send = options.fetchFn ?? fetch;
  const scope = isAccountWriteFenced(userId) ? null : createAccountWriteScope(userId);
  const canSend = () => {
    const active = readActiveUserId();
    return (
      scope !== null &&
      !scope.signal.aborted &&
      !isAccountWriteFenced(userId) &&
      (!active || active === userId) &&
      !finished &&
      performance.now() < deadline
    );
  };
  const drainQueue = async (
    replay: (fetchFn: typeof fetch) => Promise<void>,
    hasPending: () => Promise<boolean>,
  ) => {
    while (canSend()) {
      let sent = false;
      let busy = false;
      await replay(async (input, init) => {
        if (!canSend()) throw new DOMException("The sign-out drain ended.", "AbortError");
        sent = true;
        const response = await send(input, init);
        busy ||= response.status === 503 && response.headers.get("Retry-After") === "1";
        return response;
      }).catch(() => undefined);
      if (!canSend()) return;
      if (!sent) {
        if (!(await hasPending().catch(() => false))) return;
        continue;
      }
      if (!busy || performance.now() + 1_000 >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  };
  let expire: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    expire = setTimeout(resolve, timeoutMs);
  });
  const drain = Promise.all([
    queued.length
      ? drainQueue(
          (drainFetch) => replayQueuedMutations(userId, drainFetch),
          async () => (await listQueuedMutations(userId)).length > 0,
        )
      : Promise.resolve(),
    actions.length
      ? drainQueue(
          (drainFetch) => replayPlaybackHistory(userId, drainFetch),
          async () => (await listPendingPlaybackActions(userId)).length > 0,
        )
      : Promise.resolve(),
    preferences.length
      ? drainQueue(
          (drainFetch) => flushPendingPreferences(userId, drainFetch),
          async () => listPendingPreferenceWrites(userId).length > 0,
        )
      : Promise.resolve(),
  ]).then(() => undefined);
  try {
    await Promise.race([drain, bound]);
  } finally {
    finished = true;
    scope?.release();
    clearTimeout(expire);
  }

  const [remainingQueued, remainingActions] = await Promise.all([
    listQueuedMutations(userId).catch(() => queued),
    listPendingPlaybackActions(userId).catch(() => actions),
  ]);
  return [
    ...remainingQueued.map((mutation) => ({
      kind: mutation.kind,
      entityId: mutation.entityId,
      queuedAt: mutation.queuedAt,
    })),
    ...remainingActions.map((action) => ({
      kind: "playback-action" as const,
      entityId: action.bookId,
      queuedAt: Date.parse(action.occurredAt) || 0,
    })),
    ...listPendingPreferenceWrites(userId),
  ];
}

export async function purgeOnSignIn(incomingUserId: string): Promise<string[]> {
  await reopenAccountAfterSignIn(incomingUserId);
  try {
    const { users, failures } = await enumerateLocalUsers();
    const stale = users.filter((userId) => userId !== incomingUserId);
    const active =
      typeof localStorage === "undefined" ? null : localStorage.getItem(ACTIVE_USER_KEY);
    if (active && active !== incomingUserId && !stale.includes(active)) stale.push(active);
    const results = await Promise.allSettled(stale.map((userId) => purgeAccount(userId)));
    await purgeCachedPages().catch(() => undefined);
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length) throw asPurgeFailure("the sign-in sweep", failures);
    return stale;
  } finally {
    await reopenAccountAfterSignIn(incomingUserId);
  }
}
