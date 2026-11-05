# Development

Use Node 22, pnpm 9.6.0, Docker Compose, and FFmpeg.

## Start locally

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install webkit chromium
test -f .env.test || cp .env.test.example .env.test
pnpm db:test:up
set -a
. ./.env.test
set +a
pnpm dev
```

Open <http://localhost:3000>. The bootstrap starts PostgreSQL at `127.0.0.1:54329`, applies migrations, and seeds the test account.
It generates only blank test credentials. Retain the environment file with its database.

For a separate development database, configure `.env.local` from `.env.example` and run `pnpm db:migrate`.
Do not overwrite an existing environment file.

## Verify changes

```sh
pnpm verify:quick
pnpm verify:browser
```

The quick check runs formatting, lint, types, unit tests, and a production build.
The browser check runs iPhone WebKit, desktop WebKit, parity, sync, resume durability, and launch tests.
On Node 26, use `NODE_OPTIONS=--no-experimental-webstorage pnpm verify:quick`.

Browser tooling reads `.env.test` or `HARK_ENV_FILE` and refuses hosted databases.
Exported variables take precedence, so never run tests with a production `DATABASE_URL`.
The runner builds and starts its own server. Use `HARK_REUSE_SERVER=1` only for a verified server you own.
FFmpeg generates fixture audio. Each browser uses a separate automation profile.
Run suites serially against a shared fixture database.

Retained accounts and authentication limits remain active.
If credentials fail, restore the matching environment or provision a separate test database.
Do not reset retained data or change passwords to bypass a test failure.
`db:test:seed` replaces the configured seed account's password.
`db:test:down` retains the volume. `db:test:reset` destroys it.

## Focused checks

```sh
pnpm test:idb-migrate
pnpm exec playwright test --project=iphone-webkit --project=desktop-webkit tests/e2e/media-session-resume.spec.ts
pnpm test:resume:position-drift
pnpm test:resume:suspension-recovery
pnpm test:resume:uncovered-axes
```

The resume commands exclude two unsupported native hidden-state cases, as CI does.
See [WebKit testing](ios-pwa-testing.md) for their limits.
Unit tests report test counts, not line coverage. No coverage provider is installed.

## Benchmarks and updates

```sh
pnpm bench prepare --ref HEAD --dir "$TMPDIR/hark-candidate"
pnpm bench run --a "$TMPDIR/hark-base" --b "$TMPDIR/hark-candidate" --label comparison --out "$TMPDIR/comparison.json"
pnpm test:update --previous <git-ref> --out "$TMPDIR/update.json"
```

Prepare both benchmark revisions with the same environment. `prepare` includes committed changes only.
Use identical builds for an A/A noise control and pass the result with `--noise`.
`--reps 1` checks functionality but cannot support a speed claim.
The launch gate checks six runs per profile, p95 at most 500 ms, and profile spread at most 150 ms.
The executable assertions in `tests/perf/launch-benchmark.spec.ts` define the contract.
The update check exercises cache rollover and playback on one origin.

Keep reports, screenshots, traces, generated builds, and recordings outside the checkout.
Retain ordered SQL, migration snapshots, pinned assets, fixtures, and the lockfile.
`public/sw.js` is authored source. Never commit environment files or local user data.
