# Setup and contributing

## Prerequisites

- Node 22 is the GitHub Actions runtime; pnpm is pinned to 9.6.0. The package
  minimum is Node 20.19, but the commands below use Node 22's `--run` support.
- Docker with Compose for the disposable test database.
- FFmpeg on `PATH` for generated browser audio fixtures.
- Playwright WebKit and Chromium for browser suites.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install webkit chromium
```

On Linux, use `pnpm exec playwright install --with-deps webkit chromium` to also
install browser system dependencies. See [package scripts](../package.json) and
[CI workflow](../.github/workflows/ci.yml) for the executable command definitions.

## Local test environment

For a **new** disposable setup:

```sh
test -f .env.test || cp .env.test.example .env.test
pnpm db:test:up
pnpm prepare:browser-assets
node --env-file=.env.test --run dev
```

Open [localhost:3000](http://localhost:3000). `db:test:up` starts the Compose
Postgres service at `127.0.0.1:54329`, checks `pg_trgm`, applies ordered migrations,
and seeds the account named in `.env.test`. It fills only blank signing secrets
and test passwords. Keep this ignored env file with its matching retained database.

`node --run` does not execute package pre/post hooks. Preparing assets explicitly
above covers development; `verify:quick` calls `pnpm build`, which does execute
its prebuild and postbuild hooks. A direct `pnpm dev` instead loads Next's
`.env.local` and runs its predev hook.

For a separate development database, copy `.env.example` to `.env.local` **only if
that file does not already exist**, set its database URL and fresh auth secret,
then use `pnpm db:migrate` and `pnpm dev`. Next and Drizzle normally load Next env
files. Browser/test tooling explicitly reads `.env.test`, or `HARK_ENV_FILE` when
set, and rejects nonlocal database hosts. Existing process env values take
precedence over file values: do not run test tooling with a production
`DATABASE_URL` exported in the shell.

### Retained fixtures and credentials

The browser suites use disposable identities and stable suite-specific loopback
IP headers. Retained-workflow runs reuse their account; deletion tests still use
a separate disposable identity. Real auth limits remain enabled. Budget helpers
read the actual bucket, make at most one bounded wait, and recheck; they do not
clear rate limits or rotate IPs to evade them. Run suites serially on a shared
fixture database. The maximum wait follows the real window (one minute for
sign-in, ten minutes for signup), plus scheduling slack; an inconsistent or
still-busy bucket fails with a diagnostic.

A retained-workflow preflight distinguishes:

| Failure                                       | Safe next step                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No retained identity                          | The harness can create its disposable fixture normally.                                                                                     |
| Identity exists without a password credential | Inspect that disposable identity's provisioning; an env backup alone cannot create the missing credential.                                  |
| Password mismatch                             | Restore the env file that matches the retained test database, or point `HARK_ENV_FILE` at a separately provisioned new disposable database. |
| Database/crypto/budget operation failed       | Check the reported category, local connection, migrations, and runtime; it is not evidence of a password mismatch.                          |

Do not reset an existing database/volume or replace credentials to make a test
pass. Diagnostics omit passwords, hashes, and raw driver text. `db:test:seed` is
an explicit **write**: it replaces the configured seeded account's password;
it is not a repair for the separate retained-workflow identity.

### Database commands

| Command                                          | Effect                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `pnpm db:test:up`                                | Start local Compose service, migrate, and seed.                                           |
| `pnpm db:test:migrate`                           | Apply migrations using the named test env.                                                |
| `pnpm db:test:seed`                              | Seed/update the configured disposable account.                                            |
| `pnpm db:test:guard`                             | Exercise the local-host guard.                                                            |
| `pnpm db:test:down`                              | Stop the Compose service and retain its volume.                                           |
| `pnpm db:test:reset`                             | Destroy the test volume and rebuild; only for a fixture you explicitly intend to discard. |
| `node scripts/test-db.mjs psql -- -c 'select 1'` | Run a query inside the local Compose service.                                             |

There is no `db:test:psql` package script. An env override does not provision a
separate Compose service: the checked-in Compose file has a fixed container and
port. Provision a separate disposable database deliberately before selecting it.

## Checks

On Node 22, after local test setup:

```sh
node --env-file=.env.test --run verify:quick
pnpm verify:browser
```

`verify:quick` runs Prettier, ESLint, TypeScript, all Vitest suites, and the
production build. `verify:browser` runs all five CI browser projects in order.
For a focused run:

```sh
pnpm test
pnpm test:idb-migrate
pnpm test:e2e:ios
pnpm test:e2e:parity
pnpm test:sync
pnpm test:resume:ci
pnpm test:e2e:launch
```

**Node 26:** its experimental native `localStorage` interferes with the unit
suite's storage doubles. Disable it for these commands:

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm test
NODE_OPTIONS=--no-experimental-webstorage node --env-file=.env.test --run verify:quick
```

