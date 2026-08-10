"use client";

import { WarningCircle, X } from "@phosphor-icons/react";
import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";

import { isAbortError } from "@/lib/abort";
import { importLocalMp3 } from "@/lib/local-import";
import { BOOK_FILE_ACCEPT, sourceFormatForFilename } from "@/lib/source-formats";

export type UploadState = {
  filename: string;
  percent: number;
  stage: string;
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
  const [upload, setUpload] = useState<UploadState | null>(null);

  useEffect(
    () => () => {
      importRef.current?.abort();
      importRef.current = null;
    },
    [userId],
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
      setUpload({ filename: file.name, percent: 0, stage: "Starting" });
      try {
        const reportProgress = (percent: number, stage: string) => {
          if (importRef.current === controller && !controller.signal.aborted) {
            setUpload({ filename: file.name, percent, stage });
          }
        };
        if (sourceFormatForFilename(file.name)?.id === "mp3") {
          await importLocalMp3(userId, file, reportProgress, controller.signal);
        } else {
          const { importLocalDocument } = await import("@/lib/document-import/import");
          await importLocalDocument(userId, file, reportProgress, { signal: controller.signal });
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
      }
    },
    [userId, onImported, reportError],
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

  return { fileInput, upload, chooseFile };
}

/** The progress banner and the error banner, rendered after the library body. */
export function UploadBanners({
  upload,
  error,
  onDismissError,
}: {
  upload: UploadState | null;
  error: string | null;
  onDismissError: () => void;
}) {
  return (
    <>
      {upload && (
        <div className="upload-status" role="status" aria-live="polite">
          <div>
            <span>
              {upload.stage} · {upload.filename}
            </span>
            <strong>{upload.percent}%</strong>
          </div>
          <progress value={upload.percent} max={100} aria-label={`Importing ${upload.filename}`} />
        </div>
      )}

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
