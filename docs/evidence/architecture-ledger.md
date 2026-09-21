# Hark simplification evidence

Objective checkout: `/Users/michaelchen/.hermes/kanban/workspaces/t_99d8ece2/hark`.
Hostname verified first: `mbp-old`. Baseline: `0e1f17eb18ce6a07c6d55c1790c860099a490932`.
Branch: `task/t_99d8ece2-hark`. One implementer, ordinary turns, no goal mode or delegation.
No push, PR, merge, deployment, board edits, cleanup gate, or independent review executed by this implementer.

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

The original implementation source snapshot is `4964071` (test/tooling-only follow-up to the
unchanged `be79d4e` application). Both phases use the same source scanner,
ESLint complexity settings, browser scripts, fixtures and production mode.
Browser runs are sequential, with no concurrent build or test load.

These historical tables and raw browser benchmarks remain unchanged. Cleanup
later changed three application files. The bounded review-fix section below
records fresh source/build metrics and browser regression results separately;
the original browser timings are not measurements of the later candidate.

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

## Bounded review-fix round — 21 September 2026

Incoming review candidate: `996e173`, after external cleanup implementation
`b323d7e` (three application files), cleanup-report-only commit `166820e`,
formatting correction `3631a6b`, and the recorded cleanup rerun.
Forge reported its cleanup gate passed and the independent Claude review found
seven minor findings, no blockers. This implementer read **all** of
`../review/REVIEW.md`; its unchanged contents are also preserved in
`.data/objective/review-fixes/original-review.md`. The external review and gate
are external outcomes, not checks claimed as executed here.

Hostname was verified first again: **mbp-old**. This round used ordinary turns,
one implementer, no agents, native goals, external review, board action, push,
PR, merge, deployment, or personal-library access. The application and test
candidate is local commit **`5d38ce6`**, “Address bounded review findings with
regression coverage.” Subsequent handoff edits affect documentation/evidence
only. The final documentation commit is identified in the handoff and local
commit history rather than embedding a self-referential commit hash here.

### Disposition of every finding

| Finding                             | Bounded correction                                                                                                                                                                        | Regression/evidence                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — measurement provenance          | Preserve original benchmark values and name `be79d4e` in README/architecture. Measure the actual post-cleanup/fix application and build separately.                                       | [Fresh source summary](review-fixes-source.json); raw `review-fixes/source-metrics.json`; verified build provenance below. No new startup/heap/search performance claim.                                                                                                                             |
| 2 — privacy oracle                  | Observe request URLs and `postDataBuffer()` from before authentication; also capture raw socket request URLs/bodies below service workers. Check decoded URL text as well as raw content. | Each consecutive WebKit run captured 99 wire requests, 11 nonempty bodies and 258 browser observations. Real GET-query, JSON, Blob, multipart and sendBeacon positive controls all reached the socket; six document formats narrated locally without the protected source text in captured requests. |
| 3 — missing static contract         | Restore the original `one-library.spec.ts` unchanged from `0e1f17e`. Its static checks cover dead obsolete files/imports, route assertions and scanner positive controls.                 | Both static guards run in the parity project. The earlier pruning rationale covered rendered behavior only and was incomplete; restoration introduces no product feature.                                                                                                                            |
| 4 — repeatable accounts/rate budget | Use one dedicated reusable account, the shared stable `.111` allocation, existing scoped fixture reset and persisted sign-in budget. Surface HTTP 429 explicitly.                         | Two consecutive complete iPhone WebKit runs passed 6/6 each. Second run reused the account and waited 57 seconds for a real idle window. Account-deletion coverage necessarily deletes/recreates that one disposable identity; no auth bucket was reset or limiter disabled.                         |
| 5 — compatibility comments          | Correct the `searchText` comments in `db.ts` and `outbox.ts`. Keep the field, schema and existing writers for older open bundles.                                                         | Full types/unit/build gate; current search/filter coverage unchanged. No migration or user-data rewrite.                                                                                                                                                                                             |
| 6 — cancellation after commit       | Cancellation now enters checking and rereads durable local media. A late attachment completion cannot overwrite the resulting ready/missing/unavailable state.                            | Three component cases plus a real WebKit commit-boundary cancellation in both full runs. The latter uses actual parsing, IndexedDB, Cache Storage, service-worker ranges and decoder playback; no second file selection.                                                                             |
| 7 — account-fenced healing          | Assert account writability at entry, after opening the DB, and before committing. Abort a partial transaction and consume its abort rejection if a fence arrives during the write.        | Deletion, sign-out and mid-write fence cases leave no healing rows and still allow the other account to heal. Hook regression covers rejected heals on mount, focus and route return; its existing catch keeps those failures handled. Existing independent playback-field clock tests remain.       |

Correction following the independent re-review: the other-account healing
claim in finding 7 covers a user-scoped deletion fence or **pending/request**
sign-out fence. A **committed** sign-out fence blocks every account on the origin
until a later sign-in. It does not allow the other account to heal.

The mid-write and component failure scenarios use controlled unit boundaries;
they are **not** described as live-browser proofs. The cancellation browser
case patches the page-wide `IDBObjectStore.prototype.put` and
`BroadcastChannel.prototype.postMessage` methods, delegating to their originals.
The first adds a download-transaction completion listener; the second calls
the actual Cancel button at the post-commit library signal, before the
attachment promise returns, then restores both prototypes. This schedules a
deterministic microtask boundary; it does not demonstrate that an unaided human
click can hit that window. The component test instead uses an ordinary
`fireEvent.click` with a deferred storage promise. The browser's positive oracle requires that the
download transaction completed. Both runs then obtained HTTP **206** with
**1,024 bytes** from that committed audio URL, checked the player's URL, and
observed real decoder time advance. No synthetic media events or fake media
records substitute for playback. The cancellation screenshot was visually
inspected alongside the narrated-library screenshot.

The privacy controls send disposable sentinel strings only to the local,
read-only pull endpoint; unsupported POSTs exercise transport capture. Raw
request contents stay in memory, and the durable capture summary stores counts
and control outcomes, not credentials or auth bodies. This checks the actual
fixture text in observed URLs/bodies; it is not a proof against every possible
encoding or external transport.

### Candidate, environment and exact outcomes

The owned port `3000` server was absent before this round. PID **76083** was
started from this checkout after the quick gate using `.env.test`,
`HARK_REQUIRE_LOCAL_DB=1`, and the disposable localhost database on **54329**.
The unchanged review scratch server on `3100` was never managed here.
`server-provenance.json`, `served-build.json` and `served-build-check.log`
record application/test commit `5d38ce6771599c49a9f9b7f075eda5fb198220df`, build
ID **`UVWgYSKhICG8soUoaBO35`**, the owned process working directory, matching HTML
build ID and all **60** served JS/CSS/WASM SHA-256 hashes. Fresh browser contexts
used this verified production PWA.

All raw prefixes in this section are relative to
`.data/objective/review-fixes/`; no earlier raw file or manifest was replaced.
Commands, start/end times, hostname, exit code and raw output are in each
prefix's `.json` / `.log`. Node 26 checks use
`NODE_OPTIONS=--no-experimental-webstorage`. Browser runs use the pinned
`PLAYWRIGHT_BROWSERS_PATH=.data/objective/browsers` and `HARK_REUSE_SERVER=1`.

| Check / raw prefix                     | Exact outcome                                                                                                                                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `red-unit`                             | Exit 1; 6 failed / 33 passed. Initial cancellation and sign-out reproductions; two deletion fixtures were initially malformed.                                                                                                |
| `green-unit`                           | Exit 1; 2 failed / 37 passed. Deletion fixtures still had the wrong shape; this was not a passing run despite its intended filename.                                                                                          |
| `types`                                | Exit 2; two TS2683 errors for the new test spy's missing `this` annotation.                                                                                                                                                   |
| `green-unit-v2`                        | Exit 0; 39 passed, after correcting fixture shape and spy annotation.                                                                                                                                                         |
| `red-unit-corrected-fixtures`          | Exit 1; 6 failed / 33 passed with corrected tests and the two production files temporarily restored from `996e173`. All three cancellation and all three fence cases reproduced. Production fixes were restored in `finally`. |
| `types-v2`, `lint`                     | Exit 0 each.                                                                                                                                                                                                                  |
| `quick`                                | Exit 0, 31.792 s; `pnpm verify:quick`: formatter, ESLint, types, **777 tests / 88 files**, production build and runtime precache.                                                                                             |
| `served-build-check`                   | Exit 0; exact build ID, process checkout and all 60 asset hashes verified.                                                                                                                                                    |
| `iphone-run-1`                         | Exit 0; **6 passed**, 48.047 s including runner startup.                                                                                                                                                                      |
| `iphone-run-2`                         | Exit 0; **6 passed**, 102.969 s including the required 57-second sign-in idle wait.                                                                                                                                           |
| `source-measurement`, `source-summary` | Exit 0 each; same original source scanner and scope, new output paths.                                                                                                                                                        |
| `historical-preservation`              | Exit 0; all **311** historical artifact hashes and sizes matched, zero missing/changed files.                                                                                                                                 |

The first two iPhone commands were run consecutively, with no intervening
browser suite, bucket reset or limiter configuration change:

