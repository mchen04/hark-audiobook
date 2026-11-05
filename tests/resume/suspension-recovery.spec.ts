import { expect, test } from "@playwright/test";

import {
  AHEAD_BAR_MS,
  CALLBACK_BAR_MS,
  closeResumeFixture,
  measureSuspensionRecovery,
  recordRow,
  resetResumeDevice,
  resumeFixture,
  type RecoveryRow,
} from "./harness/resume-oracle";

const BOOK_COUNT = 3;

const GAP_MS = 120_000;

const LONG_BOOK_REPEAT = 25;

test.beforeAll(async () => {
  test.setTimeout(900_000);
  await resumeFixture(BOOK_COUNT, {
    0: LONG_BOOK_REPEAT,
    1: LONG_BOOK_REPEAT,
    2: LONG_BOOK_REPEAT,
  });
});

test.afterAll(async () => {
  await closeResumeFixture();
});

test.beforeEach(async () => {
  await resetResumeDevice();
});

function assertMeasured(row: RecoveryRow): void {
  expect(row.ticks, `${row.scenario}: no timeupdate ticks — nothing was measured`).toBeGreaterThan(
    2,
  );
  expect(
    row.playedMs,
    `${row.scenario}: the position advanced by ${row.playedMs}ms, which is not a listening ` +
      "session. A row from a player that never played is not a pass.",
  ).toBeGreaterThan(4_000);
  expect(
    row.lifecycle.map((entry) => entry.split("@")[0]),
    `${row.scenario}: the platform delivered no lifecycle callback at all, so the hide-edge write ` +
      "this row is about could never have happened",
  ).not.toStrictEqual([]);
}

function assertSuspensionSignature(row: RecoveryRow): void {
  expect(
    row.writersBlocked,
    `${row.scenario}: the harness dropped no "setTimeout:200" registration, so the 200ms cadence ` +
      `timer was never deleted (dropped: ${JSON.stringify(row.writersBlocked)}) and this row is ` +
      "measuring an ordinary build",
  ).toContain("setTimeout:200");
  expect(
    row.writersBlocked,
    `${row.scenario}: the harness dropped no "timeupdate" registration, so the media-tick writer ` +
      "was never deleted and this row is measuring an ordinary build",
  ).toContain("timeupdate");
  expect(
    row.recordAfterKill.source,
    `${row.scenario}: with both cadence writers deleted, the last durable write should be the ` +
      `hide-edge flush — it was "${row.recordAfterKill.source}". Either a writer survived the ` +
      "poison, or the flush never ran, and either way there is no suspension signature here.",
  ).toBe("visibility-flush");
  expect(
    row.recordAfterKill.playingAtWrite,
    `${row.scenario}: the hide-edge record does not say audio was live, so nothing can tell this ` +
      "apart from a book backgrounded while paused",
  ).toBe(true);
  expect(
    row.recordAfterKill.writtenAt,
    `${row.scenario}: the hide-edge record carries no write timestamp, so the size of the ` +
      "unrecorded stretch is unknowable",
  ).toBeGreaterThan(0);
}

