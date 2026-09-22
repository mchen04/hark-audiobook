# Architecture

Hark is a private audiobook PWA. Accounts isolate personal libraries and sync
metadata; there is no shared catalog. Imports, document narration, and playback
run on the device. The server handles authentication and metadata only.

## Runtime boundaries

| Layer                      | Responsibilities                                                                       | Main code                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Next.js App Router / React | App shell, library, settings, and player UI                                            | [src/app](../src/app), [components](../src/components)                                                            |
| Browser import             | MP3 parsing, document extraction, Kestrel narration, fingerprints                      | [local-import.ts](../src/lib/local-import.ts), [document-import](../src/lib/document-import)                      |
| Browser persistence        | Media chunks, transcripts, metadata mirror, durable mutation queues                    | [offline](../src/lib/offline), [offline-sync](../src/lib/offline-sync)                                            |
| Service worker             | Cached shell and runtime assets, local audio Range responses                           | [public/sw.js](../public/sw.js)                                                                                   |
| Same-origin JSON API       | Session/ownership checks, strict request validation, metadata mutations                | [route-handler.ts](../src/server/api/route-handler.ts), [mutation schemas](../src/server/api/mutation-schemas.ts) |
| PostgreSQL / Drizzle       | Accounts, books, chapters, progress, history, tags, collections, preferences, receipts | [schema](../src/server/db/schema.ts), [migrations](../drizzle)                                                    |

Better Auth owns authentication, cookie sessions, and password hashing. Its
Postgres rate-limit adapter enforces limits across server processes. Native CSS
and Phosphor icons supply the UI. Exact dependency versions are in the lockfile.

The [storage and sync contract](local-first.md) defines ownership, receipt
ordering, conflict resolution, and migration rules. Library paint reads local
state; a new device must complete its first sync before it can claim to show the
account's library. Authentication and settings are not universally offline.

## Imports and rendition identity

1. **MP3:** `music-metadata` parses tags and chapters in the browser; shared
   domain validation normalizes chapter sequences. A worker streams whole-file
   SHA-256 for identity without buffering the complete book. Legacy sample
   fingerprints remain supported for existing books.
2. **Document:** lazy adapters extract PDF, EPUB, DOCX, TXT, Markdown, or HTML.
   A book-scoped Kestrel Fast worker uses ONNX Runtime WebGPU/WASM. The pinned
   model, voice, graphs, and runtime are verified against the
   [asset manifest](../src/lib/kestrel/asset-manifest.json). The first use fetches
   public model assets; it does not send the document to a speech service.
3. Generated PCM is progressively encoded into chunked MP3 storage. Progress and
   cancellation stay in the library. Only completed, committed audio is playable.
   Client navigation can preserve an import; closing the page or changing account
   stops the work. Cancel discards incomplete output; if media already committed,
   it remains available without inheriting autoplay intent.
4. `POST /api/books/local` registers metadata: title/author, duration, size,
   fingerprint, rendition identity, and chapters. It never receives source bytes,
   audio, cover blobs, or transcript payloads. Recoverable registration failures
   retain the completed local audio and queue the metadata write.
5. A duplicate can map a device-minted id to its canonical server id. Media,
   mirror aggregates, and queued mutations move together. Reattachment verifies
   source identity; document regeneration also requires the exact supported
   rendition key and chapter timeline before committing replacement audio.

Rendition identity includes the model bundle, extraction/splitting revisions,
voice, chunking, and encoding. Unknown or legacy Lemonade rendition keys are
refused for regeneration, while already-completed audio stays playable. Never
pair a new rendering with an old seek map. See
[rendition.ts](../src/lib/document-import/rendition.ts).

The document adapters enforce source limits (PDF 96 MiB, EPUB/DOCX 48 MiB,
TXT/Markdown 8 MiB, HTML 2 MiB), at most two million extracted characters and
10,000 chapters, plus archive expansion limits. See
[extraction](../src/lib/document-import/extract.ts) and
[archive handling](../src/lib/document-import/archive.ts). No OCR or DRM removal
is provided. Actual capacity and narration time depend on device storage and CPU.

## Media and playback

Audio lives in 4 MiB Cache Storage chunks with an account-owned IndexedDB record.
The service worker serves `/offline-media/<id>` with Range support. Cover
thumbnails avoid decoding full artwork for small cards. MP3 seek-header repair
changes only the stored playback copy; the original file's fingerprint remains
unchanged. Embedded MP3 read-along transcripts and generated narration cues are
validated and stored locally.

One `HTMLAudioElement` is owned by the playback provider. Focused hooks handle
progress persistence, playback history, sleep timer, Media Session, tab
arbitration, and transport. Playback time uses an external store so time updates
do not rerender the whole player; chapter selection uses binary search.

A book route resolves account and media identity before mounting a player.
Browsing or deleting a different book without local audio preserves the active
book's playback and controls. Switching account revokes the old player. Chapters,
speed, skips, smart rewind, read-along, history, and optional collection autoplay
use this same playback path.

## Local launch and updates

The service worker serves a cached, user-agnostic `/offline` shell for library
navigation; that shell renders the same library and rewrites the URL to
`/library`. It contains no account identity or book rows. Chromium's static route
optimization covers the manifest start URL when supported. Other navigations
have a three-second network budget before an applicable offline fallback.

The library joins the account's mirror snapshot with device media availability.
Search, sorting, facets, and the continue card reuse this snapshot. Warm-launch
revalidation waits for the real-content readiness marker, a quiet interval, and
idle scheduling. The first sync is an explicit loading/recovery state.

Build output includes the dependency closure for lazy import, workers, encoding,
and ONNX. Shell updates stage complete immutable cache generations before
promotion. Leases retain chunks needed by open windows. Account purge preserves
only safe shell/static assets and removes account media and private page caches.

The [launch gate](../tests/perf/BASELINE.md) measures this path with real content,
request counters, and a calibrated browser. It is not a physical-iPhone latency
claim. Resume under real iOS suspension requires the
[device check](resume-durability-device-check.md).

## Source map

- [src/domain](../src/domain): shared book, chapter, MP3, transcript, and library rules.
- [playback-core.ts](../src/lib/playback-core.ts) and [player components](../src/components/player): playback decisions and UI.
- [library components](../src/components/library): import state and local snapshot rendering.
- [mirror.ts](../src/lib/offline/mirror.ts) and [sync-protocol.ts](../src/lib/offline/sync-protocol.ts): atomic pulled batches and wire guards.
- [outbox.ts](../src/lib/offline/outbox.ts) and [offline-sync](../src/lib/offline-sync): durable intent and replay.
- [syncReceipt](../src/server/db/sync-receipt.ts) and [pull](../src/server/sync/pull.ts): server receipt order and consistent snapshots.
- [src/app/styles](../src/app/styles): authored CSS, theme tokens, and reduced-motion handling.

Required migration snapshots, pinned model assets, and the lockfile stay tracked.
Generated builds and process receipts do not; see [contributing](development.md#contributing).
