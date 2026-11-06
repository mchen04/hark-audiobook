import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalBookRegistration } from "@/domain/local-book";
import {
  listQueuedMutations,
  replayQueuedMutations,
  type QueuedMutation,
} from "@/lib/offline-sync";
import { commitImport, commitMetadataEdit } from "./outbox";
import { projectLocalBookRegistration } from "./local-import-mirror";
import { applyPullBatch, getMirrorPlayerBook, getSyncMeta, readMirrorLibrary } from "./mirror";
import type { PullBatch, PulledBook } from "./sync-protocol";

function book(owner: string, id: string, title = `${owner}:server`): PulledBook {
  return {
    id,
    title,
    author: "Author",
    narrator: null,
    description: null,
    series: null,
    seriesPosition: null,
    chapterDiagnostic: null,
    archivedAt: null,
    createdAt: stamp(0),
    updatedAt: stamp(0),
    media: {
      originalFilename: "fixture.mp3",
      mimeType: "audio/mpeg",
      byteSize: 1000,
      fingerprint: "f".repeat(64),
      fingerprintKind: "sha256-v1",
      renditionKey: "source-v1",
      durationMs: 60000,
    },
    chapters: [{ position: 0, title: "One", startMs: 0, endMs: 60000 }],
    tagIds: [],
  };
}
function stamp(index: number) {
  return new Date(Date.UTC(2026, 10, 6, 12, 0, 0, index)).toISOString();
}
function batch(books: PulledBook[], cursor: string, complete: boolean): PullBatch {
  return {
    since: null,
    cursor,
    complete,
    books,
    playbackStates: [],
    tags: [],
    collections: [],
    preferences: null,
    listeningSessions: [],
    liveBookIds: complete ? books.map((row) => row.id) : null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

it("preserves sync invariants through fixed seeded account and request sequences", async () => {
  const seeds = [7, 73, 701];
  let steps = 0;
  for (const seed of seeds) {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("BroadcastChannel", undefined);
    const users = [`seed-${seed}-a`, `seed-${seed}-b`];
    const states = new Map(
      users.map((id) => [
        id,
        {
          queued: new Map<string, QueuedMutation>(),
          server: new Map([[`${id}-main`, book(id, `${id}-main`)]]),
          cursor: stamp(0),
        },
      ]),
    );
    for (const id of users)
      await applyPullBatch(id, batch([...states.get(id)!.server.values()], stamp(0), true));
    let owner = { id: users[0]!, controller: new AbortController() };
    const pulls: { owner: typeof owner; payload: PullBatch }[] = [];
    const replays = new Map<
      string,
      {
        gate: ReturnType<typeof deferred<boolean>>;
        done: Promise<void>;
        acknowledged: QueuedMutation[];
      }
    >();
    let index = 0;
    let random = seed;
    const next = () => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return random >>> 0;
    };
    const verify = async () => {
      for (const id of users) {
        const state = states.get(id)!;
        const queued = await listQueuedMutations(id);
        expect(queued.map((row) => `${row.key}:${row.mutationId}`).sort()).toEqual(
          [...state.queued.values()].map((row) => `${row.key}:${row.mutationId}`).sort(),
        );
        const mirror = await readMirrorLibrary(id);
        expect(mirror.books.every((row) => row.title.startsWith(`${id}:`))).toBe(true);
        for (const row of state.queued.values()) {
          if (row.kind === "metadata")
            expect(mirror.books.find((book) => book.id === row.entityId)?.title).toBe(
              row.payload.title,
            );
          if (row.kind === "import")
            expect(await getMirrorPlayerBook(id, String(row.payload.bookId))).not.toBeNull();
        }
        const cursor = (await getSyncMeta(id))!.cursor;
        expect(cursor >= state.cursor).toBe(true);
        state.cursor = cursor;
      }
      steps++;
    };
    const finishReplay = async (id: string, success: boolean) => {
      const replay = replays.get(id);
      if (!replay) return;
      replay.gate.resolve(success);
      await replay.done;
      if (success)
        for (const row of replay.acknowledged) {
          const queued = states.get(id)!.queued;
          if (queued.get(row.key)?.mutationId === row.mutationId) queued.delete(row.key);
        }
      replays.delete(id);
    };
    const actions = [
      "pull",
      "metadata",
      "import",
      "replay",
      "response",
      "switch",
      "success",
      "metadata",
      "replay",
      "switch",
      "pull",
      "failure",
      "response",
    ];
    const choices = [
      "pull",
      "metadata",
      "import",
      "replay",
      "switch",
      "response",
      "success",
      "failure",
    ];
    actions.push(...Array.from({ length: 24 }, () => choices[next() % choices.length]!));
    for (const action of actions) {
      const state = states.get(owner.id)!;
      if (action === "pull")
        pulls.push({
          owner,
          payload: batch(
            structuredClone([...state.server.values()]),
            stamp(++index),
            index % 3 === 1,
          ),
        });
      if (action === "metadata") {
        const result = await commitMetadataEdit(
          { userId: owner.id, deviceId: "sequence" },
          `${owner.id}-main`,
          { title: `${owner.id}:edit-${++index}` },
        );
        state.queued.set(result.queued.key, result.queued);
      }
      if (action === "import") {
        const registration: LocalBookRegistration = {
          bookId: `${owner.id}-import-${++index}`,
          fileName: "fixture.mp3",
          mimeType: "audio/mpeg",
          byteSize: 1000,
          durationMs: 60000,
          fingerprint: index.toString(16).padStart(64, "0"),
          fingerprintKind: "sha256-v1",
          renditionKey: "source-v1",
          title: `${owner.id}:import-${index}`,
          author: "Author",
          narrator: null,
          chapterDiagnostic: null,
          chapters: book(owner.id, "unused").chapters,
        };
        await projectLocalBookRegistration(owner.id, registration);
        const result = await commitImport(
          { userId: owner.id, deviceId: "sequence" },
          registration.fingerprint,
          registration,
        );
        state.queued.set(result.queued.key, result.queued);
      }
      if (action === "replay" && state.queued.size && !replays.has(owner.id)) {
        const id = owner.id;
        const gate = deferred<boolean>();
        const entered = deferred<void>();
        const acknowledged: QueuedMutation[] = [];
        const done = replayQueuedMutations(id, async (url, init) => {
          const payload = JSON.parse(String(init?.body));
          const sent = [...states.get(id)!.queued.values()].find((row) =>
            String(url) === "/api/books/local"
              ? row.kind === "import" && row.payload.bookId === payload.bookId
              : row.kind === "metadata" && row.payload.title === payload.title,
          );
          entered.resolve();
          if (!(await gate.promise)) return new Response(null, { status: 503 });
          expect(sent).toBeDefined();
          acknowledged.push(sent!);
          const server = states.get(id)!.server;
          if (sent!.kind === "import")
            server.set(payload.bookId, book(id, payload.bookId, payload.title));
          else server.set(sent!.entityId, { ...server.get(sent!.entityId)!, title: payload.title });
          return Response.json(
            { bookId: payload.bookId },
            { status: sent!.kind === "import" ? 201 : 200 },
          );
        });
        replays.set(id, { gate, done, acknowledged });
        await entered.promise;
      }
      if (action === "success" || action === "failure") {
        const id = [...replays.keys()][next() % (replays.size || 1)];
        if (id) await finishReplay(id, action === "success");
      }
      if (action === "switch") {
        owner.controller.abort();
        owner = {
          id: owner.id === users[0] ? users[1]! : users[0]!,
          controller: new AbortController(),
        };
      }
      if (action === "response" && pulls.length) {
        const pull = pulls.splice(next() % pulls.length, 1)[0]!;
        const payload = pull.owner.controller.signal.aborted
          ? batch([book(owner.id, `${owner.id}-main`)], pull.payload.cursor, true)
          : pull.payload;
        const apply = applyPullBatch(
          pull.owner.id,
          payload,
          undefined,
          pull.owner.controller.signal,
        );
        if (pull.owner.controller.signal.aborted)
          await expect(apply).rejects.toMatchObject({ name: "AbortError" });
        else await apply;
      }
      await verify();
    }
    for (const id of [...replays.keys()]) {
      await finishReplay(id, false);
      await verify();
    }
    owner.controller.abort();
    for (const pull of pulls) {
      await expect(
        applyPullBatch(pull.owner.id, pull.payload, undefined, pull.owner.controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      await verify();
    }
  }
  console.log("SEEDED_SYNC", JSON.stringify({ seeds, steps }));
}, 5000);
