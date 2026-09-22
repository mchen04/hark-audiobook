import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { PullBatch } from "@/lib/offline/sync-protocol";

import {
  APP_ORIGIN,
  attachDriver,
  closeSql,
  commit,
  createCollection,
  drainOutbox,
  mirror,
  openDevice,
  pull,
  resetAccount,
  sharedSession,
  sql,
  type Account,
  type StorageState,
} from "./harness/app";
import { readBookIds, readCollectionIds, readTagIds, toDeviceState } from "./harness/state";

/** `collections.updatedAt` straight from Postgres, serialized at millisecond precision. */
async function collectionUpdatedAt(collectionId: string): Promise<string | null> {
  const [row] = await sql()<{ updated_at: Date }[]>`
    SELECT updated_at FROM collections WHERE id = ${collectionId}::uuid
  `;
  return row ? row.updated_at.toISOString() : null;
}

/** `books.updatedAt` straight from Postgres. */
async function bookUpdatedAt(bookId: string): Promise<string | null> {
  const [row] = await sql()<{ updated_at: Date }[]>`
    SELECT updated_at FROM books WHERE id = ${bookId}::uuid
  `;
  return row ? row.updated_at.toISOString() : null;
}

/**
 * Two devices, one account.
 *
 * The device id is stamped into localStorage before any app script runs, so
 * these really are two devices and not two tabs — `chapterline:device-id` is
 * the key the whole progress-ordering policy hangs off, and two contexts that
 * minted the same one would make every assertion here vacuous. The ids are
 * asserted distinct before anything else runs.
 *
 * The case this file exists for is design contract section 3: `chapters`,
 * `book_tags` and `collection_books` carry no `updatedAt`, so a change to one
 * of them propagates ONLY because the parent aggregate's `updatedAt` is bumped.
 * Device B pulls INCREMENTALLY (it already holds a cursor), which is the only
 * way that failure is observable — a full pull would mask a missing bump.
 */

const DURATION_MS = 600_000;
const DEVICE_A = "device-a-converge-0001";
const DEVICE_B = "device-b-converge-0002";

let session: { account: Account; storageState: StorageState } | null = null;

test.afterAll(async () => {
  await closeSql();
});

function chapterList() {
  return [
    { position: 0, title: "Opening", startMs: 0, endMs: 300_000 },
    { position: 1, title: "Close", startMs: 300_000, endMs: DURATION_MS },
  ];
}

function importPayload(fingerprint: string, title: string) {
  return {
    fileName: encodeURIComponent(`${fingerprint.slice(0, 10)}.mp3`),
    byteSize: 2_097_152,
    durationMs: DURATION_MS,
    fingerprint,
    fingerprintKind: "sha256-v1",
    title,
    author: "Convergence Author",
    narrator: null,
    chapterDiagnostic: null,
    chapters: chapterList(),
  };
}

/** `media_assets.fingerprint` is validated as 64 lowercase hex characters. */
function fingerprint(tag: string): string {
  const hex = [...tag].map((character) => character.charCodeAt(0).toString(16)).join("");
  return hex.padStart(64, "a").slice(-64);
}

type Device = { context: BrowserContext; page: Page; id: string };

async function bringUp(
  browser: Parameters<typeof openDevice>[0],
  account: Account,
  storageState: StorageState,
  deviceId: string,
): Promise<Device> {
  const { context, page } = await openDevice(browser, deviceId, storageState);
  await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  await attachDriver(page, account, deviceId);
  return { context, page, id: deviceId };
}

async function setUpPair(
  browser: Parameters<typeof openDevice>[0],
): Promise<{ account: Account; a: Device; b: Device }> {
  session ??= await sharedSession(browser);
  const { account, storageState } = session;
  await resetAccount(account.userId);
  const a = await bringUp(browser, account, storageState, DEVICE_A);
  const b = await bringUp(browser, account, storageState, DEVICE_B);

  const ids = await Promise.all(
    [a, b].map((device) =>
      device.page.evaluate(() => localStorage.getItem("chapterline:device-id")),
    ),
  );
  expect(
    new Set(ids).size,
    `both contexts report device id ${ids[0]}, so this is one device pretending to be two`,
  ).toBe(2);
  return { account, a, b };
}

