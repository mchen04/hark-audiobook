import { registerMp3Encoder } from "@mediabunny/mp3-encoder";
import {
  AppendOnlyStreamTarget,
  AudioSample,
  AudioSampleSource,
  canEncodeAudio,
  Mp3OutputFormat,
  Output,
  Quality,
} from "mediabunny";

import type { PlayerBook, PlayerChapter } from "@/domain/player";
import { KESTREL_DOWNLOAD_BYTES } from "@/lib/kestrel/assets";
import { KestrelClient } from "@/lib/kestrel/client";
import { KESTREL_SAMPLE_RATE } from "@/lib/kestrel/dsp";
import { registerLocalBook, type LocalBookRegistration } from "@/lib/local-import";
import { fingerprintMedia } from "@/lib/media-fingerprint";
import { createStreamedLocalBookMedia, withLocalMediaSlot } from "@/lib/offline/media-store";
import type { OfflineBook } from "@/lib/offline/db";

import { chunkNarrationText } from "./chunks";
import { documentMimeType, extractDocument } from "./extract";

const MP3_BITRATE = 64_000;
const CHAPTER_SILENCE_SAMPLES = Math.round(0.4 * KESTREL_SAMPLE_RATE);
const MP3_QUALITY = new Quality({ bitrate: MP3_BITRATE, bitrateMode: "constant" });
let mp3EncoderReady: Promise<void> | null = null;

export type DocumentImportProgress = (percent: number, stage: string) => void;

export type DocumentImportTarget = {
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl">;
  fingerprint?: string;
};

/** Turns a document into a normal, chaptered, offline Hark audiobook. */
export async function importLocalDocument(
  userId: string,
  file: File,
  onProgress: DocumentImportProgress,
  target?: DocumentImportTarget,
): Promise<OfflineBook> {
  onProgress(2, "Reading the document on this device");
  const document = await extractDocument(file);
  onProgress(8, "Checking the complete document");
  const fingerprint =
    target?.fingerprint ||
    (await fingerprintMedia(file, "sha256-v1", (fraction) =>
      onProgress(8 + Math.round(fraction * 4), "Checking the complete document"),
    ));
  const bookId = target?.book.id || crypto.randomUUID();
  const narrationUnits = document.chapters.map((chapter) => ({
    chapter,
    chunks: chunkNarrationText(chapter.text),
  }));
  const totalCharacters = narrationUnits.reduce(
    (total, unit) => total + unit.chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    0,
  );
  const estimatedAudioBytes = estimateMp3Bytes(totalCharacters);

  return withLocalMediaSlot(userId, bookId, async (slot) => {
    const streamedMedia = await createStreamedLocalBookMedia(
      userId,
      bookId,
      estimatedAudioBytes,
      slot,
    );
    const kestrel = new KestrelClient();
    let output: Output<Mp3OutputFormat, AppendOnlyStreamTarget> | null = null;
    try {
      await ensureMp3Encoder();
      onProgress(12, `Loading Kestrel on this device (${formatModelSize()})`);
      await kestrel.initialize((progress) => {
        if (progress.stage !== "model") return;
        onProgress(
          12 + Math.round(progress.fraction * 13),
          progress.fraction < 1 ? "Downloading Kestrel once to this device" : "Loading Kestrel",
        );
      });

      const targetStream = new AppendOnlyStreamTarget(streamedMedia.writable);
      output = new Output({
        format: new Mp3OutputFormat({ xingHeader: false }),
        target: targetStream,
      });
      const audioSource = new AudioSampleSource({
        codec: "mp3",
        quality: MP3_QUALITY,
      });
      output.addAudioTrack(audioSource, { languageCode: "eng" });
      output.setMetadataTags({
        title: document.title,
        artist: document.author,
        albumArtist: document.author,
        album: document.title,
        genre: "Audiobook",
        comment: "Narrated privately on-device by Hark with Kestrel Fast.",
      });
      await output.start();

      let completedCharacters = 0;
      let totalSamples = 0;
      const chapters: PlayerChapter[] = [];
      let synthesisIndex = 0;
      for (let chapterIndex = 0; chapterIndex < narrationUnits.length; chapterIndex += 1) {
        const unit = narrationUnits[chapterIndex]!;
        const chapterStart = totalSamples;
        for (const text of unit.chunks) {
          const baseCharacters = completedCharacters;
          const synthesis = await kestrel.synthesize(
            text,
            seedFor(fingerprint, synthesisIndex++),
            (progress) => {
              if (progress.stage !== "speech") return;
              const narrated = baseCharacters + text.length * progress.fraction;
              onProgress(
                25 + Math.round((narrated / totalCharacters) * 66),
                `Narrating chapter ${chapterIndex + 1} of ${narrationUnits.length} on this device`,
              );
            },
          );
          if (synthesis.sampleRate !== KESTREL_SAMPLE_RATE || !synthesis.audio.length) {
            throw new Error("Kestrel returned invalid audio.");
          }
          await addAudio(audioSource, synthesis.audio, totalSamples);
          totalSamples += synthesis.audio.length;
          completedCharacters += text.length;
        }
        if (chapterIndex < narrationUnits.length - 1) {
          await addAudio(audioSource, new Float32Array(CHAPTER_SILENCE_SAMPLES), totalSamples);
          totalSamples += CHAPTER_SILENCE_SAMPLES;
        }
        const endMs = samplesToMilliseconds(totalSamples);
        chapters.push({
          id: `${bookId}:${chapterIndex}`,
          position: chapterIndex,
          title: unit.chapter.title,
          startMs: samplesToMilliseconds(chapterStart),
          endMs,
        });
      }

      onProgress(93, "Encoding the final audio");
      audioSource.close();
      await output.finalize();
      const durationMs = samplesToMilliseconds(totalSamples);
      // Rounding adjacent sample positions independently is monotonic, and the
      // final boundary is made identical to the registered book duration.
      chapters[chapters.length - 1]!.endMs = durationMs;
      const registration: LocalBookRegistration = {
        bookId,
        fileName: encodeURIComponent(file.name),
        mimeType: documentMimeType(file),
        byteSize: file.size,
        durationMs,
        fingerprint,
        fingerprintKind: "sha256-v1",
        title: document.title,
        author: document.author,
        narrator: "Kestrel Fast · af_heart",
        chapterDiagnostic: null,
        chapters: chapters.map((chapter) => ({
          position: chapter.position,
          title: chapter.title,
          startMs: chapter.startMs,
          endMs: chapter.endMs,
        })),
      };

      onProgress(96, "Adding to your library");
      const registered = await registerLocalBook(userId, registration);
      const canonicalId = registered.bookId;
      const generatedBook: Omit<PlayerBook, "mediaUrl" | "coverUrl"> = {
        id: canonicalId,
        title: document.title,
        author: document.author,
        durationMs,
        chapters: chapters.map((chapter) => ({
          ...chapter,
          id: `${canonicalId}:${chapter.position}`,
        })),
        initialPositionMs: 0,
        initialProgressOccurredAt: null,
        initialPlaybackRate: 1,
        initialPlaybackRateOccurredAt: null,
        completed: false,
        initialCompletedOccurredAt: null,
      };
      const book = registered.canonicalBook || target?.book || generatedBook;
      onProgress(99, "Saving to this device");
      const record = await streamedMedia.commit(book, slot);
      onProgress(100, "Finishing");
      return record;
    } catch (error) {
      if (output?.state === "started" || output?.state === "finalizing") {
        await output.cancel().catch(() => undefined);
      }
      await streamedMedia.abort(error);
      throw error;
    } finally {
      kestrel.close();
    }
  });
}

