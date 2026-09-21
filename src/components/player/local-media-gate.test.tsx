// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlayerBook } from "@/domain/player";

const { readMedia, storeMedia } = vi.hoisted(() => ({
  readMedia: vi.fn(),
  storeMedia: vi.fn(),
}));
vi.mock("@/lib/offline/library", () => ({ getOfflineBook: readMedia }));
vi.mock("@/lib/offline/media-store", () => ({ storeLocalBookMedia: storeMedia }));
vi.mock("@/lib/local-import", () => ({ parseLocalMp3: async () => ({ artwork: null }) }));
vi.mock("@/components/book/use-delete-book", () => ({ useDeleteBook: () => ({}) }));
vi.mock("@/components/player/full-player", () => ({
  FullPlayer: ({ playerBook, autoplay }: { playerBook: PlayerBook; autoplay: boolean }) => (
    <audio aria-label="Resolved media" src={playerBook.mediaUrl} autoPlay={autoplay} />
  ),
}));
import { LocalMediaGate } from "./local-media-gate";

const book: PlayerBook = {
  id: "book",
  title: "Book",
  author: "Author",
  durationMs: 60000,
  mediaUrl: "",
  coverUrl: null,
  chapters: [],
  initialPositionMs: 0,
  initialProgressOccurredAt: null,
  initialPlaybackRate: 1,
  completed: false,
};
const media = { offlineMediaUrl: "/offline-media/committed", offlineCoverUrl: null };

const props = {
  userId: "user",
  playerBook: book,
  mediaFingerprint: null,
  mediaFingerprintKind: null,
  mediaRenditionKey: "source-v1",
  byteSize: null,
  autoplay: true,
  details: null,
  nextInCollection: null,
};

beforeEach(() => {
  readMedia.mockReset().mockResolvedValue(null);
  storeMedia.mockReset();
});
afterEach(cleanup);

it.each(["committed", "missing", "unavailable"])(
  "cancellation rereads durable storage when media is %s and ignores late completion",
  async (outcome) => {
    let finish!: (record: typeof media) => void;
    storeMedia.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { container, rerender } = render(<LocalMediaGate {...props} />);
    await screen.findByRole("button", { name: "Attach MP3" });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["fixture"], "book.mp3", { type: "audio/mpeg" })] },
    });
    await waitFor(() => expect(storeMedia).toHaveBeenCalledTimes(1));
    const signal = storeMedia.mock.calls[0]![6] as AbortSignal;
    // Model the boundary after storage committed but before its promise returns.
    if (outcome === "committed") readMedia.mockResolvedValue(media);
    if (outcome === "unavailable") readMedia.mockRejectedValue(new Error("Storage unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel attachment" }));
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(readMedia).toHaveBeenCalledTimes(2));
    await act(async () => {
      finish(media);
    });
    if (outcome === "committed") {
      expect(screen.getByLabelText("Resolved media").getAttribute("src")).toBe(
        media.offlineMediaUrl,
      );
      expect(screen.queryByRole("button", { name: "Attach MP3" })).toBeNull();
      expect((screen.getByLabelText("Resolved media") as HTMLAudioElement).autoplay).toBe(false);
      for (const next of [
        { playerBook: { ...book, id: "next-book" } },
        { userId: "next-account" },
      ]) {
        rerender(<LocalMediaGate {...props} {...next} />);
        await waitFor(() =>
          expect((screen.getByLabelText("Resolved media") as HTMLAudioElement).autoplay).toBe(true),
        );
      }
    } else if (outcome === "unavailable") {
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    } else {
      expect(screen.getByRole("button", { name: "Attach MP3" })).toBeTruthy();
    }
    expect(storeMedia).toHaveBeenCalledTimes(1);
  },
);

it.each(["already saved", "attached normally"])(
  "preserves collection autoplay when media is %s",
  async (availability) => {
    if (availability === "already saved") readMedia.mockResolvedValue(media);
    storeMedia.mockResolvedValue(media);
    const { container } = render(<LocalMediaGate {...props} />);
    if (availability === "attached normally") {
      await screen.findByRole("button", { name: "Attach MP3" });
      fireEvent.change(container.querySelector('input[type="file"]')!, {
        target: { files: [new File(["fixture"], "book.mp3", { type: "audio/mpeg" })] },
      });
    }
    expect(((await screen.findByLabelText("Resolved media")) as HTMLAudioElement).autoplay).toBe(
      true,
    );
  },
);
