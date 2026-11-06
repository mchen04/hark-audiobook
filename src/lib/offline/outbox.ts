import type { IDBPTransaction } from "idb";

import { assertAccountWritable } from "@/lib/account-deletion-fence";
import {
  archiveMutationKey,
  buildMutation,
  buildProgressMutation,
  collectionMutationKey,
  eventMutationKey,
  metadataMutationKey,
  newMutationId,
  queueMutationWithOutcome,
  tagMutationKey,
  type MutationDraft,
  type QueuedMutation,
  type QueuedProgress,
} from "@/lib/offline-sync";

import {
  database,
  mirrorKey,
  mirrorPrefixRange,
  type MirrorBook,
  type MirrorBookTag,
  type MirrorCollectionBook,
  type MirrorPlaybackState,
  type MirrorTag,
  type OfflineDatabase,
} from "./db";
import { ensurePermanentOfflineBookDeletion } from "./deletion-fence";
import { notifyLibraryChanged } from "./library-revision";
import { withBookProjectionLock } from "@/lib/offline-sync/locks";

const PATCH_STORES = [
  "books",
  "chapters",
  "bookTags",
  "playbackStates",
  "collections",
  "collectionBooks",
  "listeningSessions",
] as const;

type PatchStore = (typeof PATCH_STORES)[number];
type MirrorPatchTransaction = IDBPTransaction<OfflineDatabase, PatchStore[], "readwrite">;
export type MirrorPatch = (transaction: MirrorPatchTransaction) => Promise<void>;

export type CommitResult = {
  queued: QueuedMutation;
  mirrored: boolean;
};

export async function commitMutation(
  mutation: QueuedMutation,
  patch: MirrorPatch | null = mirrorPatchFor(mutation),
  afterQueue?: () => Promise<void>,
): Promise<CommitResult> {
  if (mutation.kind === "metadata" || mutation.kind === "archive") {
    return withBookProjectionLock(mutation.userId, () =>
      commitMutationUnlocked(mutation, patch, afterQueue),
    );
  }
  return commitMutationUnlocked(mutation, patch, afterQueue);
}

async function commitMutationUnlocked(
  mutation: QueuedMutation,
  patch: MirrorPatch | null,
  afterQueue?: () => Promise<void>,
): Promise<CommitResult> {
  assertAccountWritable(mutation.userId);
  const { queued, changed } = await queueMutationWithOutcome(mutation);
  assertAccountWritable(mutation.userId);
  await afterQueue?.();
  assertAccountWritable(mutation.userId);
  if (!changed || !patch) return { queued, mirrored: false };
  const effectivePatch = queued.kind === "progress" ? mirrorPatchFor(queued) : patch;
  if (!effectivePatch) return { queued, mirrored: false };
  await applyMirrorPatch(mutation.userId, effectivePatch);
  return { queued, mirrored: true };
}

async function applyMirrorPatch(userId: string, patch: MirrorPatch): Promise<void> {
  const db = await database();
  const transaction = db.transaction(PATCH_STORES as unknown as PatchStore[], "readwrite");
  try {
    await patch(transaction);
    assertAccountWritable(userId);
    await transaction.done;
    notifyLibraryChanged();
  } catch (error) {
    abortQuietly(transaction);
    throw error;
  }
}

export function commitDraft(
  draft: MutationDraft,
  patch?: MirrorPatch | null,
  afterQueue?: () => Promise<void>,
) {
  const mutation = buildMutation(draft);
  return commitMutation(
    mutation,
    patch === undefined ? mirrorPatchFor(mutation) : patch,
    afterQueue,
  );
}

type Origin = { userId: string; deviceId: string };

export function commitMetadataEdit(
  origin: Origin,
  bookId: string,
  fields: Record<string, unknown>,
) {
  return commitDraft({
    key: metadataMutationKey(origin.userId, bookId),
    userId: origin.userId,
    kind: "metadata",
    entityId: bookId,
    payload: fields,
    deviceId: origin.deviceId,
    deviceSequence: 0,
  });
}

