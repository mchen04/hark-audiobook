import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
type Timer = { run: () => void; ms: number; cancelled: boolean };
type ServeNavigation = (request: Request, pathname: string) => Promise<Response>;

const SHELL_HTML = "<!doctype html><title>Library shell</title>";
const LAUNCH_KEY = "/library?source=pwa";

let cache: {
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  addAll: ReturnType<typeof vi.fn>;
};
let entries: Map<string, string>;
let timers: Timer[];
let fetchMock: ReturnType<typeof vi.fn>;
let serveNavigation: ServeNavigation;
let rendersFromLocalData: (pathname: string) => boolean;

beforeEach(() => {
  entries = new Map();
  timers = [];
  cache = {
    match: vi.fn(async (key: string) => {
      const body = entries.get(key);
      return body === undefined ? undefined : new Response(body);
    }),
    put: vi.fn(async () => undefined),
    add: vi.fn(async () => undefined),
    addAll: vi.fn(async () => undefined),
  };
  fetchMock = vi.fn(async () => new Response("live document from the server"));

  const setTimeoutStub = (run: () => void, ms: number) => {
    timers.push({ run, ms, cancelled: false });
    return timers.length;
  };
  const clearTimeoutStub = (handle: number) => {
    const timer = timers[handle - 1];
    if (timer) timer.cancelled = true;
  };

  const build = new Function(
    "self",
    "caches",
    "fetch",
    "setTimeout",
    "clearTimeout",
    `${source}\nreturn { serveNavigation, rendersFromLocalData };`,
  ) as (
    self: unknown,
    caches: unknown,
    fetch: unknown,
    setTimeout: unknown,
    clearTimeout: unknown,
  ) => { serveNavigation: ServeNavigation; rendersFromLocalData: (pathname: string) => boolean };

  const built = build(
    { addEventListener: vi.fn() },
    { open: vi.fn(async () => cache) },
    fetchMock,
    setTimeoutStub,
    clearTimeoutStub,
  );
  serveNavigation = built.serveNavigation;
  rendersFromLocalData = built.rendersFromLocalData;
});

async function settleMicrotasks() {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function spendTheBudget() {
  for (const timer of timers) if (!timer.cancelled) timer.run();
}

function navigate(pathname: string) {
  return new Request(`https://hark.test${pathname}`);
}

describe("service-worker navigation", () => {
  it("serves a warm library launch from Cache Storage without touching the network", async () => {
    entries.set(LAUNCH_KEY, SHELL_HTML);

    const response = await serveNavigation(navigate("/library"), "/library");

    expect(await response.text()).toBe(SHELL_HTML);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the shell for the launch URL the manifest actually uses", async () => {
    entries.set(LAUNCH_KEY, SHELL_HTML);

    const response = await serveNavigation(
      new Request("https://hark.test/library?source=pwa"),
      "/library",
    );

    expect(await response.text()).toBe(SHELL_HTML);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps serving the committed launch key during a two-document promotion", async () => {
    entries.set("/offline", "uncommitted candidate");
    entries.set(LAUNCH_KEY, SHELL_HTML);

    const response = await serveNavigation(navigate("/library"), "/library");

    expect(await response.text()).toBe(SHELL_HTML);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls through to the network on a first install, when there is no shell yet", async () => {
    const response = await serveNavigation(navigate("/library"), "/library");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("live document from the server");
  });

  it("bounds a first install: a connection that never answers still shows something", async () => {
    entries.set(LAUNCH_KEY, SHELL_HTML);
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));

    const pending = serveNavigation(navigate("/books/abc"), "/books/abc");
    await settleMicrotasks();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBeLessThanOrEqual(3_000);

    spendTheBudget();
    expect(await (await pending).text()).toBe(SHELL_HTML);
  });

  it("prefers the live document for a book page, which the shell cannot fully render", async () => {
    entries.set(LAUNCH_KEY, SHELL_HTML);

    const response = await serveNavigation(navigate("/books/abc"), "/books/abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("live document from the server");
  });

  it("falls back to the shell when a book page cannot be fetched", async () => {
    entries.set(LAUNCH_KEY, SHELL_HTML);
    fetchMock.mockRejectedValue(new Error("offline"));

    const response = await serveNavigation(navigate("/books/abc"), "/books/abc");

    expect(await response.text()).toBe(SHELL_HTML);
  });

  it("never answers an auth page with the library shell", async () => {
    entries.set(LAUNCH_KEY, SHELL_HTML);
    fetchMock.mockRejectedValue(new Error("offline"));

    const response = await serveNavigation(navigate("/login"), "/login");
    const body = await response.text();

    expect(body).not.toBe(SHELL_HTML);
    expect(body).toContain("can&rsquo;t reach the network");
    expect(rendersFromLocalData("/login")).toBe(false);
  });

  it("never writes a navigation response into the shell cache", async () => {
    await serveNavigation(navigate("/library"), "/library");
    await serveNavigation(navigate("/books/abc"), "/books/abc");
    await serveNavigation(navigate("/settings"), "/settings");

    expect(cache.put).not.toHaveBeenCalled();
    expect(cache.add).not.toHaveBeenCalled();
    expect(cache.addAll).not.toHaveBeenCalled();
  });
});