```sh
PLAYWRIGHT_BROWSERS_PATH=.data/objective/browsers HARK_REUSE_SERVER=1 NODE_OPTIONS=--no-experimental-webstorage node scripts/record-check.mjs .data/objective/review-fixes/iphone-run-1 pnpm exec playwright test --project=iphone-webkit --output=.data/objective/review-fixes/iphone-run-1-artifacts
PLAYWRIGHT_BROWSERS_PATH=.data/objective/browsers HARK_REUSE_SERVER=1 NODE_OPTIONS=--no-experimental-webstorage node scripts/record-check.mjs .data/objective/review-fixes/iphone-run-2 pnpm exec playwright test --project=iphone-webkit --output=.data/objective/review-fixes/iphone-run-2-artifacts
```

Use **new output prefixes** to reproduce any command; Playwright replaces its
output directory. Each run's narration timings are diagnostic artifacts only,
not comparable replacements for the original calibrated benchmark.

### Fresh final-source measurements, separate from the original browser benchmark

Measured application/test source: `5d38ce6`. Build: `UVWgYSKhICG8soUoaBO35`.
The original `scripts/measure-source.mjs` method and full app scope are unchanged:
all non-test `src` TS/TSX plus authored `public/sw.js`, with token-occupied code
lines excluding comments/blanks and classic ESLint cyclomatic complexity.
Tests/harness, CSS and generated Drizzle snapshots remain separate. All
per-function and asset entries are in the new raw source report. The committed
[summary](review-fixes-source.json) is generated by
`.data/objective/review-fixes/summarize-source.mjs`.

| Metric                             | Original baseline `0e1f17e` | Final source `5d38ce6` |
| ---------------------------------- | --------------------------: | ---------------------: |
| App files                          |                         185 |                    178 |
| App physical lines                 |                      28,134 |                 27,274 |
| App token-occupied code lines      |                      23,950 |                 23,226 |
| App function complexity sum        |                       5,623 |                  5,452 |
| Retained library subset complexity |                         357 |                    329 |
| App functions                      |                       1,810 |                  1,745 |
| Maximum function complexity        |                          70 |                     70 |
| Functions with complexity above 10 |                          84 |                     79 |
| Tests/harness physical lines       |                      35,655 |                 36,265 |
| Tests/harness code lines           |                      32,148 |                 32,802 |
| CSS physical lines                 |                       3,249 |                  3,149 |
| Generated Drizzle JSON lines       |                      58,251 |                 58,251 |
| All build JS/CSS/WASM bytes        |                  28,550,966 |             28,540,391 |
| Sum of individually gzipped assets |                   7,559,946 |              7,555,774 |

Compared with the reviewer's source measurements at `996e173` (23,217 app code
lines, complexity 5,450, retained subset 328), this round adds nine app code
lines and two complexity points. The extra branches implement the requested
safe cancellation/fencing behavior. The original startup/search/heap/import
performance values remain attached to `be79d4e` / source snapshot `4964071`;
there is **no refreshed comparable browser-performance measurement** in this
bounded fix round. Functional regression durations do not establish a speedup
or memory improvement.

### Retained-feature coverage refreshed in this round

The original detailed coverage matrix above remains historical. These are the
new candidate's checks; unit fault injection and static scans are distinguished
from production-PWA journeys.

| Retained workflow / state                                | New candidate evidence                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading, empty, unreachable, recovery                    | Both iPhone runs: socket-held first sync, slow notice, disconnect, retry and recovered empty library; screenshots `first-sync-loading`, `first-sync-unreachable`, `first-sync-recovered`.                                                                                     |
| MP3 import, offline relaunch/playback, reattachment      | Both iPhone runs: original Downloads journey plus real post-commit attachment cancellation; range bytes and player URL in `committed-attachment.json`. Parity covers cold/missing-media routes.                                                                               |
| Document import and completed-book playback              | Both iPhone runs: TXT, Markdown, HTML, PDF, DOCX, EPUB through real extraction/Kestrel/encoding; narration cancellation; no playable book until completion. Privacy positive controls and `privacy-capture.json`.                                                             |
| Legacy rendition and timing integrity                    | Both iPhone runs: disposable completed rendition relabelled as legacy, still plays while saved audio exists, refuses regeneration after removal, chapter rows and legacy key unchanged. Existing regeneration parity also runs.                                               |
| Chapters, skips, speed, sleep timer, history, transcript | Both retained-player journeys drive actual controls and decoder playback; screenshots `player`, `transcript`. Timer pauses at the real chapter boundary.                                                                                                                      |
| Tags, organization, archive, collections/autoplay        | Both retained-player journeys and cross-tab filter journeys; committed edits appear on the next filter. Screenshots `collection-autoplay`, `filter-after-another-tab-edit`.                                                                                                   |
| Smart rewind, preferences, diagnostics, export/deletion  | Both retained-player journeys set/persist settings, show diagnostics, export actual metadata, delete a book and delete the dedicated disposable account. `metadata-export.json` and `settings-diagnostics.png`. Rewind persistence/behavior also remains in the resume suite. |
| Account isolation, purge, sign-out, expiry               | Parity suite exercises real account transitions, playing peers and late responses. Unit fence cases check healing rollback and another account's independent state; hook test verifies rejected heal promises are handled.                                                    |
| One library, online/offline controls                     | Actual parity and navigation journeys plus two separately identified static guards for obsolete repository residue.                                                                                                                                                           |
| Sync clocks, outbox, restart and resume durability       | Existing sync and resume suites run against the same verified build; results and any limitations are recorded in the final outcome below.                                                                                                                                     |

Screenshot/JSON directories under `review-fixes/`:

- `iphone-run-1-artifacts/` and `iphone-run-2-artifacts/`: all new journey captures,
  source fixtures, export metadata, narration durations and privacy/cancellation
  summaries. These two sets are independent consecutive runs.
- Within either run, `retained-workflows-cancell-2795d-t-without-choosing-it-again-iphone-webkit/committed-attachment-after-cancel.png`
  shows the recovered player without another attachment; the neighboring JSON
  records the successful media range.
- `retained-workflows-real-do-271b3--preserve-legacy-identities-iphone-webkit/`
  contains `six-document-formats.png`, `legacy-rendition-refused.png` and
  `privacy-capture.json`.
- `parity-screenshots/`: preserved copies of the newly generated phone/desktop,
  online/offline and missing-download screenshots. The historical copies and
  all 311 original artifact hashes remain intact.

### Standing limitations and fixes-only handoff

This round is desktop browser automation, not a physical iPhone/lock-screen,
background-audio, battery or sustained long-document thermal verification.
The two `T1 hidden (online|offline)` cases remain excluded exactly as in the
existing CI resume command. Persistent WebKit Cache Storage limitations and the
resume harness's disclosed fixture-restoration/second-tap behavior remain as
recorded above. No comparable launch, heap or responsiveness benchmark was
rerun; the original measurements retain their original provenance.

The local test server and isolated database remain available for Forge. Do not
alter the independent scratch server on `3100`, reset auth buckets, remove
`.data/objective`, overwrite existing evidence prefixes, or touch Michael's
library. Read-only bounded checks for the external fixes-only re-review are:

```sh
git status --short
git log --oneline 996e173..HEAD
git diff --check 996e173 HEAD
git diff -w 996e173 HEAD -- src/components/player/local-media-gate.tsx src/lib/offline/mirror.ts src/lib/offline/db.ts src/lib/offline/outbox.ts
git diff 0e1f17e HEAD -- tests/parity/one-library.spec.ts
cat .data/objective/review-fixes/quick.json
cat .data/objective/review-fixes/iphone-run-1.json
cat .data/objective/review-fixes/iphone-run-2.json
cat .data/objective/review-fixes/integrity.json
cat .data/objective/review-fixes/integrity-final.json
```

The static-guard diff should be empty. The implementer does not run the cleanup
gate or independent reviewer and will pause for the authorized fixes-only
external re-review after the final outcomes are recorded. No additional fix
round is assumed.

### Integrity-run diagnostic and preserved interruption

The initial `integrity` run used the default retained tracing. It completed
**41 checks**, then was deliberately interrupted with SIGINT at the five-cycle
smart-rewind case: **exit 130**, **1 interrupted**, **47 did not run**, elapsed
**1,318.019 s**. This is not a passing full gate and the interrupted case is not
counted as passed even though its measurement row was emitted during shutdown.
The command outcome, partial resume rows, interruption reason, screenshot and
trace ZIP remain under `review-fixes/integrity*` and `resume-rows.jsonl`.

`trace-progress-diagnostic.json` records only call names/times, not request
contents. It showed browser evaluation calls growing to approximately 1.2–1.4
seconds each during repeated persistent-context restarts. That motivated an
artifact-capture alternative; it does not establish a production performance
regression or prove tracing was the sole cause. Only the verified owned runner
PID was interrupted; the app server and independent review server were left
alone. The replacement `integrity-final` run uses the original successful
implementation-gate option `--trace=off`, with **identical tests, exclusions,
assertions and thresholds**, and fresh output/JSONL paths. Both attempts are
preserved; no test was skipped to obtain a green result.

### Final outcome of this bounded fix round

`integrity-final`: **exit 0**, **89 passed** in **919.031 s** including runner
startup — **33 parity**, **24 resume-durability**, **32 sync** checks. This is the
completed replacement gate, distinct from the interrupted traced attempt.
The parity count includes the two restored static guards; suite counts are not
claims that every assertion is a live UI interaction. All 22 emitted resume
measurement rows name build `UVWgYSKhICG8soUoaBO35`. Final-run T6 hard-kill loss
was **128 ms** against the unchanged **1,000 ms** bar; T7 pagehide loss was
**131 ms** against **250 ms**. All four repeated-open scenarios had zero total
drift. The original raw performance benchmark is still separate.