test("R1: the app resumes where it saved, never forward, and offers the estimate", async () => {
  test.setTimeout(300_000);
  const row = await measureSuspensionRecovery({
    scenario: "R1 suspended session, recovery offered",
    bookIndex: 0,
    killCadenceWriters: true,
    gapMs: GAP_MS,
  });
  recordRow(row);
  assertMeasured(row);
  assertSuspensionSignature(row);

  const recordedMs = row.recordAfterKill.positionMs!;

  expect(
    recordedMs + GAP_MS,
    `${row.scenario}: a ${GAP_MS}ms projection from ${recordedMs}ms runs off the end of a ` +
      `${row.durationMs}ms book, so the offer below would be clamped to the end and this row ` +
      "would grade the clamp rather than the projection. The fixture book is too short.",
  ).toBeLessThan(row.durationMs - 5_000);

  expect(
    row.resumedAheadOfRecordMs,
    `${row.scenario}: the app came back ${row.resumedAheadOfRecordMs}ms AHEAD of the position it ` +
      `saved (record ${recordedMs}ms, resumed ${row.resumedPositionMs}ms). The projected point ` +
      `was ${row.offer.projectedMs}ms; applying it without the user pressing anything skips ` +
      "content they never heard, and would be simply wrong if iOS had stopped the audio early.",
  ).toBeLessThanOrEqual(AHEAD_BAR_MS);
  expect(
    Math.abs(row.resumedAheadOfRecordMs! + row.expectedRewindMs),
    `${row.scenario}: the app resumed ${row.resumedPositionMs}ms against a saved ${recordedMs}ms ` +
      `(rewind due: ${row.expectedRewindMs}ms). The recorded position is the source of truth and ` +
      "the player has to come back at it.",
  ).toBeLessThanOrEqual(CALLBACK_BAR_MS);

  expect(
    row.offer.shown,
    `${row.scenario}: the app came back ${recordedMs}ms with ${GAP_MS}ms of listening it could ` +
      "not record, and said nothing about it. That is the case this whole path exists for.",
  ).toBe(true);
  expect(row.offer.role, `${row.scenario}: the offer is not announced politely`).toBe("status");
  expect(
    row.offer.modal,
    `${row.scenario}: the offer is a modal, so it blocks the player behind it`,
  ).toBe(false);
  expect(
    row.offer.transportUsable,
    `${row.scenario}: the transport is not usable with the offer on screen, so the offer is ` +
      "blocking playback",
  ).toBe(true);
  expect(
    row.offer.dismissLabel,
    `${row.scenario}: the offer has no dismiss control, so the user cannot say no to it`,
  ).not.toBeNull();
  expect(
    row.offer.jumpLabel,
    `${row.scenario}: the jump control does not say the estimate is an estimate ` +
      `("${row.offer.jumpLabel}")`,
  ).toMatch(/about/i);

  expect(
    row.offer.recordedMs,
    `${row.scenario}: the offer is built on ${row.offer.recordedMs}ms, which is not the position ` +
      `the app actually saved (${recordedMs}ms)`,
  ).toBe(recordedMs);
  expect(
    row.offer.playbackRate,
    `${row.scenario}: the offer used rate ${row.offer.playbackRate} against a record written at ` +
      `${row.recordAfterKill.playbackRate}`,
  ).toBe(row.recordAfterKill.playbackRate);

  const harnessDelayMs = row.offerReadAtMs - row.agedAtMs!;
  expect(
    row.offer.elapsedMs,
    `${row.scenario}: the offer reports ${row.offer.elapsedMs}ms unaccounted for against a gap ` +
      `the harness set to exactly ${GAP_MS}ms. It cannot be smaller.`,
  ).toBeGreaterThanOrEqual(GAP_MS);
  expect(
    row.offer.elapsedMs! - GAP_MS,
    `${row.scenario}: the offer reports ${row.offer.elapsedMs}ms unaccounted for, which is ` +
      `${row.offer.elapsedMs! - GAP_MS}ms more than the ${GAP_MS}ms gap — larger than the ` +
      `${harnessDelayMs}ms the harness itself spent between setting the clock and reading the ` +
      "offer, so the app is inventing time",
  ).toBeLessThanOrEqual(harnessDelayMs);

  expect(
    row.projectionErrorMs,
    `${row.scenario}: the offer projects ${row.offer.projectedMs}ms, but ${row.offer.recordedMs}ms ` +
      `+ ${row.offer.elapsedMs}ms x ${row.offer.playbackRate} clamped to a ${row.durationMs}ms ` +
      `book is ${row.recomputedProjectionMs}ms`,
  ).toBeLessThanOrEqual(1);
  expect(
    row.offer.projectedMs,
    `${row.scenario}: the projection ran past the end of a ${row.durationMs}ms book`,
  ).toBeLessThanOrEqual(row.durationMs);
  expect(
    row.offer.projectedMs,
    `${row.scenario}: the projection is not ahead of the saved position, so there is nothing to ` +
      "offer",
  ).toBeGreaterThan(recordedMs);
});

