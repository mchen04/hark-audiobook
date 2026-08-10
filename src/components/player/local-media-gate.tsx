"use client";

import { ArrowClockwise, Trash, UploadSimple } from "@phosphor-icons/react";
import Link from "next/link";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import type { BookDetails } from "@/components/book/book-details-dialog";
import { useDeleteBook } from "@/components/book/use-delete-book";
import { FullPlayer } from "@/components/player/full-player";
import type { PlaybackHistorySnapshot } from "@/domain/playback-history";
import type { NextInCollection, PlayerBook } from "@/domain/player";
import { isAbortError } from "@/lib/abort";
import { formatBytes } from "@/lib/format-bytes";
import { type MediaFingerprintKind, fingerprintMedia } from "@/lib/media-fingerprint";
import { parseLocalMp3 } from "@/lib/local-import";
import { getOfflineBook } from "@/lib/offline/library";
import { storeLocalBookMedia } from "@/lib/offline/media-store";
import { DOCUMENT_FILE_ACCEPT, isDocumentSource, MP3_FILE_ACCEPT } from "@/lib/source-formats";

type GateState =
  | { phase: "checking" }
  | { phase: "ready"; mediaUrl: string; coverUrl: string | null; coverThumbUrl: string | null }
  | { phase: "missing" }
  | { phase: "unavailable" }
  | { phase: "attaching"; percent: number | null; stage: string };

/**
 * Audio bytes live only on the user's devices. Before the player mounts, this
 * gate resolves the book's media from this device's store; when the book was
 * imported elsewhere, it asks for the original MP3 and verifies it is the
 * same file before storing it here.
 */
