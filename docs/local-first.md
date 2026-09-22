# Storage and sync contract

Hark reads its library from the device and syncs metadata with the account's
server. Audio is available only where it has been imported or regenerated.
Section numbers are kept stable for references from source and tests.

## 1. Device-first reads

The library joins an account-scoped metadata mirror with local downloads. A
refresh reads a snapshot once; search, facets, sorting, and the continue card
reuse it. Import completion refreshes local availability before a background pull.
A new device without any snapshot shows first-sync loading or recovery, not an
unverified empty library.

## 2. What is stored where

| Data                                                                                       | Device                                                   | Server                              |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------- |
| Audio and cover bytes                                                                      | Cache Storage                                            | Never uploaded                      |
| Source document                                                                            | Read locally for import/regeneration; keep your original | Never uploaded                      |
| Read-along transcripts                                                                     | IndexedDB                                                | Never uploaded                      |
| Books, media identity, chapters, progress, tags, collections, preferences, recent sessions | Account-scoped mirror/caches                             | Account-owned metadata              |
| Pending mutations and local playback registers                                             | IndexedDB/localStorage                                   | Received through authenticated APIs |
| Auth sessions, rate limits, idempotency receipts                                           | No authoritative mirror                                  | Server-authoritative                |

Metadata includes titles, authors, chapter labels, fingerprints, and listening
positions. “Files stay local” does not mean metadata stays off the server.

## 3. Aggregate and receipt ordering

Books are the cursored aggregate: chapter/tag-edge changes bump the parent book's
`updatedAt`, and pull replaces the aggregate together. Collections, membership,
tag vocabulary, and preferences are pulled in full. Collection mutations still
advance their parent timestamp; full-pull convergence alone cannot prove that bump.

Books, playback states, and book tombstones share one timestamp cursor. Every
writer to these streams first calls
[`syncReceipt()`](../src/server/db/sync-receipt.ts) in a **read-committed
transaction**, before other write locks or state-dependent decisions:

1. Acquire the account advisory lock and hold it through commit.
2. In a separate statement after admission, read the maximum receipt across all
   three streams. Allocate at least the database clock and strictly above the
   retained maximum, including any future-dated rows.
3. Keep database timestamp precision in text/SQL; JavaScript `Date` truncates
   microseconds. Deletion allocates before removing rows and transfers the floor
   to its tombstone.

This orders receipts with commits and prevents a future row or blocked writer
from making a sibling change invisible behind an issued cursor. Pull uses a
read-only repeatable-read snapshot without a writer lock. Installed clients keep
the timestamp protocol; all server writers must follow the rule. Direct SQL
writes or mixed old/new server binaries do not provide that guarantee.

Account-lock admission has a transaction-local **100 ms lock timeout**, restored
before subsequent work. Timeout rolls back and returns **503, Retry-After: 1**;
no progress/ownership/no-op read moves outside serialization. This bounds lock
admission only, **not** pool checkout, arbitrary queries, the admitted transaction,
or total request time. Production uses the shared ten-connection pool; unrelated
accounts have different account locks but still share that pool.

Uncursored row updates use `monotonicTimestamp()` under their row lock. Client
position/rate/completion event clocks remain separate from server receipt time.
Receipt timestamps can be ahead of wall time after retained clock skew; they are
ordering tokens, not listening times.

## 4. Local schema

- `chapterline-offline-v1`, version 7: downloads, transcripts, deletion journal,
  cache metadata, and the library mirror. Mirror keys include account identity;
  multirow stores have user indexes for scoped reads and purge. Version 7 adds
  stores without replacing existing downloads.
- `chapterline-sync-v1`, version 5: durable mutations and per-book device sequence
  counters. Migration scopes sequence keys by account without lowering counters;
  the legacy bare-key fallback remains for rows without safe attribution.
- `hark-playback-history-v1`: device playback-history ledger.
- localStorage: active-account marker, per-writer playback registers, device id,
  preference cache/pending revision, and lifecycle fences.

State and outbox deliberately use different IndexedDB databases. There is no
transaction spanning both; write ordering is part of the durability contract.
Schema upgrades must preserve pending writes and existing media identities.

## 5. Durable writes and replay

1. Commit the outbox intent before its optimistic mirror patch. A crash may leave
   an unapplied projection with recoverable intent; it must not leave a visible
   edit with no durable intent. Imports explicitly project the accepted local or
   canonical identity after journaling registration.
2. A mutation id remains stable across retries of that intent. Replay uses the
   same strict REST schemas and server idempotency receipts as live requests.
3. Progress coalesces by book/device and merges field clocks. Metadata/archive
   changes replace the pending value; tag/collection changes coalesce per edge.
   Import, delete, and history are distinct events and never coalesce.
4. Retryable failures retain the row. Auth failures retain intent for a restored
   session; duplicate imports merge identity. A 404 while registration is still
   queued cannot discard dependent edits. See
   [replay policy](../src/lib/offline-sync/replay.ts) for status-specific handling.
5. Replay runs while the app is open, including launch and reconnect. No closed-app
   Background Sync delivery is promised.

A permanent delete atomically removes an older unsent registration of the same
source **and rendition** while journaling deletion. A later re-import is a new
intent and stays queued behind that deletion. A device tombstone prevents stale
tabs from recreating media for the deleted id.

On a canonical duplicate, rekey the media, complete mirror aggregate, and queued
mutations before settling registration. Progress must use the target identity's
sequence counter. Fingerprint alone is not enough to identify a rendition.

