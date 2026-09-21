# Hark simplification evidence

Objective checkout: `/Users/michaelchen/.hermes/kanban/workspaces/t_99d8ece2/hark`.
Hostname verified first: `mbp-old`. Baseline: `0e1f17eb18ce6a07c6d55c1790c860099a490932`.
Branch: `task/t_99d8ece2-hark`. One implementer, ordinary turns, no goal mode or delegation.
No push, PR, merge, deployment, board edits, cleanup gate, or independent review executed.

## Evidence policy

Raw output lives in `.data/objective/{baseline,final}` inside this checkout (ignored).
`scripts/record-check.mjs <prefix> <command> [args...]` records command, host, times,
exit code and combined output. Screenshots, traces and browser measurements use
the same phase directories. A passing mocked test is never labelled live coverage.
All browser users and media belong to disposable local test accounts.

## Baseline preparation

- Clean checkout at the baseline confirmed before edits.
- Node v26.3.1, pnpm 9.6.0, Docker 29.5.2. Host caches held Chromium 1243 and WebKit 2359; the pinned checkout actually
  needs Chromium 1228 and WebKit 2311. These were installed inside
  `.data/objective/browsers` (no global configuration changes).
- `pnpm install --frozen-lockfile`: exit 0; raw `.data/objective/baseline/install.log`.
- Application edits have not started. Measurement scripts and this ledger are
  the only authored additions during baseline capture.

## Results, coverage and limitations

Baseline capture completed before application edits:

| Check                                                    | Result                                                                                                                   | Raw prefix under `.data/objective/baseline/` |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Production build                                         | exit 0, 21.272 s                                                                                                         | `build`                                      |
| TypeScript                                               | exit 0                                                                                                                   | `static-gates`                               |
| Default Node 26 unit run                                 | exit 1: 14 tests fail on unavailable experimental global localStorage                                                    | `unit`                                       |
| Node 26 with `NODE_OPTIONS=--no-experimental-webstorage` | exit 0: 802 passed, 2 opt-in Lemonade tests skipped                                                                      | `unit-node26-compatible`                     |
| Browser install                                          | exit 0, pinned engines in checkout                                                                                       | `browser-install`                            |
| Initial launch/core capability attempts                  | fail: pinned executables missing                                                                                         | `launch`, `browser-core`                     |
| Launch, pinned browsers                                  | exit 0: 24 launches / 1,000 books; p95 A/B/C/D 253/245/247/250 ms; spread 8 ms; 0 server documents and queries           | `launch-pinned`                              |
| Library search                                           | exit 0: median search 47.351 ms, roundtrip 138.234 ms; 6 IDB transactions per search+clear                               | `browser-library`                            |
| Core real Chromium PWA                                   | exit 0: registration, empty/error, MP3 import, playback/seek/rate/resume, offline relaunch/play, live document narration | `browser-core-v4`                            |

Core MP3 import: 257 ms. Tiny TXT narration including uncached public weights:
9.656 s. The same core script and fixtures will be used for the final comparison.
Chromium browser version 149.0.7827.55, iPhone 15 emulation; no claim of physical iOS.
The launch harness probes WebKit and records its unavailable persistent Cache Storage/CDP
capability, then uses calibrated Chromium (16 ms reference work, baseline 2.22x).

Baseline source scope: src TS/TSX excluding test/spec plus authored public/sw.js.
185 files, 28,134 physical lines, 23,950 token-occupied app code lines. Tests and
harness: 35,655 physical lines separately. CSS: 3,249 physical lines separately.
Drizzle generated JSON: 58,251 lines separately. ESLint classic function complexity:
1,810 functions, sum 5,623, max 70, 84 functions above 10. All build JS/CSS/WASM:
28,550,966 bytes; individually gzipped sum 7,559,946 bytes. These bundle totals
include lazy runtimes, not just launch transfer. Exact per-file results and
method are in `source-metrics.json` and `scripts/measure-source.mjs`.

`library/measurements.json` records initial loaded script bodies of 1,273,385 bytes
and main-page JS heap of 11,590,416 bytes (CDP; excludes worker/WASM/process memory).
Baseline screenshots/traces: `core/` and `library/`. Three failed custom-harness
selectors are preserved in `core-selector-failure/`, `core-speed-selector-failure/`,
`core-progress-selector-failure/` with corresponding command logs. These were
harness corrections, not passing app claims. All source remained at 0e1f17e.

Final implementation and retained-feature coverage are pending.