This flag is a unit runtime requirement on Node 26, not an app storage setting.
Node 22 CI uses no such flag. Do not treat a different runtime/options combination
as the same test run.

Playwright builds the production bundle and starts `scripts/run-standalone.mjs`
using the explicitly selected test env and a local-database guard. It normally
refuses a port already in use. `HARK_REUSE_SERVER=1` is an opt-in for a server
you own whose source, build, origin, and disposable database you have verified;
a dev server or stale production build is not valid evidence for a new commit.
Failure traces/screenshots go to `test-results/`. Do not run against a personal
library. See [iPhone coverage](ios-pwa-testing.md), [resume limits](resume-durability-device-check.md),
and the [launch protocol](../tests/perf/BASELINE.md).

`pnpm test:resume` includes two hidden-state cases that can report `UNCOVERED`
when the browser cannot reproduce real iOS suspension. CI uses `test:resume:ci`
to exclude those cases explicitly; that exclusion is not a physical-device pass.

## CI

The workflow runs on pull requests, pushes to `main`, and manual dispatches:

- `Verify quick`
- `Browser (iPhone WebKit)`
- `Browser (Offline parity)`
- `Browser (Sync integrity)`
- `Browser (Resume durability)`
- `Browser (Launch performance)`

Each job uses Node 22, a frozen pnpm install, and its own local Postgres fixture.
Browser jobs build the app and retain failure artifacts. Acceptance must inspect
all six conclusions for the candidate being merged; an earlier branch run is not
proof for a changed head. Repository protection is configured on GitHub, not by
this document. Recheck it before publication. Also inspect hosting integrations:
a push or merge can trigger deployment independently of GitHub Actions.

## Contributing

Keep changes scoped to the private audiobook workflow. Preserve account
ownership, local media, rendition identity, receipt ordering, and migration
compatibility. Add regression coverage where behavior changes and run the
relevant browser project as well as the quick gate. Describe what ran, its source
commit/runtime, and any failures or unexercised paths.

Update these docs and [CHANGELOG](../CHANGELOG.md) when behavior changes.
`pnpm format:check` checks formatting; `pnpm exec prettier --write <changed-files>`
formats a scoped edit. Check relative links against tracked files and anchors,
and external links for reachability; the repo has no dedicated link-check script.

Keep `drizzle/meta/*.json`, ordered SQL migrations, pinned assets, fixtures, and
`pnpm-lock.yaml`: they are required inputs. `public/sw.js` is authored source.
Do not commit `.next`, dependencies, env secrets, user files, mail captures,
Playwright output, coverage, or generated review/cleanup reports. Keep process
receipts outside the repository.

Reusable measurement helpers remain available: `scripts/measure-source.mjs`
counts application TS/TSX and the service worker separately from tests, CSS, and
migration snapshots; `scripts/measure-browser.mjs` measures live browser work.
Source measurements require a build and their own output path. Build-wide asset
size is not initial transfer size. Preserve the measured commit and command;
do not relabel old browser measurements after a source change.
