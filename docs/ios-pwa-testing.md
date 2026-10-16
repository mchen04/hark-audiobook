# WebKit PWA testing

Acceptance uses automated browser checks and synthetic tests. No physical device,
Simulator, Xcode, or manual checklist is required. These checks do not promise
uninterrupted audio through OS interruptions.

Follow [local setup](development.md#local-test-environment). Export the disposable
test environment before running these commands:

```sh
pnpm test:e2e:ios
pnpm test:e2e:desktop
pnpm test:resume:ci
```

The iPhone project uses Playwright WebKit with an iPhone 15 profile. The desktop
project uses WebKit with the Desktop Safari profile. Both use a production build,
local data, and one worker. Neither runs the Safari application or an installed
iOS Home Screen container.

## Evidence tiers

| Tier                 | What it establishes                                                                                 | Limit                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Browser proof        | Routes, real media elements, storage, service workers, and rendered controls in the recorded engine | Desktop WebKit policies can differ from iOS host policies.             |
| Standalone emulation | Behavior with `navigator.standalone` and standalone display-mode flags enabled                      | Flags do not create an installed container or native safe-area insets. |
| Synthetic test       | App behavior after injected media, lifecycle, interruption, or durable-record inputs                | The event does not prove that iOS delivers that input.                 |
| Platform knowledge   | Public WebKit source, standards, and Apple documentation                                            | Source revisions and OS policies can differ from the tested runtime.   |

A result must name its source commit, runtime, command, and scope. This document
defines procedures; it records no new run result.

## Automated flows

| Spec                                                                          | Protected behavior                                                                                               | Tier                                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [iphone-pwa.spec.ts](../tests/e2e/iphone-pwa.spec.ts)                         | Import, play, seek, local availability, and offline recovery                                                     | Browser proof; meaningful desktop steps also run there              |
| [library-playback.spec.ts](../tests/e2e/library-playback.spec.ts)             | Resume and grid/list playback during the click, saved position, paused card navigation, and recovery-offer guard | Browser proof; the suspension record is synthetic                   |
| [phone-library-controls.spec.ts](../tests/e2e/phone-library-controls.spec.ts) | Phone view controls, bounded targets, and download removal                                                       | Browser proof at 320/393px                                          |
| [media-session-resume.spec.ts](../tests/e2e/media-session-resume.spec.ts)     | Handler effects, saved position, offline artwork, and 206 ranges                                                 | Browser media with invoked handlers; no native system-UI dispatch   |
| [playback-interruption.spec.ts](../tests/e2e/playback-interruption.spec.ts)   | Playback audio category, script-induced pause/resume, and two-tab ownership                                      | Browser probe; interruption is synthetic in WebKit                  |
| [standalone-playback.spec.ts](../tests/e2e/standalone-playback.spec.ts)       | Manifest/Apple contract, start URL, native-element identity, offline reload/resume, handlers, and control bounds | Browser proof with standalone flags emulated                        |
| [session-bootstrap.spec.ts](../tests/e2e/session-bootstrap.spec.ts)           | Cookie-only bootstrap, interrupted sign-in, and fenced deletion recovery                                         | Browser proof; selected storage and server failures are injected    |
| [password-reset.spec.ts](../tests/e2e/password-reset.spec.ts)                 | Captured-mail redemption, session revocation, new password, and invalid/expired links                            | Local browser proof; expiry is set on the disposable token          |
| [retained-workflows.spec.ts](../tests/e2e/retained-workflows.spec.ts)         | Player tools, narration, organization, export, deletion, and first-sync recovery                                 | Browser proof                                                       |
| [launch-flicker.spec.ts](../tests/e2e/launch-flicker.spec.ts)                 | Frame stability and a positive control for all five flicker kinds                                                | Browser proof                                                       |
| [rollover.mjs](../tests/update/rollover.mjs)                                  | Two builds, lazy chunks, cache cleanup, saved position, and offline media                                        | WebKit live-process proof; Chromium process relaunches are separate |

The standalone offline check cuts a local proxy socket. A control fetch fails and
upstream hits stay at zero. Returned HTML and its generation must match the
prepared Cache Storage shell. This proves a full document reload in one browser
context. It does not prove an installed-host or physical-process relaunch.

Protocol flags alone do not prove cached delivery. The response-body, generation,
and network controls supply independent checks. Each result must distinguish a
same-context document reload from a new page, browser process, or installed host.
A failed navigation remains a failed check; it supplies no app workaround by itself.

## Resume and native limits

[Resume specs](../tests/resume) check saved positions after supported lifecycle
inputs and renderer termination. Their Cache Storage restoration repairs a
known desktop harness failure. They do not prove native storage retention.
`test:resume:ci` excludes only `T1 hidden online` and `T1 hidden offline`.
Those cases can report `UNCOVERED` when the engine cannot create a hidden page.

Calls, Siri, other-app audio, headphone removal, ear detection, lock-screen
presentation, and OS scheduling remain platform knowledge. Scripted pause/play
and Audio Session stubs test the app's response. They do not reproduce those
native surfaces. Foreground reconciliation never starts playback automatically.

Optional background observations are in
[resume limits](resume-durability-device-check.md). They are not an acceptance
gate. No operator action is required.
