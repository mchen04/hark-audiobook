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

const cacheDiagnostic = {
  name: "Cache API operation failed",
  message: "Context is stopped",
  stack: "",
  wallTime: 20,
};
const reloadRecording = {
  scriptErrors: [],
  actions: [{ kind: "reload-library", startWallTime: 10, endWallTime: 30 }],
};

it.each([
  ["reload-library", ""],
  ["reload-player", ""],
  ["reload-library", "Cache API operation failed: Context is stopped"],
  ["reload-player", "Cache API operation failed: Context is stopped"],
])("records the native Cache diagnostic during %s with stack %j as a note", (kind, stack) => {
  expect(
    isHandledReloadDiagnostic(
      { ...cacheDiagnostic, stack },
      { ...reloadRecording, actions: [{ kind, startWallTime: 10, endWallTime: 30 }] },
    ),
  ).toBe(true);
});

it.each([
  { rule: "name", error: { ...cacheDiagnostic, name: "TypeError" }, recording: reloadRecording },
  {
    rule: "message",
    error: { ...cacheDiagnostic, message: "Quota exceeded" },
    recording: reloadRecording,
  },
  {
    rule: "script stack",
    error: { ...cacheDiagnostic, stack: "at saveBook (import.js:1:1)" },
    recording: reloadRecording,
  },
  {
    rule: "console text with script frames",
    error: {
      ...cacheDiagnostic,
      stack: "Cache API operation failed: Context is stopped\n    at saveBook (import.js:1:1)",
    },
    recording: reloadRecording,
  },
  {
    rule: "unhandled rejection",
    error: cacheDiagnostic,
    recording: { ...reloadRecording, scriptErrors: [{ kind: "unhandledrejection" }] },
  },
  {
    rule: "script error",
    error: cacheDiagnostic,
    recording: { ...reloadRecording, scriptErrors: [{ kind: "error" }] },
  },
  { rule: "before reload", error: { ...cacheDiagnostic, wallTime: 9 }, recording: reloadRecording },
  { rule: "after reload", error: { ...cacheDiagnostic, wallTime: 31 }, recording: reloadRecording },
  {
    rule: "other navigation",
    error: cacheDiagnostic,
    recording: {
      ...reloadRecording,
      actions: [{ kind: "history-back", startWallTime: 10, endWallTime: 30 }],
    },
  },
  { rule: "no action", error: cacheDiagnostic, recording: { ...reloadRecording, actions: [] } },
])("keeps the Cache diagnostic as a failure when it violates $rule", ({ error, recording }) => {
  expect(isHandledReloadDiagnostic(error, recording)).toBe(false);
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
