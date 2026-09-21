# Hark simplification evidence

Objective checkout: `/Users/michaelchen/.hermes/kanban/workspaces/t_99d8ece2/hark`.
Hostname verified first: `mbp-old`. Baseline: `0e1f17eb18ce6a07c6d55c1790c860099a490932`.
Branch: `task/t_99d8ece2-hark`. One implementer, ordinary turns, no goal mode or delegation.
No push, PR, merge, deployment, board edits, cleanup gate, or independent review executed.

## Evidence policy

Raw output lives under `.data/objective/`, primarily its `baseline/` and `final/`
directories, inside this checkout (ignored).
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
- Application edits had not started. Measurement scripts and this ledger were
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

## Implementation and retained workflow decisions

The product contract was read first in README, architecture, local-first,
development and resume-durability documentation, then traced through the import,
library, player, offline mirror/outbox, account and service-worker paths.

- Removed Lemonade detection, HTTP client, settings, engine-selection wrapper,
  dedicated tests and installation documentation. Kestrel now has one direct
  local narration path; the model, voice, chunking, encoding and rendition key
  are unchanged. No cloud audio or TTS service was added.
- Removed the partial-audio preview queue, handle and player route. An import
  shows progress and cancellation without a playable link. The completed audio
  commit precedes its library row. The controller guards callbacks by both
  account ownership and active import, and suppresses duplicate progress renders.
- The measured retained-workflow bottleneck was the library: every search and
  clear repeated three complete IndexedDB reads. One coherent four-store read
  now provides books, tags and continue-listening data; an account-scoped React
  snapshot handles search, facets and sort without another storage transaction.
  Filter and sort rules are shared with device-only imports. Older clients'
  persisted search fields remain compatible.
- Committed mirror/media changes invalidate the snapshot through an in-memory
  revision and a data-free BroadcastChannel signal. The next filter interaction
  rereads dirty rows; route returns and focus also refresh local state. No new
  IndexedDB schema or persistent cache metadata is introduced. A real two-tab
  edit/search test reproduced the stale snapshot before this correction.
- A held real sync response exposed a completed-import delay. The library now
  rereads the committed local book immediately, then refreshes after background
  sync. The new socket-level browser regression failed before this fix.
- Loading now has visible status text. Document attachment offers cancellation;
  the empty downloads hint names attachment of the original source. Screenshot
  review caught truncated narration instructions; those paragraphs now wrap.
  Small list thumbnails use the missing-audio icon while the adjacent row keeps
  the full attachment explanation, fixing a clipped duplicate badge.
- Player transport, chapter/speed/skip/history/sleep logic, smart rewind,
  transcripts, tags/archive, collections/autoplay, account/sync, export/deletion
  and diagnostics retain their existing contracts. Their common library reads
  benefit from the snapshot change; parser loading is deferred until needed.
  Their durability and security state machines were retained because removing
  them would weaken offline recovery and account isolation.

### Legacy rendition safety

The exact supported recipe remains
`kestrel-fast-v1:ebfe37d8a8771780:extract-v2:split-v1:chunk320:af_heart:mp3-cbr64k`.
Unknown/legacy keys are rejected before extraction, synthesis or media storage.
Cached completed audio still plays. Missing legacy audio shows why Hark cannot
rebuild it, and attachment is disabled; no new audio is paired with old timing.
The existing fingerprint/rendition uniqueness rules and all chapter/position
data are unchanged. Importing the same original source is not advertised as a
way around the legacy identity conflict. The browser compatibility fixture
relabels a disposable completed Kestrel book as legacy; it proves the identity
gate and cached playback, not historical Lemonade synthesis quality.

### Pruning rationale

Only code, styles, tests and docs exclusive to the two retired features were
removed, plus `tests/parity/one-library.spec.ts`, a filename/regex scanner whose
behavioral claims are covered by actual library parity and navigation tests.
New focused unit tests protect cancellation/replacement/account races and the
no-extra-read filter contract. New production browser tests cover retained UI
journeys, actual document narration and a stalled sync response. Test count is
not an optimization target. Migration history, generated Drizzle snapshots,
lockfile, model assets, IndexedDB upgrades, outbox/purge and resume oracles remain.
No user library or unrelated repository was cleaned.

