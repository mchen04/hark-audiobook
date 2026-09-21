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