Exact completed integrity command:

```sh
node scripts/record-check.mjs .data/objective/review-fixes/integrity-final env PLAYWRIGHT_BROWSERS_PATH=.data/objective/browsers HARK_REUSE_SERVER=1 NODE_OPTIONS=--no-experimental-webstorage HARK_RESUME_LEDGER=.data/objective/review-fixes/resume-final-rows.jsonl pnpm exec playwright test --project=parity --project=sync --project=resume-durability '--grep-invert=T1 hidden (online|offline)' --trace=off --output=.data/objective/review-fixes/integrity-final-artifacts
```

`parity-final-screenshots/` preserves the replacement run's captures alongside
the initial run's `parity-screenshots/`. `resume-final-rows.jsonl` is the completed
run's measurement stream; `resume-rows.jsonl` belongs to the interrupted run.
Neither was overwritten. The new
[artifact manifest](review-fixes-artifacts.json) indexes this round's durable
outputs, reproduction helpers and failures. It excludes the live server log;
`server-captured.log` is its frozen handoff snapshot. The original artifact
manifest is unchanged and all 311 of its entries were verified.

All seven findings are addressed. No product defect remains unresolved from
this bounded round; the standing platform/measurement limitations above remain.
The application and tests have not changed since the successful full quick gate
at `5d38ce6`. Final documentation/evidence formatting and source-identity checks
are captured under `handoff-format`, `source-unchanged`, `static-guard-restored`
and `handoff-diff-check`. Those checks verify the handoff without rebuilding or
making the already verified local server stale.

Local implementation commit: **`5d38ce6`**. The subsequent one-line local
hand-off commit is reported with its exact ID in the final response. The
implementer now pauses for Forge's **fixes-only independent external re-review**;
no cleanup/review or board action is performed here.

## Additional authorized residual-finding round

Michael's “another round of hark” authorized this bounded continuation from
`e9feaee`. Hostname was verified first as **mbp-old**; the checkout was clean.
The complete independent re-review is preserved at
`.data/objective/residual-fixes/rereview-input.md`. This is implementation and
verification evidence, not an independent review. No goal mode, subagents,
reviewer execution, board actions, remote commits or deployments were used.
Reviewer-owned port `3100` was not changed.

### S1–S6 dispositions

| Finding                     | Correction and regression protection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 — cancel/autoplay        | Cancel suppresses autoplay for that account/book while rereading durable availability. Other books/accounts retain their own autoplay intent. Component tests cover committed/missing/unavailable cancellation, late completion, normal attachment, already-saved autoplay and changed book/account scope. The real browser case opens `?autoplay=1`, cancels after commit, requires zero `play()` calls, paused time zero, HTTP 206/1,024 bytes from that same media, then one manual Play and advancing decoder time without another attachment. The separate collection journey requires actual decoder advancement in the next book without a second Play click. |
| S2 — evidence accuracy      | The prior section now names the two native prototype wrappers and their limits, distinguishes pending user-scoped from committed origin-wide sign-out fences, and attributes application cleanup to `b323d7e`. `166820e` recorded the cleanup report only; it did not change application files. Every historical failure/outcome remains.                                                                                                                                                                                                                                                                                                                            |
| S3 — defensive assertions   | Retain all three original guards and pin each independently. New tests model a fence at entry or during database opening, followed by a later sign-in clearing it. Removing either early guard wrongly admits and commits the stale heal; removing the final guard admits a fence installed during the write. Each individual mutant fails one case. The final healing implementation is byte-identical to `e9feaee`.                                                                                                                                                                                                                                                |
| S4 — repeated signup budget | The retained suite reads its actual Postgres sign-in and signup buckets under stable `.111` before each request, rechecks after a wait, and extends the test timeout by any required idle wait. It never resets or reserves a bucket, disables a limiter, or rotates IPs. Account deletion/recreation remains in every full run. Four fake-clock cases cover unused/expired buckets, the sixth signup, the ninth sign-in and an intervening spender; these are bounded unit checks, not six live full-suite runs.                                                                                                                                                    |
| S5 — retained credentials   | A read-only preflight verifies only `retained-workflows@hark.test` against its existing credential hash before any content reset. A mismatch produces instructions to restore the matching env backup or use a separately provisioned new disposable DB/env, without printing a password/hash. The browser supplies a different ephemeral password to the retained account and gets real HTTP 401, checks the diagnostic and unchanged fixture book IDs, then logs in with the correct credentials. No env file, stored credential, database or volume is reset to simulate this condition.                                                                          |
| S6 — privacy calibration    | A separate browser test sends sentinel-only traffic between two owned loopback origins. Its wire collector observes an encoded GET query and JSON, string, Blob, multipart, beacon and service-worker POST bodies. The browser channel has its own required URL and JSON-body positive controls. Actual observations expose the Blob-body and worker-event gaps described below. Six real document imports retain app-origin wire inspection and limited browser URL/body inspection.                                                                                                                                                                                |

### Safety and instrumentation boundaries

The initial S3 simplification was withdrawn before handoff. Its reasoning had
missed fence lifetime: a later sign-in can reopen the origin while a job is
awaiting IndexedDB. The final transaction check cannot retroactively reject a
job admitted while an earlier fence was active. All three original checks are
therefore retained, and the healing source again exactly matches `e9feaee`.

Two new unit cases use surviving local playback registers and the real
`reopenAccountAfterSignIn` operation with fake IndexedDB. The entry case reopens
a committed origin-wide fence after calling heal. The post-open case defers
`database()` and wraps/delegates `IDBObjectStore.get` to reopen the fence if the
job wrongly reaches the transaction. Each would commit a row without its
corresponding guard. The restored implementation rejects with the sign-out
error and leaves playback/download stores empty. A third, existing mid-write
case independently kills removal of the final assertion. These are controlled
unit boundaries, not claims of a live-browser sign-in race. The pending-row and
committed-origin-fence cases remain, as does hook coverage for handled rejected
heals. No production account-isolation defense was removed in the final diff.
The original guard-removal experiment and every failing mutation are preserved.

The cancellation browser case wraps **page-wide**
`IDBObjectStore.prototype.put` to observe the real download transaction's
`complete` event and `BroadcastChannel.prototype.postMessage` to call the real
Cancel button at the ensuing library-change notification. Both wrappers delegate
to the originals and restore them when Cancel fires. They schedule a narrow
post-commit/pre-promise-return boundary; this is not an unaided human-click
reproduction. This round also wraps `HTMLMediaElement.prototype.play`, counting
and delegating every call until the disposable page is closed. That detects even
attempts rejected by browser autoplay policy; a paused element alone would not.
The subsequent manual Play is its positive control. Parsing, IDB records, Cache
Storage, service-worker ranges and decoder playback remain real. The component
oracle uses a deferred mocked storage promise and a normal `fireEvent.click`,
which is a separate kind of evidence.

Privacy wire capture in the document test covers **only the app-origin proxy**.
For other destinations, `BrowserContext.on('request')` exposes only what the
pinned engine reports. The executed cross-origin control on WebKit 26.5 observed
all six POST bodies on the loopback socket, but `postDataBuffer()` omitted the
Blob body and no context request event appeared for the worker fetch. JSON,
string, multipart and beacon bodies were visible. The test worker belongs to a
separate disposable loopback fixture, not the production PWA. Its collector is
not a sniffer for arbitrary app destinations. We make no absence claim for
arbitrary cross-origin Blob/SW traffic, unobserved transports, encoded/encrypted
payloads or binary audio. Captured production-fixture text was absent from the
observed raw/URL-decoded values. Auth bodies remain in memory; durable artifacts
contain counts and sentinel outcomes, never credentials. Complementary checks
include real offline document regeneration with the backend socket removed,
MP3 transcript privacy units, and source inspection: document import contains
no transport call, model download uses pinned asset URLs with credential-free
GETs for remote weights, and the production SW handles only same-origin GETs.

The credential test reproduces the retained-DB/different-password condition by
passing an ephemeral different value; it does not actually regenerate
`.env.test`, change a stored password, or test automated credential recovery.
The implemented response is actionable fail-fast diagnosis. It is restricted
to one clearly disposable fixture; this round does not retrofit all other
projects' existing account helpers. The budget reader likewise belongs to the
serial retained suite; other projects retain their existing stable-IP budgeting.
Exhausted signup behavior is checked with a fake clock, avoiding a gratuitous
ten-minute live wait. Real consecutive browser runs and bucket snapshots test
the live integration; they do not establish arbitrary concurrent-worker safety.

### Final source and build provenance

Application/test candidate: **`0bdf543`**. Owned server PID **2512**, origin
`http://localhost:3000`, build **`VofujEzfQgMxrf_Udli6u`**, loaded from `.env.test`
with the local-database guard and the existing disposable DB at
`127.0.0.1:54329`. Only previously verified owned PIDs `76083`, `27878` and `39342`
were stopped. Verification checked the process working directory, root and
standalone build IDs, served HTML build ID and SHA-256 equality for all **60**
served JS/CSS/WASM assets. See `server-handoff-provenance.json`,
`served-build-handoff.json` and `served-build-handoff-check.{json,log}` under
`.data/objective/residual-fixes/`. Earlier `6aae383` and `31eae01` builds and
measurements remain explicitly labeled intermediate evidence.