async function ensureMp3Encoder(): Promise<void> {
  mp3EncoderReady ??= (async () => {
    // Some Chromium builds report native MP3 encoding support but never emit
    // a packet. Prefer Mediabunny's deterministic LAME worker on every device.
    registerMp3Encoder();
    if (
      !(await canEncodeAudio("mp3", {
        numberOfChannels: 1,
        sampleRate: KESTREL_SAMPLE_RATE,
        quality: MP3_QUALITY,
      }))
    ) {
      throw new Error("This browser cannot encode Kestrel audio as an MP3.");
    }
  })().catch((error) => {
    mp3EncoderReady = null;
    throw error;
  });
  return mp3EncoderReady;
}

async function addAudio(
  source: AudioSampleSource,
  audio: Float32Array,
  startSample: number,
): Promise<void> {
  const sample = new AudioSample({
    data: audio,
    format: "f32",
    numberOfChannels: 1,
    sampleRate: KESTREL_SAMPLE_RATE,
    timestamp: startSample / KESTREL_SAMPLE_RATE,
  });
  try {
    await source.add(sample);
  } finally {
    sample.close();
  }
}

function estimateMp3Bytes(characterCount: number): number {
  // Rough English narration is 12–16 characters/second. The 1.25 margin
  // covers unusually slow prose, tags, and MP3 encoder padding.
  const seconds = characterCount / 12;
  return Math.ceil((seconds * MP3_BITRATE * 1.25) / 8 + 1024 * 1024);
}

function samplesToMilliseconds(samples: number): number {
  return Math.max(1, Math.round((samples / KESTREL_SAMPLE_RATE) * 1_000));
}

function seedFor(fingerprint: string, index: number): number {
  return (Number.parseInt(fingerprint.slice(0, 8), 16) ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
}

function formatModelSize(): string {
  return `${Math.round(KESTREL_DOWNLOAD_BYTES / (1024 * 1024))} MB once`;
}