The retained workflows were evaluated through their actual entry points and
the matrix below. Library filtering, local completion visibility, attachment
copy and narration status had measurable or reproduced friction and changed.
Transport, sleep/rewind, history, transcripts, organization, collections and
account controls were exercised together; no evidence justified replacing
their established persistence or conflict rules. The largest retained
complexity remains in durability/reconciliation code, not the removed engines.
Total complexity is reported as well as per-function results, so reductions
cannot be manufactured by merely moving branches to another app file.

### Verification corrections, with original failures retained

- Node 26's experimental global localStorage conflicts with jsdom in the
  original test suite. `NODE_OPTIONS=--no-experimental-webstorage` makes the
  unmodified baseline executable; the same flag is used for the final gate.
- Missing pinned browser executables were installed under this checkout.
  No global MCP or browser configuration was changed.
- Initial custom selectors confused the password field, speed control and
  narration/listening progress bars. The raw failures remain; corrected
  selectors drive the actual accessible controls.
- A recipe-key test initially contained a transcription typo; the production
  key was never changed. Fresh builds clear Next's stale generated types for
  the deleted route. Deferred test promises use the project's supported TS API.
- Playwright route interception did not hold the service worker's first pull.
  The new loading/recovery test uses the existing real socket proxy instead.
  `final/import-stalled-socket` then reproduced the actual completed-import
  delay before its fix, rather than passing against a mocked request.
- `final/integrity-complete` exposed two verifier defects. The delete-while-
  playing journey used an 8-second clip that ended during real clicks; its
  replacement is an independently imported 90-second FFmpeg fixture, and the
  assertion also checks that the same audio source remains mounted.
- T7's old estimate stopped before the last live audio read and SIGKILL. It
  claimed a true position of 12,450 ms even though the trace already observed
  the element at 12,665.228 ms; the resumed value was 12,763 ms. The measurement
  now advances the latest independent audio sample to the actual kill instant,
  like the plain pagehide path. No drift/ahead thresholds were relaxed.
  `final/resume-timestamp-diagnosis.json` preserves the trace calls and values.
  Both affected composed-termination scenarios require repeated verification.
- X2's 24.137-second fixture finished while the second device was listening.
  Reopening a completed book correctly restarted at zero. The two-device fixture
  now has about two minutes of real MP3 frames, identical on both devices, and
  explicitly fails if the listening interval reaches the end before measurement.
- The first cache-regression attempt passed because the normal post-paint pull
  raced the edit. After allowing that pull to settle, `cache-invalidation-settled-red`
  failed on the stale tag search against the pre-invalidation production build.
  Neither that preliminary pass nor mocked hook tests substitute for the final
  two-tab production test.
- `verify-quick-invalidations` passed format/lint/types and all 770 tests, then
  its build lacked `DATABASE_URL` and `BETTER_AUTH_SECRET`. `build-complete`
  passed with `.env.test` loaded explicitly. The final combined gate records
  the local database URL and an explicitly disposable build-only auth secret.
- The added autoplay journey tried to fill the position range with 89,500 ms,
  but the real control's step is 1,000 ms. WebKit correctly rejected the malformed
  input. `iphone-final` retains that failure (the other four journeys passed).
  The fixture now seeks to 89,000 ms and still waits for the real decoder's end
  event; no synthetic completion event or app behavior changed.

## Final verification

Application implementation: `be79d4e` (production build ID
`j7PMWI5_48ZudOzCn4zCo`). The following commands ran on `mbp-old` against the
guarded standalone server and isolated PostgreSQL database. Every raw prefix
has both `.json` command metadata and `.log` combined output.

| Check                                                  | Result                                                  | Raw prefix under `.data/objective/final/`                        |
| ------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------- |
| Format, lint, TypeScript, unit tests, production build | exit 0; 770 tests in 87 files; 35.288 s total           | `verify-quick-final`                                             |
| Full parity, resume and sync matrix                    | exit 0; 87 passed; 921.225 s                            | `integrity-final`                                                |
| Five production PWA journeys                           | exit 1; 4 passed, 1 malformed test seek input; 46.094 s | `iphone-final`                                                   |
| Corrected retained-player/autoplay journey             | exit 0; 1 passed; 9.785 s                               | `iphone-autoplay-corrected`                                      |
| T6/T7, three repetitions each                          | exit 0; 6 passed; 144.744 s                             | `resume-composed-repeat`                                         |
| Final source/complexity/bundle measurement             | exit 0; 2.461 s                                         | `source-final`                                                   |
| Changed verification tooling lint                      | exit 0; 2.170 s                                         | `verification-tooling`                                           |
| Comparable launch benchmark                            | exit 0; 24 launches; 26.600 s                           | `launch-final`                                                   |
| Comparable 1,000-book library measurement              | exit 0; seven search/clear samples; 9.432 s             | `browser-library-final`                                          |
| Comparable core production PWA measurement             | exit 0; all six journeys; 11.286 s                      | `browser-core-final`                                             |
| Cold library setup follow-ups                          | both exit 0; 6.477 / 6.447 s command time               | `browser-library-cold-repeat-1`, `browser-library-cold-repeat-2` |