Fresh measurements use the unchanged `scripts/measure-source.mjs` scope and
method. An exact `git archive e9feaee` snapshot provides the round comparison;
its helper removes only its own newly created temporary source snapshot. The
round-baseline bundle is the preserved `UVWgYSKhICG8soUoaBO35` build, whose app
source is identical at `5d38ce6` and `e9feaee`. Complete source/function/asset
measurements are in `round-baseline-source.json` and `source-metrics-handoff.json`;
the tracked summary is [residual-fixes-source.json](residual-fixes-source.json).

| Metric                                | Original `0e1f17e` | Round baseline `e9feaee` | Final `0bdf543` |
| ------------------------------------- | -----------------: | -----------------------: | --------------: |
| App files                             |                185 |                      178 |             178 |
| App physical lines                    |             28,134 |                   27,274 |          27,280 |
| App token-occupied code lines         |             23,950 |                   23,226 |          23,232 |
| App classic cyclomatic complexity sum |              5,623 |                    5,452 |           5,456 |
| Retained library subset complexity    |                357 |                      329 |             329 |
| App functions                         |              1,810 |                    1,745 |           1,745 |
| Maximum function complexity           |                 70 |                       70 |              70 |
| Functions above complexity 10         |                 84 |                       79 |              79 |
| Tests/harness physical lines          |             35,655 |                   36,265 |          36,759 |
| Tests/harness code lines              |             32,148 |                   32,802 |          33,283 |
| CSS physical lines                    |              3,249 |                    3,149 |           3,149 |
| Generated Drizzle JSON physical lines |             58,251 |                   58,251 |          58,251 |

Final complete static bundle: **28,540,479 raw bytes / 7,555,810 individually
gzipped bytes**, 60 files. Relative to this round's baseline: **+88 raw bytes,
+36 gzip bytes**. This is all emitted static code, not initial transfer. The
small source/complexity increase pays for account/book-scoped autoplay
cancellation; no new startup, responsiveness, memory, import, narration or
playback performance improvement is claimed. The original calibrated browser
benchmark remains attributed to **`be79d4e`**, with its separate original source
snapshot at `4964071`. New browser timings are functional-test diagnostics only.

### Exact outcomes and preserved failures

All prefixes below are under `.data/objective/residual-fixes/`. Each recorded
command has a `.json` receipt (argv, cwd, hostname, UTC times, elapsed time,
exit code) and an unedited combined `.log`. Use new prefixes and Playwright
output directories on rerun so earlier outcomes remain intact.

| Prefix                                                                      | Exact result and interpretation                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline-unit`                                                             | Exit 0, **34 tests / 2 files**. The requested hook path was wrong and unmatched, so this baseline did not include hook tests. Later focused and full gates use the actual hook path.                                                                                                                                                   |
| `baseline-source`                                                           | Exit 0; measurement summary retained in the log. An output-name collision let the command receipt replace its detailed measurement JSON. This is not the authoritative baseline.                                                                                                                                                       |
| `baseline-source-rerun`                                                     | Exit 0; app scope unchanged but this scan overlapped test-only edits. Not used for the tests baseline.                                                                                                                                                                                                                                 |
| `baseline-exact`                                                            | Exit 0, 2.503 s. Exact archived `e9feaee` app/tests scope measured with the original scanner; authoritative round baseline.                                                                                                                                                                                                            |
| `s1-red`                                                                    | Exit 1, **1 failed / 4 passed** against the original gate: cancellation passed `autoplay=true`. Expected regression reproduction.                                                                                                                                                                                                      |
| `focused-unit`, `focused-unit-final`                                        | Exit 0 each, **47 tests / 4 files**, including the correct library hook test file.                                                                                                                                                                                                                                                     |
| `types`                                                                     | Exit 0.                                                                                                                                                                                                                                                                                                                                |
| `mutation-commit-guard`                                                     | Exit 1, **4 failed / 3 passed / 26 skipped** when the remaining healing commit assertion is removed. Mutated source restored exactly.                                                                                                                                                                                                  |
| `mutation-normalization-lock`                                               | Exit 1, **1 failed / 6 passed / 26 skipped** when normalization draining bypasses the account lock. Its pending row is lost; source restored exactly.                                                                                                                                                                                  |
| `quick`                                                                     | Exit 1, 33.200 s. Format/lint/types and **785 tests / 89 files** passed; build then failed because `DATABASE_URL` and `BETTER_AUTH_SECRET` were absent from the invocation.                                                                                                                                                            |
| `server-start-failure.json`, `server.log`                                   | Premature start after that failed build: missing `.next/BUILD_ID`, then `ERR_MODULE_NOT_FOUND` for standalone `server.js`. No listener remained. The combined shell's following copy command exited 0; that is explicitly not a successful server start.                                                                               |
| `quick-with-env`                                                            | Exit 0, 32.203 s, full quick gate at `34a77f2` using the explicit test-env wrapper.                                                                                                                                                                                                                                                    |
| `quick-final`                                                               | Exit 0, 32.701 s, full quick gate at `6aae383`.                                                                                                                                                                                                                                                                                        |
| `iphone-run-1`                                                              | Exit 1, 63.892 s, **6 passed / 2 failed** at `6aae383`. One harness assertion demanded decoded data before Play although metadata preload correctly yielded ready state 1. The direct auth probe lacked Origin and returned 403 before password validation. The chained second run did not execute. Screenshots/error contexts remain. |
| `browser-targeted`                                                          | Exit 0, 65.111 s, **2 passed** after those harness corrections, including a real 60-second sign-in-budget wait. Served app remained `6aae383`; only the two browser assertions changed, subsequently committed as `31eae01`.                                                                                                           |
| `quick-final-v2`                                                            | Exit 0, **32.865 s**, full format/lint/types/**785 tests in 89 files**/production-build gate at intermediate `31eae01`.                                                                                                                                                                                                                |
| `served-build-check`, `served-build-final-check`                            | Exit 0 each; verified the corresponding owned process, HTML/build ID and all 60 static hashes. Those checks identify the intermediate `6aae383` and `31eae01` builds; the later handoff check identifies `0bdf543`.                                                                                                                    |
| `iphone-final-1`                                                            | Exit 0, **8 passed**, 49.846 s including runner startup.                                                                                                                                                                                                                                                                               |
| `iphone-final-2`                                                            | Exit 0, **8 passed**, 78.127 s including a real **26-second** sign-in idle wait.                                                                                                                                                                                                                                                       |
| `auth-buckets-before-final`, `auth-buckets-final-1`, `auth-buckets-final-2` | Exit 0 each; read-only `.111` signup counts **1 → 2 → 3**, and sign-in counts **2 → 7 → 6** with real idle-window resets. Account deletion was exercised in both full runs.                                                                                                                                                            |
| `source-measurement-final`, `source-summary-final`                          | Exit 0 each; intermediate `31eae01` source/build metrics, distinct from historical browser benchmarks. Earlier `source-measurement`, `source-summary` and `source-summary-6aae383.json` remain as intermediate evidence.                                                                                                               |
| `historical-preservation`                                                   | Exit 0: all **311 original + 112 prior-fix** artifact hashes and byte sizes match, no missing/changed file.                                                                                                                                                                                                                            |

The first successful consecutive full browser commands (at `31eae01`) were:

```sh
node scripts/record-check.mjs .data/objective/residual-fixes/iphone-final-1 env PLAYWRIGHT_BROWSERS_PATH=.data/objective/browsers HARK_REUSE_SERVER=1 NODE_OPTIONS=--no-experimental-webstorage pnpm exec playwright test --project=iphone-webkit --trace=off --output=.data/objective/residual-fixes/iphone-final-1-artifacts
node scripts/record-check.mjs .data/objective/residual-fixes/iphone-final-2 env PLAYWRIGHT_BROWSERS_PATH=.data/objective/browsers HARK_REUSE_SERVER=1 NODE_OPTIONS=--no-experimental-webstorage pnpm exec playwright test --project=iphone-webkit --trace=off --output=.data/objective/residual-fixes/iphone-final-2-artifacts
```

Only a read-only budget snapshot ran between them. The real signup bucket was
not exhausted by these two runs: its boundary is covered by the bounded
fake-clock tests and existing real limiter contract tests, not a claimed live
sixth full-suite run. The broader parity limiter tests manage only their own
explicit `.77/.78/.79` probe rows; they do not clear the retained `.111` budget.

`consecutive-browser-summary.json` records both runs' exact artifact paths and
asserted outcomes. Each cancellation result has **zero** play calls after Cancel,
**one** after manual Play, committed-media HTTP **206 / 1,024 bytes**, and the same
player URL. Both collection controls navigated with `autoplay=1` and advanced the
next book's decoder without another Play click. Both credential controls received
**401**, retained the one fixture book and subsequently logged in successfully.
Each six-format document run captured **99 app-origin wire requests / 11 bodies**;
browser observations were **258** and **256** respectively, with the stated gaps.
Both cross-origin controls independently reproduced the same Blob/SW blind spots.

Screenshots are under each `iphone-final-*-artifacts` directory. Visual inspection
of the `31eae01` cancellation player, completed library and unreachable-first-sync
screens is recorded in `visual-inspection.json`, with exact paths. The library
screenshot paints four visible cards; all six formats are established by the
executed count assertions and `narration-times.json`, not that image alone.

The later, final-candidate outcomes are:

| Prefix                                                                                      | Exact result and interpretation                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrity-final`                                                                           | **Exit 1; 84 passed, 2 failed, 3 did not run**, 828.271 s, at intermediate `31eae01` / build `9EepwfWvsdfjxsnWyVXis`. Full parity + sync + supported resume-durability rows. Failures: account-purge setup had no `bookTags` canary; collection `updatedAt` moved backward. All 24 resume tests passed. |
| `integrity-collection`                                                                      | Exit 1: the evidence collector tried to parse a non-JSON resume log line. Raw failure preserved.                                                                                                                                                                                                        |
| `integrity-collection-v2`                                                                   | Exit 0: corrected collection of 22 actual resume-row artifacts and parity screenshots. `integrity-summary.json` explicitly records `passed: false`; successful collection does not turn the browser command into a pass.                                                                                |
| `parity-sync-retry`                                                                         | **Exit 1; 46 passed, 7 failed, 12 did not run**, 308.907 s, unchanged intermediate candidate. Exact failures and limits below.                                                                                                                                                                          |
| `database-clock`, `clock-source-inspection`, `timestamp-source-unchanged`                   | Exit 0 each. Read-only DB/host clock comparison and source inspection. No clock change or database reset. Relevant server timestamp code is unchanged from `e9feaee`.                                                                                                                                   |
| `fence-admission-red`                                                                       | Exit 1; **2 failed / 33 skipped** with the early guards absent. Each stale heal resolved with one committed row after a later sign-in reopened the fence. This disproved the initial simplification.                                                                                                    |
| `fence-admission-green`                                                                     | Exit 0; **40 tests / 2 files**, with all guards restored, including the handled-rejection library hook.                                                                                                                                                                                                 |
| `admission-mutation-entry`, `admission-mutation-database-open`, `admission-mutation-commit` | Exit 1 each; **1 failed / 8 passed / 26 skipped** independently. Each assertion has its own failing case; source restored exactly after each mutation.                                                                                                                                                  |
| `quick-handoff`                                                                             | **Exit 0**, 35.406 s, at final **`0bdf543`**. Full project formatting, lint, typecheck, **787 unit tests / 89 files**, production build.                                                                                                                                                                |
| `served-build-handoff-check`                                                                | Exit 0; owned PID 2512, build `VofujEzfQgMxrf_Udli6u`, served HTML and all **60** static asset hashes match the final candidate.                                                                                                                                                                        |
| `iphone-handoff-1`                                                                          | **Exit 0; 8 passed**, 47.441 s, final candidate/build.                                                                                                                                                                                                                                                  |
| `iphone-handoff-2`                                                                          | **Exit 0; 8 passed**, 77.673 s, final candidate/build, including a real **30-second** sign-in idle wait.                                                                                                                                                                                                |
| `auth-buckets-before-handoff`, `auth-buckets-handoff-1`, `auth-buckets-handoff-2`           | Exit 0 each. Read-only signup observations **absent → 1 → 2**, sign-in **absent → 7 → 6**. Both full runs retain actual account deletion and recreation.                                                                                                                                                |
| `browser-handoff-targets`                                                                   | **Exit 1; 5 passed / 1 failed**, 39.936 s, final candidate/build. Passed: late accepted progress after purge, playing-peer sign-out revocation, sync seed 20260102, tag edit, queued tag edge. Failed: collection timestamp ordering, again.                                                            |
| `browser-summary-handoff`                                                                   | Exit 0; asserted and collected both final iPhone receipts and raw JSON evidence into `handoff-browser-summary.json`.                                                                                                                                                                                    |
| `source-measurement-handoff`, `source-summary-handoff`, `source-scope-handoff`              | Exit 0 each. Final source metrics above. The only application file changed from this round's baseline is `src/components/player/local-media-gate.tsx`; the final healing implementation equals the baseline.                                                                                            |
| `historical-preservation-handoff`                                                           | Exit 0; all **423** previously indexed artifacts still match their historical sizes/hashes after the browser runs.                                                                                                                                                                                      |
| `privacy-source-path-failure`                                                               | Exit 2: a source-inspection query named nonexistent `src/lib/narration`. This reproduces the earlier unrecorded terminal query failure; its chained log search did not execute.                                                                                                                         |
| `privacy-source-inspection`                                                                 | Exit 0 using the real `src/lib/kestrel/assets.ts` path. Literal direct-transport scan of document import plus model-download and SW excerpts; limited source inspection, not a whole-program privacy proof.                                                                                             |

