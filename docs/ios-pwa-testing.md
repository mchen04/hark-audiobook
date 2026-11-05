# WebKit PWA testing

Use the [local test environment](development.md) and separate automation browsers.
Never reuse or close personal Safari windows.

```sh
pnpm test:e2e:ios
pnpm test:e2e:desktop
pnpm test:resume:ci
```

The iPhone project uses WebKit with the iPhone 15 profile.
The desktop project uses WebKit with the Desktop Safari profile.
Both test a production build against disposable local data with one worker.
Neither creates an installed iOS Home Screen container.

## Check silent resume

```sh
HARK_EVIDENCE_DIR=/absolute/evidence/path pnpm exec playwright test --project=iphone-webkit --project=desktop-webkit tests/e2e/media-session-resume.spec.ts
```

The simulated test imports real MP3 audio and invokes the registered Media Session handlers.
It forces low `readyState` from first load and dispatches hidden, pagehide, and freeze events.
It repeats pause/resume five times and checks position, mute, volume, playback state, and decoded audio energy.
WebKit does not expose decoded-byte counters on every version; the test also samples decoded PCM through an analyser.
The same session checks normal play, pause, and seek.
Reports include the browser version, injection scope, audio samples, and a screenshot.

These events simulate the app's inputs. They do not reproduce physical locking or prove speaker output.
Warm sources previously bypassed muted priming, so forcing low readiness only after warm playback did not expose that path.

## Preserve resume and offline behavior

The browser suites cover interruption rewind, pause intent, tab ownership, offline reload, Media Session, and history.
The resume suite also covers process termination, competing writers, rate, completion, and saved-position recovery.
`test:resume:ci` excludes `T1 hidden online` and `T1 hidden offline` because desktop WebKit cannot reliably create native suspension.
Its fixture-cache repair restores media after a desktop WebKit failure, so it cannot prove native cache retention.

Cached-shell tests require a failed network control, no upstream document requests, and matching cached content.
Standalone flags alone do not prove offline delivery.
Record the exact build, command, engine, pass/fail counts, and any injected state with each result.

Calls, Siri, headphone changes, OS scheduling, native safe areas, and physical lock-screen output require device observations.
Foreground reconciliation never starts playback automatically.
If all JavaScript writers stop while audio continues, the saved position can lag listening.
Recovery offers an estimate without accepting it automatically.