export function commitArchiveChange(origin: Origin, bookId: string, archived: boolean) {
  return commitDraft({
    key: archiveMutationKey(origin.userId, bookId),
    userId: origin.userId,
    kind: "archive",
    entityId: bookId,
    payload: { archived },
    deviceId: origin.deviceId,
    deviceSequence: 0,
  });
}

export async function commitTagEdge(
  origin: Origin,
  bookId: string,
  tagId: string,
  include: boolean,
) {
  const db = await database();
  const tag = await db.get("tags", mirrorKey(origin.userId, tagId));
  return commitDraft({
    key: tagMutationKey(origin.userId, bookId, tagId),
    userId: origin.userId,
    kind: "tag",
    entityId: bookId,
    payload: { tagId, include, ...(tag ? { name: tag.name } : {}) },
    deviceId: origin.deviceId,
    deviceSequence: 0,
  });
}

export async function commitTagList(
  origin: Origin,
  bookId: string,
  previous: string[],
  next: string[],
): Promise<void> {
  const before = new Map(previous.map((name) => [name.trim().toLowerCase(), name.trim()]));
  const after = new Map(next.map((name) => [name.trim().toLowerCase(), name.trim()]));
  before.delete("");
  after.delete("");

  const db = await database();
  const vocabulary = await db.getAllFromIndex("tags", "by-user", origin.userId);
  const idByName = new Map(vocabulary.map((tag) => [tag.name.toLowerCase(), tag.tagId]));

  for (const [lowered] of before) {
    if (after.has(lowered)) continue;
    const tagId = idByName.get(lowered);
    if (tagId) await commitTagEdge(origin, bookId, tagId, false);
  }
  for (const [lowered, name] of after) {
    if (before.has(lowered)) continue;
    let tagId = idByName.get(lowered);
    if (!tagId) {
      tagId = crypto.randomUUID();
      const record: MirrorTag = {
        key: mirrorKey(origin.userId, tagId),
        userId: origin.userId,
        tagId,
        name,
      };
      await db.put("tags", record);
      idByName.set(lowered, tagId);
    }
    await commitTagEdge(origin, bookId, tagId, true);
  }
}

export function commitProgress(entry: QueuedProgress) {
  return commitMutation(buildProgressMutation(entry));
}

export function mirrorProgress(entry: QueuedProgress): Promise<void> {
  const patch = mirrorPatchFor(buildProgressMutation(entry));
  return patch ? applyMirrorPatch(entry.userId, patch) : Promise.resolve();
}

export function commitCollectionEdge(
  origin: Origin,
  collectionId: string,
  bookId: string,
  include: boolean,
) {
  return commitDraft({
    key: collectionMutationKey(origin.userId, collectionId, bookId),
    userId: origin.userId,
    kind: "collection",
    entityId: collectionId,
    payload: { bookId, include },
    deviceId: origin.deviceId,
    deviceSequence: 0,
  });
}

function commitDistinctEvent(
  origin: Origin,
  kind: "import" | "delete" | "history",
  entityId: string,
  payload: Record<string, unknown>,
  afterQueue?: () => Promise<void>,
) {
  const mutationId = newMutationId();
  return commitDraft(
    {
      key: eventMutationKey(origin.userId, kind, entityId, mutationId),
      userId: origin.userId,
      kind,
      entityId,
      payload,
      mutationId,
      deviceId: origin.deviceId,
      deviceSequence: 0,
    },
    undefined,
    afterQueue,
  );
}

export function commitImport(
  origin: Origin,
  fingerprint: string,
  payload: Record<string, unknown>,
) {
  return commitDistinctEvent(origin, "import", fingerprint, payload);
}

export async function commitBookDeletion(
  origin: Origin,
  bookId: string,
  knownFingerprint?: string | null,
  knownRenditionKey?: string | null,
) {
  const db = await database();
  const book = await db.get("books", mirrorKey(origin.userId, bookId));
  const fingerprint = knownFingerprint || book?.media?.fingerprint;
  const renditionKey = knownRenditionKey || book?.media?.renditionKey || "source-v1";
  return commitDistinctEvent(
    origin,
    "delete",
    bookId,
    {
      ...(fingerprint ? { fingerprint, renditionKey } : {}),
    },
    () => ensurePermanentOfflineBookDeletion(origin.userId, bookId),
  );
}