The early `mutation-commit-guard` and `mutation-normalization-lock` results above
belong to the withdrawn guard-removal experiment. They are retained history;
the three later `admission-mutation-*` results establish final guard coverage.
`ledger-before-fence-restoration.md` and `round-notes.md` preserve the superseded
reasoning. A progress update prematurely described the initial parity run as
passed before its final receipt; that was explicitly corrected. Only the final
receipt counts shown here are authoritative.

Final candidate commands (run serially, with only read-only bucket snapshots
between the two iPhone invocations):

```sh
node scripts/record-check.mjs .data/objective/residual-fixes/quick-handoff env NODE_OPTIONS=--no-experimental-webstorage node .data/objective/residual-fixes/with-test-env.mjs pnpm verify:quick
node scripts/record-check.mjs .data/objective/residual-fixes/iphone-handoff-1 env PLAYWRIGHT_BROWSERS_PATH=.data/objective/browsers HARK_REUSE_SERVER=1 NODE_OPTIONS=--no-experimental-webstorage pnpm exec playwright test --project=iphone-webkit --trace=off --output=.data/objective/residual-fixes/iphone-handoff-1-artifacts
node scripts/record-check.mjs .data/objective/residual-fixes/iphone-handoff-2 env PLAYWRIGHT_BROWSERS_PATH=.data/objective/browsers HARK_REUSE_SERVER=1 NODE_OPTIONS=--no-experimental-webstorage pnpm exec playwright test --project=iphone-webkit --trace=off --output=.data/objective/residual-fixes/iphone-handoff-2-artifacts
node scripts/record-check.mjs .data/objective/residual-fixes/browser-handoff-targets env PLAYWRIGHT_BROWSERS_PATH=.data/objective/browsers HARK_REUSE_SERVER=1 NODE_OPTIONS=--no-experimental-webstorage pnpm exec playwright test --project=parity --project=sync --trace=off '--grep=a late accepted progress response|signing out in one tab|a collection membership change|a tag change|a tag EDGE|seed 20260102' --output=.data/objective/residual-fixes/browser-handoff-targets-artifacts
```

`handoff-browser-summary.json` pins **`0bdf543`** and the final build. Both final
cancellation cases have zero automatic `play()` calls and one successful manual
call; both collection controls advance the next book; both credential controls
get 401, retain one book and accept the original credentials afterward. Each
document run observes **99 app-origin wire requests / 11 bodies**; browser request
counts are **270 / 256**. Both cross-origin controls observe every sentinel at
the loopback receiver and reproduce the Blob-body and SW-event gaps. These
counts do not imply coverage outside the stated channels. Final screenshots
and observations are recorded in `visual-inspection-handoff.json`.

### Retained-feature coverage and unresolved browser outcomes

| Retained workflow or state                                                                   | This round's evidence and limits                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MP3 import, playback, seek, offline relaunch                                                 | Passed in both final full iPhone runs, using actual local media and decoder playback. Playwright WebKit with iPhone emulation is not a physical iPhone/Home Screen certification.                                                                                                                                                          |
| Chapters, skips, speed, history, transcripts, sleep timer                                    | Passed twice on the final candidate. End-of-chapter sleep uses actual decoder advancement; position and speed survive reload. The transcript fixture contains embedded text.                                                                                                                                                               |
| Smart rewind and durable resume                                                              | Settings persistence passed twice on final candidate. The broader run at `31eae01` passed all **24** supported resume tests / **22** scenario rows. T6 observed 187 ms drift against a 1,000 ms bound; T7 157 ms against 250 ms; C1–C4 reported zero accumulated player/shelf drift. No fresh full resume run after the fence restoration. |
| Six document formats, completed-only playback, cancellation, regeneration, legacy identities | Passed twice on the final candidate, including the real local narration path, offline regeneration and refusal of incompatible legacy rendition timing. No cloud document/audio upload.                                                                                                                                                    |
| Tags, archive/unarchive, collections, collection autoplay                                    | Passed twice through the final iPhone UI, including next-book decoder advancement without another Play. The separate incremental-sync collection timestamp test remains **failing**.                                                                                                                                                       |
| Loading, empty, unreachable, import while sync is stalled, recovery                          | Passed twice on the final candidate; screenshots preserve the distinct UI states.                                                                                                                                                                                                                                                          |
| Export, book deletion, account deletion/recreation, settings/diagnostics                     | Passed twice on the final candidate with disposable accounts; actual deletion coverage remains. No existing database/volume was reset.                                                                                                                                                                                                     |
| Offline storage, missing-media reattachment and post-commit cancellation                     | Final cancellation proves already-committed HTTP 206 media is recognized without another file, with autoplay suppressed. Broader reimport/eviction coverage ran at `31eae01`; the parity Back-button retry stopped in library setup, so that retry proves nothing about Back navigation.                                                   |
| Accounts, fences and rejected heals                                                          | Final quick gate plus three killed assertion mutants. Final real-browser late-response purge and playing-peer revocation cases passed. The broader all-store account-switch purge case stopped before purge because its `bookTags` canary was missing; it is **not** a passing isolation proof.                                            |
| Sync convergence and library mirror                                                          | Broad runs remain **red**. Seed 20260102 and both tag cases passed on the final targeted run after failing in the broad retry; this does not erase their earlier failures or establish full-suite stability.                                                                                                                               |
| Privacy                                                                                      | Executed same-origin wire controls and separate cross-origin loopback wire/browser positive controls, plus real offline narration. Blob/SW browser gaps and scope limits are explicit. MP3 privacy units stub fetch and byte storage; they are complementary unit evidence, not live wire evidence.                                        |
| Static architecture guard                                                                    | Original `one-library.spec.ts` remains byte-identical to `0e1f17e`; both scanner and scanner-positive-control cases ran in the broader parity commands.                                                                                                                                                                                    |

