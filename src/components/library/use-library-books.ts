"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { filterLibraryBooks, type LibraryBook } from "@/domain/library";
import { afterLaunchPaint } from "@/lib/launch-revalidation";
import type { OfflineBook } from "@/lib/offline/db";
import { removeOfflineBook } from "@/lib/offline/deletion-journal";
import { listOfflineBooks, listVisibleStoredOfflineBooks } from "@/lib/offline/library";
import { libraryRevision } from "@/lib/offline/library-revision";
import {
  applyPullBatch,
  getSyncMeta,
  healMirrorPlaybackFromLocal,
  readMirrorLibrary,
} from "@/lib/offline/mirror";
import { isPullBatch } from "@/lib/offline/sync-protocol";
import { singleFlight } from "@/lib/single-flight";

import type { SortOrder, StatusFilter } from "./library-view";

/**
 * The library's only source of truth is this device.
 *
 * Every read below goes to IndexedDB — the mirror for metadata, `downloads`
 * for the audio this device actually holds. There is no "am I online?" branch
 * on this path, which is what makes search, the facets, sort and the continue
 * card behave identically with the network off.
 *
 * The network appears exactly once, *after* the first paint, as revalidation:
 * a pull is applied to the mirror and the re-read patches into the list that
 * is already on screen.
 */

export type LibraryFilters = {
  query: string;
  status: StatusFilter;
  tag: string | null;
  sort: SortOrder;
  onDevice: boolean;
};

/**
 * Downloads keyed by book id: byte size, cover art, and the record to play.
 *
 * Only books whose audio this device can actually reach. A record marked
 * `mediaMissingSince` is deliberately absent: this map decides the download
 * badge, the on-device facet and — through `library-client.tsx`'s
 * `device.get(...)` → `asOfflinePlayerBook` — which record the library hands
 * straight to the player. The book itself is still listed and still openable;
 * the gate then offers to re-attach the MP3.
 */
export type DeviceIndex = Map<string, OfflineBook>;

type LibraryListing = {
  /** Matching rows, already filtered and sorted. */
  books: LibraryBook[];
  /** Every book on this device, regardless of the active filters. */
  device: DeviceIndex;
  /** Every book this account has anywhere, for the empty-library decision. */
  libraryTotal: number;
  tags: string[];
  continueBook: LibraryBook | null;
};

const PULL_PAGE_LIMIT = 50;

/**
 * How long a device that has never synced may spend on its first pull before
 * the library stops saying "setting up" and says what is actually happening.
 *
 * Without a ceiling a stalled-but-alive connection would hold a first-time user
 * on "setting up" indefinitely — the same failure the service worker's
 * navigation budget exists to prevent. What the ceiling may NOT do is conclude
 * the pull succeeded: it is a deadline on the wording, not on the truth.
 */
const FIRST_SYNC_GATE_MS = 4_000;

/**
 * How long to wait before asking again after a first pull that could not reach
 * the server. Doubles per attempt and is capped, because a device with no
 * mirror has nothing to show until this succeeds and equally must not turn a
 * server outage into a retry storm.
 */
function retryDelayFor(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4));
}

/**
 * Whether this device has ever completed a pull for the signed-in account.
 *
 * `done` is set from exactly two facts — a sync cursor already in the mirror,
 * or a pull that just applied one — and from nothing else. It used to be set by
 * the gate above and by an `unreachable` pull as well, which meant a device
 * that had never synced and could not reach the server announced that the
 * account owns no books. It does not know that. Nobody has told it anything.
 */
type FirstSync = "unknown" | "pending" | "done";

/** What the library may say about a first pull it has not yet completed. */
export type FirstSyncStatus = "done" | "waiting" | "slow" | "unreachable";

function firstSyncStatusOf(
  firstSync: FirstSync,
  attempt: number,
  slowAttempt: number,
  unreachedAttempt: number,
): FirstSyncStatus {
  if (firstSync === "done") return "done";
  if (unreachedAttempt === attempt) return "unreachable";
  if (slowAttempt === attempt) return "slow";
  return "waiting";
}