test("R2: an ordinary background offers nothing, because nothing was lost", async () => {
  test.setTimeout(300_000);
  const row = await measureSuspensionRecovery({
    scenario: "R2 ordinary background, no recovery offered",
    bookIndex: 1,
  });
  recordRow(row);
  assertMeasured(row);

  expect(
    row.writersBlocked,
    `${row.scenario}: a writer was deleted on a row that is supposed to be measuring the ` +
      `ordinary build (${JSON.stringify(row.writersBlocked)})`,
  ).toStrictEqual([]);

  expect(
    row.offer.shown,
    `${row.scenario}: the app offered to move the user forward after an ORDINARY backgrounding, ` +
      `where the writers recorded the position all along (last write: ` +
      `"${row.recordAfterKill.source}", offering a jump to ${row.offer.projectedMs}ms from ` +
      `${row.offer.recordedMs}ms). This prompt would appear every time the user glanced at ` +
      "another app.",
  ).toBe(false);

  expect(
    ["cadence-timer", "media-tick"],
    `${row.scenario}: after an ordinary backgrounding the last durable write was ` +
      `"${row.recordAfterKill.source}" rather than a cadence writer, so the 200ms cadence stopped ` +
      "on a page that was still playing",
  ).toContain(row.recordAfterKill.source);

  expect(
    row.resumedAheadOfRecordMs,
    `${row.scenario}: the app resumed ${row.resumedAheadOfRecordMs}ms AHEAD of the position it ` +
      "saved",
  ).toBeLessThanOrEqual(AHEAD_BAR_MS);
});

test("R3: a dismissed estimate stays dismissed for that gap", async () => {
  test.setTimeout(300_000);
  const row = await measureSuspensionRecovery({
    scenario: "R3 suspended session, offer dismissed",
    bookIndex: 2,
    killCadenceWriters: true,
    gapMs: GAP_MS,
    dismissAndReopen: true,
  });
  recordRow(row);
  assertMeasured(row);
  assertSuspensionSignature(row);

  const recordedMs = row.recordAfterKill.positionMs!;

  expect(
    row.offer.shown,
    `${row.scenario}: no offer appeared, so there was nothing to dismiss`,
  ).toBe(true);

  expect(
    row.recordAtReopen!.source,
    `${row.scenario}: the durable record was rewritten between the dismissal and the second open ` +
      `("${row.recordAfterKill.source}" -> "${row.recordAtReopen!.source}"), so the signature was ` +
      "gone and an absent offer proves nothing about the dismissal",
  ).toBe("visibility-flush");
  expect(
    row.recordAtReopen!.writtenAt,
    `${row.scenario}: the hide-edge write's clock changed between the two opens, so the second ` +
      "open was looking at a different gap from the one that was dismissed",
  ).toBe(row.agedWrittenAt);

  expect(
    row.offerAfterDismissal!.shown,
    `${row.scenario}: the dismissed estimate came back on the next open of the same book, about ` +
      `the same ${GAP_MS}ms gap. The user has to say no to it every single time they reach for ` +
      "this book.",
  ).toBe(false);

  expect(
    Math.abs(row.positionAfterDismissal! - recordedMs),
    `${row.scenario}: dismissing the estimate moved the position from ${recordedMs}ms to ` +
      `${row.positionAfterDismissal}ms. Declining an offer must not move the user.`,
  ).toBeLessThanOrEqual(CALLBACK_BAR_MS);
  expect(
    row.positionAfterDismissal! - recordedMs,
    `${row.scenario}: dismissing the estimate moved the user FORWARD to ` +
      `${row.positionAfterDismissal}ms`,
  ).toBeLessThanOrEqual(AHEAD_BAR_MS);
});
