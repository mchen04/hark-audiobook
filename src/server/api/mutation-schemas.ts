import { z } from "zod";

import { PLAYBACK_ACTIONS } from "@/domain/playback-history";
import { SKIP_BOUNDS_MS } from "@/domain/preferences";

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .nullable();

const tagEdgeSchema = z.strictObject({
  tagId: z.uuid(),
  include: z.boolean(),
  name: z.string().trim().min(1).max(80).optional(),
});

export const bookPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    author: z.string().trim().min(1).max(240),
    narrator: optionalTrimmed(240),
    description: optionalTrimmed(5000),
    series: optionalTrimmed(240),
    seriesPosition: z.number().min(0).max(999_999).nullable(),
    archived: z.boolean(),
    tags: z.array(z.string().trim().min(1).max(80)).max(20),
    tagEdge: tagEdgeSchema,
    mutationId: z.uuid(),
  })
  .partial()
  .strict()
  .refine((value) => !(value.tags !== undefined && value.tagEdge !== undefined), {
    message: "Send either the whole tag list or a single edge, never both.",
  });

export const collectionCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
});

export const collectionPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    bookId: z.uuid(),
    include: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => value.name !== undefined || value.bookId !== undefined)
  .refine((value) => (value.bookId === undefined) === (value.include === undefined));

const skipMs = z.number().int().min(SKIP_BOUNDS_MS.min).max(SKIP_BOUNDS_MS.max);

export const preferencesPatchSchema = z
  .object({
    skipBackMs: skipMs,
    skipForwardMs: skipMs,
    smartRewind: z.boolean(),
    autoplayNextInCollection: z.boolean(),
  })
  .partial()
  .strict();

export const progressSchema = z.strictObject({
  deviceId: z.string().min(16).max(100),
  deviceSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  positionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  playbackRate: z.number().min(0.5).max(3),
  completed: z.boolean(),
  eventOccurredAt: z.coerce.date(),
  playbackRateOccurredAt: z.coerce.date().optional(),
  completedOccurredAt: z.coerce.date().optional(),
  stateOccurredAt: z.coerce.date().optional(),
});

export const playbackActionSchema = z.strictObject({
  id: z.uuid(),
  action: z.enum(PLAYBACK_ACTIONS),
  positionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  previousPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  playbackRate: z.number().min(0.5).max(3),
  description: z.string().trim().min(1).max(160).nullable(),
  occurredAt: z.coerce.date(),
});

export const listeningSessionSchema = z.strictObject({
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  startPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  endPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mutationId: z.uuid().optional(),
});

const listeningStretchSchema = z.strictObject({
  id: z.uuid(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  startPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  endPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const playbackHistoryEventSchema = z.union([playbackActionSchema, listeningStretchSchema]);

const MAX_CHAPTERS = 10_000;
const MAX_DURATION_MS = 1_000 * 60 * 60 * 1_000;
const MAX_BYTE_SIZE = 100 * 1024 * 1024 * 1024;

const chapterSchema = z.strictObject({
  position: z.number().int().min(0),
  title: z.string().min(1).max(500),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
});

export const bookRegistrationSchema = z.strictObject({
  bookId: z.uuid().optional(),
  fileName: z.string().min(1).max(8192),
  mimeType: z.string().trim().min(1).max(100).default("audio/mpeg"),
  byteSize: z.number().int().positive().max(MAX_BYTE_SIZE),
  durationMs: z.number().int().positive().max(MAX_DURATION_MS),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  fingerprintKind: z.literal("sha256-v1"),
  renditionKey: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._:-]{0,159}$/)
    .default("source-v1"),
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().min(1).max(240),
  narrator: z.string().trim().min(1).max(240).nullable(),
  chapterDiagnostic: z.string().trim().min(1).max(300).nullable(),
  chapters: z.array(chapterSchema).min(1).max(MAX_CHAPTERS),
});