export function LocalMediaGate({
  userId,
  playerBook,
  mediaFingerprint,
  mediaFingerprintKind,
  mediaRenditionKey,
  byteSize,
  sourceFilename,
  sourceMimeType,
  historySnapshot,
  autoplay,
  details,
  nextInCollection,
}: {
  userId: string;
  playerBook: PlayerBook;
  mediaFingerprint: string | null;
  mediaFingerprintKind: MediaFingerprintKind | null;
  mediaRenditionKey: string;
  byteSize: number | null;
  sourceFilename?: string | null;
  sourceMimeType?: string | null;
  historySnapshot?: PlaybackHistorySnapshot;
  autoplay: boolean;
  details: BookDetails | null;
  nextInCollection: NextInCollection | null;
}) {
  const [state, setState] = useState<GateState>({ phase: "checking" });
  const [error, setError] = useState<string | null>(null);
  const [checkAttempt, setCheckAttempt] = useState(0);
  // The book must stay deletable even when this device lacks the audio,
  // otherwise a book imported elsewhere could never be removed from here.
  const { deleteBook, deleting, deleteLabel } = useDeleteBook(
    userId,
    playerBook.id,
    setError,
    mediaFingerprint,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<AbortController | null>(null);
  const documentSource = isDocumentSource(sourceFilename || "", sourceMimeType);
  const readyMediaUrl = state.phase === "ready" ? state.mediaUrl : null;
  const readyCoverUrl = state.phase === "ready" ? state.coverUrl : null;
  const readyCoverThumbUrl = state.phase === "ready" ? state.coverThumbUrl : null;
  const resolvedPlayerBook = useMemo(
    () =>
      readyMediaUrl
        ? {
            ...playerBook,
            mediaUrl: readyMediaUrl,
            coverUrl: readyCoverUrl,
            coverThumbUrl: readyCoverThumbUrl,
          }
        : null,
    [playerBook, readyCoverThumbUrl, readyCoverUrl, readyMediaUrl],
  );

  useEffect(
    () => () => {
      attachmentRef.current?.abort();
      attachmentRef.current = null;
    },
    [userId, playerBook.id],
  );

  useEffect(() => {
    let active = true;
    void getOfflineBook(userId, playerBook.id)
      .then((record) => {
        if (!active) return;
        if (record) {
          setState({
            phase: "ready",
            mediaUrl: record.offlineMediaUrl,
            coverUrl: record.offlineCoverUrl,
            coverThumbUrl: record.offlineCoverThumbUrl || record.offlineCoverUrl,
          });
        } else {
          setState({ phase: "missing" });
        }
      })
      .catch(() => active && setState({ phase: "unavailable" }));
    return () => {
      active = false;
    };
  }, [userId, playerBook.id, checkAttempt]);

  async function attachFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    attachmentRef.current?.abort();
    const controller = new AbortController();
    attachmentRef.current = controller;
    const reportAttachment = (percent: number | null, stage: string) => {
      if (attachmentRef.current === controller && !controller.signal.aborted) {
        setState({ phase: "attaching", percent, stage });
      }
    };
    setError(null);
    reportAttachment(null, "Checking the source");
    try {
      if (byteSize && file.size !== byteSize) {
        throw new Error(
          `This file is not the one this book was imported from (expected ${formatBytes(byteSize)}).`,
        );
      }
      const fingerprint = mediaFingerprintKind
        ? await fingerprintMedia(
            file,
            mediaFingerprintKind,
            (fraction) => reportAttachment(Math.round(fraction * 100), "Checking the source"),
            controller.signal,
          )
        : undefined;
      if (mediaFingerprint && fingerprint !== mediaFingerprint) {
        throw new Error("This file's content does not match this book.");
      }
      const targetBook = withoutMediaUrls(playerBook);
      const record = documentSource
        ? await import("@/lib/document-import/import").then(({ importLocalDocument }) =>
            importLocalDocument(
              userId,
              file,
              (percent, stage) => reportAttachment(percent, stage),
              {
                target: {
                  book: targetBook,
                  renditionKey: mediaRenditionKey,
                  ...(fingerprint ? { fingerprint } : {}),
                },
                signal: controller.signal,
              },
            ),
          )
        : await storeLocalBookMedia(
            userId,
            targetBook,
            file,
            (await parseLocalMp3(file, controller.signal)).artwork,
            (fraction) => reportAttachment(Math.round(fraction * 100), "Saving to this device"),
            undefined,
            controller.signal,
          );
      if (controller.signal.aborted || attachmentRef.current !== controller) return;
      setState({
        phase: "ready",
        mediaUrl: record.offlineMediaUrl,
        coverUrl: record.offlineCoverUrl,
        coverThumbUrl: record.offlineCoverThumbUrl || record.offlineCoverUrl,
      });
    } catch (caught) {
      if (attachmentRef.current === controller && !isAbortError(caught)) {
        setError(caught instanceof Error ? caught.message : "The file could not be attached.");
        setState({ phase: "missing" });
      }
    } finally {
      if (attachmentRef.current === controller) attachmentRef.current = null;
    }
  }

  if (resolvedPlayerBook) {
    return (
      <FullPlayer
        playerBook={resolvedPlayerBook}
        historySnapshot={historySnapshot}
        autoplay={autoplay}
        details={details}
        mediaFingerprint={mediaFingerprint}
        nextInCollection={nextInCollection}
      />
    );
  }

  return (
    <main className="local-media-gate">
      <section aria-live="polite">
        <h1>{playerBook.title}</h1>
        <p className="gate-author">{playerBook.author}</p>
        {state.phase === "checking" && <p>Checking this device for the audio…</p>}
        {state.phase === "attaching" && (
          <p>
            {state.stage}…{state.percent !== null ? ` ${state.percent}%` : ""}
          </p>
        )}
        {state.phase === "unavailable" && (
          <>
            <p>
              Hark could not access this device&apos;s saved audio. This can be temporary; retry
              before attaching the source again.
            </p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setState({ phase: "checking" });
                setError(null);
                setCheckAttempt((attempt) => attempt + 1);
              }}
            >
              <ArrowClockwise size={18} aria-hidden="true" />
              Try again
            </button>
            <p>
              <Link href="/library">Back to library</Link>
            </p>
          </>
        )}
        {state.phase === "missing" && (
          <>
            <p>
              The audio for this book is stored on your devices, not in the cloud — and this device
              does not currently have it. Attach the original {documentSource ? "document" : "MP3"}
              {byteSize ? ` (${formatBytes(byteSize)})` : ""} to listen here. Your reading position
              and playback history are already synced.
            </p>
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              accept={documentSource ? DOCUMENT_FILE_ACCEPT : MP3_FILE_ACCEPT}
              onChange={attachFile}
              tabIndex={-1}
              aria-label={`Attach ${sourceFilename || (documentSource ? "the book's document" : "the book's MP3")}`}
            />
            <button
              type="button"
              className="primary-button"
              onClick={() => inputRef.current?.click()}
            >
              <UploadSimple size={17} aria-hidden="true" />
              Attach {documentSource ? "document" : "MP3"}
            </button>
            {error && <p className="form-error">{error}</p>}
            <p>
              <Link href="/library">Back to library</Link>
            </p>
            <div className="gate-danger">
              <button
                type="button"
                className="danger-button"
                onClick={() => void deleteBook()}
                disabled={deleting}
              >
                <Trash size={17} aria-hidden="true" />
                {deleteLabel}
              </button>
              <p className="details-hint">
                Removes the book, its progress, and playback history from your library everywhere.
              </p>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function withoutMediaUrls(book: PlayerBook): Omit<PlayerBook, "mediaUrl" | "coverUrl"> {
  const { mediaUrl, coverUrl, ...withoutMedia } = book;
  void mediaUrl;
  void coverUrl;
  return withoutMedia;
}
