# Cleanup report

Historical coordinator receipt for `9d64cca`; the checks below describe that
cleanup pass. Current acceptance repairs and checks are recorded separately in
`docs/evidence/architecture-ledger.md`.

A4 clarification: deriving `incrementalMirrorMatchedEveryEdit` from the counter
did not create an independent oracle. Like `strictlyIncreasing` and the autoplay
boolean, it could only be written after matching assertions passed. The current
specs omit these redundant flags and retain the measured timestamps/positions
and executable assertions. The original report is preserved verbatim at
`.data/objective/acceptance-followup/CLEANUP.md.9d64cca.txt`.

Run ID: cc69bfbf83b04ef48ba75588e885d26b
Status: complete

## Passes

One bounded pass over `3209b06..HEAD` (2 commits, 19 files), read in full. The
evidence JSONs and ledger section are receipts of executed runs: read for staleness, not rewritten. `src/` stays byte-identical on purpose — the ledger pins tested source `a6eecfb` to build `Mf1y0CMcug2Ygn89_7aTB` and 65 served asset hashes, and this gate cannot produce replacement build evidence.

## Rebase

Not needed. The coordinator checked ancestry; I ran no rebase, fetch or reset.

## Removed

`tests/sync/two-device-convergence.spec.ts` wrote
`incrementalMirrorMatchedEveryEdit: true` as a literal into its artifact — the
unfalsifiable form the review rejected as N5 elsewhere. It now derives that field
from a count of the mirrored edits the loop ran. One comment grammar slip fixed in
`tests/e2e/retained-workflows.spec.ts`.

## Tests deleted

None. Every case this diff adds can fail, per the ledger's red runs: `n1-n8-red`
5 failed / 4 passed against the old media gate, `n3-red-corrected-fixture` 5 / 2,
`n6-red` 5 / 4 against the old wait helper, `n9-future-red` and `n9-state-red` red
before the timestamp fix. Budget and headroom cases also fail under the old `RULES`.

## Docs updated

`docs/local-first.md` section 3 states the `updatedAt` bump rule every write path
must honor, but predated `monotonicTimestamp()`. It now names the helper, its
`greatest(clock_timestamp(), previous + interval '1 microsecond')` expression, the
row-lock requirement, and that a new route writing `new Date()` restores the bug.

## Verified

`prettier --check` passed on the three touched files, proving both specs parse. A
comment, a derived artifact field and prose changed; no behavior. I started no
suite, lint or typecheck job, and nothing runs in the background.

## Checks

Bounded plan: `git diff --check`, `pnpm install --frozen-lockfile` and raw
`pnpm verify:quick` (format, lint, `tsc --noEmit`, vitest, build) on the `3209b06`
baseline tree and on this checkout. Coordinator prechecks ran synchronously before this pass — raw exit codes, not a diagnostic delta: all three exit 0 on both trees. Postchecks have NOT run: the coordinator runs the full quick gate, lint, typecheck and sync/e2e browser suites after I exit. Both edited specs sit in that unrun scope.

## Commits

`f4b7c5b` — Derive sync mirror evidence and document receipt clocks.

## Reverted

none
