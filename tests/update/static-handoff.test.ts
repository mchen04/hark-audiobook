import { expect, it } from "vitest";

import { classifyStaticFailures } from "./static-handoff.mjs";

const step = "switch-and-open-lazy-routes";
const url = "http://hark.test/_next/static/next.js";
const previous = { buildId: "previous", assets: { "/_next/static/previous.js": "old-bytes" } };
const next = { buildId: "next", assets: { "/_next/static/next.js": "next-bytes" } };

function sequence() {
  const document = {
    id: 1,
    url: "http://hark.test/library",
    buildId: "previous",
    htmlSha256: "old-html",
  };
  const destination = {
    id: 4,
    url: "http://hark.test/books/book",
    buildId: "next",
    htmlSha256: "new-html",
  };
  const failure = {
    url,
    requestId: 2,
    requestedAt: 2,
    documentId: 1,
    step,
    failure: { errorText: "cancelled" },
    failedAt: 5,
    failedStep: step,
  };
  const navigation = { mainFrame: true, id: 4, requestedAt: 4, fromDocumentId: 1, step };
  const reload = {
    url,
    requestId: 6,
    requestedAt: 6,
    documentId: 4,
    step,
    status: 200,
    sha256: "next-bytes",
    finishedAt: 9,
  };
  const evidence = {
    documents: [document, destination],
    navigations: [navigation],
    failedStatic: [failure],
    staticResponses: [reload],
  };
  return { document, destination, failure, navigation, reload, evidence };
}

it("accepts only a proven old-document hand-off and keeps all its evidence", () => {
  const { evidence, document, navigation, destination, reload, failure } = sequence();
  expect(() => expect(evidence.failedStatic).toEqual([])).toThrow();
  expect(classifyStaticFailures(evidence, previous, next)).toEqual({
    rejected: [],
    accepted: [
      { failure, document, navigation, destination, reload, expectedSha256: "next-bytes" },
    ],
  });
  expect(evidence.failedStatic).toEqual([failure]);
});

it.each(["navigation observed after cancel", "reload starts before cancel is observed"])(
  "accepts the same hand-off when %s",
  (ordering) => {
    const { evidence, failure, navigation } = sequence();
    if (ordering === "navigation observed after cancel") failure.failedAt = 3;
    else navigation.requestedAt = 3;
    if (ordering !== "navigation observed after cancel") failure.failedAt = 7;
    expect(classifyStaticFailures(evidence, previous, next).accepted).toHaveLength(1);
  },
);

const rejected: [string, (input: ReturnType<typeof sequence>) => void][] = [
  [
    "a subframe navigation",
    ({ navigation }) => {
      navigation.mainFrame = false;
    },
  ],
  [
    "a response finishing before its request",
    ({ reload }) => {
      reload.requestedAt = 10;
    },
  ],
  [
    "another network error",
    ({ failure }) => {
      failure.failure.errorText = "Load failed";
    },
  ],
  [
    "different cancellation text",
    ({ failure }) => {
      failure.failure.errorText = "Cancelled";
    },
  ],
  [
    "a previous-only asset",
    ({ failure, reload }) => {
      failure.url = reload.url = "http://hark.test/_next/static/previous.js";
    },
  ],
  [
    "an unknown asset",
    ({ failure, reload }) => {
      failure.url = reload.url = "http://hark.test/_next/static/unknown.js";
    },
  ],
  [
    "another origin",
    ({ failure, reload }) => {
      failure.url = reload.url = url.replace("hark.test", "other.test");
    },
  ],
  [
    "a next-build requesting document",
    ({ document }) => {
      document.buildId = "next";
    },
  ],
  [
    "an unknown requesting build",
    ({ document }) => {
      document.buildId = "unknown";
    },
  ],
  [
    "an unproved requesting document",
    ({ document }) => {
      document.htmlSha256 = "";
    },
  ],
  [
    "no requesting document",
    ({ evidence }) => {
      evidence.documents.shift();
    },
  ],
  [
    "a request outside the switch step",
    ({ failure }) => {
      failure.step = "stage-next-and-launch";
    },
  ],
  [
    "a cancellation outside the switch step",
    ({ failure }) => {
      failure.failedStep = "stage-next-and-launch";
    },
  ],
  [
    "no main-frame navigation",
    ({ evidence }) => {
      evidence.navigations = [];
    },
  ],
  [
    "navigation from another document",
    ({ navigation }) => {
      navigation.fromDocumentId = 8;
    },
  ],
  [
    "navigation before the failed request",
    ({ navigation }) => {
      navigation.requestedAt = 1;
    },
  ],
  [
    "navigation outside the hand-off",
    ({ navigation }) => {
      navigation.step = "stage-next-and-launch";
    },
  ],
  [
    "an unproved destination build",
    ({ destination }) => {
      destination.buildId = "unknown";
    },
  ],
  [
    "an unproved destination document",
    ({ destination }) => {
      destination.htmlSha256 = "";
    },
  ],
  [
    "no successful reload",
    ({ evidence }) => {
      evidence.staticResponses = [];
    },
  ],
  [
    "a different reload URL",
    ({ reload }) => {
      reload.url += "?different";
    },
  ],
  [
    "the same aborted request",
    ({ reload, failure }) => {
      reload.requestId = failure.requestId;
    },
  ],
  [
    "a reload in another document",
    ({ reload }) => {
      reload.documentId = 8;
    },
  ],
  [
    "a reload outside the hand-off",
    ({ reload }) => {
      reload.step = "stage-next-and-launch";
    },
  ],
  [
    "a reload before navigation",
    ({ reload }) => {
      reload.requestedAt = 3;
    },
  ],
  [
    "a reload finished before cancellation",
    ({ reload }) => {
      reload.finishedAt = 3;
    },
  ],
  [
    "an unfinished reload",
    ({ reload }) => {
      reload.finishedAt = 0;
    },
  ],
  [
    "an HTTP error",
    ({ reload }) => {
      reload.status = 404;
    },
  ],
  [
    "a non-200 response",
    ({ reload }) => {
      reload.status = 304;
    },
  ],
  [
    "wrong bytes",
    ({ reload }) => {
      reload.sha256 = "wrong-bytes";
    },
  ],
  [
    "no body hash",
    ({ reload }) => {
      reload.sha256 = "";
    },
  ],
];

it.each(rejected)("rejects %s", (_, change) => {
  const input = sequence();
  change(input);
  expect(classifyStaticFailures(input.evidence, previous, next)).toEqual({
    accepted: [],
    rejected: [input.failure],
  });
});
