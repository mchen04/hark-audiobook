# Launch performance gate

The [launch benchmark](launch-benchmark.spec.ts) measures time from navigation to
painted library content in a fresh browser process reusing a warm profile. Run it
against disposable local fixtures after [setup](../../docs/development.md):

```sh
pnpm test:e2e:launch
```

The harness builds/starts the production app, ensures at least 1,000 fixture books,
and refuses hosted databases. Its seeded account is test data; never point it at
a personal library or reset a retained database to improve a score.

## Fixed acceptance contract

- Six launches per profile: fast (0 ms), slow (400 ms), simulated cold database
  (3,000 ms), and offline.
- p95 no more than **500 ms** on every profile; spread between profile p95 values
  no more than **150 ms**.
- Real book cards and the `books` readiness marker must paint. A skeleton or
  accidental empty mirror is not a successful launch.
- The cached document, zero document transfers/server document hits, and zero
  Postgres queries before paint are asserted independently of the timing.
- Delay/offline controls and persistent cache survival are proved before the
  relevant samples count. CPU calibration normalizes a fixed reference workload;
  viewport emulation alone does not simulate phone CPU speed.

The harness probes persistent WebKit first. The chosen engine must support
persistent Cache Storage and CPU throttling. Chromium can provide both with
iPhone viewport emulation and calibrated CPU.
The report names the engine and capability result. Neither that fallback nor
Playwright WebKit is a physical-iPhone measurement.

## Recording a comparison

Use the same command, fixture scale, runtime, browser engine, CPU calibration,
network controls, and metric definitions for baseline and candidate. Record exact
source commit, dirty status, build id, samples, and final assertion outcomes in an
external receipt directory. Keep failures and incomplete output. A printed table
before assertions finish is not a passing result.

This file defines the protocol, not the latest measured score. Historical results
remain attributable to their original commits in Git history and external
artifacts. Do not carry an earlier browser score forward as a measurement of a
new source head. Source LOC/complexity and build-wide asset totals from
`scripts/measure-source.mjs` are separate measurements, not launch latency or
initial-download size.

# Benchmark protocol v1.1

Results, videos, and command receipts stay outside the repository.

## Setup and fixtures

- Use a quiet Mac, production standalone builds, local Postgres, and headless
  Playwright 1.61.1 WebKit build 2311. Use `devices["iPhone 15"]` without CPU throttling.
- Record host model, CPU, memory, OS, Node, Playwright, browser versions, Git head,
  dirty status, build IDs, directories, fixture hashes, and measurement order.
  Desktop CPU timings and RSS are not physical-iPhone measurements.
- A is the archived frozen base `e4525ac70dd5bc3113ce3c8a76b97dcdd2d47858`.
  B is the prepared candidate. Each has its own server port, account, and context.
  Builds stay under `TMPDIR`; servers use 3100/3200 and the test environment.
- Each account has 1,000 metadata books seeded by [seed-perf.mjs](../../scripts/seed-perf.mjs).
  Import the generated MP3 through the real file chooser: 600 seconds of sine
  tones, mono, 64 kb/s, five ID3 chapters, and more than 4 MiB across two media chunks.
  Record SHA-256 and the first FFmpeg version line.
- First visits use fresh contexts with only the session cookie. Other WebKit
  metrics share one prepared non-persistent context per variant: SW controlling,
  shell cached, mirror synced, and audio saved. The page process stays live.