The first broad failure was an empty `chapterline-offline-v1/bookTags` canary
before the account-switch purge assertion. The retry reproduced it, then two
other parity fixtures timed out because archived **Parity Book Fallowmar**
remained visible in the mirror. The retry also found four seed-20260102 imports
missing from the device mirror after a full pull, a collection timestamp moving
backward by 19 ms, a tag-edit book timestamp moving backward by 14 ms, and a
queued tag edge missing on the other device. All seven raw errors, screenshots
and contexts remain in `parity-sync-retry.log` and its artifact directory.

The final targeted collection case still moves `updatedAt` backward by **10 ms**
(`2026-09-21T22:08:53.469Z → 2026-09-21T22:08:53.459Z`). A bounded read-only clock
probe found PostgreSQL ahead of the host by **148.2–148.8 ms** in seven short
round-trip samples; the first, slower sample measured 161.1 ms. Collection
creation uses a database default timestamp, while mutation uses host `new Date()`.
That mixed-clock mechanism is consistent with the observed ordering failure.
It is **not a proven explanation for every mirror/setup failure**. Server API,
schema and sync timestamp code are unchanged from `e9feaee`; no baseline
reproduction of these broader failures was run this round, so they are not
declared pre-existing or harmless. The only final product delta is the S1
media-gate change. No clock adjustment, broad reset, extra feature change or
weakened assertion was used to obtain a pass. These unresolved outcomes must
remain visible to the coordinator and external reviewer.

The resume exclusions remain `T1 hidden (online|offline)`, which this host's
browser cannot exercise as physical background lifecycle behavior. The existing
resume harness uses disposable ephemeral contexts, scoped renderer termination,
fixture-only cache/cookie restoration and documented second-tap allowances;
its result is not physical-device OS-kill evidence. Full broad parity/sync/resume
coverage was run on the intermediate build; final coverage is the complete quick
gate, two full iPhone suites and the six targeted browser cases listed above.

### Local handoff and bounded external checks

Local source/test commits in this round:

- `34a77f2` — Resolve residual playback, fixture and evidence findings
- `6aae383` — Await durable browser evidence before assertions
- `31eae01` — Correct WebKit readiness and browser auth probes
- `0bdf543` — Retain fence admission guards across later sign-ins
- `e8afea7` — External cleanup: shared fence-test storage stub and browser documentation
- `3209b06` — External cleanup report only

The historical documentation-only implementer handoff was **`a08d27c`**.
`.data/objective/residual-fixes-handoff.{json,log}` proves identical tested
app/harness source and 60 served asset hashes at that head only. Cleanup
`e8afea7` subsequently changed harness source, and `3209b06` recorded its report.
Those heads are not documentation-only descendants of the tested `0bdf543`
source. The old `verify-handoff-v2.mjs` correctly rejects them and is not a
current-candidate check. The external additional review supplies independent
execution at `3209b06`: 787 units, full quick gate, two 8/8 iPhone runs and full
33/33 parity; collection sync remained red. Its complete report is preserved in
`.data/objective/acceptance-fixes/review-input.md`. The old source JSON and
tests/harness counts remain historical measurements pinned to `0bdf543`;
cleanup's current-at-`3209b06` counts were 36,755 physical / 33,279 code lines.
Fresh implementation, source metrics and server provenance follow in the next
round's section. Earlier receipts and metrics have not been rewritten.

[residual-fixes-artifacts.json](residual-fixes-artifacts.json) indexes this round's
raw receipts, failures, measurements, scripts and screenshots. The active
`server-handoff-live.log` is excluded from its immutable index; a captured
snapshot is included. Sealing, final formatting, manifest verification and
post-commit receipts live immediately outside the indexed root under
`.data/objective/residual-fixes-*` to avoid a self-referential hash. The prior
311 original and 112 prior-fix indexed artifacts are unchanged.

Recommended bounded, read-only checks for the external cleanup/review gate:

```sh
git diff --check e9feaee HEAD
pnpm format:check
python3 .data/objective/residual-fixes/check-historical-artifacts.py
python3 .data/objective/residual-fixes/check-residual-artifacts.py
node .data/objective/residual-fixes/with-test-env.mjs node .data/objective/residual-fixes/check-db-clock.mjs
```

Do not overwrite historical receipt/output paths when rerunning browser checks.
Another quick gate rebuild requires restarting only the verified owned test
server and recording its new build provenance. The implementer pauses here for
Forge's cleanup gate if needed and **independent fixes-only external review**.
No reviewer, cleanup procedure or board action was run by the implementer.

## Acceptance repairs after independent additional review

This section supersedes earlier final-candidate coverage claims without changing
their receipts. Michael authorized continuing task `t_99d8ece2`. The complete
external review of `3209b06` was read before changes and is copied verbatim to
`.data/objective/acceptance-fixes/review-input.md`. It approved S1–S6 as fixes,
not the card's acceptance. N1–N9, including the two reproduced pre-existing
product defects, are addressed below. No independent review or cleanup gate was
run by this implementer.

### Candidate, baseline and provenance

Host was verified as **mbp-old** before work. This remained one implementer,
ordinary turns, no native goal, no subagents, no remote publication or board
actions. The clean round baseline was **`3209b06e56f8638478009838570bbd84dd0d625b`**.
Before edits, `baseline-quick` passed formatting, lint, types, **787 unit tests
in 89 files** and a production build. `baseline-source.json` was measured
separately from the command receipt, using the unchanged source scanner.

The stale owned `:3000` server was stopped only after checking its PID and exact
checkout cwd. The new baseline server served build `URgcnaMQyWPVp3kDffZ2W`;
`served-baseline.json` verifies the source, process, HTML/build ID and **65**
assets: all 64 emitted static files plus `public/sw.js`. Reviewer ports **3100
and 3199** were not altered. No real library, database/volume or credential was
reset. Tests use guarded local disposable accounts and their existing stable
per-project IP allocations; auth rate limits remain active.

The repaired source/test commit is **`a6eecfb07e5f0c9dfa23e8f386d14fd14637812c`** —
`Repair media identity, sync clocks and bounded fixture checks`. Its full quick
gate passed with **803 tests in 90 files**, then built `Mf1y0CMcug2Ygn89_7aTB`.
Only the owned server was restarted: PID **1538**, `:3000`, exact cwd
`hark/.next/standalone`. `served-candidate-1.json` pins this source and verifies
the same 65 live/disk hashes. All candidate browser results below use this
build. Later documentation-only changes are checked separately at handoff;
they do not relabel the tested source or the earlier review's candidate.

### N1–N9 dispositions

| Finding                                   | Disposition and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **N1 — cancellation outlives its intent** | The gate's state is scoped to account, book and rendition identity. A fresh attachment clears cancellation only after a nonempty file selection. Navigating away/back creates fresh intent. Cancel still re-reads committed availability with autoplay suppressed. Component regressions exercise reattachment, late completion and return to the cancelled book. Both full iPhone runs prove **0** play calls after Cancel and **1** after manual Play, using the already-committed media without another attachment.                                                                                                                                                                                                                                                   |
| **N2 — stale final-candidate handoff**    | The previous handoff is explicitly historical at `a08d27c`/tested source `0bdf543`. Cleanup commits `e8afea7` and `3209b06`, their harness changes and the external execution at `3209b06` are now named. The old verifier and receipts remain untouched, but the stale verifier is no longer recommended. The new verifier accepts only documentation changes after this tested source and checks clean-tree/build/process/65-asset provenance.                                                                                                                                                                                                                                                                                                                         |
| **N3 — conflated fixture diagnostics**    | A missing user returns the signup path. An existing disposable user lacking its credential fails with a provisioning diagnosis; an env backup cannot repair it. A real mismatch retains the matching-env/separate-fixture guidance. Database and verifier failures name their stage and a safe whitelisted error category, without raw error text, credentials or hashes. Seven unit cases cover these distinct outcomes. No user/credential mutation is attempted. `docs/development.md` includes a read-only identity/credential-count query.                                                                                                                                                                                                                          |
| **N4 — tautological password assertion**  | The browser case now captures the actual thrown Error, checks its actual message for the attempted password and exact expected text, and writes that actual verified message. Boolean assertions avoid leaking a mismatched secret through a diff. A mutation appending the attempted password to the real helper's error fails **1 of 7** unit cases; source is restored exactly. Both live runs receive **401**, keep the fixture book count **1 → 1**, and authenticate with the original credential afterward.                                                                                                                                                                                                                                                       |
| **N5 — unproved decoder advancement**     | The collection control waits for unpaused, non-seeking decoded readiness, samples the next book's position, then requires advancement beyond that sample by **0.1 s**. Its artifact derives the result. Consecutive live runs observed **0.148975 → 0.516866 s** and **0.157375 → 0.503335 s** with `autoplay=1`, without a second Play click.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **N6 — unbounded budget waits**           | The retained helper re-reads real buckets after each wait, retains **2 sign-in / 1 signup** attempts as headroom and 1,500 ms slack. Each call allows at most two waits with cumulative scheduled duration at most one window plus slack: **61.5 s / 601.5 s**. Continued saturation or a future clock fails with a serial-run/bucket/clock diagnosis, never reset/rotate/disable guidance. Nine fake-clock cases include repeated saturation and future timestamps. Both consecutive full browser runs exercised real sign-in waits, logged rounded to **62 s**, and passed with account deletion retained.                                                                                                                                                             |
| **N7 — metrics and cleanup attribution**  | Historical `residual-fixes-source.json` still pins `0bdf543`; it is not rewritten. The ledger now names cleanup's `3209b06` test counts, and the new source summary below pins this candidate. `CLEANUP.md` identifies its actual input range `e9feaee..a08d27c` (5 commits/12 files), the subsequent 7-commit/13-file range, and the largest-file audit's actual location in `docs/repository-anatomy.md`. Its postcheck paragraph distinguishes outcomes at report creation from subsequent coordinator/reviewer execution.                                                                                                                                                                                                                                            |
| **N8 — new identity mounts old audio**    | A keyed inner media gate synchronously discards state on account/book/fingerprint/rendition changes before React commits the new identity. An effect-only reset would be too late. Three regressions delay the next lookup and inspect committed player renders: no old media may mount under the new identity; the resolved source must be the new account/book/rendition's distinct URL. Together with N1 regressions, the old implementation fails **5 of 9** cases and the corrected gate passes all **9**. No account fence or legacy-rendition refusal was weakened.                                                                                                                                                                                               |
| **N9 — mixed receipt clocks break sync**  | The original collection failure reproduced on the baseline with a **19 ms backward** timestamp. Server receipt updates now use atomic database `greatest(clock_timestamp(), previous + interval '1 microsecond')` under the row write lock, for books, collections, playback, preferences, sequence receipts and tombstone conflicts. Creation remains database-timed. Client playback event clocks/conflict decisions and positions are unchanged. Three new real-browser tests move only disposable fixture rows one minute ahead, then require strictly advancing SQL microsecond timestamps and real incremental convergence after repeated metadata/tag/archive/membership or playback/preferences mutations. All three are red before the fix and green afterward. |