export function commitHistoryEvent(origin: Origin, bookId: string, event: Record<string, unknown>) {
  return commitDistinctEvent(origin, "history", bookId, event);
}

function abortQuietly(transaction: MirrorPatchTransaction): void {
  void transaction.done.catch(() => undefined);
  try {
    transaction.abort();
  } catch {}
}

function mirrorPatchFor(mutation: QueuedMutation): MirrorPatch | null {
  const { userId, entityId, payload } = mutation;
  const now = new Date().toISOString();
  switch (mutation.kind) {
    case "metadata":
    case "archive":
      return async (transaction) => {
        await patchBook(transaction, userId, entityId, (book) => ({
          ...book,
          ...bookFieldsFrom(payload),
          updatedAt: now,
        }));
      };
    case "tag":
      return async (transaction) => {
        const tagId = String(payload.tagId ?? "");
        const key = mirrorKey(userId, entityId, tagId);
        const edges = transaction.objectStore("bookTags");
        if (payload.include === false) await edges.delete(key);
        else {
          const edge: MirrorBookTag = { key, userId, bookId: entityId, tagId };
          await edges.put(edge);
        }
        await patchBook(transaction, userId, entityId, (book) => ({ ...book, updatedAt: now }));
      };
    case "collection":
      return async (transaction) => {
        const bookId = String(payload.bookId ?? "");
        const key = mirrorKey(userId, entityId, bookId);
        const edges = transaction.objectStore("collectionBooks");
        if (payload.include === false) await edges.delete(key);
        else {
          const existing = await edges.get(key);
          const member: MirrorCollectionBook = existing || {
            key,
            userId,
            collectionId: entityId,
            bookId,
            position: (await edges.index("by-user-collection").count([userId, entityId])) || 0,
          };
          await edges.put(member);
        }
        const collections = transaction.objectStore("collections");
        const collection = await collections.get(mirrorKey(userId, entityId));
        if (collection) await collections.put({ ...collection, updatedAt: now });
      };
    case "progress":
      return async (transaction) => {
        const store = transaction.objectStore("playbackStates");
        const key = mirrorKey(userId, entityId);
        const existing = await store.get(key);
        const eventOccurredAt = String(payload.eventOccurredAt ?? now);
        const playbackRateOccurredAt = String(
          payload.playbackRateOccurredAt ?? payload.stateOccurredAt ?? eventOccurredAt,
        );
        const completedOccurredAt = String(
          payload.completedOccurredAt ?? payload.stateOccurredAt ?? eventOccurredAt,
        );

        if (!existing) {
          await store.put({
            key,
            userId,
            bookId: entityId,
            positionMs: Number(payload.positionMs ?? 0),
            playbackRate: Number(payload.playbackRate ?? 1),
            completed: Boolean(payload.completed ?? false),
            deviceId: mutation.deviceId,
            deviceSequence: mutation.deviceSequence,
            eventOccurredAt,
            playbackRateOccurredAt,
            completedOccurredAt,
            stateOccurredAt: laterClock(playbackRateOccurredAt, completedOccurredAt),
            updatedAt: now,
          });
          return;
        }
        if (sameDeviceHasNewerMutation(existing, mutation)) return;

        const positionWins = clockAtLeast(eventOccurredAt, existing.eventOccurredAt);
        const playbackRateWins = clockAtLeast(
          playbackRateOccurredAt,
          existing.playbackRateOccurredAt ?? existing.stateOccurredAt ?? existing.eventOccurredAt,
        );
        const completedWins = clockAtLeast(
          completedOccurredAt,
          existing.completedOccurredAt ?? existing.stateOccurredAt ?? existing.eventOccurredAt,
        );
        if (!positionWins && !playbackRateWins && !completedWins) return;
        const mergedRateClock = playbackRateWins
          ? playbackRateOccurredAt
          : (existing.playbackRateOccurredAt ??
            existing.stateOccurredAt ??
            existing.eventOccurredAt);
        const mergedCompletedClock = completedWins
          ? completedOccurredAt
          : (existing.completedOccurredAt ?? existing.stateOccurredAt ?? existing.eventOccurredAt);
        const state: MirrorPlaybackState = {
          key,
          userId,
          bookId: entityId,
          positionMs: positionWins
            ? Number(payload.positionMs ?? existing.positionMs)
            : existing.positionMs,
          playbackRate: playbackRateWins
            ? Number(payload.playbackRate ?? existing.playbackRate)
            : existing.playbackRate,
          completed: completedWins
            ? Boolean(payload.completed ?? existing.completed)
            : existing.completed,
          deviceId: mutation.deviceId,
          deviceSequence: mutation.deviceSequence,
          eventOccurredAt: positionWins ? eventOccurredAt : existing.eventOccurredAt,
          playbackRateOccurredAt: mergedRateClock,
          completedOccurredAt: mergedCompletedClock,
          stateOccurredAt: laterClock(mergedRateClock, mergedCompletedClock),
          updatedAt: now,
        };
        await store.put(state);
      };
    case "delete":
      return (transaction) => removeBookAggregate(transaction, userId, entityId);
    default:
      return null;
  }
}

