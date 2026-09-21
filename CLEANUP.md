# Cleanup

Run ID: 704dbec08cf74d63bbfe1f703ff552a5
Status: complete

## Passes

One pass (the bounded maximum) against `0e1f17e`. Retained audiobook features, legacy-rendition safety and raw `.data`/objective evidence untouched.

## Rebase

Not needed; the coordinator checked ancestry.

## Removed

- `src/domain/library.ts` — a `!` assertion in `selectContinueBook` silencing narrowing it had lost; it now tracks the winning timestamp beside the book.
- `src/components/library/use-library-books.ts` — a `.then(() => undefined).catch(() => undefined)` chain that only reshaped a promise; now one async body with one `.catch`.
- `src/components/player/local-media-gate.tsx` — a nested inline `await (await import(...))...artwork` buried in an argument list, extracted to a named local with the same arguments, dynamic import and abort signal.

## Tests deleted

none — nothing qualified. Every new and reworked case (`use-library-books`, `import-controller`, `retained-workflows`, `rendition`, `mirror`, `library-listing`, `player-back`, resume oracle) has a failing mode.

## Docs updated

none — the diff's own doc changes are current, links resolve, and no reference to the removed Lemonade, narration-preview or `/narrating` code survives outside the evidence ledger and the tests asserting their absence.

## Verified

Synchronous, scoped to the edited paths: `vitest run` on `mirror.test.ts`, `library-listing.test.ts`, `use-library-books.test.tsx`, `rendition.test.ts` — exit 0, 54 passed; `prettier --write` on the three files, already formatted. Targeted only: not lint, not typecheck, not the full run.

## Checks

Plan: read the receipts, one pass, small synchronous checks only, commit, report. Below are the coordinator's raw exit codes from `cleanup-evidence/` — not a diagnostic delta — recorded before this pass's commits.

| Precheck                                                                   | Base `0e1f17e` | Current        |
| -------------------------------------------------------------------------- | -------------- | -------------- |
| `pnpm install --frozen-lockfile`                                           | exit 0         | exit 0         |
| `git diff --check`                                                         | exit 0         | exit 0         |
| `pnpm verify:quick` (`format:check && lint && typecheck && test && build`) | exit 0 (38.5s) | exit 0 (33.2s) |

Postchecks have NOT run; the coordinator runs them after I exit. Nothing here re-establishes green for `b323d7e` or claims the repository is green.

## Commits

- `b323d7e` Deslop the library read, rendition selection and MP3 attach paths
- this commit, recording the pass

## Reverted

none