export function useLibraryBooks(
  userId: string | null,
  filters: LibraryFilters,
  routeBookId: string | null = null,
) {
  const { query, status, tag, sort, onDevice } = filters;
  const [source, setSource] = useState<(LibraryListing & { userId: string }) | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loaded = useRef<{
    userId: string;
    nonce: number;
    routeBookId: string | null;
    revision: number;
  } | null>(null);
  const [reconnects, setReconnects] = useState(0);
  const [firstSync, setFirstSync] = useState<FirstSync>("unknown");
  /**
   * Which pull attempt ran past the gate, and which one could not reach the
   * server at all. Both are recorded as the attempt number rather than as a
   * boolean, so a retry clears them by moving on instead of by a second state
   * write racing the effect that starts the attempt they belong to.
   */
  const [slowAttempt, setSlowAttempt] = useState(-1);
  const [unreachedAttempt, setUnreachedAttempt] = useState(-1);

  const reread = useCallback(() => setNonce((current) => current + 1), []);

  // Unchanged filters use the account snapshot. A committed mutation marks it
  // dirty (also across tabs), so the next control interaction reads fresh rows.
  // Route returns and explicit refreshes also heal this device's saved position.
  useEffect(() => {
    if (!userId) return;
    const prior = loaded.current;
    const refresh =
      prior?.userId !== userId || prior.nonce !== nonce || prior.routeBookId !== routeBookId;
    const revision = libraryRevision();
    if (!refresh && prior.revision === revision) return;
    let active = true;
    void readLibrary(userId, refresh)
      .then((next) => {
        if (active) {
          loaded.current = { userId, nonce, routeBookId, revision };
          setSource({ ...next, userId });
          setUnavailable(false);
        }
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [userId, nonce, routeBookId, query, status, tag, sort, onDevice]);

  const snapshot = useMemo(() => {
    if (!source || source.userId !== userId) return null;
    const books = filterLibraryBooks(source.books, { query, status, tag, sort });
    return {
      ...source,
      books: onDevice ? books.filter((book) => source.device.has(book.id)) : books,
    };
  }, [source, userId, query, status, tag, sort, onDevice]);

  // Revalidation, after paint and never before.
  //
  // An earlier version scheduled this on `requestAnimationFrame` from mount,
  // which fires while the mirror is still being read — before there is any
  // paint to be "after". `afterLaunchPaint` waits for the render that puts the
  // user's real library on screen and then for the browser to go quiet, so the
  // pull competes with nothing that launch is measured on.
  //
  // The cold start is the exception, and it is the one section 10 asks for: a
  // device that has never completed a pull has no mirror to paint, so it would
  // be telling someone with a library that they have no books. There is nothing
  // to protect, so the first pull runs at once and the library waits for it.
  // The test is the sync cursor, not "the list looks empty" — an account that
  // genuinely owns no books has a cursor, and must not re-pull eagerly on every
  // launch forever.
  useEffect(() => {
    if (!userId) return;
    let active = true;
    let cancelWait = () => {};
    let gate = 0;
    let backoff = 0;
    let firstPull = false;
    const attempt = reconnects;
    const run = () => {
      void revalidate(userId).then((outcome) => {
        if (!active) return;
        // An expired or revoked session must never strand the user on a
        // cached library. Purging belongs to the sign-in/sign-out path,
        // which owns it; doing it here would destroy the only copy of the
        // audio over a session that has merely timed out.
        if (outcome === "unauthorized") {
          window.location.replace("/login");
          return;
        }
        window.clearTimeout(gate);
        // Only a pull that actually applied proves this device now knows what
        // the account holds. `unreachable` proves the opposite.
        if (outcome === "applied") setFirstSync("done");
        else {
          setUnreachedAttempt(attempt);
          // A device with no mirror cannot show a library at all, so its first
          // pull is retried on its own rather than waiting for the user to
          // notice. One dropped request must not cost a launch. The delay grows
          // and is capped, so a server that is down is asked politely rather
          // than hammered, and every later pull is still reconnect-driven.
          if (firstPull) backoff = window.setTimeout(retryFirstPull, retryDelayFor(attempt));
        }
        reread();
      });
    };
    const retryFirstPull = () => {
      if (active) setReconnects((current) => current + 1);
    };
    void getSyncMeta(userId)
      .catch(() => undefined)
      .then((meta) => {
        if (!active) return;
        if (meta?.cursor) {
          setFirstSync("done");
          cancelWait = afterLaunchPaint(run);
          return;
        }
        firstPull = true;
        setFirstSync("pending");
        gate = window.setTimeout(() => {
          if (active) setSlowAttempt(attempt);
        }, FIRST_SYNC_GATE_MS);
        run();
      });
    return () => {
      active = false;
      window.clearTimeout(gate);
      window.clearTimeout(backoff);
      cancelWait();
    };
  }, [userId, reconnects, reread]);

  // Section 6: pull runs on launch and on reconnect. Nothing else listens for
  // connectivity, and nothing on the read path does.
  useEffect(() => {
    const onOnline = () => setReconnects((current) => current + 1);
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", reread);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", reread);
    };
  }, [reread]);

  const retry = useCallback(() => {
    setUnavailable(false);
    // Also re-runs the pull, which is what a device that has never synced is
    // actually retrying — re-reading an empty mirror would tell it nothing.
    setReconnects((current) => current + 1);
    reread();
  }, [reread]);

  /** Completed local audio is usable even while the sync peer is stalled. */
  const reload = useCallback(async () => {
    if (!userId) return;
    reread();
    void revalidate(userId).then(reread);
  }, [userId, reread]);

  const removeDownload = useCallback(
    async (bookId: string) => {
      if (!userId) return false;
      try {
        // Journaled before any bytes move, so a failure retries on next load.
        // This removes the media this device holds and nothing else: the book,
        // its chapters, tags, progress and history are untouched.
        await removeOfflineBook(userId, bookId);
      } catch {
        return false;
      }
      reread();
      return true;
    },
    [userId, reread],
  );

  return {
    snapshot,
    /**
     * This device has never completed a pull for this account, so an empty
     * mirror does not mean an empty library — it means nobody has asked yet.
     * The caller must not present that as the genuine "no books" state.
     */
    preparing: firstSync !== "done",
    /**
     * How that first pull is going, for the wording only — every value but
     * `done` means this device does not know what the account holds, and none
     * of them may carry the readiness marker.
     *
     * `slow` and `unreachable` are deliberately separate. A pull still in
     * flight past the gate has not failed, and telling the user it did would be
     * as wrong as telling them their library is empty.
     */
    firstSyncStatus: firstSyncStatusOf(firstSync, reconnects, slowAttempt, unreachedAttempt),
    unavailable,
    reload,
    retry,
    removeDownload,
  };
}

// ---------------------------------------------------------------------------
// Local reads
// ---------------------------------------------------------------------------

// A refresh heals the durable position once; filter keystrokes never write.
const activeHeals = new Map<string, Promise<void>>();

async function readLibrary(userId: string, heal: boolean): Promise<LibraryListing> {
  // Never fatal to a read: a device that cannot write the mirror can still show
  // what the mirror already holds.
  if (heal)
    await singleFlight(activeHeals, userId, async () => {
      await healMirrorPlaybackFromLocal(userId).catch(() => 0);
    });
  const [mirror, records] = await Promise.all([
    readMirrorLibrary(userId),
    listVisibleStoredOfflineBooks(userId),
  ]);
  const mirrorIds = new Set(mirror.books.map((book) => book.id));
  // Keep metadata for device-only books even if their audio was evicted.
  const books = [
    ...mirror.books,
    ...records.filter((record) => !mirrorIds.has(record.book.id)).map(asLibraryBook),
  ];
  const device: DeviceIndex = new Map(
    records.filter((record) => !record.mediaMissingSince).map((record) => [record.book.id, record]),
  );
  return {
    books,
    device,
    libraryTotal: books.length,
    tags: mirror.tags,
    continueBook: mirror.continueBook,
  };
}

function asLibraryBook(record: OfflineBook): LibraryBook {
  return {
    id: record.book.id,
    title: record.book.title,
    author: record.book.author,
    narrator: null,
    series: null,
    chapterDiagnostic: null,
    archivedAt: null,
    createdAt: record.downloadedAt,
    updatedAt: record.downloadedAt,
    tags: [],
    durationMs: record.book.durationMs,
    positionMs: record.book.initialPositionMs || 0,
    completed: record.book.completed || false,
    progressUpdatedAt: record.book.initialProgressOccurredAt,
  };
}

// ---------------------------------------------------------------------------
// Revalidation — the only network on this path, and only after paint
// ---------------------------------------------------------------------------

type PullOutcome = "applied" | "unauthorized" | "unreachable";

async function revalidate(userId: string): Promise<PullOutcome> {
  const outcome = await pull(userId);
  // Reconciling downloads against Cache Storage is how missing audio is
  // detected: the record is marked "not on this device" — never deleted, and
  // never at the cost of its read-along cues — so the book stops looking
  // playable while staying re-attachable, and un-marks itself if the bytes come
  // back. See `reconcileOfflineRecord`.
  await listOfflineBooks(userId).catch(() => undefined);
  return outcome;
}

async function pull(userId: string): Promise<PullOutcome> {
  // Bounded: a server that keeps reporting `complete: false` without advancing
  // its cursor must not spin here.
  for (let page = 0; page < PULL_PAGE_LIMIT; page += 1) {
    const meta = await getSyncMeta(userId).catch(() => undefined);
    // `snapshots=final` declares that this bundle skips interim pages'
    // snapshot streams (mirror.ts gates on `batch.complete`), so the server
    // may omit them there. Bundles that predate the gate never send it and
    // keep receiving snapshots on every page.
    const since = meta?.cursor ? `&since=${encodeURIComponent(meta.cursor)}` : "";
    let response: Response;
    try {
      response = await fetch(`/api/sync/pull?snapshots=final${since}`, { cache: "no-store" });
    } catch {
      return "unreachable";
    }
    if (response.status === 401 || response.status === 403) return "unauthorized";
    if (!response.ok) return "unreachable";
    const batch: unknown = await response.json().catch(() => null);
    if (!isPullBatch(batch)) return "unreachable";
    try {
      await applyPullBatch(userId, batch);
    } catch {
      // The batch is all-or-nothing and the cursor moves with it, so a failed
      // apply leaves the mirror exactly as it was and the next pull retries.
      return "unreachable";
    }
    if (batch.complete) return "applied";
  }
  return "applied";
}
