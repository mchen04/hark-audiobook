# Cleanup

Run ID: 3f32a1a66921488692b2f9b752900101
Status: complete

## Passes

One bounded pass over **`e9feaee..a08d27c`** (5 commits, 12 files), read in full. This is the historical input range, before cleanup commits `e8afea7` and `3209b06` extended it to 7 commits and 13 files. At that pass the one application file, `src/components/player/local-media-gate.tsx`, remained byte-identical to the reviewed candidate. Fence defenses and test cases were retained; the shared test stub was extracted as described below. Subsequent implementation and current provenance belong to the evidence ledger, not this historical report.

## Rebase

Not needed; the coordinator checked ancestry.

## Removed

- `src/lib/offline/mirror.test.ts`: the diff added a third copy of the 9-line `localStorage` register stub, identical to the adjacent fence test's. Both now call one `stubPlaybackStorage()`; the two stubs that genuinely differ (quota-throwing, read-only) are left alone.
- `tests/e2e/retained-workflows.spec.ts`: dropped `expect(before.length).toBeGreaterThan(0)` — the `expect.poll(...).toBe(1)` two lines above pins that count, and `expect(after).toEqual(before)` carries the meaning.

## Tests deleted

None. Every case this diff adds can fail: the fake-clock budget cases, both fence-admission boundaries, the cancel/autoplay component cases and the credential-mismatch and cross-origin privacy browser cases each have a distinct oracle. `tests/shared/sign-in-budget.ts` still serves parity, sync, resume and launch, so the retained suite's new reader orphans nothing.

## Docs updated

`docs/development.md` listed what the iPhone Playwright project covers; this diff added `tests/e2e/privacy-transport.spec.ts` under `tests/e2e`, so that sentence now names it and its loopback calibration scope. The `.111` IP and credential-preflight paragraph were current at that pass. The separate largest-tracked-files audit recipe is in `docs/repository-anatomy.md`, not `docs/development.md`.

## Verified

`vitest run` on the three touched unit files — exit 0, 44 passed. The extracted helper is load-bearing: with its `stubGlobal` body removed `mirror.test.ts` fails 7 of 35; restored, 35 pass. The prose and assertion edits are not executable here.

## Checks

Coordinator prechecks, synchronous, before this pass: `git diff --check` exit 0 on both trees; `pnpm install --frozen-lockfile` exit 0 on both; raw `pnpm verify:quick` (format, lint, `tsc --noEmit`, vitest, production build) exit 0 on the `e9feaee` baseline (88 files / 777 tests) and exit 0 on the cleanup input (89 files / 787 tests). At report creation the coordinator's postchecks had not run; the cleanup writer started none. Subsequently the coordinator's post-quick gate passed at `3209b06`. The independent additional review passed 787 units, quick, two 8/8 iPhone runs and 33/33 parity at that head, while reproducing the collection timestamp failure. These outcomes do not describe later repair candidates; consult the current evidence ledger.

## Commits

`e8afea7` — Deduplicate the fence storage stub and refresh e2e docs. This report is committed separately.

## Reverted

none
