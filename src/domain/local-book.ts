import type { PlayerChapter } from "./player";

/** Metadata synced for media whose source bytes remain on the user's device. */
export type LocalBookRegistration = {
  bookId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  durationMs: number;
  fingerprint: string;
  fingerprintKind: "sha256-v1";
  renditionKey: string;
  title: string;
  author: string;
  narrator: string | null;
  chapterDiagnostic: string | null;
  chapters: Array<Pick<PlayerChapter, "position" | "title" | "startMs" | "endMs">>;
};
