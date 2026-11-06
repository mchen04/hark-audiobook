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
  LiveBookSetChangedError,
  localLiveBooks,
  readMirrorLibrary,
} from "@/lib/offline/mirror";
import { isPullBatch } from "@/lib/offline/sync-protocol";
import { singleFlight } from "@/lib/single-flight";

import type { SortOrder, StatusFilter } from "./library-view";

export type LibraryFilters = {
  query: string;
  status: StatusFilter;
  tag: string | null;
  sort: SortOrder;
  onDevice: boolean;
};

export type DeviceIndex = Map<string, OfflineBook>;

type LibraryListing = {
  books: LibraryBook[];
  device: DeviceIndex;
  libraryTotal: number;
  tags: string[];
  continueBook: LibraryBook | null;
};

const PULL_PAGE_LIMIT = 50;

const FIRST_SYNC_GATE_MS = 4_000;

function retryDelayFor(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4));
}

type FirstSync = "unknown" | "pending" | "applied" | "done";

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
  const firstSyncApplied = firstSync === "applied";
  const [slowAttempt, setSlowAttempt] = useState(-1);
  const [unreachedAttempt, setUnreachedAttempt] = useState(-1);

  const pullOwner = useRef<PullOwner | null>(null);
  useEffect(() => {
    if (!userId) {
      pullOwner.current = null;
      return;
    }
    const controller = new AbortController();
    pullOwner.current = { userId, signal: controller.signal };
    return () => controller.abort();
  }, [userId]);

  const reread = useCallback(() => setNonce((current) => current + 1), []);

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
          if (firstSyncApplied) setFirstSync("done");
        }
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [userId, nonce, routeBookId, query, status, tag, sort, onDevice, firstSyncApplied]);

  const snapshot = useMemo(() => {
    if (!source || source.userId !== userId) return null;
    const books = filterLibraryBooks(source.books, { query, status, tag, sort });
    return {
      ...source,
      books: onDevice ? books.filter((book) => source.device.has(book.id)) : books,
    };
  }, [source, userId, query, status, tag, sort, onDevice]);

  useEffect(() => {
    const owner = pullOwner.current;
    if (!userId || !owner) return;
    let active = true;
    let cancelWait = () => {};
    let gate = 0;
    let backoff = 0;
    let firstPull = false;
    const attempt = reconnects;
    const run = () => {
      void revalidate(owner).then((outcome) => {
        if (!active) return;
        if (outcome === "unauthorized") {
          window.location.replace("/login");
          return;
        }
        window.clearTimeout(gate);
        if (outcome === "applied")
          setFirstSync((current) => (current === "done" ? "done" : "applied"));
        else {
          setUnreachedAttempt(attempt);
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
    setReconnects((current) => current + 1);
    reread();
  }, [reread]);

  const reload = useCallback(async () => {
    const owner = pullOwner.current;
    if (!userId || owner?.userId !== userId) return;
    reread();
    void revalidate(owner).then(reread);
  }, [userId, reread]);

  const removeDownload = useCallback(
    async (bookId: string) => {
      if (!userId) return false;
      try {
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
    preparing: firstSync !== "done",
    firstSyncStatus: firstSyncStatusOf(firstSync, reconnects, slowAttempt, unreachedAttempt),
    unavailable,
    reload,
    retry,
    removeDownload,
  };
}

const activeHeals = new Map<string, Promise<void>>();

async function readLibrary(userId: string, heal: boolean): Promise<LibraryListing> {
  if (heal)
    await singleFlight(activeHeals, userId, async () => {
      await healMirrorPlaybackFromLocal(userId).catch(() => 0);
    });
  const [mirror, records] = await Promise.all([
    readMirrorLibrary(userId),
    listVisibleStoredOfflineBooks(userId),
  ]);
  const mirrorIds = new Set(mirror.books.map((book) => book.id));
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

type PullOutcome = "applied" | "unauthorized" | "unreachable";

type PullOwner = {
  userId: string;
  signal: AbortSignal;
  pending?: Promise<PullOutcome>;
};

async function revalidate(owner: PullOwner): Promise<PullOutcome> {
  const outcome = await pull(owner);
  if (!owner.signal.aborted) await listOfflineBooks(owner.userId).catch(() => undefined);
  return outcome;
}

function pull(owner: PullOwner): Promise<PullOutcome> {
  return (owner.pending ??= pullOnce(owner).finally(() => {
    owner.pending = undefined;
  }));
}

async function pullOnce(owner: PullOwner): Promise<PullOutcome> {
  const { userId } = owner;
  let sendDigest = true;
  for (let page = 0; page < PULL_PAGE_LIMIT; page += 1) {
    if (owner.signal.aborted) return "unreachable";
    const meta = await getSyncMeta(userId).catch(() => undefined);
    const since = meta?.cursor ? `&since=${encodeURIComponent(meta.cursor)}` : "";
    const held = sendDigest ? await localLiveBooks(userId).catch(() => null) : null;
    const liveBooks = held ? `&liveBooks=${held.digest}` : "";
    try {
      owner.signal.throwIfAborted();
      const response = await fetch(`/api/sync/pull?snapshots=final${since}${liveBooks}`, {
        cache: "no-store",
        signal: owner.signal,
      });
      if (response.status === 401 || response.status === 403) return "unauthorized";
      if (!response.ok) return "unreachable";
      const body: unknown = await response.json();
      if (!isPullBatch(body)) return "unreachable";
      await applyPullBatch(userId, body, held?.ids, owner.signal);
      if (body.complete) return "applied";
    } catch (error) {
      if (error instanceof LiveBookSetChangedError) {
        sendDigest = false;
        continue;
      }
      return "unreachable";
    }
  }
  return "applied";
}
