import { expect, it } from "vitest";

import { analyzeFrames, isHandledReloadDiagnostic } from "../../scripts/bench/sampler.mjs";

const heading = { identity: "library", x: 16, y: 80, width: 100, height: 24 };
const frame = (documentId: string, wallTime: number, state: string) => ({
  documentId,
  time: wallTime,
  wallTime,
  state,
  url: state === "login" ? "/login" : "/library",
  firstPaint: state !== "blank",
  landmarks: { mainHeading: state === "books" ? heading : null },
});

it("only classifies a handled WebKit sync diagnostic during the actual reload as a note", () => {
  const error = {
    name: "Fetch API cannot load http",
    message: "/hark.test/api/sync/pull?snapshots=final due to access control checks.",
    stack:
      "Fetch API cannot load http://hark.test/api/sync/pull?snapshots=final due to access control checks.",
    wallTime: 20,
  };
  const recording = {
    scriptErrors: [],
    actions: [{ kind: "reload-library", startWallTime: 10, endWallTime: 30 }],
  };
  expect(isHandledReloadDiagnostic(error, recording)).toBe(true);
  expect(isHandledReloadDiagnostic({ ...error, wallTime: 40 }, recording)).toBe(false);
  expect(
    isHandledReloadDiagnostic(error, {
      ...recording,
      scriptErrors: [{ kind: "unhandledrejection" }],
    }),
  ).toBe(false);
  expect(isHandledReloadDiagnostic({ ...error, name: "TypeError" }, recording)).toBe(false);
  const blob = {
    ...error,
    name: "Cannot load blob",
    stack:
      "Cannot load blob:http://127.0.0.1:3300/synthetic-id due to access control checks.\n    at peekBuffer",
  };
  expect(isHandledReloadDiagnostic(blob, recording)).toBe(true);
  expect(isHandledReloadDiagnostic(blob, { ...recording, scriptErrors: [{ kind: "error" }] })).toBe(
    false,
  );
});

it("a user reload measures first appearances within each document", () => {
  expect(
    analyzeFrames({
      frames: [
        frame("old", 10, "books"),
        frame("new", 20, "header-only"),
        frame("new", 30, "books"),
      ],
      actions: [{ startWallTime: 15, endWallTime: 35, kind: "reload-library" }],
    }),
  ).toEqual([]);
});

it.each([401, 403])("records one confirmed %s expiry navigation as expected", (status) => {
  const recording = {
    frames: [frame("library", 10, "books"), frame("login", 30, "login")],
    actions: [],
    responses: [
      { documentId: "library", wallTime: 20, status, url: "http://hark.test/api/sync/pull" },
    ],
    expectedTransitions: [],
  };
  expect(analyzeFrames(recording)).toEqual([]);
  expect(recording.expectedTransitions).toHaveLength(1);
});

it.each([
  { documentId: "other", status: 401, url: "http://hark.test/api/sync/pull", wallTime: 20 },
  { documentId: "library", status: 200, url: "http://hark.test/api/sync/pull", wallTime: 20 },
  { documentId: "library", status: 401, url: "http://hark.test/api/books", wallTime: 20 },
  { documentId: "library", status: 401, url: "http://hark.test/api/sync/pull", wallTime: 40 },
])("a redirect needs its own preceding unauthorized sync response: %j", (response) => {
  expect(
    analyzeFrames({
      frames: [frame("library", 10, "books"), frame("login", 30, "login")],
      actions: [],
      responses: [response],
    }).map((event) => event.kind),
  ).toContain("state-regression");
});

it("a confirmed expiry never excuses a blink inside the library document", () => {
  const events = analyzeFrames({
    frames: [
      frame("library", 10, "books"),
      frame("library", 30, "header-only"),
      frame("library", 40, "books"),
    ],
    actions: [],
    responses: [
      { documentId: "library", wallTime: 20, status: 401, url: "http://hark.test/api/sync/pull" },
    ],
  });
  expect(events.map((event) => event.kind)).toContain("state-regression");
  expect(events.map((event) => event.kind)).toContain("blink");
});
