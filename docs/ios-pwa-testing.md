# iPhone PWA testing

Follow [local setup](development.md#local-test-environment), then run
`pnpm test:e2e:ios`. The project uses headless WebKit with an iPhone 15 profile,
a production build, and synthetic local data. See [checks](development.md#checks)
and [update commands](development.md#update-and-playback-checks).

Automation proves these checks for the recorded build and engine:

- [iphone-pwa.spec.ts](../tests/e2e/iphone-pwa.spec.ts): real file import, playback,
  seeking, local availability, and offline recovery.
- [retained-workflows.spec.ts](../tests/e2e/retained-workflows.spec.ts): retained
  player controls, document narration, organization, settings, export, deletion,
  and first-sync recovery.
- [launch-flicker.spec.ts](../tests/e2e/launch-flicker.spec.ts): frame stability
  across launch/navigation scenarios and detection of all five flicker kinds.
- [media-session-resume.spec.ts](../tests/e2e/media-session-resume.spec.ts): native
  Media Session handlers, exact saved position, same-page offline reload/history,
  and local 206 ranges. Invoking handlers does not prove lock-screen controls.
- [rollover.mjs](../tests/update/rollover.mjs): real previous/next builds, lazy
  chunks, cache cleanup, progress, and offline playback. WebKit uses one live
  page; Chromium proves browser relaunches separately.
- [position-drift.spec.ts](../tests/resume/position-drift.spec.ts): measured resume
  positions after supported lifecycle events and renderer kills. Its existing
  Cache Storage snapshot restoration is a harness workaround. Real-background
  cases report `UNCOVERED` when the engine cannot hide a page; CI excludes them.

## Physical installation and listening

Only a physical iPhone can prove:

- Lock-screen controls and background audio with the screen off.
- Installed-PWA suspension and relaunch.
- iOS storage eviction and recovery.
- Real cellular network behavior.

Use a disposable account and source files, on an HTTPS instance you are authorized
to test. Do not change production data to complete this checklist.

1. Open in Safari, sign in, and add the site to the Home Screen from Share.
   Launch from the icon and record iOS/device/build details.
2. Use **Choose a book** to import an MP3. Confirm chapters and duration, then
   exercise play/pause, seeks, speed, skips, sleep timer, and smart rewind.
3. Import a short text document. Keep the app open; check progress and cancel one
   attempt. Complete another. Its audio should become playable only after saving.
   A different completed book can keep playing during narration.
4. Use **On this device**, search, tags, archive, and collections. Enable collection
   autoplay only for that check. Inspect read-along text for a source with cues.
5. After the shell and audio are saved, disconnect networking. Relaunch, browse,
   and play. Reconnect and confirm queued metadata/position changes sync.
6. Remove only this test book's download, then attach the matching source. Confirm
   its existing position and organization survive. A different source must not
   replace it silently.
7. On a second device, sign into the disposable account, sync metadata, and attach
   the same source there. Check progress changes and account isolation.
8. Run the separate [screen-off resume procedure](resume-durability-device-check.md).

Record pass/fail per step, screenshots where useful, and any skipped paths. A
checklist in the repository is a procedure, not evidence that it was executed.
