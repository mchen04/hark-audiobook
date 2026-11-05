import { assertAccountWritable } from "@/lib/account-deletion-fence";

import type { IDBPObjectStore } from "idb";

import {
  activeUserId,
  database,
  deviceSequenceKey,
  SEQUENCE_FLOOR_KEY,
  type SyncDatabase,
} from "./db";

export async function nextDeviceSequence(bookId: string, userId?: string): Promise<number> {
  return reserveDeviceSequenceAbove(bookId, 0, userId);
}

export async function reserveDeviceSequenceAbove(
  bookId: string,
  floor: number,
  userId?: string,
): Promise<number> {
  const owner = userId || activeUserId();
  if (owner) assertAccountWritable(owner);
  const db = await database();
  const transaction = db.transaction("sequences", "readwrite");
  const next = await reserveDeviceSequenceAboveInStore(transaction.store, bookId, floor, owner);
  if (owner) assertAccountWritable(owner);
  await transaction.done;
  return next;
}

type SequenceStore = Pick<
  IDBPObjectStore<SyncDatabase, ["sequences"], "sequences", "readwrite">,
  "get" | "put" | "delete"
>;

export async function reserveDeviceSequenceAboveInStore(
  store: SequenceStore,
  bookId: string,
  floor: number,
  owner: string | null,
): Promise<number> {
  const scoped = owner ? deviceSequenceKey(owner, bookId) : null;

  const [scopedRow, legacyRow, floorRow] = await Promise.all([
    scoped ? store.get(scoped) : Promise.resolve(undefined),
    store.get(bookId),
    store.get(SEQUENCE_FLOOR_KEY),
  ]);
  const next =
    Math.max(scopedRow?.value || 0, legacyRow?.value || 0, floorRow?.value || 0, floor) + 1;

  if (scoped) {
    await store.put({ key: scoped, userId: owner!, bookId, value: next });
    if (legacyRow) await store.delete(bookId);
  } else {
    await store.put({ key: bookId, value: next });
  }
  return next;
}

export async function currentDeviceSequence(bookId: string, userId?: string): Promise<number> {
  const owner = userId || activeUserId();
  const db = await database();
  const transaction = db.transaction("sequences", "readonly");
  const [scopedRow, legacyRow] = await Promise.all([
    owner ? transaction.store.get(deviceSequenceKey(owner, bookId)) : Promise.resolve(undefined),
    transaction.store.get(bookId),
    transaction.done,
  ]);
  return Math.max(scopedRow?.value || 0, legacyRow?.value || 0);
}

export async function purgeDeviceSequencesForUser(userId: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction("sequences", "readwrite");
  const store = transaction.store;
  const owned = await store.getAll(IDBKeyRange.bound(`${userId}:`, `${userId}:￿`));
  if (!owned.length) {
    await transaction.done;
    return;
  }
  const floorRow = await store.get(SEQUENCE_FLOOR_KEY);
  const floor = owned.reduce((highest, row) => Math.max(highest, row.value), floorRow?.value || 0);
  await store.put({ key: SEQUENCE_FLOOR_KEY, value: floor });
  await Promise.all(owned.map((row) => store.delete(row.key)));
  await transaction.done;
}