The final full matrix disables Playwright trace recording, retaining every
assertion and existing position-loss bar. The prior traced run remains at
`integrity-complete`: 84 passed, 3 failed. Its three failures and the resulting
fixture/timestamp corrections are described above. Final raw resume rows are
also in `final/resume-rows.jsonl`; all four cumulative scenarios reported zero
drift over five opens. Bounded loss checks and both corrected cross-device
scenarios passed. No hidden/background T1 coverage is claimed.

After the documentation and summary tooling updates, whole-repository format
and lint checks also exited 0: `final/format-final` (3.892 s) and
`final/lint-final` (5.763 s). The final generated-evidence format check and diff
whitespace check are recorded outside the indexed directories at
`.data/objective/document-check` and `.data/objective/source-diff-check`.

The unit suite uses mocks/fake IndexedDB where declared by its tests. Browser
journeys use the production app, real engines/decoder, real local database and
socket failures. Sync fuzz calls production mutation APIs directly; it is not
presented as clicking every UI control. The separate real-UI sync case passed.

All five PWA journeys are covered by the four initial passes plus the corrected
journey, not a claim that the original five-test command exited successfully.
The six document fixtures used real extraction and Kestrel synthesis: TXT
1,970 ms, Markdown 2,084 ms, HTML 2,034 ms, PDF 2,225 ms, DOCX 2,283 ms and EPUB
2,347 ms. Weights were warm after the cancelled import; these are functional
short-fixture observations, not the comparable cold-weight narration metric.
The latter comes from the unchanged core measurement script below.

Repeated T6 loss was 50/134/54 ms against the unchanged 1,000 ms hard-kill bar.
Repeated T7 loss was 160/161/163 ms against the unchanged 250 ms pagehide bar.
No repeated case resumed ahead. The independent samples and kill-time gaps are
in `final/resume-repeat-rows.jsonl`.

## Comparable measurements

The final source snapshot is `4964071` (test/tooling-only follow-up to the
unchanged `be79d4e` application). Both phases use the same source scanner,
ESLint complexity settings, browser scripts, fixtures and production mode.
Browser runs are sequential, with no concurrent build or test load.

| Source scope / metric                    |   Baseline |      Final |      Change |
| ---------------------------------------- | ---------: | ---------: | ----------: |
| App files                                |        185 |        178 |          −7 |
| App physical lines                       |     28,134 |     27,254 |        −880 |
| App token-occupied code lines            |     23,950 |     23,210 | −740 (3.1%) |
| App function complexity sum              |      5,623 |      5,448 | −175 (3.1%) |
| Retained library read/filter complexity  |        357 |        327 |  −30 (8.4%) |
| App functions                            |      1,810 |      1,744 |         −66 |
| Maximum function complexity              |         70 |         70 |   unchanged |
| Functions with complexity above 10       |         84 |         79 |          −5 |
| Tests/harness physical lines             |     35,655 |     35,752 |         +97 |
| Tests/harness code lines                 |     32,148 |     32,332 |        +184 |
| CSS physical lines                       |      3,249 |      3,149 |        −100 |
| Generated Drizzle JSON lines             |     58,251 |     58,251 |   unchanged |
| All build JS/CSS/WASM bytes              | 28,550,966 | 28,540,225 |     −10,741 |
| Sum of individually gzipped build assets |  7,559,946 |  7,555,714 |      −4,232 |

The total build reduction is small because retained document/player runtimes
still ship. Public model weights are unchanged and are not part of this static
JS/CSS/WASM count. Deferring parser imports primarily changes which scripts
load on the initial library path; that separate browser measurement follows.
The complexity maximum is deliberately reported unchanged, not hidden by an
aggregate reduction. Tests and generated files do not contribute to app LOC
or the app complexity sum.