- Chromium uses a separately prepared persistent profile with the same fixture.
  Chromium measurements remain labelled Chromium; they are not Safari results.
  See [WebKit limits](../../docs/development.md#benchmark).
- Continue the A,B,B,A sequence across metric groups. An A/A run of the frozen
  base sets the noise band. Reduced repetitions are functional smoke checks only.

## Metrics

The library end marker is `[data-launch-ready="books"]` with at least one
`.book-grid .book-item`. The start URL is `/library?source=pwa`.

| Metric                                | Definition                                                                                                                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first_visit_ms`                      | Empty context, session cookie only; navigation to `/library` through complete first sync and the books marker.                                                                                                                                                   |
| `cold_start_ms`, `cold_start_wall_ms` | Not measurable in this WebKit build; report unavailable, never zero.                                                                                                                                                                                             |
| `warm_start_ms`                       | Navigate the same live library page to the start URL; navigation start to the books marker.                                                                                                                                                                      |
| `time_to_playback_ms`                 | From a warm-started WebKit library, card tap to unpaused audio at least 0.2 s past its pre-play position. Wait for enabled Play, then tap it.                                                                                                                    |
| `open_player_ms`                      | Card tap to player heading and enabled Play visible on an animation frame.                                                                                                                                                                                       |
| `play_start_ms`                       | Play tap to the same 0.2 s advancement boundary.                                                                                                                                                                                                                 |
| `cold_relaunch_chromium_ms`           | SIGKILL the owned Chromium browser, relaunch its prepared persistent profile, then navigate the start URL to the books marker. Browser launch is outside the timer.                                                                                              |
| `cold_relaunch_playback_chromium_ms`  | Card tap to 0.2 s advancement from that relaunched Chromium library.                                                                                                                                                                                             |
| Screen transitions                    | Click to the first animation frame with the target: library → player heading + Play; player → books marker; library → settings heading; settings → books marker.                                                                                                 |
| `playback_rss_kib`                    | `ps` RSS of owned WebKit UI, WebContent, Networking, and GPU processes, 10 s after playback begins. Identify browser mains by Node ancestry; use build-scoped macOS responsibility or Linux descendants. Reject ambiguous ownership. Confirm playback continues. |
| `cold_rss_kib`                        | Unavailable because WebKit cold start is unavailable.                                                                                                                                                                                                            |
| JS heap                               | `null`, reason `unavailable in WebKit`; never zero.                                                                                                                                                                                                              |

Before each warm navigation, wait for the books marker, no pending requests, and
3,000 ms of network quiet. This readiness wait is outside the measured interval.
Playback measurements state “from warm library”. No metric waits for server
revalidation before the initial warm paint.

Bundle sizes come from the built files, compressed independently with gzip -9
and Brotli -11:

- Launch JS/CSS referenced by the `/offline` document used for the start URL.
- Player JS/CSS closure from the `/books/[id]` client-reference manifest, including
  required document runtime scripts.
- Total client JS bytes under `.next/static`.
- SW install closure: shell, referenced assets, and runtime precache assets,
  excluding dependencies deferred until the model exists.
- First-visit `/_next/static` wire bytes completed by books paint, counted at the
  server socket, including SW fetches and HTTP headers. Reject ambiguous pipelining.

## Repetitions, validation, and aggregation

Per variant: first visit 5; warm start 10; playback 10; each transition 10;
Chromium relaunch/playback 10; playback RSS 5. WebKit cold metrics have no samples.
Metric order is first visit, warm start, playback, transitions, memory, Chromium.
Keep every current-run raw sample, timeout, content failure, and page error.
Every valid library sample needs the books marker and cards; playback must advance.

Report median, p90, min, max, IQR, n, and failure count per metric and variant.
Median and quartiles use linear interpolation; p90 uses nearest rank.
Noise input requires complete full-repetition A/A results with matching host,
OS, Node, engines, fixture, metric definitions, and measurement order.
Without it, timing and memory decisions say `noise band unknown`.

## Decision rule

- Timing gain: B's median falls by at least the larger of 10% of A and twice the
  absolute A/A median delta. The same increase is a regression.
- Memory uses the same rule with 5% instead of 10%.
- Bundle gain: launch-closure gzip falls by at least 1%; report every byte change.
- Static transfer bytes and cold-start wall time are informational.
- A performance change needs a gain, no regression, valid samples, and all external
  checks green. Smoke runs cannot qualify. The JSON leaves external check/keep
  decisions unset; a caller must supply their outcomes.
- Cleanup or correctness changes need their own reason; they are not performance
  wins without meeting this rule. Limit optimization to three rounds and stop
  after two consecutive rounds without a gain.

## Flicker and layout stability

Record video and per-frame readiness, card count, state, and rectangles for the
header, main heading, first card, player heading, and Play button.
States include blank, header-only, first-sync notice, empty library, books,
player, settings, and login.

Scenarios: signed-out `/` → login → sign-in → library; first sync on a new device;
reopen; reopen with 3,000 ms server delay; offline reopen; book and Back; browser
back/forward; reload player and library; invalid session; library ↔ settings.
Reopen closes pages and proves their WebContent PIDs exit before opening a new page.
Offline reopen keeps the live page process and cuts the upstream socket.
These recorder scenarios do not make WebKit cold-start timing available.

Five event kinds stay fixed:

1. **Blink:** a visible landmark disappears and returns.
2. **State regression:** books changes to non-books without a user action.
3. **Blank after first paint:** a blank frame appears after content has painted.
4. **Layout jump:** a landmark moves more than 1 CSS px from its first position.
5. **False empty:** an empty library is followed by books in the same document
   without an intervening import; report frame count and visible duration.

Never compare landmarks across documents. Exempt only the outgoing landmarks
named by the harness action, only for that navigation's duration. Incoming content
and blank frames stay checked. One library-to-login navigation is expected only
with its preceding 401/403 sync response recorded for that library document.
Nothing excuses an earlier blink or regression inside that document.

True page errors and unhandled rejections fail scenarios. Console diagnostics
remain notes. The sampler narrowly recognizes WebKit's handled sync/blob resource
cancellation during the recorded reload, only without a script error.
The synthetic regression control must detect all five event kinds.

Use the [benchmark commands](../../docs/development.md#benchmark) to prepare,
measure, and record. This protocol defines measurements, not a current score.