/** A book on the server, addressable from both devices, with both mirrors current. */
async function seedBook(account: Account, a: Device, b: Device, tag: string, title: string) {
  const media = fingerprint(tag);
  await commit(a.page, {
    kind: "import",
    fingerprint: media,
    payload: importPayload(media, title),
  });
  await drainOutbox(a.page);
  expect(await pull(a.page)).toBe("applied");
  expect(await pull(b.page)).toBe("applied");
  const bookId = (await readBookIds(account.userId)).get(media);
  expect(bookId, "the import never reached the server").toBeTruthy();
  return { media, bookId: bookId! };
}

test("a collection membership change on one device reaches the other on an incremental pull", async ({
  browser,
}) => {
  const { account, a, b } = await setUpPair(browser);
  try {
    const book = await seedBook(account, a, b, "col1", "Collection Subject");
    const collectionId = await createCollection(a.page, "Shared Shelf");
    // Both devices take a cursor BEFORE the change, so the pull below is
    // incremental. That is the only shape in which a missing parent bump is
    // observable: a full pull would carry the edge regardless.
    expect(await pull(a.page)).toBe("applied");
    expect(await pull(b.page)).toBe("applied");
    const cursorBefore = (await mirror(b.page)).syncMeta?.cursor;
    expect(
      cursorBefore,
      "device B has no pull cursor, so its next pull would be a full sync",
    ).toBeTruthy();

    const bumpBefore = await collectionUpdatedAt(collectionId);
    await commit(a.page, {
      kind: "collection",
      collectionId,
      bookId: book.bookId,
      include: true,
    });
    await drainOutbox(a.page);

    // The parent bump itself, asserted at runtime.
    //
    // Design contract section 3 requires a membership change to move
    // `collections.updatedAt`, and `src/server/sync/parent-updated-at.test.ts`
    // guards it at the source level. It has to be checked directly here because
    // the pull sends the collection list IN FULL on every sync
    // (`pull.ts#loadCollections` applies no cursor), so membership would still
    // reach device B with the bump removed — the propagation check below cannot
    // see this failure, and a verifier that only ran it would report a green
    // suite while the contract was broken.
    const bumpAfter = await collectionUpdatedAt(collectionId);
    expect(
      bumpAfter && bumpBefore && bumpAfter > bumpBefore,
      `adding a book to a collection did not move collections.updatedAt ` +
        `(${bumpBefore} -> ${bumpAfter}). \`collection_books\` carries no updatedAt of its own, ` +
        "so the parent bump is the only timestamp that records the change.",
    ).toBe(true);

    expect(await pull(b.page)).toBe("applied");
    const onB = toDeviceState(await mirror(b.page));
    expect(
      [...(onB.collectionMembers.get("Shared Shelf") || [])],
      "device A put the book in a collection and device B never saw it",
    ).toStrictEqual([book.media]);

    // And the reverse direction, so the test is about propagation rather than
    // about one lucky ordering.
    await commit(b.page, {
      kind: "collection",
      collectionId,
      bookId: book.bookId,
      include: false,
    });
    await drainOutbox(b.page);
    expect(await pull(a.page)).toBe("applied");
    const onA = toDeviceState(await mirror(a.page));
    expect(
      [...(onA.collectionMembers.get("Shared Shelf") || [])],
      "device B removed the book from the collection and device A never saw the removal",
    ).toStrictEqual([]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("a tag change on one device reaches the other on an incremental pull", async ({ browser }) => {
  const { account, a, b } = await setUpPair(browser);
  try {
    const book = await seedBook(account, a, b, "tag1", "Tag Subject");
    expect(await pull(b.page)).toBe("applied");
    const cursorBefore = (await mirror(b.page)).syncMeta?.cursor;
    expect(cursorBefore, "device B has no pull cursor").toBeTruthy();

    const bumpBefore = await bookUpdatedAt(book.bookId);
    await commit(a.page, {
      kind: "rename",
      bookId: book.bookId,
      fields: { tags: ["fiction", "reread"] },
    });
    await drainOutbox(a.page);
    const bumpAfter = await bookUpdatedAt(book.bookId);
    expect(
      bumpAfter && bumpBefore && bumpAfter > bumpBefore,
      `a tag edit did not move books.updatedAt (${bumpBefore} -> ${bumpAfter}). Unlike the ` +
        "collection list, book aggregates ARE cursored, so this bump is the only thing that " +
        "puts the change in another device's incremental pull.",
    ).toBe(true);

    expect(await pull(b.page)).toBe("applied");
    const onB = toDeviceState(await mirror(b.page));
    expect(
      [...(onB.tagsByFingerprint.get(book.media) || [])].sort(),
      "device A tagged the book and device B's incremental pull never saw it. `book_tags` " +
        "carries no updatedAt, so this is the parent bump on `books.updatedAt` failing " +
        "(design contract section 3).",
    ).toStrictEqual(["fiction", "reread"]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("a tag EDGE queued through commitTagEdge reaches the other device", async ({ browser }) => {
  const { account, a, b } = await setUpPair(browser);
  try {
    const book = await seedBook(account, a, b, "tag2", "Tag Edge Subject");
    // The vocabulary has to exist before an edge can name a tag id.
    await commit(a.page, {
      kind: "rename",
      bookId: book.bookId,
      fields: { tags: ["fiction"] },
    });
    await drainOutbox(a.page);
    const tagIds = await readTagIds(account.userId);
    const fictionId = tagIds.get("fiction");
    expect(fictionId, "the tag vocabulary was not created").toBeTruthy();

    expect(await pull(a.page)).toBe("applied");
    expect(await pull(b.page)).toBe("applied");

    // The production tag-edge mutation, exactly as `src/lib/offline/outbox.ts`
    // exposes it. This is the mutation a "remove this tag" control would queue.
    await commit(a.page, {
      kind: "tag",
      bookId: book.bookId,
      tagId: fictionId!,
      include: false,
    });
    await drainOutbox(a.page);

    expect(await pull(b.page)).toBe("applied");
    const onB = toDeviceState(await mirror(b.page));
    expect(
      [...(onB.tagsByFingerprint.get(book.media) || [])].sort(),
      "device A removed a tag edge through commitTagEdge and the queue drained clean, but " +
        "device B still holds the tag. The mutation was acknowledged and deleted from the " +
        "outbox without ever being applied — a silent lost write.",
    ).toStrictEqual([]);

    // And the same edge added back.
    await commit(a.page, {
      kind: "tag",
      bookId: book.bookId,
      tagId: fictionId!,
      include: true,
    });
    await drainOutbox(a.page);
    expect(await pull(b.page)).toBe("applied");
    expect(
      [...(toDeviceState(await mirror(b.page)).tagsByFingerprint.get(book.media) || [])],
      "device A added a tag edge through commitTagEdge and device B never saw it",
    ).toStrictEqual(["fiction"]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("two devices editing different books converge on the same state", async ({ browser }) => {
  const { account, a, b } = await setUpPair(browser);
  try {
    const left = await seedBook(account, a, b, "conv1", "Left Book");
    const right = await seedBook(account, a, b, "conv2", "Right Book");
    const collectionId = await createCollection(a.page, "Converged");
    expect(await pull(a.page)).toBe("applied");
    expect(await pull(b.page)).toBe("applied");

    // Simultaneous, on different books, from two devices with the network up.
    await Promise.all([
      commit(a.page, {
        kind: "rename",
        bookId: left.bookId,
        fields: { title: "Left Renamed By A" },
      }),
      commit(b.page, {
        kind: "rename",
        bookId: right.bookId,
        fields: { title: "Right Renamed By B" },
      }),
    ]);
    await commit(a.page, { kind: "archive", bookId: left.bookId, archived: true });
    await commit(b.page, {
      kind: "collection",
      collectionId,
      bookId: right.bookId,
      include: true,
    });
    await drainOutbox(a.page);
    await drainOutbox(b.page);

    expect(await pull(a.page)).toBe("applied");
    expect(await pull(b.page)).toBe("applied");

    const stateA = toDeviceState(await mirror(a.page));
    const stateB = toDeviceState(await mirror(b.page));

    const describe = (state: typeof stateA) =>
      [...state.booksByFingerprint.entries()]
        .sort()
        .map(
          ([media, row]) =>
            `${media.slice(-6)} "${row.title}" archived=${row.archived} chapters=${row.chapterCount}`,
        );

    // Each device must see BOTH edits, including the one it did not make.
    expect(describe(stateA), "device A does not hold what the pair agreed on").toStrictEqual([
      `${left.media.slice(-6)} "Left Renamed By A" archived=true chapters=2`,
      `${right.media.slice(-6)} "Right Renamed By B" archived=false chapters=2`,
    ]);
    expect(describe(stateB), "the two devices did not converge").toStrictEqual(describe(stateA));
    expect(
      [...(stateA.collectionMembers.get("Converged") || [])],
      "device B's collection edit never reached device A",
    ).toStrictEqual([right.media]);
    expect([...(stateB.collectionMembers.get("Converged") || [])]).toStrictEqual([right.media]);

    // …and both must match the server, not merely each other. Two devices that
    // agreed on a stale copy would satisfy the check above.
    const collections = await readCollectionIds(account.userId);
    expect(collections.get("Converged")).toBe(collectionId);
    const serverBooks = await readBookIds(account.userId);
    expect([...serverBooks.keys()].sort()).toStrictEqual([left.media, right.media].sort());
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

for (const parent of ["book", "collection"] as const) {
  test(`${parent} sync timestamps advance beyond a retained future timestamp`, async ({
    browser,
  }, info) => {
    const { account, a, b } = await setUpPair(browser);
    try {
      const book = await seedBook(account, a, b, `clock-${parent}`, "Clock Subject");
      const collectionId = await createCollection(a.page, "Clock Shelf");
      const table = parent === "book" ? "books" : "collections";
      const owner = parent === "book" ? "owner_id" : "user_id";
      const entityId = parent === "book" ? book.bookId : collectionId;
      // Only this disposable fixture row moves. Neither database nor host clock
      // is changed. A retained timestamp ahead of the current clock also pins
      // monotonicity when an earlier server clock was fast or stepped backward.
      await sql()`update ${sql()(table)} set updated_at = clock_timestamp() + interval '1 minute'
        where id = ${entityId}::uuid and ${sql()(owner)} = ${account.userId}`;
      const stamp = async () => {
        const [row] = await sql()<{ value: string }[]>`select
          to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as value
          from ${sql()(table)} where id=${entityId}::uuid and ${sql()(owner)}=${account.userId}`;
        return row!.value;
      };
      const stamps = [await stamp()];
      expect(
        Date.parse(stamps[0]!) - Date.now(),
        "The skew fixture must still be ahead of the host",
      ).toBeGreaterThan(30_000);
      expect(await pull(b.page)).toBe("applied");
      const cursorBefore = (await mirror(b.page)).syncMeta?.cursor;
      expect(cursorBefore).toBeTruthy();
      const edits = [true, false, true];
      for (const include of edits) {
        await commit(
          a.page,
          parent === "book"
            ? {
                kind: "rename",
                bookId: book.bookId,
                fields: {
                  title: "Clock Updated",
                  tags: include ? ["clock-safe"] : [],
                  archived: include,
                },
              }
            : { kind: "collection", collectionId, bookId: book.bookId, include },
        );
        await drainOutbox(a.page);
        const after = await stamp();
        expect(
          after > stamps.at(-1)!,
          `${parent} receipt timestamp must strictly advance: ${stamps.at(-1)} -> ${after}`,
        ).toBe(true);
        stamps.push(after);
        expect(await pull(b.page)).toBe("applied");
        const state = toDeviceState(await mirror(b.page));
        if (parent === "book") {
          expect(state.booksByFingerprint.get(book.media)).toMatchObject({
            title: "Clock Updated",
            archived: include,
            chapterCount: 2,
          });
          expect([...(state.tagsByFingerprint.get(book.media) ?? [])]).toEqual(
            include ? ["clock-safe"] : [],
          );
        } else {
          expect([...(state.collectionMembers.get("Clock Shelf") ?? [])]).toEqual(
            include ? [book.media] : [],
          );
        }
      }
      writeFileSync(
        info.outputPath("monotonic-timestamps.json"),
        JSON.stringify(
          {
            parent,
            fixtureScope: "One row owned by the disposable sync account; no clock change",
            cursorBefore,
            stamps,
          },
          null,
          2,
        ),
      );
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
}

test("playback and preference receipt clocks advance without replacing playback field clocks", async ({
  browser,
}, info) => {
  const { account, a, b } = await setUpPair(browser);
  try {
    const book = await seedBook(account, a, b, "clock-state", "Clock State");
    const progress = async (positionMs: number) => {
      const eventOccurredAt = new Date().toISOString();
      await commit(a.page, {
        kind: "progress",
        bookId: book.bookId,
        positionMs,
        playbackRate: 1.5,
        completed: false,
        eventOccurredAt,
      });
      await drainOutbox(a.page);
      return eventOccurredAt;
    };
    const preferences = (skipBackMs: number) =>
      a.page.evaluate(
        async (skipBackMs) =>
          (
            await fetch("/api/preferences", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ skipBackMs }),
            })
          ).status,
        skipBackMs,
      );
    await progress(10_000);
    expect(await preferences(5_000)).toBe(200);
    await sql()`update playback_states set updated_at=clock_timestamp() + interval '1 minute'
      where user_id=${account.userId} and book_id=${book.bookId}::uuid`;
    await sql()`update user_preferences set updated_at=clock_timestamp() + interval '1 minute'
      where user_id=${account.userId}`;
    const stamps = () => sql()<{ kind: string; stamp: string }[]>`
      select 'playback' as kind, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as stamp
      from playback_states where user_id=${account.userId} and book_id=${book.bookId}::uuid
      union all select 'preferences' as kind, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as stamp
      from user_preferences where user_id=${account.userId} order by kind`;
    const before = await stamps();
    expect(before).toHaveLength(2);
    expect(await pull(b.page)).toBe("applied");
    const eventOccurredAt = await progress(24_000);
    expect(await preferences(10_000)).toBe(200);
    const after = await stamps();
    for (const row of after) {
      expect
        .soft(
          row.stamp > before.find((prior) => prior.kind === row.kind)!.stamp,
          `${row.kind} receipt clock must advance`,
        )
        .toBe(true);
    }
    expect(await pull(b.page)).toBe("applied");
    expect(
      (await mirror(b.page)).playbackStates.find((row) => row.bookId === book.bookId),
    ).toMatchObject({ positionMs: 24_000, playbackRate: 1.5, eventOccurredAt });
    writeFileSync(
      info.outputPath("state-receipt-clocks.json"),
      JSON.stringify({ before, after, eventOccurredAt, positionMs: 24_000 }, null, 2),
    );
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

/** Real authenticated endpoints; no driver interception or server-clock mocks. */
async function request(device: Device, method: string, path: string, data?: unknown) {
  return device.context.request.fetch(`${APP_ORIGIN}${path}`, {
    method,
    data,
    headers: { Origin: APP_ORIGIN },
  });
}

async function incremental(device: Device, cursor: string): Promise<PullBatch> {
  const response = await request(
    device,
    "GET",
    `/api/sync/pull?since=${encodeURIComponent(cursor)}`,
  );
  expect(response.status()).toBe(200);
  const batch = (await response.json()) as PullBatch;
  expect(batch.complete).toBe(true);
  return batch;
}

for (const futureStream of ["book", "playback", "tombstone"] as const) {
  test(`account receipts keep sibling writes visible after a future ${futureStream} cursor`, async ({
    browser,
  }, info) => {
    const { account, a, b } = await setUpPair(browser);
    const receipts: unknown[] = [];
    try {
      const future = await seedBook(account, a, b, `future-${futureStream}`, "Future Receipt");
      const sibling = await seedBook(account, a, b, `sibling-${futureStream}`, "Sibling Before");
      if (futureStream === "playback") {
        expect(
          (
            await request(a, "PATCH", `/api/books/${future.bookId}/progress`, {
              deviceId: a.id,
              deviceSequence: 1,
              positionMs: 1_000,
              playbackRate: 1,
              completed: false,
              eventOccurredAt: new Date().toISOString(),
            })
          ).status(),
        ).toBe(200);
      } else if (futureStream === "tombstone") {
        expect((await request(a, "DELETE", `/api/books/${future.bookId}`)).status()).toBe(200);
      }
      const table =
        futureStream === "book"
          ? "books"
          : futureStream === "playback"
            ? "playback_states"
            : "book_tombstones";
      const owner = futureStream === "playback" ? "user_id" : "owner_id";
      const id = futureStream === "book" ? "id" : "book_id";
      const stamp = futureStream === "tombstone" ? "deleted_at" : "updated_at";
      // Only this account's disposable row changes, never the actual clocks.
      await sql()`update ${sql()(table)} set ${sql()(stamp)}=clock_timestamp() + interval '1 minute'
        where ${sql()(owner)}=${account.userId} and ${sql()(id)}=${future.bookId}::uuid`;
      expect(await pull(b.page)).toBe("applied");
      let cursor = (await mirror(b.page)).syncMeta!.cursor!;
      expect(Date.parse(cursor) - Date.now()).toBeGreaterThan(30_000);
      const initialCursor = cursor;
      const capture = async (stage: string) => {
        const batch = await incremental(b, cursor);
        expect(await pull(b.page)).toBe("applied");
        const snapshot = await mirror(b.page);
        receipts.push({ stage, cursorBefore: cursor, batch, snapshot });
        expect.soft(batch.cursor > cursor, `${stage} must advance the account cursor`).toBe(true);
        cursor = batch.cursor;
        return { batch, snapshot };
      };
      expect(
        (
          await request(a, "PATCH", `/api/books/${sibling.bookId}`, { title: "Sibling After" })
        ).status(),
      ).toBe(200);
      let result = await capture("sibling edit");
      expect
        .soft(result.batch.books.find((row) => row.id === sibling.bookId)?.title)
        .toBe("Sibling After");
      expect
        .soft(toDeviceState(result.snapshot).booksByFingerprint.get(sibling.media)?.title)
        .toBe("Sibling After");

      const newId = randomUUID();
      const newMedia = fingerprint(`new-${futureStream}`);
      expect(
        (
          await request(a, "POST", "/api/books/local", {
            ...importPayload(newMedia, "New Sibling"),
            bookId: newId,
          })
        ).status(),
      ).toBe(201);
      result = await capture("new import");
      expect.soft(result.batch.books.some((row) => row.id === newId)).toBe(true);
      expect.soft(toDeviceState(result.snapshot).booksByFingerprint.has(newMedia)).toBe(true);

      const eventOccurredAt = new Date().toISOString();
      expect(
        (
          await request(a, "PATCH", `/api/books/${sibling.bookId}/progress`, {
            deviceId: a.id,
            deviceSequence: 1,
            positionMs: 24_000,
            playbackRate: 1.5,
            completed: false,
            eventOccurredAt,
          })
        ).status(),
      ).toBe(200);
      result = await capture("sibling progress");
      expect
        .soft(result.snapshot.playbackStates.find((row) => row.bookId === sibling.bookId))
        .toMatchObject({
          positionMs: 24_000,
          playbackRate: 1.5,
          eventOccurredAt,
        });

      // Delete the highest receipt too: its tombstone must preserve the floor
      // for subsequent writes, rather than letting the account clock regress.
      expect((await request(a, "DELETE", `/api/books/${sibling.bookId}`)).status()).toBe(200);
      result = await capture("sibling deletion");
      expect.soft(result.batch.tombstones?.some((row) => row.bookId === sibling.bookId)).toBe(true);
      expect.soft(toDeviceState(result.snapshot).booksByFingerprint.has(sibling.media)).toBe(false);
      expect(
        (
          await request(a, "PATCH", `/api/books/${newId}`, { title: "After Highest Deleted" })
        ).status(),
      ).toBe(200);
      result = await capture("edit after highest deletion");
      expect
        .soft(result.batch.books.find((row) => row.id === newId)?.title)
        .toBe("After Highest Deleted");
      receipts.push({ initialCursor, finalCursor: cursor });
    } finally {
      // Preserve numeric/raw observations even when a soft assertion is red.
      writeFileSync(
        info.outputPath("sibling-cursors.json"),
        JSON.stringify({ futureStream, receipts }, null, 2),
      );
      await a.context.close();
      await b.context.close();
    }
  });
}

for (const operation of ["insert", "update", "delete"] as const) {
  test(`account receipts cannot strand a delayed ${operation} across a concurrent pull`, async ({
    browser,
  }, info) => {
    const { account, a, b } = await setUpPair(browser);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let barrier: Promise<unknown> | undefined;
    const pending: Promise<unknown>[] = [];
    const receipts: unknown[] = [];
    try {
      const first = await seedBook(account, a, b, `ordered-a-${operation}`, "First Before");
      const second = await seedBook(account, a, b, `ordered-b-${operation}`, "Second Before");
      const cursor = (await mirror(b.page)).syncMeta!.cursor!;
      const targetId = operation === "insert" ? randomUUID() : first.bookId;
      let blockerPid = 0;
      const rollback = new Error("rollback disposable uncommitted insert barrier");
      barrier = sql()
        .begin(async (transaction) => {
          const [connection] = await transaction<{ pid: number }[]>`select pg_backend_pid() as pid`;
          blockerPid = connection!.pid;
          if (operation === "insert") {
            // The server insert waits for this uncommitted PK, then succeeds
            // after rollback. No trigger, table lock or retained row is changed.
            await transaction`insert into books (id, owner_id, title, author)
            values (${targetId}::uuid, ${account.userId}, 'Uncommitted fixture', 'Fixture')`;
          } else {
            await transaction`select pg_advisory_xact_lock(hashtextextended(${`tags:${account.userId}`}, 0))`;
          }
          await gate;
          if (operation === "insert") throw rollback;
        })
        .catch((error: unknown) => {
          if (error !== rollback) throw error;
        });
      // Observe the fixture lock itself before launching either HTTP write.
      await expect
        .poll(async () => {
          const [row] = await sql()<{ ready: boolean }[]>`select exists(
          select 1 from pg_stat_activity where pid=${blockerPid} and state='idle in transaction'
        ) as ready`;
          return row!.ready;
        })
        .toBe(true);
      const slow =
        operation === "insert"
          ? request(a, "POST", "/api/books/local", {
              ...importPayload(fingerprint(`ordered-new-${operation}`), "First After"),
              bookId: targetId,
            })
          : request(
              a,
              operation === "update" ? "PATCH" : "DELETE",
              `/api/books/${targetId}`,
              operation === "update" ? { title: "First After", tags: ["commit-order"] } : undefined,
            );
      pending.push(slow);
      let firstPid = 0;
      await expect
        .poll(
          async () => {
            const [row] = await sql()<{ pid: number }[]>`select pid from pg_stat_activity
          where ${blockerPid} = any(pg_blocking_pids(pid))`;
            firstPid = row?.pid ?? 0;
            return firstPid;
          },
          { message: "first real HTTP writer did not reach the scoped DB barrier" },
        )
        .toBeGreaterThan(0);

      const fast = request(a, "PATCH", `/api/books/${second.bookId}`, {
        title: "Second After",
      });
      pending.push(fast);
      // Busy admission rolls back promptly, without allocating or publishing a
      // later receipt. The same intent retries after the first commit below.
      const busy = await fast;
      expect(busy.status()).toBe(503);
      const during = await incremental(b, cursor);
      receipts.push({
        phase: "while first writer is blocked",
        blockerPid,
        firstPid,
        secondStatus: busy.status(),
        batch: during,
      });
      expect(during.books).toEqual([]);
      expect(during.playbackStates).toEqual([]);
      expect(during.tombstones).toEqual([]);
      expect(during.cursor).toBe(cursor);
      release();
      await barrier;
      expect((await slow).status()).toBe(operation === "insert" ? 201 : 200);
      expect(
        (
          await request(a, "PATCH", `/api/books/${second.bookId}`, {
            title: "Second After",
          })
        ).status(),
      ).toBe(200);
      const after = await incremental(b, during.cursor);
      receipts.push({ phase: "after both commits", batch: after });
      // A full liveBookIds snapshot could conceal a stranded tombstone: assert
      // the incremental stream itself, which older clients also consume.
      if (operation === "delete") {
        expect(after.tombstones?.some((row) => row.bookId === targetId)).toBe(true);
      } else {
        expect(after.books.find((row) => row.id === targetId)?.title).toBe("First After");
      }
      expect(after.books.find((row) => row.id === second.bookId)?.title).toBe("Second After");
    } finally {
      release();
      await Promise.allSettled([...(barrier ? [barrier] : []), ...pending]);
      writeFileSync(
        info.outputPath("commit-order.json"),
        JSON.stringify({ operation, receipts }, null, 2),
      );
      await a.context.close();
      await b.context.close();
    }
  });
}