The retained-library subset is the hook, mirror, domain library rules and new
in-memory revision module; exact file names and all per-function measurements
are retained in the JSON. The revision module is included even though it did
not exist at baseline.

| Browser measurement                                   |      Baseline |         Final |
| ----------------------------------------------------- | ------------: | ------------: |
| 1,000-book warm launch p95: fast                      |        253 ms |        224 ms |
| Warm launch p95: 400 ms network                       |        245 ms |        223 ms |
| Warm launch p95: 3,000 ms database                    |        247 ms |        225 ms |
| Warm launch p95: offline                              |        250 ms |        232 ms |
| Document/API/asset/DB hits before launch paint        | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Median search, seven samples                          |     47.351 ms |      8.901 ms |
| Median search + clear                                 |    138.234 ms |     45.889 ms |
| IDB transactions per search + clear, every sample     |             6 |             0 |
| Initial library JS decoded bodies, including preloads |   1,306,238 B |   1,019,533 B |
| Script-initiator decoded bodies only                  |   1,273,385 B |     986,680 B |
| MP3 import journey                                    |    257.083 ms |    155.852 ms |
| Playback/seek/rate/reload journey                     |    722.583 ms |    682.072 ms |
| Offline relaunch/play journey                         |    720.363 ms |    765.008 ms |
| Tiny TXT narration, uncached weights                  |  9,655.932 ms |  7,592.331 ms |
| Median warm reload, five samples / two books          |     41.140 ms |     30.415 ms |
| First sign-in/library setup step                      |  5,686.428 ms |  8,099.519 ms |
| Main-page JS heap at library startup                  |  11,590,416 B |  19,262,984 B |
| Main-page JS heap after search                        |  25,650,020 B |  20,581,972 B |

Warm launch uses six process launches per profile and the same frozen 16 ms
calibration workload (2.22x baseline, 2.29x final). Both launch runs reported an
8 ms p95 spread; displayed profile numbers are rounded independently. Search
improved 81.2%, and initial decoded JS bodies fell 21.9%. Decoded bytes are not
compressed network transfer. Core journey times include Playwright actions and
screenshots where present; individual import/playback/narration observations
are not a sustained-throughput benchmark. The small offline timing increase is
reported rather than omitted.

The slower cold setup was investigated rather than replaced with a better run.
It includes navigation, sign-in, full sync, an explicit two-second settling
wait and a screenshot. Baseline and final traces contain the same five pull
responses with identical decoded sizes; the larger gaps were between requests,
not increased server response times (`cold-sync-timing-diagnosis.json`). Two
fresh-context follow-ups took 5,153.281 ms and 5,067.118 ms for that same step.
The 8,099.519 ms observation remains in the comparable table. This sample set
does not establish an overall cold-setup improvement or a persistent regression.

Heap samples have no forced GC and exclude worker/WASM/process memory. The
startup heap sample increased while the post-search sample decreased, so there
is **no memory-reduction claim**. Earlier intermediate results remain in
`final/core-before-followup`, `library-before-followup` and
`source-metrics-before-followup.json`; they are not substituted for final data.

Derived, tracked summaries: [architecture-metrics.json](architecture-metrics.json)
and [architecture-artifacts.json](architecture-artifacts.json). Regenerate them
with `node scripts/summarize-objective.mjs` after the recorded checks, then run
`pnpm exec prettier --write docs/evidence/architecture-metrics.json docs/evidence/architecture-artifacts.json`.
The script
reads raw outcomes and hashes the JSON/log/screenshot/trace artifacts, excluding
the active server log. The baseline/final method and scope are encoded in both
the summary and the full source reports.

## Visual evidence

Reviewed final screenshots are collected at `.data/objective/final/visual-final/`:

| State or workflow                        | Screenshot filename(s)                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Loading, unreachable and recovery        | `first-sync-loading.png`, `first-sync-unreachable.png`, `first-sync-recovered.png` |
| Empty / account deletion                 | `empty.png`, `account-deleted.png`                                                 |
| Narration progress and cancellation      | `narration-cancel.png`                                                             |
| Completed document formats / legacy gate | `six-document-formats.png`, `legacy-rendition-refused.png`                         |
| Player and autoplay                      | `player.png`, `collection-autoplay.png`                                            |
| Organization, transcript and diagnostics | `organization.png`, `transcript.png`, `settings-diagnostics.png`                   |
| Offline and missing media                | `library-offline.png`, `not-on-this-device.png`                                    |
| Recovery regressions                     | `filter-after-another-tab-edit.png`, `import-while-sync-stalled.png`               |

