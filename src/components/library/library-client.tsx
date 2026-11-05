"use client";

import {
  BookOpenText,
  CloudSlash,
  DownloadSimple,
  MagnifyingGlass,
  Plus,
  SortAscending,
  Rows,
  SquaresFour,
  TextAlignLeft,
  Trash,
  UploadSimple,
  WarningCircle,
  WaveSine,
  X,
} from "@phosphor-icons/react";
import Link from "next/link";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { memo, useCallback, useDeferredValue, useEffect, useState } from "react";

import { FullPlayer } from "@/components/player/full-player";
import { LocalMediaGate } from "@/components/player/local-media-gate";
import { useActiveUserId } from "@/components/use-active-user";
import { titleMonogram } from "@/lib/book-monogram";

import type { LibraryBook } from "@/domain/library";
import { formatBytes } from "@/lib/format-bytes";
import { formatDurationRounded } from "@/lib/format-time";
import { markLaunchPainted } from "@/lib/launch-revalidation";
import type { OfflineBook } from "@/lib/offline/db";
import { asOfflinePlayerBook } from "@/lib/offline/library";
import { getMirrorPlayerBook, type MirrorPlayerBook } from "@/lib/offline/mirror";
import { listBookIdsWithTranscripts } from "@/lib/offline/transcript-store";

import { abortImport } from "@/lib/document-import/import-controller";

import { LibraryPlayButton } from "./library-play-button";
import { UploadBanners, useBookImport, type UploadState } from "./library-upload";
import { type SortOrder, type StatusFilter } from "./library-view";
import { useLibraryViewState } from "./library-view-state";
import { usePageWindow, useSeedFollowingValue } from "./use-derived-reset";
import { type DeviceIndex, useLibraryBooks } from "./use-library-books";
import { useOfflineBookRoute } from "./use-offline-book-route";

type LibraryClientProps = {
  userId?: string;
};

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "in-progress", label: "In progress" },
  { id: "not-started", label: "Not started" },
  { id: "finished", label: "Finished" },
  { id: "archived", label: "Archived" },
];

const PAGE_SIZE = 50;

const MISSING_MEDIA_HINT =
  "The audio for this book lives only on the device that imported it. Attach its original source here to listen.";

