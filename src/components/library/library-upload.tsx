"use client";

import { WarningCircle, X } from "@phosphor-icons/react";
import { ChangeEvent, useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import {
  abortImportForOtherAccount,
  emptyImportSnapshot,
  type ImportState,
  importSnapshot,
  runImport,
  subscribeToImport,
} from "@/lib/document-import/import-controller";
import { BOOK_FILE_ACCEPT } from "@/lib/source-formats";

export type UploadState = ImportState;

export function useBookImport(
  userId: string | null,
  onImported: () => Promise<void>,
  reportError: (message: string | null) => void,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useSyncExternalStore(subscribeToImport, importSnapshot, emptyImportSnapshot);

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
