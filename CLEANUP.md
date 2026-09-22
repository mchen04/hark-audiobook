# Cleanup report

Supersedes the `9d64cca` receipt (git history `1f10c80`; verbatim copy under
`.data/objective/acceptance-followup/`), whose A4 point holds.

Run ID: 911da31cabd046d7912bfa00555d8286
Status: complete

## Passes

One bounded pass over `9d64cca..HEAD` (3 commits, 23 files), read in full. Evidence
JSONs and the ledger are receipts of executed runs: read for staleness, not rewritten.

## Rebase

Not needed. The coordinator checked ancestry; I ran no rebase, fetch or reset.

## Removed

`src/server/playback/progress.ts`: the raw upsert template kept its old indentation
after the transaction callback gained a nesting level, so the SQL read two columns left
of its own statement; whitespace inside the template only.
`tests/parity/player-back.spec.ts`: the exact `Play` locator was spelled out a third
time beside the `play` locator it duplicates; it now reuses it.

## Tests deleted

None. Every case here can fail, per the ledger's red runs: A5's future-receipt and A6's
commit-order cases were red on `9d64cca`, A0 fails when the exact selector is reverted,
A8 dies when the book/history returns to the gate key. The `0/1/500 ms` budget offsets
are redundant (the `waited` flag refuses the second wait whatever the offset), but they
still fail against the old helper and A1 records them, so pruning would desync the ledger.

## Docs updated

None needed. `docs/local-first.md` section 3, `docs/development.md` and
`docs/architecture.md` were rewritten by this diff and match the shipped helper, the
one-wait budget and the media gate. The stale `N6` ledger row is historical; `A1` supersedes it.

## Verified

`prettier --check` passed on both touched files, proving they parse. `vitest run
src/server/sync/parent-updated-at.test.ts tests/shared/auth-budget.test.ts`: 19 passed,
exit 0 — the route-source audit still parses the edited routes, and no test asserts the SQL
text. The parity spec needs pinned browsers and a served app; I did not run it. I started
no suite, lint or typecheck job; nothing runs in the background.

## Checks

Bounded plan: `git diff --check`, `pnpm install --frozen-lockfile` and raw
`pnpm verify:quick` (format, lint, `tsc --noEmit`, vitest, build) on the `9d64cca` baseline
tree and on this checkout. Coordinator prechecks ran synchronously before this pass — raw
exit codes, not a diagnostic delta: all three exit 0 on both trees. Postchecks have NOT run:
the coordinator runs the quick gate, lint, typecheck and the sync/parity/e2e browser suites
after I exit. The edited parity spec is in that unrun scope.

## Commits

`951d6af` — Align the progress receipt SQL with its transaction nesting; report on top.

## Reverted

none
