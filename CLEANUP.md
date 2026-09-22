# Cleanup report — bounded gate over the account-contention diff

Run ID: ef2b0c00fcf743bab690f53e6ba1c5b1
Status: complete

## Passes

One bounded pass over `8b5adc2..HEAD` (5 commits, 17 files), read in full. The ledger and both
`contention-fixes-*.json` evidence files are past-run receipts: read for staleness, left as-is.

## Rebase

Not needed. The coordinator checked ancestry; I ran no rebase, fetch, reset, clean or push.

## Removed

`docs/local-first.md` section 3 was one 20-line paragraph with a stray line break: now three
(ordering cost, bounded admission, client recovery), with the duplicated "no separate pool,
state-read race, or server-side retry loop" folded into the sentence that already bounds it.
`docs/development.md` drops the hedge about the package's Node minimum. In
`tests/sync/two-device-convergence.spec.ts` the second writer's PATCH body appeared twice and its
retry sat in a four-level `expect`; one `secondEdit()` closure replaces both. No server-code comment
was cut: each pins a constraint or a test-integrity claim.

## Tests deleted

None. Every case has a recorded red run: load at `contention-baseline-with-peer-write`, player at
`contention-candidate-1`, sign-out at `signout-busy-red-drain`; both unit files fail if
`SyncBusyError` regresses. Carried forward: false-red baseline `9d64cca`, `1f10c80` already holds
the `8aa80bc` fix, and prior reports stay in `.data/objective/contention-fixes/`.

## Docs updated

`docs/local-first.md` and `docs/development.md`, reworded only: the 100ms `lock_timeout`, 503 /
Retry-After: 1, eight-second sign-out budget, Node 22/26.3.1 runtime and 807 tests at `8b5adc2`
survive.

## Verified

`prettier --check` on the three touched files: exit 0. `esbuild` transform of the edited convergence
spec: exit 0, and `secondEdit()` returns the same `request()` value the inline calls did. That spec
needs a served app and database, so I did not run it.

## Checks

Bounded plan: `git diff --check`, `pnpm install --frozen-lockfile` and raw `pnpm verify:quick`
(format, lint, typecheck, vitest, build) on the `8b5adc2` baseline tree and on this checkout under
`NODE_OPTIONS=--no-experimental-webstorage`. Coordinator prechecks ran first — raw exit codes, not a
diagnostic delta: all three exit 0 on both trees, quick 38.974s/34.467s. Postchecks have NOT run:
the coordinator runs that gate plus sync/parity/e2e, including the edited spec, after I exit. No
green-repository claim here.

## Commits

`3a88100` cleanup; this report on top. The five product commits `51a6916..1e13420` are untouched.

## Reverted

none
