# iPhone PWA testing

## Automated production checks

Follow [local setup](development.md#local-test-environment), then run:

```sh
pnpm test:e2e:ios
```

The `iphone-webkit` project uses Playwright WebKit with an iPhone 15 profile,
real production build, service worker, and disposable local Postgres fixtures.
The harness normally builds and starts its own server. Reuse is allowed only
when the served commit/build and local fixture environment are known; do not
reuse an unrelated server or personal library. See [checks](development.md#checks).

The [iPhone specs](../tests/e2e) exercise import/playback, local narration,
retained controls, account changes, and offline/recovery behavior. The full
`pnpm verify:browser` command also covers parity, sync, resume, and launch.
Failures retain screenshots and traces under ignored `test-results/`.

This is an automated WebKit check, not an installed app on a physical iPhone.
Persistent-context suites probe browser storage support and can use Chromium
when persistent WebKit cannot serve its own cached entries. Read the browser
selected in the raw output; do not label that run physical iOS coverage.

## Physical installation and listening

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
