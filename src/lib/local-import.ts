import { interpretMp3Metadata, InvalidMp3Error, type ParsedMp3 } from "@/domain/mp3";
import type { LocalBookRegistration } from "@/domain/local-book";
import type { PlayerBook, PlayerChapter } from "@/domain/player";
import type { BookTranscript } from "@/domain/transcript";
import {
  createAccountWriteScope,
  type AccountWriteSlot,
  withAccountWriteLock,
} from "@/lib/account-deletion-fence";
import { throwIfAborted } from "@/lib/abort";
import { fingerprintMedia } from "@/lib/media-fingerprint";
import {
  hasPendingDeleteForMediaRegistration,
  shouldRetainMutation,
  withMediaRegistrationLock,
} from "@/lib/offline-sync";
import { storeLocalBookMedia, withLocalMediaSlot } from "@/lib/offline/media-store";
import { projectLocalBookRegistration } from "@/lib/offline/local-import-mirror";
import { commitImport } from "@/lib/offline/outbox";
import { storeBookTranscript } from "@/lib/offline/transcript-store";
import { getDeviceId } from "@/lib/playback-core";
import { extractTranscript } from "@/lib/transcript-import";

export type ParsedLocalMp3 = ParsedMp3 & {
  transcript: BookTranscript | null;
  transcriptDiagnostic: string | null;
};

export type { LocalBookRegistration } from "@/domain/local-book";

export type RegisteredLocalBook = {
  bookId: string;
  canonicalBook: Omit<PlayerBook, "mediaUrl" | "coverUrl"> | null;
};

export const LOCAL_REGISTRATION_TIMEOUT_MS = 15_000;

export async function parseLocalMp3(file: File, signal?: AbortSignal): Promise<ParsedLocalMp3> {
  throwIfAborted(signal);
  const { parseBlob } = await import("music-metadata");
  let metadata;
  try {
    metadata = await parseBlob(file, { duration: false, skipCovers: false });
  } catch {
    throw new InvalidMp3Error();
  }
  throwIfAborted(signal);
  const fallbackTitle = file.name.replace(/\.[^.]*$/, "");
  const parsedDuration = metadata.format.duration;
  const fallbackDurationMs =
    parsedDuration && Number.isFinite(parsedDuration) && parsedDuration > 0
      ? undefined
      : await probeAudioDurationMs(file, signal);
  const parsed = interpretMp3Metadata(metadata, fallbackTitle, fallbackDurationMs);
  let transcript: BookTranscript | null = null;
  let transcriptDiagnostic: string | null = null;
  try {
    transcript = await extractTranscript(metadata, parsed.durationMs);
  } catch (error) {
    transcriptDiagnostic = error instanceof Error ? error.message : "Transcript rejected.";
    console.warn(`Read-along transcript dropped for "${file.name}": ${transcriptDiagnostic}`);
  }
  return { ...parsed, transcript, transcriptDiagnostic };
}