Comparable baseline/final core screenshots and traces are in each phase's
`core/` directory, including `import-error.png`, `offline-player.png` and
`narration-progress.png`. The 1,000-book and search screenshots/traces are in
each phase's `library/`. A screenshot shows a moment; the associated assertions,
decoder samples and raw outcomes establish playback, cancellation and recovery.

## Retained-feature coverage matrix

This matrix names the executable evidence and its scope. Final command outcomes
are recorded above; a scenario listed here is not by itself a passing claim.

| Workflow                                  | Production browser path / independent check                                                                                                        | Additional boundary coverage                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Loading, empty, failure and recovery      | `retained-workflows`: hold first sync at the socket, slow notice, disconnect, retry; core empty and invalid MP3 screenshots                        | First-sync gate and mirror unit tests                                                                       |
| MP3 import and re-import                  | Core chooser → real parser → cached audio → player; sync lossless re-import and racing deletion                                                    | FFmpeg MP3 contracts, frame/seek-table tests including >4 GiB header behavior                               |
| Document formats                          | `retained-workflows`: actual TXT, Markdown, HTML, PDF, DOCX, EPUB extraction and local Kestrel synthesis                                           | Parser/source limits and malformed/encrypted/unsupported input tests                                        |
| Narration progress/cancel/completion      | Real long-text import cancelled from UI; no playable import link; six documents complete before playback                                           | Replacement/account cancellation callbacks; duplicate progress reports                                      |
| Legacy narration                          | Cached completed compatibility fixture plays; after removing its download the old rendition is refused and DB chapters stay identical              | Exact Kestrel identity and timing mismatch checks; no historical Lemonade synthesis claim                   |
| Play, pause, seek, speed and skips        | Real MP3 decoder, 15/30-second skips, 1.5x, chapter navigation and reload                                                                          | Pure transport and persistence tests                                                                        |
| Sleep timer                               | Real decoder crosses a chapter boundary and stops at its end                                                                                       | Countdown/deadline policy unit tests; not a physical lock-screen run                                        |
| Smart rewind and durable position         | Resume oracle: online/offline cycles, process kills, navigation, cumulative 5-second and 30-second rewind tiers, cross-book and cross-device cases | Long absences are simulated by ageing an app-written pause marker; no hours-long wait claim                 |
| Listening history                         | UI selects a fast-forward entry and restores its position                                                                                          | History retention, account scoping and snapshot conflict tests                                              |
| Transcripts                               | Real embedded-transcript MP3, show text, select cue, play                                                                                          | Transcript parsers, alignment and offline preservation tests                                                |
| Search, tags, sort, grid/list and archive | 1,000-book search measurements; online/offline parity on phone and tablet; tag/save/archive/unarchive through UI                                   | Server/mirror parity and no-extra-read regression                                                           |
| Collections and autoplay                  | UI creates collection, adds books, enables autoplay; actual ended event opens and plays the next book                                              | Two-device membership convergence and finished-book preservation oracle                                     |
| Offline storage / missing media           | Core offline reload/play with failed API control; socket-disconnected parity, eviction/reattachment, offline document regeneration                 | Cache ranges, runtime precache, IDB upgrades and deletion journal                                           |
| Accounts, privacy and isolation           | Registration, sign-out/purge, peer revocation, incoming account, interrupted purge, session expiry and account deletion                            | Server owner scopes, atomic auth limits, account write fence; browser request-body checks for document text |
| Sync and conflict recovery                | Real PostgreSQL + browser outbox, socket failures, retries, two devices, UI offline edit and reconnect                                             | Fuzz uses production engine calls directly, not UI clicks for every operation                               |
| Export and deletion                       | UI downloads metadata JSON; book/account delete; lost-response and stale-tab deletion scenarios                                                    | Idempotent deletion and local media cleanup tests                                                           |
| Diagnostics                               | Settings resume diagnostics displayed; chapter warning visible; resume rows preserve independent position samples                                  | No physical iOS background diagnostic validation                                                            |

## Scope limits and tradeoffs

- Production Next standalone server and real pinned Chromium/WebKit engines were
  used. These are desktop browser tests with mobile viewport emulation, not a
  physical iPhone or an installed iOS home-screen PWA.
- The pinned WebKit persistent context fails its Cache Storage probe; launch
  performance therefore uses calibrated Chromium. WebKit resume tests restore
  harness snapshots when that engine discards its fixture media. Those tests
  grade position durability, not operating-system retention of audio bytes.
