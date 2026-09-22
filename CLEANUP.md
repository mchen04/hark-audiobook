# Cleanup report — follow-on gate over the cleanup diff

Run ID: 6d95aa60f8c149cba6fb1dad8d38f23a
Status: complete

## Passes

One bounded pass over `1e13420..HEAD` (2 commits, 4 files), read in full: the prior gate's docs
rewording, one test refactor and its report. No scope expansion beyond it.

## Rebase

Not needed. The coordinator checked ancestry; I ran no rebase, fetch, reset, clean or push.

## Removed

One compound sentence in `docs/development.md` joined two unrelated facts with "and": the option's
scope and the package's Node minimum. It is now two sentences. Nothing else was cut. The
`docs/local-first.md` split into ordering cost, bounded admission and client recovery holds, and
`secondEdit()` in `tests/sync/two-device-convergence.spec.ts` drops a duplicated PATCH body and a
four-level `expect`, asserting the same things.

## Tests deleted

None. This diff deletes and adds no case. The two `secondEdit()` calls keep distinct assertions (503
while the first writer is blocked, 200 after it commits), so neither is a test that cannot fail.

## Docs updated

`docs/development.md` only, reworded. Every claim survives and was checked against the code: the
100ms `lock_timeout` saved/restored around `pg_advisory_xact_lock` (`src/server/db/sync-receipt.ts`),
`503 / Retry-After: 1` (`src/server/api/route-handler.ts:99`), Node 22/26.3.1 and 807 tests at
`8b5adc2`. I left `Last reviewed: 2026-08-13` in `docs/local-first.md`: I read section 3, not all.

## Verified

`prettier --check` on the three touched files, an `esbuild` transform of the convergence spec and
`git diff --check`: each exit 0. That spec needs a served app and database, so I did not run it, and
I started no background job.

## Checks

Bounded plan: `git diff --check`, `pnpm install --frozen-lockfile` and raw `pnpm verify:quick`
(format, lint, typecheck, vitest, build) on the baseline tree and on this checkout under
`NODE_OPTIONS=--no-experimental-webstorage`. Coordinator prechecks ran synchronously before this
pass — raw exit codes, not a diagnostic delta: all three exit 0 on both trees, quick 38.402s
baseline / 33.329s current, all predating my commits. Postchecks have NOT run: the coordinator
reruns that install/quick/diff plan after I exit, and an independent reviewer runs the browser tests
— this coordinator runs none. Nothing above claims the repository is green.

## Commits

`25e0ded` docs edit; this report on top. `3a88100`, `706358e` and the product commits through
`1e13420` are unchanged. The prior gate failed retirement only on an untracked helper-created
`.venv` symlink, ignored this run by process-local git config with its original evidence preserved.

## Reverted

none
