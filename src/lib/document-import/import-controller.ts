import { isAbortError } from "@/lib/abort";
import { importLocalMp3 } from "@/lib/local-import";
import { sourceFormatForFilename } from "@/lib/source-formats";

import type { NarrationPreviewHandle } from "./narration-preview-handle";

export type ImportState = {
  filename: string;
  title: string;
  percent: number;
  stage: string;
  /** False for an MP3: it is copied, not narrated, so there is no partial audio. */
  narrated: boolean;
  canListen: boolean;
  listening: boolean;
};

/**
 * The running import, owned outside React.
 *
 * It used to live in the library screen, which meant React unmounting that
 * screen aborted the import — so opening the book you were narrating destroyed
 * the narration. Keeping it here is what lets you walk into the book while it
 * is still being made, which is the entire point of narrating in the
 * background.
 *
 * One import at a time, per device. Starting another replaces it.
 */
let state: ImportState | null = null;
let controller: AbortController | null = null;
let preview: NarrationPreviewHandle | null = null;
let ownerId: string | null = null;
const listeners = new Set<() => void>();

function closePreview() {
  preview?.close();
  preview = null;
}

function publish(next: ImportState | null) {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeToImport(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function importSnapshot(): ImportState | null {
  return state;
}

/** Server render has no import in flight, and must not read the live one. */
export function emptyImportSnapshot(): ImportState | null {
  return null;
}

export function startListeningToImport(): void {
  preview?.start();
  if (state) publish({ ...state, listening: true, canListen: false });
}

/** Abandons the running import. Used when the account leaves, not on navigation. */
export function abortImport(): void {
  controller?.abort();
  controller = null;
  closePreview();
  ownerId = null;
  publish(null);
}

export function abortImportForOtherAccount(userId: string): void {
  if (ownerId && ownerId !== userId) abortImport();
}

export async function runImport(
  userId: string,
  file: File,
  onFinished: () => Promise<void>,
  onError: (message: string) => void,
): Promise<void> {
  controller?.abort();
  closePreview();

  const own = new AbortController();
  controller = own;
  ownerId = userId;
  const narrated = sourceFormatForFilename(file.name)?.id !== "mp3";
  const title = file.name.replace(/\.[^.]+$/, "");
  publish({
    filename: file.name,
    title,
    percent: 0,
    stage: "Starting",
    narrated,
    canListen: false,
    listening: false,
  });

  const report = (percent: number, stage: string) => {
    if (controller !== own || own.signal.aborted) return;
    publish({
      filename: file.name,
      title,
      percent,
      stage,
      narrated,
      listening: state?.listening ?? false,
      canListen: !state?.listening && !!preview?.isReady(),
    });
  };

  try {
    if (!narrated) {
      await importLocalMp3(userId, file, report, own.signal);
    } else {
      const [{ importLocalDocument }, { createBrowserNarrationPreview }] = await Promise.all([
        import("./import"),
        import("./narration-preview-handle"),
      ]);
      await importLocalDocument(userId, file, report, {
        signal: own.signal,
        onNarrationAudio: (audio, sampleRate) => {
          preview ??= createBrowserNarrationPreview(sampleRate);
          preview.enqueue(audio);
        },
      });
    }
    if (own.signal.aborted) return;
    await onFinished();
  } catch (caught) {
    if (!isAbortError(caught)) {
      onError(caught instanceof Error ? caught.message : "The audiobook could not be imported.");
    }
  } finally {
    if (controller === own) {
      controller = null;
      ownerId = null;
      publish(null);
    }
    // The finished book plays through the real player, which owns chapters,
    // scrubbing and resume; the preview has no business outliving the import.
    closePreview();
  }
}