function sameDeviceHasNewerMutation(
  existing: MirrorPlaybackState,
  mutation: QueuedMutation,
): boolean {
  return (
    existing.deviceId === mutation.deviceId && existing.deviceSequence > mutation.deviceSequence
  );
}

function clockAtLeast(incoming: string, held: string): boolean {
  const incomingMs = Date.parse(incoming);
  const heldMs = Date.parse(held);
  return !Number.isFinite(heldMs) || (Number.isFinite(incomingMs) && incomingMs >= heldMs);
}

function laterClock(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function bookFieldsFrom(payload: Record<string, unknown>): Partial<MirrorBook> {
  const fields: Partial<MirrorBook> = {};
  for (const field of ["title", "author", "narrator", "description", "series"] as const) {
    if (field in payload) fields[field] = payload[field] as never;
  }
  if ("seriesPosition" in payload) {
    const value = payload.seriesPosition;
    fields.seriesPosition = value === null ? null : Number(value).toFixed(2);
  }
  if ("archived" in payload) {
    fields.archivedAt = payload.archived ? new Date().toISOString() : null;
  }
  return fields;
}

async function patchBook(
  transaction: MirrorPatchTransaction,
  userId: string,
  bookId: string,
  update: (book: MirrorBook) => MirrorBook,
): Promise<void> {
  const store = transaction.objectStore("books");
  const key = mirrorKey(userId, bookId);
  const existing = await store.get(key);
  if (!existing) return;
  const next = update(existing);
  await store.put({ ...next, searchText: searchTextFor(next) });
}

function searchTextFor(book: MirrorBook): string {
  return [book.title, book.author, book.narrator || "", book.series || ""].join(" ").toLowerCase();
}

async function removeBookAggregate(
  transaction: MirrorPatchTransaction,
  userId: string,
  bookId: string,
): Promise<void> {
  const collectionBooks = transaction.objectStore("collectionBooks");
  const listeningSessions = transaction.objectStore("listeningSessions");
  const [edgeKeys, sessionKeys] = await Promise.all([
    collectionBooks.index("by-user").getAllKeys(userId),
    listeningSessions.index("by-user-book").getAllKeys([userId, bookId]),
  ]);
  await Promise.all([
    transaction.objectStore("books").delete(mirrorKey(userId, bookId)),
    transaction.objectStore("playbackStates").delete(mirrorKey(userId, bookId)),
    transaction.objectStore("chapters").delete(mirrorPrefixRange(userId, bookId)),
    transaction.objectStore("bookTags").delete(mirrorPrefixRange(userId, bookId)),
    ...edgeKeys
      .filter((key) => key.slice(key.lastIndexOf(":") + 1) === bookId)
      .map((key) => collectionBooks.delete(key)),
    ...sessionKeys.map((key) => listeningSessions.delete(key)),
  ]);
}