export function LibraryClient({ userId: serverUserId }: LibraryClientProps) {
  const userId = useActiveUserId(serverUserId);
  const searchParams = useSearchParams();
  const { view: savedView, setView: setSavedView } = useLibraryViewState();
  const { query, status, activeTag, sort, view } = savedView;
  const deferredQuery = useDeferredValue(query);
  const [onDevice, setOnDevice] = useSeedFollowingValue(
    searchParams.get("device") === "1" || savedView.onDevice,
  );
  const [readAlongIds, setReadAlongIds] = useState<Set<string>>(new Set());
  const { bookId: fallbackBookId, leavePlayer } = useOfflineBookRoute();

  const updateDeviceRoute = useCallback((enabled: boolean) => {
    const params = new URLSearchParams(window.location.search);
    if (enabled) params.set("device", "1");
    else params.delete("device");
    const queryString = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${queryString ? `?${queryString}` : ""}${window.location.hash}`,
    );
  }, []);

  const { snapshot, preparing, firstSyncStatus, unavailable, reload, retry, removeDownload } =
    useLibraryBooks(
      userId,
      { query: deferredQuery, status, tag: activeTag, sort, onDevice },
      fallbackBookId,
    );

  const [error, setError] = useState<string | null>(null);
  const { fileInput, upload, chooseFile } = useBookImport(userId, reload, setError);

  const books = snapshot?.books || [];
  const device: DeviceIndex = snapshot?.device || EMPTY_DEVICE_INDEX;
  const playing = fallbackBookId ? device.get(fallbackBookId) || null : null;
  const snapshotReady = snapshot !== null;
  const [mirroredRoute, setMirroredRoute] = useState<{
    bookId: string;
    phase: "checking" | "ready" | "missing" | "unavailable";
    book?: MirrorPlayerBook;
  } | null>(null);
  const filterKey = JSON.stringify([deferredQuery, status, activeTag, sort, onDevice]);
  const { pages, showMore } = usePageWindow(filterKey);
  const firstSync = !!snapshot && snapshot.libraryTotal === 0 && preparing;
  const launchReady = !snapshot
    ? undefined
    : snapshot.libraryTotal === 0
      ? firstSync
        ? undefined
        : "empty"
      : books.length > 0
        ? "books"
        : undefined;

  useEffect(() => {
    if (launchReady) markLaunchPainted();
  }, [launchReady]);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    void listBookIdsWithTranscripts(userId)
      .then((ids) => {
        if (active) setReadAlongIds(ids);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [userId]);

  useEffect(() => {
    if (!userId || !fallbackBookId || playing || !snapshotReady) return;
    let active = true;
    void getMirrorPlayerBook(userId, fallbackBookId).then(
      (book) => {
        if (!active) return;
        setMirroredRoute(
          book
            ? { bookId: fallbackBookId, phase: "ready", book }
            : { bookId: fallbackBookId, phase: "missing" },
        );
      },
      () => {
        if (active) setMirroredRoute({ bookId: fallbackBookId, phase: "unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [fallbackBookId, playing, snapshotReady, userId]);

  useEffect(() => {
    if (
      !playing &&
      fallbackBookId &&
      mirroredRoute?.bookId === fallbackBookId &&
      mirroredRoute.phase === "missing"
    ) {
      leavePlayer();
    }
  }, [fallbackBookId, leavePlayer, mirroredRoute, playing]);

  const forgetDownload = useCallback(
    async (bookId: string) => {
      const removed = await removeDownload(bookId);
      if (!removed) {
        setError("The download could not be removed right now. It will retry automatically.");
      }
    },
    [removeDownload, setError],
  );

  if (playing) {
    return (
      <FullPlayer
        playerBook={asOfflinePlayerBook(playing)}
        offlineMode
        backLabel="Library"
        onBack={leavePlayer}
      />
    );
  }

  if (fallbackBookId) {
    const route = mirroredRoute?.bookId === fallbackBookId ? mirroredRoute : null;
    if (route?.phase === "ready" && route.book) {
      return (
        <LocalMediaGate
          userId={userId!}
          playerBook={route.book.playerBook}
          mediaFingerprint={route.book.mediaFingerprint}
          mediaFingerprintKind={route.book.mediaFingerprintKind}
          mediaRenditionKey={route.book.mediaRenditionKey}
          byteSize={route.book.byteSize}
          sourceFilename={route.book.sourceFilename}
          sourceMimeType={route.book.sourceMimeType}
          autoplay={searchParams.get("autoplay") === "1"}
          details={null}
          nextInCollection={null}
        />
      );
    }
    if (route?.phase === "missing") {
      return null;
    }
    if (route?.phase === "unavailable") {
      return (
        <main className="local-media-gate">
          <section>
            <h1>This book is temporarily unavailable</h1>
            <p>Hark could not read this device&apos;s saved library.</p>
            <button type="button" className="secondary-button" onClick={leavePlayer}>
              Back to library
            </button>
          </section>
        </main>
      );
    }
    return null;
  }

  if (!snapshot) {
    return unavailable ? (
      <section className="library-content">
        <div className="no-results">
          <WarningCircle size={30} weight="duotone" aria-hidden="true" />
          <h2>Your library is temporarily unavailable</h2>
          <p>Hark could not open this device&apos;s storage. Your records are intact.</p>
          <button type="button" className="secondary-button" onClick={retry}>
            Try again
          </button>
        </div>
      </section>
    ) : (
      <section className="library-content" aria-busy="true">
        <p role="status">Opening your library…</p>
      </section>
    );
  }

  if (firstSync) {
    if (firstSyncStatus === "unreachable") {
      return (
        <section className="library-content" aria-labelledby="library-title">
          <div className="no-results">
            <CloudSlash size={30} weight="duotone" aria-hidden="true" />
            <h2 id="library-title">This device has not seen your library yet</h2>
            <p>
              Hark could not reach your account from this device, so it cannot tell you what is in
              your library. Nothing is lost — this finishes as soon as there is a connection.
            </p>
            <button type="button" className="secondary-button" onClick={retry}>
              Try again
            </button>
          </div>
        </section>
      );
    }
    return (
      <section className="library-content" aria-labelledby="library-title" aria-busy="true">
        <div className="no-results">
          <BookOpenText size={30} weight="duotone" aria-hidden="true" />
          <h2 id="library-title">Setting up your library</h2>
          <p>
            Hark is bringing this account&apos;s books onto this device for the first time.
            {firstSyncStatus === "slow" && " This one is taking longer than usual."}
          </p>
        </div>
      </section>
    );
  }

  const shown = books.slice(0, pages * PAGE_SIZE);
  const continueBook = snapshot.continueBook;
  const continueRecord = continueBook ? device.get(continueBook.id) : undefined;

  return (
    <>
      {fileInput}

      {snapshot.libraryTotal === 0 && !upload ? (
        <section
          className="empty-library"
          data-launch-ready={launchReady}
          aria-labelledby="library-title"
          aria-busy={!!upload}
        >
          <div className="empty-library-art" aria-hidden="true">
            <BookOpenText size={54} weight="duotone" />
          </div>
          <p className="library-kicker">Your private library</p>
          <h1 id="library-title">Bring your first audiobook.</h1>
          <p>
            Choose an MP3, or let Kestrel narrate a document privately on this device. Hark keeps
            the result offline and remembers your place.
          </p>
          <button type="button" className="primary-button" onClick={chooseFile} disabled={!!upload}>
            <UploadSimple size={20} weight="bold" aria-hidden="true" />
            <span>{upload ? "Importing" : "Choose a book"}</span>
          </button>
          <small>MP3, PDF, EPUB, DOCX, TXT, Markdown, or HTML. Files never upload.</small>
        </section>
      ) : (
        <section
          className="library-content"
          data-launch-ready={launchReady}
          aria-labelledby="library-title"
          aria-busy={!!upload}
        >
          <div className="library-heading">
            <h1 id="library-title">Library</h1>
            <button
              type="button"
              className="primary-button"
              onClick={chooseFile}
              disabled={!!upload}
            >
              <Plus size={20} weight="bold" aria-hidden="true" />
              <span>{upload ? "Importing" : "Add book"}</span>
            </button>
          </div>

          <div>
            {continueBook && (
              <div className="continue-card">
                <Link
                  href={`/books/${continueBook.id}`}
                  className="continue-open"
                  prefetch={false}
                  aria-label={`Continue listening ${continueBook.title}`}
                >
                  <span className="book-cover continue-cover" aria-hidden="true">
                    <BookCover book={continueBook} coverUrl={coverUrlFor(continueRecord)} />
                  </span>
                  <span className="continue-copy">
                    <small>Continue listening</small>
                    <strong>{continueBook.title}</strong>
                    <span>
                      {progressPercent(continueBook)}% · {remainingLabel(continueBook)}
                      {continueRecord ? "" : " · Not on this device"}
                    </span>
                  </span>
                </Link>
                {continueRecord ? (
                  <LibraryPlayButton record={continueRecord} title={continueBook.title} resume />
                ) : (
                  <span className="continue-play continue-unavailable" title={MISSING_MEDIA_HINT}>
                    <CloudSlash size={22} aria-hidden="true" />
                    <span className="visually-hidden">Not on this device</span>
                  </span>
                )}
              </div>
            )}

            <div className="library-tools">
              <label className="search-field">
                <MagnifyingGlass size={19} aria-hidden="true" />
                <span className="visually-hidden">Search your library</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => {
                    const next = event.target.value;
                    setSavedView((current) => ({ ...current, query: next }));
                  }}
                  placeholder="Search library"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setSavedView((current) => ({ ...current, query: "" }));
                    }}
                    aria-label="Clear search"
                  >
                    <X size={17} aria-hidden="true" />
                  </button>
                )}
              </label>
              <label className="sort-field">
                <SortAscending size={20} aria-hidden="true" />
                <span className="visually-hidden">Sort books</span>
                <select
                  value={sort}
                  onChange={(event) => {
                    const next = event.target.value as SortOrder;
                    setSavedView((current) => ({ ...current, sort: next }));
                  }}
                >
                  <option value="activity">Recent activity</option>
                  <option value="added">Recently added</option>
                  <option value="title">Title A–Z</option>
                  <option value="author">Author A–Z</option>
                </select>
              </label>
              <div className="view-switch" aria-label="Library view">
                <button
                  type="button"
                  aria-label="Grid view"
                  aria-pressed={view === "grid"}
                  onClick={() => {
                    setSavedView((current) => ({ ...current, view: "grid" }));
                  }}
                >
                  <SquaresFour size={19} weight={view === "grid" ? "fill" : "regular"} />
                </button>
                <button
                  type="button"
                  aria-label="List view"
                  aria-pressed={view === "list"}
                  onClick={() => {
                    setSavedView((current) => ({ ...current, view: "list" }));
                  }}
                >
                  <Rows size={19} weight={view === "list" ? "bold" : "regular"} />
                </button>
              </div>
            </div>

            <div className="library-filters" role="group" aria-label="Filter your library">
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  className="filter-chip"
                  aria-pressed={status === filter.id}
                  onClick={() => {
                    setSavedView((current) => ({ ...current, status: filter.id }));
                  }}
                >
                  {filter.label}
                </button>
              ))}
              <button
                type="button"
                className="filter-chip filter-chip-device"
                aria-pressed={onDevice}
                onClick={() => {
                  const next = !onDevice;
                  setOnDevice(next);
                  setSavedView((current) => ({ ...current, onDevice: next }));
                  updateDeviceRoute(next);
                }}
              >
                <DownloadSimple size={15} weight="bold" aria-hidden="true" />
                <span>On this device</span>
                {device.size > 0 && <span className="filter-chip-count">{device.size}</span>}
              </button>
              {snapshot.tags.map((tag) => (
                <button
                  key={`tag-${tag}`}
                  type="button"
                  className="filter-chip filter-chip-tag"
                  aria-pressed={activeTag === tag}
                  onClick={() => {
                    const next = activeTag === tag ? null : tag;
                    setSavedView((current) => ({ ...current, activeTag: next }));
                  }}
                >
                  #{tag}
                </button>
              ))}
            </div>
          </div>

          <div>
            {upload || shown.length ? (
              <div className={`book-grid ${view === "list" ? "book-grid-list" : ""}`}>
                {upload && <NarratingItem upload={upload} />}
                {shown.map((book) => (
                  <BookItem
                    book={book}
                    key={book.id}
                    compact={view === "list"}
                    record={device.get(book.id)}
                    hasReadAlong={readAlongIds.has(book.id)}
                    onRemoveDownload={forgetDownload}
                  />
                ))}
              </div>
            ) : (
              <div className="no-results">
                <MagnifyingGlass size={30} weight="duotone" aria-hidden="true" />
                <h2>
                  {onDevice && device.size === 0 ? "Nothing downloaded yet" : "No matching books"}
                </h2>
                <p>
                  {onDevice && device.size === 0
                    ? "Open a book and attach its original source to listen on this device."
                    : "Try another search, status, or tag."}
                </p>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setSavedView((current) => ({
                      ...current,
                      query: "",
                      status: "all",
                      activeTag: null,
                      onDevice: false,
                    }));
                    setOnDevice(false);
                    updateDeviceRoute(false);
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
            {books.length > shown.length && (
              <div className="library-more">
                <button type="button" className="secondary-button" onClick={showMore}>
                  Load more books
                </button>
                <small>
                  Showing {shown.length} of {books.length} matching books.
                </small>
              </div>
            )}
          </div>
        </section>
      )}

      <UploadBanners error={error} onDismissError={() => setError(null)} />
    </>
  );
}

const EMPTY_DEVICE_INDEX: DeviceIndex = new Map();

function coverUrlFor(record: OfflineBook | undefined): string | undefined {
  return record ? record.offlineCoverThumbUrl || record.offlineCoverUrl || undefined : undefined;
}

function progressPercent(book: LibraryBook): number {
  if (!book.durationMs || !book.positionMs) return 0;
  return Math.min(100, Math.max(0, Math.round((book.positionMs / book.durationMs) * 100)));
}

function remainingLabel(book: LibraryBook): string {
  if (!book.durationMs) return "";
  const remaining = Math.max(0, book.durationMs - (book.positionMs || 0));
  if (remaining < 60_000) return "under a minute left";
  return `${formatDurationRounded(remaining)} left`;
}

function BookCover({ book, coverUrl }: { book: LibraryBook; coverUrl?: string }) {
  if (coverUrl) {
    return (
      <Image
        className="book-cover-art"
        src={coverUrl}
        alt=""
        width={160}
        height={240}
        unoptimized
      />
    );
  }
  return (
    <>
      <span>{titleMonogram(book.title)}</span>
      <small>MP3</small>
    </>
  );
}

const BookItem = memo(function BookItem({
  book,
  compact,
  record,
  hasReadAlong,
  onRemoveDownload,
}: {
  book: LibraryBook;
  compact: boolean;
  record?: OfflineBook;
  hasReadAlong?: boolean;
  onRemoveDownload: (bookId: string) => void;
}) {
  const percent = progressPercent(book);

  return (
    <article
      className="book-item"
      title={record ? undefined : "Not on this device — attach its original file to listen"}
    >
      <div className="book-cover-controls">
        <Link
          href={`/books/${book.id}`}
          className="book-cover"
          prefetch={false}
          tabIndex={-1}
          aria-hidden="true"
        >
          <BookCover book={book} coverUrl={coverUrlFor(record)} />
          {hasReadAlong && (
            <span className="book-readalong">
              <TextAlignLeft size={12} aria-hidden="true" />
              Read-along
            </span>
          )}
        </Link>
        {!compact && !record && (
          <span className="book-offdevice">
            <CloudSlash size={12} aria-hidden="true" />
            <span className="book-offdevice-label">Not on device</span>
          </span>
        )}
        {!compact && record && <LibraryPlayButton record={record} title={book.title} />}
      </div>
      <div className="book-copy">
        <Link href={`/books/${book.id}`} className="book-title" prefetch={false}>
          {book.title}
        </Link>
        <p>{book.author}</p>
        {book.chapterDiagnostic && (
          <p className="book-diagnostic" title={book.chapterDiagnostic}>
            <WarningCircle size={15} aria-hidden="true" />
            One chapter
          </p>
        )}
        {book.tags.length > 0 && <p className="book-tags">{book.tags.join(" · ")}</p>}
        {compact && !record && (
          <p className="book-device book-device-missing" title={MISSING_MEDIA_HINT}>
            <CloudSlash size={14} aria-hidden="true" />
            <span>Not on this device — attach its original file to listen</span>
          </p>
        )}
        <div className="book-progress-copy">
          <span className="book-progress-status">
            {book.durationMs ? `${formatDurationRounded(book.durationMs)} • ` : ""}
            {book.completed ? "Finished" : percent ? `${percent}%` : "Not started"}
          </span>
          {record && (
            <>
              <span className="book-device-size">
                <DownloadSimple size={13} aria-hidden="true" />
                <span>{formatBytes(record.byteSize)}</span>
                <span className="visually-hidden">{" on this device"}</span>
              </span>
              <button
                type="button"
                className="book-device-remove"
                aria-label={`Remove download of ${book.title}`}
                title="Remove the audio from this device. The book, its progress and its history stay."
                onClick={() => onRemoveDownload(book.id)}
              >
                <Trash size={14} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
        <div
          className="book-progress"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Listening progress"
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      </div>
      {compact &&
        (record ? (
          <LibraryPlayButton record={record} title={book.title} />
        ) : (
          <span
            className="book-play-button book-play-unavailable"
            title={MISSING_MEDIA_HINT}
            aria-hidden="true"
          >
            <CloudSlash size={19} aria-hidden="true" />
          </span>
        ))}
    </article>
  );
});

function NarratingItem({ upload }: { upload: UploadState }) {
  return (
    <article className="narrating-book">
      <div className="book-cover narrating-cover">
        <NarratingCoverArt percent={upload.percent} />
      </div>
      <div className="narrating-copy">
        <p className="narrating-title">{upload.title}</p>
        <p role="status">{upload.stage}</p>
        <div
          className="narrating-progress"
          role="progressbar"
          aria-valuenow={upload.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${upload.narrated ? "Narrating" : "Importing"} ${upload.title}`}
        >
          <span style={{ width: `${upload.percent}%` }} />
        </div>
        {upload.narrated && <p>Ready to listen when narration finishes. Keep Hark open.</p>}
        <button type="button" className="secondary-button" onClick={abortImport}>
          Cancel import
        </button>
      </div>
    </article>
  );
}

function NarratingCoverArt({ percent }: { percent: number }) {
  return (
    <>
      <span className="book-cover-fallback" aria-hidden="true">
        <WaveSine size={26} weight="duotone" />
      </span>
      <span className="narrating-badge">{percent}%</span>
    </>
  );
}