- The two genuine hidden/background T1 rows remain explicitly uncovered. The
  executable CI matrix excludes only those rows. Synthetic pagehide callbacks,
  real process kills and reloads are distinguished in each recorded resume row.
- Some persistent WebKit resume-fixture openings need the harness's existing
  second tap. The row notes disclose this; they do not prove one-tap navigation.
  Its historical comment blamed a library `router.refresh()` that no longer
  exists, so that explanation was corrected. The cause is unresolved. Ordinary
  nonpersistent PWA/parity journeys separately exercise single-click navigation.
- Narration measurements use short fixtures. No multi-hour document, phone
  thermal/battery benchmark, or physical-device peak memory result is claimed.
  Backend selection (WebGPU versus WASM) was not separately forced and measured.
- CDP heap values are main-page snapshots without forced garbage collection;
  they exclude workers, WASM and process memory. They vary with collection timing
  and do not establish a memory reduction. Raw before/after values are retained.
- Metadata synchronizes; audio and source files remain on the importing device.
  Legacy missing narration cannot be regenerated under another engine's identity.
  These are existing ownership/timing constraints, now surfaced explicitly.
- There is no schema migration, model/voice change, or stored rendition rewrite.
  Existing skip, speed, rewind, autoplay and storage defaults are unchanged.
  The implementation commits can be reverted without a data migration; no
  rollback or destructive data cleanup was performed during this task.
- No Forge messaging tool is available in this host session. The final response
  is the Forge handoff; no board state or other messaging service is used.

## Reproduction and handoff

Local commits:

- `7e51d09` — Record reproducible mbp-old production baseline.
- `f8d0d12` — Simplify local narration and library reads.
- `be79d4e` — Keep library snapshots fresh and verify edge cases.
- `4964071` — Make browser evidence reproducible and precise.
- The final documentation/evidence commit is recorded in
  `.data/objective/commits.log` and the final handoff. Source/build metrics
  identify the implementation they measured.

The local standalone server on port 3000 and disposable database on port 54329
remain available for the gate. The container is
`hark-objective-t99d8ece2-postgres`, managed by
`.data/objective/compose.yml`; it is separate from any personal library.
No cleanup gate, independent Claude review, or board-state change was performed.

Run from this checkout on `mbp-old`. The existing `.env.test` selects only the
isolated localhost database; Playwright and the standalone launcher reject
hosted database targets. Keep that guard enabled. Do not substitute a running
server connected to Michael's library.

```sh
NODE_OPTIONS=--no-experimental-webstorage node --env-file=.env.test scripts/record-check.mjs .data/objective/recheck/quick pnpm verify:quick
HARK_REQUIRE_LOCAL_DB=1 NODE_OPTIONS=--no-experimental-webstorage node scripts/run-standalone.mjs
```

In a second shell, use the recorded browser commands with
`PLAYWRIGHT_BROWSERS_PATH=.data/objective/browsers HARK_REUSE_SERVER=1`. Keep the
browser suites sequential. The account limiter is deliberately active; retrying
whole suites immediately can require its normal idle window. The 1,000-book
launch fixture seeds the disposable account used by the library measurement.
Run `node scripts/measure-source.mjs <output.json>` after the build and
`node scripts/measure-browser.mjs final core` / `final library` for the same
fixtures and measurement protocol as baseline. Save existing evidence before
reusing an output path.

The following are **recommended bounded read-only checks for Forge's cleanup
gate**, not a cleanup or reviewer run performed by this implementer:

```sh
git status --short
git diff --check 0e1f17e HEAD
git diff --name-status 0e1f17e HEAD
git ls-files -- .data .env.test test-results
rg -n -i 'lemonade|narration-preview|narrating-client|/narrating' src tests docs README.md
du -sh .data/objective .next test-results
docker compose -p hark-objective-t99d8ece2 -f .data/objective/compose.yml ps
```

The tracked-file check should return no disposable artifacts or `.env.test`.
The text search may find the explicit legacy-identity regression fixture and
this evidence record; it should find no retired client, detector, setting or
preview implementation. Preserve `.data/objective` until the independent review
has consumed its raw outcomes and screenshots. Removal of generated artifacts,
test containers or volumes belongs to the authorized cleanup gate. No global
prune, unrelated checkout, real library or account cleanup is proposed.
