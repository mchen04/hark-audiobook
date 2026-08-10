import { describe, expect, it, vi } from "vitest";

import { readFileText } from "./file-read";

describe("streaming document reads", () => {
  it("cancels an in-flight file read instead of waiting for the source", async () => {
    const controller = new AbortController();
    let finishRead: ((value: { done: true; value: undefined }) => void) | undefined;
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode("a") })
        .mockImplementationOnce(
          () =>
            new Promise<{ done: true; value: undefined }>((resolve) => {
              finishRead = resolve;
            }),
        ),
      cancel: vi.fn(async () => finishRead?.({ done: true, value: undefined })),
      releaseLock: vi.fn(),
    };
    const file = {
      name: "stream.txt",
      size: 1,
      stream: () => ({ getReader: () => reader }),
    } as unknown as File;

    const pending = readFileText(file, 100, controller.signal);
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
});
