import { afterEach, expect, it, vi } from "vitest";

const imports = vi.hoisted(() => ({ mp3: vi.fn(), document: vi.fn() }));
vi.mock("@/lib/local-import", () => ({ importLocalMp3: imports.mp3 }));
vi.mock("./import", () => ({ importLocalDocument: imports.document }));

import {
  abortImport,
  abortImportForOtherAccount,
  importSnapshot,
  runImport,
  subscribeToImport,
} from "./import-controller";

afterEach(() => {
  abortImport();
  vi.resetAllMocks();
});

it("publishes progress without offering incomplete audio and ignores duplicate updates", async () => {
  const changed = vi.fn();
  const unsubscribe = subscribeToImport(changed);
  const finished = vi.fn(async () => {});
  const error = vi.fn();
  imports.document.mockImplementation(async (_user, _file, report, options) => {
    expect(Object.keys(options)).toEqual(["signal"]);
    report(25, "Narrating");
    const count = changed.mock.calls.length;
    report(25, "Narrating");
    expect(changed).toHaveBeenCalledTimes(count);
    expect(importSnapshot()).toEqual({
      filename: "book.txt",
      title: "book",
      percent: 25,
      stage: "Narrating",
      narrated: true,
    });
  });
  try {
    await runImport("a", new File(["Hello"], "book.txt"), finished, error);
    expect(finished).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(importSnapshot()).toBeNull();
  } finally {
    unsubscribe();
  }
});

it("a canceled job cannot report errors or clear a replacement job", async () => {
  let rejectOld!: (error: Error) => void;
  let finishNew!: () => void;
  const started = deferred();
  imports.document
    .mockImplementationOnce(async () => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        rejectOld = reject;
      });
    })
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishNew = resolve;
        }),
    );
  const error = vi.fn();
  const completed = vi.fn(async () => {});
  const old = runImport("a", new File(["Old"], "old.txt"), completed, error);
  await started.promise;
  const replacement = runImport("a", new File(["New"], "new.txt"), completed, error);
  await vi.waitFor(() => expect(finishNew).toBeTypeOf("function"));
  rejectOld(new Error("worker stopped"));
  await old;
  expect(importSnapshot()?.title).toBe("new");
  expect(error).not.toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
  finishNew();
  await replacement;
  expect(completed).toHaveBeenCalledOnce();
});

it("account changes abort the owner and suppress late completion", async () => {
  const started = deferred();
  let finish!: () => void;
  let signal!: AbortSignal;
  imports.mp3.mockImplementation(async (_user, _file, _report, ownSignal) => {
    signal = ownSignal;
    started.resolve();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const completed = vi.fn(async () => {});
  const pending = runImport("a", new File(["Audio"], "book.mp3"), completed, vi.fn());
  await started.promise;
  abortImportForOtherAccount("a");
  expect(signal.aborted).toBe(false);
  abortImportForOtherAccount("b");
  expect(signal.aborted).toBe(true);
  expect(importSnapshot()).toBeNull();
  finish();
  await pending;
  expect(completed).not.toHaveBeenCalled();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
