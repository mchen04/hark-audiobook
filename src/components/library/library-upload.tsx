"use client";

import { WarningCircle, X } from "@phosphor-icons/react";
import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";

import { isAbortError } from "@/lib/abort";
import { importLocalMp3 } from "@/lib/local-import";
import type { NarrationPreviewHandle } from "@/lib/document-import/narration-preview-handle";
import { BOOK_FILE_ACCEPT, sourceFormatForFilename } from "@/lib/source-formats";

export type UploadState = {
  filename: string;
  percent: number;
  stage: string;
  /** Enough narration is buffered that playing it will not stutter at once. */
  canListen: boolean;
  listening: boolean;
};

/**
 * The local book import flow: MP3s stay unchanged; documents are narrated by
 * Kestrel on the device before entering the same offline media store.
 * Failures are reported through the caller's `reportError`, so the page's one
 * alert region stays owned by the page, not by this hook.
 */
export function useBookImport(
  userId: string | null,
  onImported: () => Promise<void>,
  reportError: (message: string | null) => void,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<AbortController | null>(null);
  const previewRef = useRef<NarrationPreviewHandle | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);

  const closePreview = useCallback(() => {
    previewRef.current?.close();
    previewRef.current = null;
  }, []);

  /** Starts the narrated-so-far audio. The gesture is what lets Safari play. */
  const startListening = useCallback(() => {
    previewRef.current?.start();
    setUpload((current) => (current ? { ...current, listening: true, canListen: false } : current));
  }, []);

  useEffect(
    () => () => {
      importRef.current?.abort();
      importRef.current = null;
      closePreview();
    },
    [userId, closePreview],
  );

  const chooseFile = useCallback(() => {
    reportError(null);
    inputRef.current?.click();
  }, [reportError]);

  const handleFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (!userId) return;

      importRef.current?.abort();
      const controller = new AbortController();
      importRef.current = controller;
      reportError(null);
      setUpload({
        filename: file.name,
        percent: 0,
        stage: "Starting",
        canListen: false,
        listening: false,
      });
      closePreview();
      try {
        const reportProgress = (percent: number, stage: string) => {
          if (importRef.current === controller && !controller.signal.aborted) {
            setUpload((current) => ({
              filename: file.name,
              percent,
              stage,
              listening: current?.listening ?? false,
              canListen: !current?.listening && !!previewRef.current?.isReady(),
            }));
          }
        };
        if (sourceFormatForFilename(file.name)?.id === "mp3") {
          await importLocalMp3(userId, file, reportProgress, controller.signal);
        } else {
          const [{ importLocalDocument }, { createBrowserNarrationPreview }] = await Promise.all([
            import("@/lib/document-import/import"),
            import("@/lib/document-import/narration-preview-handle"),
          ]);
          await importLocalDocument(userId, file, reportProgress, {
            signal: controller.signal,
            onNarrationAudio: (audio, sampleRate) => {
              previewRef.current ??= createBrowserNarrationPreview(sampleRate);
              previewRef.current.enqueue(audio);
            },
          });
        }
        if (controller.signal.aborted) return;
        await onImported();
      } catch (caught) {
        if (!isAbortError(caught)) {
          reportError(
            caught instanceof Error ? caught.message : "The audiobook could not be imported.",
          );
        }
      } finally {
        if (importRef.current === controller) {
          importRef.current = null;
          setUpload(null);
        }
        // The finished book plays through the real player, which owns chapters,
        // scrubbing and resume; the preview has no business outliving the import.
        closePreview();
      }
    },
    [userId, onImported, reportError, closePreview],
  );

  // Rendered by the caller wherever the hidden input belongs in its tree; the
  // ref and change handler never leave this module.
  const fileInput = (
    <input
      ref={inputRef}
      className="visually-hidden"
      type="file"
      accept={BOOK_FILE_ACCEPT}
      onChange={handleFile}
      tabIndex={-1}
      aria-label="Choose an audiobook or document to import"
    />
  );

  return { fileInput, upload, chooseFile, startListening };
}

/**
 * The error banner, rendered after the library body. Import progress is not
 * here: it belongs to the entry the library shows for the book being made, and
 * saying it twice on one screen was noise.
 */
export function UploadBanners({
  error,
  onDismissError,
}: {
  error: string | null;
  onDismissError: () => void;
}) {
  return (
    <>
      {error && (
        <div className="upload-error" role="alert">
          <WarningCircle size={21} weight="fill" aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={onDismissError} aria-label="Dismiss error">
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}
