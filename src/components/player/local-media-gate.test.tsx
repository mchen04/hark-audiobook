// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlayerBook } from "@/domain/player";

const { readMedia, storeMedia, committedMedia } = vi.hoisted(() => ({
  readMedia: vi.fn(),
  storeMedia: vi.fn(),
  committedMedia: [] as { bookId: string; src: string; autoplay: boolean }[],
}));
vi.mock("@/lib/offline/library", () => ({ getOfflineBook: readMedia }));
vi.mock("@/lib/offline/media-store", () => ({ storeLocalBookMedia: storeMedia }));
vi.mock("@/lib/local-import", () => ({ parseLocalMp3: async () => ({ artwork: null }) }));
vi.mock("@/components/book/use-delete-book", () => ({ useDeleteBook: () => ({}) }));
vi.mock("@/components/player/full-player", () => ({
  FullPlayer: ({ playerBook, autoplay }: { playerBook: PlayerBook; autoplay: boolean }) => {
    useLayoutEffect(() => {
      committedMedia.push({ bookId: playerBook.id, src: playerBook.mediaUrl, autoplay });
    });
    return <audio aria-label="Resolved media" src={playerBook.mediaUrl} autoPlay={autoplay} />;
  },
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
  committedMedia.length = 0;
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
      readMedia.mockImplementation(async (userId: string, bookId: string) => ({
        ...media,
        offlineMediaUrl: `/offline-media/${userId}/${bookId}`,
      }));
      for (const next of [
        { playerBook: { ...book, id: "next-book" } },
        { userId: "next-account" },
        {}, // Returning to this book carries a fresh autoplay intent.
      ]) {
        rerender(<LocalMediaGate {...props} {...next} />);
        await waitFor(() => {
          const audio = screen.getByLabelText("Resolved media") as HTMLAudioElement;
          expect(audio.getAttribute("src")).toBe(
            `/offline-media/${next.userId ?? props.userId}/${next.playerBook?.id ?? book.id}`,
          );
          expect(audio.autoplay).toBe(true);
        });
      }
    } else if (outcome === "unavailable") {
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    } else {
      expect(screen.getByRole("button", { name: "Attach MP3" })).toBeTruthy();
    }
    expect(storeMedia).toHaveBeenCalledTimes(1);
  },
);

it.each(["book", "account", "rendition"])(
  "never commits the previous media while a new %s identity resolves",
  async (identity) => {
    readMedia.mockResolvedValueOnce(media);
    let resolveNext!: (value: typeof media) => void;
    readMedia.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveNext = resolve;
      }),
    );
    const { rerender } = render(<LocalMediaGate {...props} />);
    await screen.findByLabelText("Resolved media");
    committedMedia.length = 0;
    const next = {
      ...props,
      ...(identity === "book" ? { playerBook: { ...book, id: "next-book" } } : {}),
      ...(identity === "account" ? { userId: "next-account" } : {}),
      ...(identity === "rendition" ? { mediaRenditionKey: "another-rendition" } : {}),
    };
    rerender(<LocalMediaGate {...next} />);
    expect(screen.queryByLabelText("Resolved media")).toBeNull();
    expect(committedMedia).toEqual([]);
    await act(async () => {
      resolveNext({ ...media, offlineMediaUrl: "/offline-media/next" });
    });
    expect(committedMedia).toEqual([
      { bookId: next.playerBook.id, src: "/offline-media/next", autoplay: true },
    ]);
  },
);

it("a deliberate new attachment after cancel may honor autoplay again", async () => {
  let finishCancelled!: (value: typeof media) => void;
  storeMedia.mockReturnValueOnce(
    new Promise((resolve) => {
      finishCancelled = resolve;
    }),
  );
  storeMedia.mockResolvedValueOnce(media);
  const { container } = render(<LocalMediaGate {...props} />);
  const attach = () =>
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["fixture"], "book.mp3", { type: "audio/mpeg" })] },
    });
  await screen.findByRole("button", { name: "Attach MP3" });
  attach();
  await waitFor(() => expect(storeMedia).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Cancel attachment" }));
  await screen.findByRole("button", { name: "Attach MP3" });
  attach();
  const audio = (await screen.findByLabelText("Resolved media")) as HTMLAudioElement;
  expect(audio.autoplay).toBe(true);
  await act(async () => {
    finishCancelled(media);
  });
  expect(audio.getAttribute("src")).toBe(media.offlineMediaUrl);
  expect(audio.autoplay).toBe(true);
});

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
