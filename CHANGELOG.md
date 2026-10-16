# Changelog

## Unreleased

- Resume a local book directly from the continue card or grid/list play button.
  Playback starts in place and appears in the mini player. Card bodies and titles
  still open the paused full player. Unanswered recovery offers open there first.
- Phone grids show three books per row with shorter secondary details. Neutral
  cloud badges mark missing audio. Add book uses a plus icon. Phone Grid/List
  controls stay available with 44px targets; sort uses an icon over its native picker.
- List covers no longer repeat the missing-download badge over their initials.
  Each missing-audio row keeps its explanation and a decorative unavailable icon.
  Download removal remains reachable through List view. Cover initials match
  across library, full player, and mini player.
- Playback speed uses compact `1×` labels and the native picker. Sleep uses a
  compact menu, selected chips, `Sleep`, minute countdown, or `Chapter end` labels.
  The countdown updates while paused. Phones keep skip-back beside mini-player Play.
- Minute sleep checks elapsed deadlines after delayed timers and lifecycle return.
  Chapter sleep follows seeks and clears when the book changes. JavaScript
  suspension can still delay a stop.
- Media Session position, rate, metadata, artwork and playback state follow book
  changes and clear on unload. Play/pause, stop and seek actions stay available;
  next/previous track actions remain unregistered.
- Explicit playback requests the supported Audio Session playback category.
  System-style pauses preserve exact position. An actual later resume can apply
  enabled smart rewind once; returning to the foreground never starts playback.
- An explicit Play can recover a media error at the retained position/rate.
  Foreground reconciliation refreshes stale UI state without changing position.
- A verified session restores its local identity before entering a cached library.
  Fenced login hands control to the existing account-deletion recovery screen.
- The rendered PWA metadata includes the Apple Home Screen capability tag.
  Testing now includes desktop WebKit, standalone-flag emulation, manifest/Apple
  contracts, and complete local password-reset redemption. Native OS behavior
  remains outside browser proof; no physical-device checklist is required.

- The library paints once, without a card-size jump or a false “Bring your first
  audiobook” message while a new device finishes syncing.
- Account deletion no longer fails when an account write is still in flight.
- Metadata export no longer stalls on large databases while reading playback history.
- The player's lock-screen artwork stays available offline after an app update.

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
- Document narration renders each chunk's audio while the next chunk is
  synthesized. The pipeline preserves the narrated samples.
- Background sync skips resending the full book-id list when the device already
  holds the same books, which shrinks routine syncs for large libraries. A book
  imported while a sync is in flight no longer briefly disappears.
- A first visit defers narration-engine code. That code is cached with the model
  on the first narration instead of up front. Offline narration still works
  once the model is on the device.
- Setup, architecture, operations, and testing docs describe the current app.
  Generated implementation/review reports are no longer shipped as reader docs.

This section describes pending changes, not a published release or deployment.
