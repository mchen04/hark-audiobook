"use client";

import { WarningCircle, X } from "@phosphor-icons/react";
import { ChangeEvent, useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import {
  abortImportForOtherAccount,
  emptyImportSnapshot,
  type ImportState,
  importSnapshot,
  runImport,
  startListeningToImport,
  subscribeToImport,
} from "@/lib/document-import/import-controller";
import { BOOK_FILE_ACCEPT } from "@/lib/source-formats";

export type UploadState = ImportState;

/**
 * The local book import flow: MP3s stay unchanged; documents are narrated on
 * the device before entering the same offline media store.
 *
 * The import itself lives outside React, in `import-controller`. This hook only
 * subscribes to it, so leaving the library — to open the book being narrated,
 * for instance — no longer destroys the import.
 */
export function useBookImport(
  userId: string | null,
  onImported: () => Promise<void>,
  reportError: (message: string | null) => void,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useSyncExternalStore(subscribeToImport, importSnapshot, emptyImportSnapshot);

  // An import belongs to the account that started it. A different account
  // signing in on this device abandons it rather than narrating into their
  // library.
  useEffect(() => {
    if (userId) abortImportForOtherAccount(userId);
  }, [userId]);

  const chooseFile = useCallback(() => {
    reportError(null);
    inputRef.current?.click();
  }, [reportError]);

  const handleFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || !userId) return;
      reportError(null);
      await runImport(userId, file, onImported, reportError);
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

  return { fileInput, upload, chooseFile, startListening: startListeningToImport };
}

/**
 * The error banner, rendered after the library body. Import progress is not
 * here: it belongs to the book the library shows for the narration in flight.
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