function probeAudioDurationMs(file: File, signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const cleanup = () => {
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const fail = () => {
      cleanup();
      reject(new InvalidMp3Error());
    };
    const timer = setTimeout(fail, 30_000);
    const abort = () => {
      cleanup();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    audio.addEventListener("loadedmetadata", () => {
      const seconds = audio.duration;
      cleanup();
      if (Number.isFinite(seconds) && seconds > 0) resolve(Math.round(seconds * 1000));
      else reject(new InvalidMp3Error());
    });
    audio.addEventListener("error", fail);
    audio.preload = "metadata";
    audio.src = url;
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function importLocalMp3(
  userId: string,
  file: File,
  onProgress: (percent: number, stage: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const scope = createAccountWriteScope(userId, signal);
  try {
    await withAccountWriteLock(userId, (accountSlot) =>
      importLocalMp3WithinFence(userId, file, onProgress, scope.signal, accountSlot),
    );
  } finally {
    scope.release();
  }
}

async function importLocalMp3WithinFence(
  userId: string,
  file: File,
  onProgress: (percent: number, stage: string) => void,
  signal: AbortSignal,
  accountSlot: AccountWriteSlot,
): Promise<void> {
  throwIfAborted(signal);
  onProgress(5, "Reading metadata");
  const parsed = await parseLocalMp3(file, signal);
  throwIfAborted(signal);
  onProgress(45, "Checking the complete file");
  const fingerprintKind = "sha256-v1" as const;
  const fingerprint = await fingerprintMedia(
    file,
    fingerprintKind,
    (fraction) => onProgress(45 + Math.round(fraction * 10), "Checking the complete file"),
    signal,
  );
  onProgress(55, "Adding to your library");

  const registration = {
    bookId: crypto.randomUUID(),
    fileName: encodeURIComponent(file.name),
    mimeType: "audio/mpeg",
    byteSize: file.size,
    durationMs: parsed.durationMs,
    fingerprint,
    fingerprintKind,
    renditionKey: "source-v1",
    title: parsed.title,
    author: parsed.author,
    narrator: parsed.narrator,
    chapterDiagnostic: parsed.chapterDiagnostic,
    chapters: parsed.chapters,
  };
  await withLocalMediaSlot(userId, registration.bookId, async (slot) => {
    throwIfAborted(signal);
    const { bookId, canonicalBook } = await registerLocalBook(userId, registration, signal);
    onProgress(70, "Saving to this device");

    const chapters: PlayerChapter[] = parsed.chapters.map((chapter) => ({
      id: `${bookId}:${chapter.position}`,
      ...chapter,
    }));
    try {
      throwIfAborted(signal);
      await storeLocalBookMedia(
        userId,
        canonicalBook || {
          id: bookId,
          title: parsed.title,
          author: parsed.author,
          durationMs: parsed.durationMs,
          chapters,
          initialPositionMs: 0,
          initialProgressOccurredAt: null,
          initialPlaybackRate: 1,
          initialPlaybackRateOccurredAt: null,
          completed: false,
          initialCompletedOccurredAt: null,
        },
        file,
        parsed.artwork ? { data: parsed.artwork.data, mimeType: parsed.artwork.mimeType } : null,
        (fraction) =>
          onProgress(Math.min(99, 70 + Math.round(fraction * 29)), "Saving to this device"),
        slot,
        signal,
        accountSlot,
      );
      throwIfAborted(signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The audiobook could not be saved.";
      throw new Error(`${reason} Choose the same MP3 again to finish saving it on this device.`);
    }
    if (parsed.transcript) {
      try {
        await storeBookTranscript(userId, bookId, parsed.transcript);
      } catch {
        console.warn("Read-along cues could not be saved; the book plays without them.");
      }
    }
  });
  onProgress(100, "Finishing");
}

export async function registerLocalBook(
  userId: string,
  registration: LocalBookRegistration,
  signal?: AbortSignal,
): Promise<RegisteredLocalBook> {
  throwIfAborted(signal);
  await commitImport({ userId, deviceId: getDeviceId() }, registration.fingerprint, registration);
  throwIfAborted(signal);

  const identity = {
    fingerprint: registration.fingerprint,
    renditionKey: registration.renditionKey,
  };
  const keepQueuedRegistration = async (): Promise<RegisteredLocalBook> => {
    await projectLocalBookRegistration(userId, registration);
    return { bookId: registration.bookId, canonicalBook: null };
  };
  if (await hasPendingDeleteForMediaRegistration(userId, identity)) {
    throwIfAborted(signal);
    return keepQueuedRegistration();
  }

  return withMediaRegistrationLock(userId, identity, async () => {
    throwIfAborted(signal);
    if (await hasPendingDeleteForMediaRegistration(userId, identity)) {
      throwIfAborted(signal);
      return keepQueuedRegistration();
    }

    const response = await postLocalRegistration(registration, signal);
    throwIfAborted(signal);
    if (!response || shouldRetainMutation(response.status)) {
      return keepQueuedRegistration();
    }
    if (response.ok) {
      const { bookId } = (await response.json()) as { bookId: string };
      if (!bookId) throw new Error("The audiobook registration returned no book id.");
      await projectLocalBookRegistration(userId, { ...registration, bookId });
      return { bookId, canonicalBook: null };
    }

    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      existingBookId?: string;
      playerBook?: Omit<PlayerBook, "mediaUrl" | "coverUrl">;
    } | null;
    if (response.status === 409 && payload?.existingBookId) {
      const canonicalBook =
        payload.playerBook?.id === payload.existingBookId ? payload.playerBook : null;
      await projectLocalBookRegistration(
        userId,
        { ...registration, bookId: payload.existingBookId },
        canonicalBook,
      );
      return {
        bookId: payload.existingBookId,
        canonicalBook,
      };
    }
    throw new Error(payload?.error || "The audiobook could not be imported.");
  });
}

async function postLocalRegistration(
  registration: LocalBookRegistration,
  signal?: AbortSignal,
): Promise<Response | null> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), LOCAL_REGISTRATION_TIMEOUT_MS);
  try {
    return await fetch("/api/books/local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
      signal: controller.signal,
    });
  } catch {
    throwIfAborted(signal);
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
