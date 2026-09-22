import { isAbortError } from "@/lib/abort";
import { sourceFormatForFilename } from "@/lib/source-formats";

export type ImportState = {
  filename: string;
  title: string;
  percent: number;
  stage: string;
  /** Documents become playable only after their complete audio is committed. */
  narrated: boolean;
};

/**
 * The running import, owned outside React.
 *
 * Navigation within the app may continue while a book is imported. Explicit
 * cancellation and the account write fence stop all work and partial storage.
 *
 * One import at a time in this page. Starting another replaces it.
 */
let state: ImportState | null = null;
let controller: AbortController | null = null;
let ownerId: string | null = null;
const listeners = new Set<() => void>();

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

/** Abandons the running import without touching completed books. */
export function abortImport(): void {
  controller?.abort();
  controller = null;
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
  abortImport();

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
  });

  const report = (percent: number, stage: string) => {
    if (controller !== own || own.signal.aborted) return;
    // Download readers can report many chunks within the same percent. Do not
    // re-render the library when the visible progress has not changed.
    if (state?.percent === percent && state.stage === stage) return;
    publish({
      filename: file.name,
      title,
      percent,
      stage,
      narrated,
    });
  };

  try {
    if (!narrated) {
      const { importLocalMp3 } = await import("@/lib/local-import");
      await importLocalMp3(userId, file, report, own.signal);
    } else {
      const { importLocalDocument } = await import("./import");
      await importLocalDocument(userId, file, report, {
        signal: own.signal,
      });
    }
    if (controller !== own || own.signal.aborted) return;
    await onFinished();
  } catch (caught) {
    if (controller === own && !own.signal.aborted && !isAbortError(caught)) {
      onError(caught instanceof Error ? caught.message : "The audiobook could not be imported.");
    }
  } finally {
    if (controller === own) {
      controller = null;
      ownerId = null;
      publish(null);
    }
  }
}
