# Changelog

## Unreleased

- Document narration uses Kestrel Fast on the device. Progress and cancellation
  remain available; a narrated book becomes playable only when its completed
  audio is saved. Removed Lemonade connection detection, client, and settings,
  and playback of narration while it is being generated.
- Existing completed narration remains playable. Unsupported older rendition
  identities cannot be regenerated onto a different audio timeline.
- The library reads an account-scoped local snapshot, with search, filters,
  tags, archive, collections, and an On this device facet. Imports become
  visible locally before background metadata sync completes.
- Playback preserves book/account identity when navigating, reattaching media,
  switching accounts, or deleting a different missing book. Chapters, speed,
  skips, sleep timer, smart rewind, history, transcripts, and collection autoplay
  remain available.
- Sync orders cursor-bearing receipts under an account transaction lock with
  bounded lock admission. Retryable server-busy writes remain queued; sign-out
  can retry within its existing drain budget without blocking terminal progress
  writes during the retry wait.
- Setup, architecture, operations, and testing docs describe the current app.
  Generated implementation/review reports are no longer shipped as reader docs.

This section describes pending changes, not a published release or deployment.