The timestamp expression establishes monotonic **per-row receipt time**; it is
not a global revision counter or a redesign of transaction ordering. The measured
host/database skew now cannot make these receipt updates step backwards. A
read-only probe found the database **28.16–28.82 ms ahead** in seven short
round trips; a slower initial sample measured 43.17 ms. No host or database clock
was changed, no sleep was added to the product/tests to conceal N9, and no
assertion was weakened. Raw clock and microsecond timestamp artifacts remain.

### Prior sync/mirror failures and current coverage

`baseline-prior-failures` exercised all seven formerly failing case names on the
clean `3209b06` production build: **6 passed / 1 failed**. The collection
timestamp failure reproduced. The account-purge canary, online/offline archived
library evidence, offline Back navigation, fuzz seed `20260102`, tag edit and
queued tag edge did not fail in that bounded baseline run. Their historical red
receipts remain valid observations; their individual root causes are not claimed
to have been proven by the clock fix.

On `a6eecfb`, full parity and sync pass **33/33 + 35/35**, including all those
cases and all twelve fixed fuzz seeds. The six-case targeted timestamp run also
passes. A further bounded run repeats seed `20260102`, tag edit and queued tag
edge three times each: **9/9 passed**, with no narrowed operation vocabulary.
These results clear the current candidate's executed cases; they are
not a claim that intermittent historical failures were imaginary or that every
possible scheduling/clock condition is covered.

Both consecutive full `iphone-webkit` runs pass **8/8**. Only read-only auth
bucket snapshots ran between them. The fixed `.111` signup bucket went from
absent to **1 → 2**; sign-in snapshots also show absent to **1 → 2**, across the
real idle-window resets. Each wait is preserved in the raw logs. Deletion is
still executed in each run; the next case creates/reuses the disposable fixture
through real auth. No live ten-minute signup-exhaustion experiment is claimed:
that boundary and continual saturation use bounded fake-clock tests, while
consecutive browser runs prove normal signup/reuse/deletion and real limiter
integration.

| Retained workflow / state                                                                     | Candidate coverage and oracle                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MP3 import, player, chapters, speed, skips, transcript, history, smart rewind and sleep timer | Both complete iPhone journeys, parity and supported resume cases; real media decoding and offline relaunch assertions.                                                                                                 |
| Document narration, progress, cancellation and completed-only playback                        | TXT/Markdown/HTML/PDF/DOCX/EPUB execute local narration in both iPhone runs; progress/cancel and legacy rendition refusal remain; committed-cancel range proof is **206 / 1,024 bytes**.                               |
| Empty/loading/error/success/offline/recovery                                                  | Full iPhone first-sync/retained journeys and parity; durable screenshots include empty, loading, unreachable, recovered, offline and not-on-device states.                                                             |
| Organization, tags, archive, collections and autoplay                                         | Both iPhone journeys plus full sync; next-book decoder advances relative to a sampled position, and future receipt-clock cases converge after every edit.                                                              |
| Offline storage, reattachment, books/positions/timeline integrity                             | iPhone offline playback, parity identity/account contracts, media-gate committed-render tests and supported resume coverage; no real user library is used.                                                             |
| Accounts/sync, export, book/account deletion and diagnostics                                  | Full parity/sync and two retained runs; actual credential-mismatch diagnostic, successful original login, account deletion and metadata export remain asserted.                                                        |
| Privacy and account isolation                                                                 | Full parity account/fence tests, full quick gate, unchanged static architecture guard and both live privacy controls. The N8 tests prove the synchronous identity boundary; existing fence assertions remain in place. |

The committed-cancel browser control retains its disclosed instrumentation:
wrappers around `IDBObjectStore.prototype.put` and
`BroadcastChannel.prototype.postMessage` delegate to the real APIs and click
Cancel after the durable commit while the mirror work remains blocked; both
wrappers are restored. `HTMLMediaElement.prototype.play` delegates and counts
calls until page teardown. This establishes behavior in the targeted window,
not that an unaided human click reliably reaches it.

Privacy claims retain their limits. Each document run recorded **99 app-origin
wire requests / 11 bodies** and **258 browser observations**, with no fixture
document text detected. Each independent cross-origin loopback control observed
all six sentinel bodies at the socket; WebKit omitted the Blob request body and
the service-worker request event from browser capture. No cloud upload occurred.
The collector does not observe arbitrary remote destinations, encrypted/encoded
payloads or binary audio; source/static checks and app-origin wire capture
complement the browser channel. These are not universal non-exfiltration proofs.

### Fresh source metrics, separate from historical benchmarks

[acceptance-fixes-source.json](acceptance-fixes-source.json) records the unchanged
scanner's same scope: application TS/TSX and `public/sw.js`, excluding tests;
token-occupied lines exclude comments and blanks. ESLint classic cyclomatic
complexity counts each function and its branches/short-circuit/optional paths.
Tests/harness, CSS and generated JSON are separate. Full static bundle totals
include every emitted JS/CSS/WASM asset, not initial page transfer.

| Metric                                | Original `0e1f17e` | Round baseline `3209b06` | Tested source `a6eecfb` |
| ------------------------------------- | -----------------: | -----------------------: | ----------------------: |
| App files                             |                185 |                      178 |                     179 |
| App physical lines                    |             28,134 |                   27,280 |                  27,316 |
| App code lines                        |             23,950 |                   23,232 |                  23,258 |
| App cyclomatic complexity sum         |              5,623 |                    5,456 |                   5,455 |
| App functions / maximum complexity    |         1,810 / 70 |               1,745 / 70 |              1,747 / 70 |
| Functions above complexity 10         |                 84 |                       79 |                      79 |
| Retained library subset complexity    |                357 |                      329 |                     329 |
| Tests/harness files                   |                130 |                      134 |                     135 |
| Tests/harness physical / code lines   |    35,655 / 32,148 |          36,755 / 33,279 |         37,222 / 33,733 |
| CSS physical lines                    |              3,249 |                    3,149 |                   3,149 |
| Generated Drizzle JSON physical lines |             58,251 |                   58,251 |                  58,251 |
| Static raw bytes                      |         28,550,966 |               28,540,479 |              28,540,585 |
| Static individually gzipped bytes     |          7,559,946 |                7,555,810 |               7,555,842 |

This round adds **26 application code lines**, reduces summed complexity by
**1**, and costs **106 raw / 32 gzip bytes**. Regression coverage increases
separately. No source-pruning or performance improvement is inferred from those
small deltas. The original calibrated browser startup/responsiveness/heap/import
measurements remain attributed to **`be79d4e`**, original source snapshot
`4964071`. Current functional narration timings are diagnostics, not a matched
performance comparison or replacement for that benchmark.

### Raw outcomes and verification limits

All prefixes in this section are under `.data/objective/acceptance-fixes/`.
Each command receipt records exact argv, cwd, hostname, UTC times, elapsed time
and exit status beside its unedited combined log. New output paths preserve all
earlier observations.

