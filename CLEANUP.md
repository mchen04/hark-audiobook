# Cleanup gate

Run ID: 90aa4f6d86404b17a1541b33f1bf5588
Status: complete

## Passes

One pass over the diff against `33f4ccd8`, covering `src/lib/offline/account-purge.*`,
`tests/sync/account-contention.spec.ts`, and the two touched docs. `docs/evidence/`
was read only; no evidence, metric, or attribution text was edited.

## Rebase

Not needed; ancestry was confirmed.

## Removed

- `drainBeforeSignOut`: the three lane closures named their parameter `send`, which
  shadowed the outer `send` (the real transport). Renamed to `drainFetch`.
- `account-contention.spec.ts`: four copies of one `pageerror` listener collapsed
  into a `recordPageErrors(page, errors)` helper.
- `docs/local-first.md`: repaired ragged wrapping the diff left behind.
- Kept: each drain comment states a non-obvious invariant, and the
  `isAccountWriteFenced` check beside `scope.signal.aborted` is load-bearing because
  `reopenAccountAfterSignIn` clears the fence while the scope stays aborted.

## Tests deleted

None. `retries hinted account contention...` and `does not retry a late busy
response...` still pin request identity, the one-second floor, and budget expiry, so
the new ambient-join cases do not supersede them. The new lane loop seeds a different
outbox per lane, so neither copy is a tautology.

## Docs updated

`docs/local-first.md`, wrapping only. `docs/development.md` is not stale.

## Verified

`npx vitest run src/lib/offline/account-purge.test.ts` exit 0, 38 passed; prettier
`--check` on the three edited files exit 0. I ran no browser checks.

## Checks

Bounded plan: the coordinator runs install / `verify:quick` / `git diff --check`, and
an independent review runs browser checks later. Coordinator prechecks are done,
receipts in `signout-cleanup/`: install exit 0, `verify:quick` exit 0 (base 814
tests, current 821), `git diff --check` exit 0 — raw exit codes on base and current,
not diagnostic deltas. Postchecks have NOT run: nothing re-ran after these commits,
so `verify:quick` and the Playwright checks are outstanding. I ran no repository
typecheck or lint, and make no claim that the repository is green.

## Commits

`69107916` drain naming, page-error capture, doc wrapping; plus this report commit.

## Reverted

none
