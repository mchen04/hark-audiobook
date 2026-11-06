import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";

import { database } from "./db";
import {
  buildMutation,
  clearQueuedMutationsForUser,
  listQueuedMutations,
  queueMutation,
} from "./queue";
import { replayQueuedMutations } from "./replay";

const userId = "replay-lifecycle-user";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function holdReplayLock() {
  const entered = deferred();
  const release = deferred();
  vi.stubGlobal("navigator", {
    locks: {
      request: async (_name: string, operation: () => Promise<void>) => {
        entered.resolve();
        await release.promise;
        return operation();
      },
    },
  });
  return { entered: entered.promise, release: release.resolve };
}

function metadata(title: string) {
  return buildMutation({
    key: `${userId}:metadata:book-1`,
    userId,
    entityId: "book-1",
    kind: "metadata",
    payload: { title },
    deviceId: "device-1",
    deviceSequence: 0,
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearQueuedMutationsForUser(userId);
});

it("sends the latest queued edit after waiting for another tab's lock", async () => {
  await queueMutation(metadata("Old title"));
  const lock = holdReplayLock();
  const send = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  const replay = replayQueuedMutations(userId, send);
  await lock.entered;
  await queueMutation(metadata("New title"));
  lock.release();
  await replay;

  expect(send).toHaveBeenCalledOnce();
  expect(JSON.parse(send.mock.calls[0]![1].body)).toEqual({ title: "New title" });
  expect(await listQueuedMutations(userId)).toEqual([]);
});

it("does not resend a mutation another tab settles while replay waits for its lock", async () => {
  const mutation = await queueMutation(metadata("Old title"));
  const lock = holdReplayLock();
  const send = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  const replay = replayQueuedMutations(userId, send);
  await lock.entered;
  const db = await database();
  await db.delete("mutations", mutation.key);
  db.close();
  lock.release();
  await replay;

  expect(send).not.toHaveBeenCalled();
  expect(await listQueuedMutations(userId)).toEqual([]);
});