| Prefix                                 | Exact outcome                                                                                                                                                                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline-quick`                       | Exit 0, **34.569 s**, format/lint/types, **787 tests / 89 files**, production build.                                                                                                                                                                                                         |
| `baseline-source-check`                | Exit 0, **2.401 s**, clean `3209b06` source/build metrics in a distinct JSON output.                                                                                                                                                                                                         |
| `baseline-prior-failures`              | Exit 1, **6 passed / 1 failed**, **34.529 s**; original collection timestamp moves backwards 19 ms.                                                                                                                                                                                          |
| `n1-n8-red`, `n1-n8-green`             | Exit 1 (**5 failed / 4 passed**) against old gate; exit 0 (**9 passed**) with the fix.                                                                                                                                                                                                       |
| `n3-red`                               | Exit 1, **5 failed / 2 passed**; two missing-credential cases also had malformed `it.each` fixture arguments, so these two failures are not product evidence.                                                                                                                                |
| `n3-red-corrected-fixture`, `n3-green` | With the fixture corrected, exit 1 (**5 failed / 2 passed**) against the old helper; exit 0 (**7 passed**) with differentiated diagnostics.                                                                                                                                                  |
| `n4-diagnostic-mutation`               | Exit 1, **1 failed / 6 passed** after appending the attempted dummy password to the real thrown error; exact source restored.                                                                                                                                                                |
| `n6-red`, `n6-green`                   | Exit 1 (**5 failed / 4 passed**) against the old wait helper; exit 0 (**9 passed**) with bounded waits/headroom.                                                                                                                                                                             |
| `n9-future-red`                        | Exit 1, **2 failed**, **7.927 s**; book/collection updates move behind their retained future receipt.                                                                                                                                                                                        |
| `n9-state-red`                         | Exit 1, **1 failed**, **5.258 s**; playback/preferences clocks move backward and the second device remains at 10,000 ms instead of 24,000 ms. The test file was formatted after runner compilation, so some stack line excerpts are shifted; actual assertions and raw errors are preserved. |
| `quick-candidate-1`                    | Exit 0, **32.974 s**, full format/lint/types/**803 tests in 90 files**/production-build gate.                                                                                                                                                                                                |
| `provenance-candidate-1`               | Exit 0; exact source, owned process/build and **65 live asset hashes** match.                                                                                                                                                                                                                |
| `source-candidate-1-check`             | Exit 0, **2.356 s**, fresh source/build scan.                                                                                                                                                                                                                                                |
| `clock-candidate-1`                    | Exit 0; read-only database/host skew probe, no clock change.                                                                                                                                                                                                                                 |
| `n9-green-candidate-1`                 | Exit 0, **6 passed**, **11.495 s**: original membership/tag/edge cases and all three new clock regressions.                                                                                                                                                                                  |
| `parity-sync-candidate-1`              | Exit 0, **68 passed**, **240.286 s**: **33 parity + 35 sync**, no skipped/unrun cases.                                                                                                                                                                                                       |
| `prior-sync-repeat-candidate-1`        | Exit 0, **9 passed**, **17.905 s**: seed `20260102`, tag edit and queued tag edge each run three times.                                                                                                                                                                                      |
| `iphone-candidate-1-run-1`             | Exit 0, **8 passed**, **108.546 s**, including a real sign-in idle wait.                                                                                                                                                                                                                     |
| `iphone-candidate-1-run-2`             | Exit 0, **8 passed**, **111.829 s**, immediately consecutive full run with a real sign-in idle wait.                                                                                                                                                                                         |
| `resume-candidate-1`                   | Exit 0, **24 passed**, **682.248 s**; all supported resume cases on the same candidate build, with **22** raw scenario rows in `resume-candidate-1-rows.jsonl`. Two physical-background cases excluded explicitly.                                                                           |
| `launch-candidate-1`                   | Exit 0, **1 passed**, **24.359 s**; four profiles × six warm launches, 1,000-book fixture, separate current launch acceptance measurement.                                                                                                                                                   |
| `browser-collection`                   | Exit 0; `browser-summary.json` indexes exact receipts and assertion-backed controls, including all 22 resume rows with the tested build ID.                                                                                                                                                  |
| `historical-preservation`              | Exit 0; **311 original + 112 prior-fix + 360 residual-fix = 783** indexed artifacts retain exact sizes/hashes.                                                                                                                                                                               |
| `historical-preservation-final`        | Exit 0 after all browser runs; the same **783** historical artifacts remain unchanged.                                                                                                                                                                                                       |
| `provenance-after-browser`             | Exit 1 before checking the server: a new output label was mistakenly passed as the existing server label, producing `ENOENT` for `server-candidate-1-after-browser.json`. No receipt was overwritten.                                                                                        |
| `provenance-after-browser-v2`          | Exit 0; the preserved verifier's new version separates the existing server label from a fresh output label and refuses overwrites. Same source/build/PID and **65** live/disk asset hashes verified after all browser runs.                                                                  |

The supported resume rows report **0–201 ms** drift against their existing
250/1,000 ms limits; all four repeated-open cycle rows report **0 ms** accumulated
drift. The paused-player row records **0 writes** over 12.009 seconds paused.
All 22 rows identify build `Mf1y0CMcug2Ygn89_7aTB`.
The two `T1 hidden (online|offline)` cases remain excluded from the supported
resume command: physical iPhone/Home Screen/lock-screen and OS background
behavior are not verified by desktop Playwright. The existing resume instrument
uses ephemeral contexts, owned renderer termination, fixture-only cache/cookie
restoration and documented second-tap allowances. Neither those aids nor mocked
unit cases are presented as unaided physical-device evidence.

`visual-inspection.json` records direct inspection of the final run's paused
committed-cancel player, unreachable-first-sync state and completed document
library, with exact PNG paths. The library image paints four visible cards;
all six formats are established by the executed assertions and narration JSON,
not by treating that one screenshot as six-card evidence. The current test
artifacts also contain empty, loading, recovered, transcript, organization,
settings/diagnostics, account-deletion, legacy-refusal and cancellation screens.

The launch run's WebKit capability probe returned **Cache Storage read-back =
null**, and rejected CDP CPU throttling (`CDP session is only available in
Chromium`). The unchanged existing fallback selected persistent **Chromium with
iPhone 15 emulation**, whose storage probe succeeded. This is not WebKit or
physical-iPhone startup certification. A fixed 8-million-iteration workload
measured 7 ms at 1× and 15 ms at the calibrated 2.22× throttle, targeting the
existing 16 ms reference. Browser-process spawn is excluded: its observed p95
was 112 ms; harness overhead p95 was 51 ms. Raw per-launch timings, network
arming and persistence proofs are in `launch-candidate-1.log`.

| Current launch profile |    p50 | p95 / maximum | Timeouts | Server document/API/asset hits / DB queries |
| ---------------------- | -----: | ------------: | -------: | ------------------------------------------: |
| A, 0 ms latency        | 159 ms |        166 ms |        0 |                               0 / 0 / 0 / 0 |
| B, 400 ms latency      | 157 ms |        166 ms |        0 |                               0 / 0 / 0 / 0 |
| C, 3,000 ms latency    | 156 ms |        165 ms |        0 |                               0 / 0 / 0 / 0 |
| D, offline             | 155 ms |        163 ms |        0 |                               0 / 0 / 0 / 0 |

All 24 launches painted **50 book cards** from the 1,000-book account and
received the document from Cache Storage with **0 wire bytes**. P95 spread was
**3 ms**, within the unchanged 150 ms limit; all profiles met the unchanged
500 ms p95 limit. This checks current acceptance, not a new before/after
performance improvement claim. No new heap or responsiveness comparison was
run in this bounded repair round; original measurements retain their original
commit attribution.

### Durable handoff and bounded external checks

[acceptance-fixes-artifacts.json](acceptance-fixes-artifacts.json) indexes this
round's **195 artifacts / 23,105,262 bytes**: raw receipts, red reproductions,
failed mutation, measurements, helper scripts and screenshots with SHA-256 and
byte size. All **783** previously indexed artifacts still match. The active owned server's
`server-candidate-1-live.log` is excluded because it remains mutable; a captured
snapshot is indexed. Seal, final formatting, manifest verification and final
handoff receipts live outside that root under `.data/objective/acceptance-fixes-*`
to avoid self-reference. No previous red receipt, outcome or artifact was
deleted or replaced. `inspection-notes.json` also records corrected read-path
mistakes without presenting them as product failures.

The source/test commit is `a6eecfb` as listed above. The subsequent local commit
`Record acceptance repair evidence and final coverage` changes documentation
only. Its exact resulting HEAD is recorded in
`.data/objective/acceptance-fixes-handoff.{json,log}`. The new
`verify-final-handoff.mjs candidate-1` checks a clean checkout, app/harness
identity relative to the tested source, current build/process/HTML and every
one of the 65 served/disk hashes. Unlike the stale historical verifier, it
explicitly permits `CLEANUP.md` report corrections along with `docs/` changes;
any app/harness change requires fresh build/test evidence.

Recommended bounded read-only cleanup/review checks from this checkout:

```sh
git diff --check 3209b06 HEAD
pnpm format:check
python3 .data/objective/acceptance-fixes/check-historical-artifacts.py
python3 .data/objective/acceptance-fixes/check-artifacts.py
node .data/objective/acceptance-fixes/verify-final-handoff.mjs candidate-1
```

Raw JSON receipts contain the exact full quick/browser commands. Use fresh
receipt and Playwright output paths if rerunning them; never overwrite these
indexed paths. A new quick gate rebuilds `.next`, so only the owned `:3000`
server may be restarted and its new candidate/build provenance must be recorded.
Do not alter reviewer ports 3100/3199. There are no failed final executed gates;
the two excluded physical-background resume cases, browser instrumentation,
privacy capture gaps and launch-engine fallback remain explicit limits. The
implementer pauses for authorized cleanup if needed and independent external
review; acceptance belongs to those external gates.