Preferences are the exception to the outbox shape: their pending revision lives
in a localStorage envelope and participates in sign-out drain/reporting. Playback
also persists local registers and queued progress before network reconciliation.

The sign-out drain has an **eight-second budget**. For a hinted busy response it
joins any ambient replay, then starts a fresh pass after a one-second wait. The
wait is outside entity mutation locks, allowing terminal progress to journal;
the next pass reads current intent. Per-account single-flight prevents parallel
replay. Deadline, account change, or any intervening fence stops further sends,
and late replies cannot cross the purge boundary. Undelivered writes are reported;
privacy purge still completes. Ordinary ambient replay retains 5xx writes but
does not schedule a timer from `Retry-After`, so a paused app may wait for its next
mount or reconnect.

## 6. Pull

`GET /api/sync/pull?since=<iso>` returns changed book aggregates and tombstones,
plus whole-account tag/collection/preference snapshots and recent sessions.
The mirror applies a batch and its cursor in one IndexedDB transaction. An
interrupted apply re-fetches the batch instead of advancing ahead of data.
Deletion is an explicit tombstone; absence is not proof of deletion.

## 7. Conflict resolution

Playback state uses per-device sequence high-water marks and independent clocks
for position, rate, and completion. A late rate-only change must not rewind a newer
position. Bootstrap and replay select the freshest value for each field; a merged
pending payload gets a fresh mutation id/sequence so an older acknowledgement
cannot settle a newer write. Explicit rewinds remain valid events.

Older clients' combined `stateOccurredAt` remains a compatibility fallback;
new clients send independent clocks. Per-writer localStorage registers protect
cross-tab field merges; the joined legacy tuple remains for older bundles and
diagnostics. Strict-schema rejection by a predecessor server retains the new
progress event rather than silently stripping its field clocks.

Book metadata and membership requests are applied by server mutation handlers;
they are not a CRDT with durable per-edge timestamp tombstones. Edge adds are
idempotent and explicit removals delete the edge. Listening sessions/history use
their existing append/deduplication rules. See
[progress policy](../src/server/playback/progress-policy.ts) and
[tag policy](../src/server/tags/tag-policy.ts).

## 8. Launch and session recovery

The cached shell contains no user identity or books. The client checks the active
account before showing its local snapshot. The readiness marker represents real
book content or a verified empty library. Warm-launch revalidation runs after
paint; a device with no completed first pull syncs immediately.

No active account redirects to login. A server 401/403 also redirects, **without
purging downloads**: session expiry is not an instruction to destroy local audio.
Authenticated sign-in handles cross-account cleanup before exposing another
account. Shell generations and offline dependencies are described in
[architecture](architecture.md#local-launch-and-updates).

## 9. One library

`/library` is the library screen; **On this device** is a facet, including when
opened through `/library?device=1`. Missing audio remains browsable and organized,
with an attach gate at its book route. The offline fallback renders the same
library and rewrites the address; it is not a separate Downloads screen.

Within an account, browsing or deleting a different missing book keeps the active
book playing. Controls and Media Session still identify the active book. A new
book/account must never transiently mount the previous media.

## 10. Eviction and reattachment

The browser may reclaim storage despite persistence requests. Metadata can pull
again from the server; audio cannot. Availability checks reconcile download
records with Cache Storage and show a missing-file gate rather than a broken
player. Keep originals outside browser storage.

Reattachment verifies the saved source size/fingerprint and rendition. Document
regeneration requires the supported recipe and an exact timeline match. The
expand-only uniqueness migration retains both the legacy fingerprint arbiter and
the rendition-aware index; an identical source with a different rendition can
still conflict with the legacy arbiter. Never drop it casually or pair regenerated
audio with an older timeline. Completed legacy audio can still play.

## 11. Account lifecycle

All reads and writes are account scoped. Sign-out purges the departing account;
authenticated sign-in purges **other** accounts and preserves the incoming
account's own downloads. Changes to the active-account marker revoke mounted
peer tabs and stop their playback.

After its final drain, sign-out installs a pending account fence before the auth
request. Account locks coordinate import/media writes with purge. A failed request
clears its pending fence; a dead request's pending fence can age out. Successful
sign-out or a started purge commits an **origin-wide**, identity-free fence that
cannot expire mid-sweep. Only authenticated sign-in behind the global purge lock
reopens writes. Verification detects rows recreated by an already-in-flight write.

Purge covers the account's media, transcripts, mirror, queues, playback registers,
preferences, and private cached pages. Safe user-agnostic shell/static assets can
remain. Session expiry alone does not invoke this purge.

Account deletion verifies the password, journals a short-lived bearer intent,
finishes local purge, then commits server deletion idempotently. A root runner
resumes an interrupted intent; server deletion cannot outrun unfinished local
purge. Metadata export does not include audio or transcript payloads.

## 12. Existing-device compatibility

Retain database names, account keys, device sequence high-water marks, receipt
precision, rendition keys, migration history, and old-client fallbacks. The first
mirror pull after an additive upgrade must not hide already-downloaded books.
Migration, purge, outbox, and resume tests protect data that cannot be recreated
from the server alone.

## 13. Deliberate limits

There is no cloud audio store, hosted TTS, CRDT, realtime push, or guaranteed
background delivery. A local library can lag another device until sync completes.
Storage eviction requires the source file, and real iOS background suspension
requires [physical-device verification](resume-durability-device-check.md).
