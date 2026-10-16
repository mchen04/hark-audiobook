# Resume durability: automated proof and optional observations

Acceptance uses WebKit browser checks and synthetic tests. No physical device,
Simulator, Xcode, or manual checklist is required. Optional field observations
are background material. They are outside automated acceptance.

## Automated proof

```sh
pnpm test:resume:ci
```

The command runs the resume oracle against a production build. It excludes only
`T1 hidden online` and `T1 hidden offline`. The full `pnpm test:resume` retains
those assertions and can report `UNCOVERED` when WebKit cannot hide a page.
A browser profile does not establish actual iOS screen-off scheduling.

The oracle checks durable position, repeated opens, smart rewind, completion,
rate, competing writers, and two-device conflicts. Its kill/reopen checks use
owned desktop browser processes. The existing Cache Storage repair restores
fixture bytes after a desktop WebKit failure. It does not replace progress after
a measured kill. Results cannot establish native cache retention.

[Suspension recovery](../tests/resume/suspension-recovery.spec.ts) uses constructed
durable records. [Player lifecycle tests](../src/components/player/playback-provider.lifecycle.test.tsx)
use synthetic media and Audio Session inputs. The standalone browser flow
emulates web-facing flags and reloads a cached document in one context. These
are separate evidence tiers, not physical iOS observations.

## Persistence and platform limits

The player writes on a 200 ms cadence while playing, on media events, and at
lifecycle boundaries. These writers limit position loss when callbacks run.
A terminated process cannot write again. A suspended process cannot guarantee
a final callback or a timer deadline.

If audio continues while both JavaScript writers stop, the last saved position
can lag what was heard. Recovery starts from the durable position. Hark can
offer a labelled estimate, but it never accepts that estimate automatically.
Elapsed wall time and an estimate do not prove continuous listening.

Unmarked, non-ended pauses are classified as system-style interruptions. The
app cannot identify a call, Siri, route change, or other app from that event.
It preserves position and waits for an actual resume path. Existing enabled
smart rewind can apply once on that later play event. Foreground reconciliation
only reads the native element.

## Optional field observations (not required)

A future investigator can use a disposable account, retained source files, and
an authorized HTTPS instance. Useful context includes the app commit/build,
iOS/device version, battery mode, network state, rate, and sleep setting.
None of these observations is an acceptance requirement.

- Compare audible playback with saved position before and after screen lock.
- Separate OS pauses from periods of continued audible playback.
- Compare Safari hosting with an installed Home Screen container.
- Observe whether a native interruption resumes itself or needs explicit Play.
- Inspect native metadata, seek controls, accessory actions, and headphone routes.
- Distinguish a same-process return from process termination and relaunch.
- Repeat offline only after shell and media bytes are cached.

Unlocking can wake the page and flush progress. An investigator must disclose
that confound. A single recent write does not show that both writers ran for
the whole locked interval. A labelled estimate shows gap detection, not proof
of uninterrupted sound. No result from these optional observations is asserted
here.

Public interruption and route behavior is platform knowledge. See
[WebKit PWA testing](ios-pwa-testing.md) for browser evidence boundaries and
[architecture](architecture.md#media-and-playback) for the app's response.
