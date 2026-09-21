# Development

Last reviewed: 2026-09-21

Local setup, the test database, every command, and what a green run does and
does not prove.

## Prerequisites

- Node.js >= 20.19
- pnpm 9.6
- Docker, for the local test database
- FFmpeg, for generated MP3 contract and browser fixtures

## Setup

```sh
cp .env.example .env.local   # then fill in the values below
pnpm install
pnpm db:migrate
pnpm dev                     # http://localhost:3000
```

Use `pnpm build && pnpm start` instead of `pnpm dev` when you need the service
worker: it ships only in the production build, so offline behavior, the launch
shell, and range serving cannot be exercised in dev.

### Environment variables

| Variable             | Purpose                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`       | Postgres connection (Neon or any Postgres 15+). Never commit it. |
| `BETTER_AUTH_SECRET` | Session signing secret.                                          |
| `BETTER_AUTH_URL`    | The app's own origin, e.g. `http://localhost:3000`.              |

`RESEND_API_KEY` and `MAIL_FROM` are optional; together they enable
password-reset email in production (see [operations.md](operations.md)). In
development, reset mails are written to `.data/mail/` instead.

## Test database

Tests never touch the hosted database. Its cold start makes runs slow and
flaky, suites must work offline, and parallel runs against one shared remote
database interfere with each other.

`docker-compose.yml` provides a local Postgres 18 matching the hosted server's
major version and locale (builtin `C.UTF-8`), with the `pg_trgm` extension that
migration 0009 needs, published on `127.0.0.1:54329`.

```sh
cp .env.test.example .env.test   # local-only, gitignored
node scripts/test-db.mjs         # generates secrets, then starts, migrates, seeds
```

Everything test-related reads `.env.test`, never `.env.local`. Override the
file with `HARK_ENV_FILE=<path>` or `--env-file=<path>`.

Keep that file with its disposable database: regenerating
`HARK_TEST_ACCOUNT_PASSWORD` while retaining the database makes existing test
accounts reject login. The retained-workflows helper verifies its single
disposable account's password hash before resetting any fixture content. On a
mismatch it stops with a credential-free diagnostic. Restore the matching env
file backup, or point `HARK_ENV_FILE` at a separate new disposable database and
matching credentials. A user row with a missing email/password credential is
reported separately as an incomplete disposable identity; restoring an env
backup cannot repair that condition. Inspect that fixture's provisioning or
use a separate new test database. Database-read and verifier failures name the
operation and a safe error category; raw messages, passwords and hashes are
omitted. This helper does not rotate credentials or reset volumes.

On the configured disposable test database, this read-only query reports whether
the retained identity and its credential exist without returning any password or
hash. Zero rows means signup is appropriate; a user with no credential needs
provisioning repair or a separate new fixture database, not a password retry.

```sql
SELECT u.id,
       count(a.id) AS credential_rows,
       coalesce(bool_or(nullif(a.password, '') IS NOT NULL), false) AS credential_present
FROM "user" u
LEFT JOIN account a ON a.user_id = u.id AND a.provider_id = 'credential'
WHERE u.email = 'retained-workflows@hark.test'
GROUP BY u.id;
```

Retained browser workflows reuse the fixed `.111` test IP and read the real
database sign-in and signup buckets before each attempt. They wait for a
bucket's remaining idle window and extend that test's timeout. They leave two
sign-in attempts and one signup attempt as headroom. Each call permits at most
two waits totaling one real window plus 1,500 ms of slack (61.5 seconds for
sign-in, 601.5 seconds for signup), then fails with a shared-IP/clock diagnosis.
Run these suites serially; an unexpectedly busy or future-dated bucket needs
inspection, not a reset. The helper never clears buckets or rotates IPs.
The bounded fake-clock budget tests cover exhaustion without that delay; two
consecutive full browser runs exercise real authentication and account deletion.
Other browser projects retain their existing per-project sign-in budgeting.

`scripts/lib/assert-local-database.mjs` aborts the e2e config, the standalone
test server, and the bootstrap script if `DATABASE_URL` ever points at a hosted
provider such as Neon.

## Commands

### Gates

| Command               | What it does                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`         | The complete executable local gate: `verify:quick` plus every browser gate. Start the test database and install the pinned browsers first.                 |
| `pnpm verify:quick`   | The fast non-browser gate: format check, lint, typecheck, all Vitest suites, and a production build.                                                       |
| `pnpm verify:browser` | Every executable Playwright gate, matching the browser matrix in `.github/workflows/ci.yml`. The two real-iOS hidden-state gaps stay deliberately outside. |

### Suites

| Command                      | What it covers                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                  | Vitest: MP3 and transcript parsing contracts, service-worker range/navigation/shell logic, progress conflict policy, the outbox and the mirror, IndexedDB upgrades, playback.                                                        |
| `pnpm test:idb-migrate`      | Just the IndexedDB upgrade suite. Every shipped version of both databases is opened from a fixture and carried forward, so downloads, transcripts, and a pending deletion journal survive `chapterline-offline-v1` v7 and outbox v5. |
| `pnpm test:e2e:ios`          | Production iPhone/WebKit flow: register, choose from Downloads, play, seek, relaunch, play offline.                                                                                                                                  |
| `pnpm test:e2e:launch`       | The launch benchmark in `tests/perf/`: warm launch to real library content over four networks (fast, slow, 3000ms cold database, offline), asserting p95, spread, server document hits, and Postgres queries.                        |
| `pnpm test:e2e:parity`       | The parity project in `tests/parity/`, whose harness removes the network at the socket rather than through Playwright interception — interception sits above the service worker and can be bypassed.                                 |
| `pnpm test:sync`             | Data integrity in `tests/sync/`: outbox durability and coalescing, two-device convergence, progress conflicts, mirror/audio eviction recovery, lossless re-import, and a seeded mutation fuzz across offline/online transitions.     |
| `pnpm test:resume:ci`        | The 24 resume-durability rows the pinned WebKit engine can execute honestly. Excludes only T1 hidden online/offline, because Playwright WebKit cannot produce a real hidden transition.                                              |
| `pnpm test:resume`           | The full 26-row resume oracle, including the two T1 rows that intentionally fail as `UNCOVERED` unless the engine can genuinely background the page. Use it when evaluating a new engine or a real-device bridge.                    |
| `pnpm verify:kestrel-export` | Clean-room Kestrel graph reproduction: downloads the exact pinned public model weights into a temporary directory, uses the pinned Python/ONNX/NumPy recipe, and requires byte-for-byte matches with every committed ONNX graph.     |

One sync spec makes its edits by clicking the real controls with the network
off. The fuzz drives the engine directly, so only that one spec can prove the
shipping UI actually uses the engine.

### Database and data

| Command                              | What it does                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node scripts/test-db.mjs`           | Starts the local Postgres container, migrates it, seeds the e2e account. Subcommands `up`, `reset`, `down`, `migrate`, `seed`, `guard`, `psql` are also exposed as `pnpm db:test:*`. |
| `pnpm db:migrate`                    | Applies ordered SQL migrations. Idempotent, and proven from an empty database.                                                                                                       |
| `pnpm db:generate`                   | Generates the next migration plus its snapshot from the schema.                                                                                                                      |
| `node scripts/seed-perf.mjs <email>` | Seeds 1,000 books / ~60k rows onto an existing account for performance work.                                                                                                         |

## Continuous integration

Pull requests run `Verify quick` and five `Browser (…)` jobs — iPhone WebKit,
Offline parity, Sync integrity, Resume durability, and Launch performance — as
separate, required-capable checks. Each job provisions its own local Postgres
and project-pinned browser binaries. Failed browser jobs retain their
screenshots and traces as artifacts.

The resume job runs 24 proven cells. The two real-iOS hidden-state cells stay
explicit in [resume-durability-device-check.md](resume-durability-device-check.md)
rather than making CI permanently red.

Protect `main` with `Verify quick` and every `Browser (…)` check before treating
a green deployment as a merge gate.

## What a green run does not prove

Three limits are worth stating before reading a green run as more than it is.

- **The launch benchmark does not run on WebKit.** It measures in a Chromium
  persistent context with iPhone 15 emulation. In Playwright 1.61.1, WebKit's
  persistent context accepts `cache.put()` but returns nothing from
  `cache.match()` — in the page and in the service worker alike — so the app's
  worker cannot even install there. The harness probes WebKit first on every run
  and will switch back automatically when that is fixed. Until then, WebKit PWA
  coverage comes from `tests/e2e/iphone-pwa.spec.ts`.
- **The outbox drains only while the app is open.** iOS will not wake a closed
  PWA, so an offline write reaches the server on the next foregrounded launch or
  reconnect, never before.
- **Audio evicted by the OS is gone.** It exists nowhere but the device, so the
  book stays visible with its metadata and asks for the original MP3 or document
  again.

Browser verification uses the repository's Playwright tooling against a production
build. It does not require computer-use or node_repl MCP servers. The iPhone
project includes real MP3 transport, settings, organization, transcript, data
export/deletion, document format narration, cancellation and legacy-rendition
checks, plus `tests/e2e/privacy-transport.spec.ts`, which calibrates what the
browser can observe about cross-origin requests between two loopback origins it
owns. Large traces and generated fixtures belong in ignored output folders.

On Node 26, use `NODE_OPTIONS=--no-experimental-webstorage pnpm test`: its
experimental global localStorage otherwise masks jsdom's storage in several
existing tests. CI uses Node 22. This flag changes the test host, not browser
storage behavior.

For the objective checkout's isolated database and browser paths, exact commands
and raw outcomes are in [the evidence ledger](evidence/architecture-ledger.md).
`node scripts/record-check.mjs <output-prefix> <command> [args...]` preserves
commands, elapsed time, exit status and raw output. Source counts use
`node scripts/measure-source.mjs <output.json>` after a production build.
`node scripts/measure-browser.mjs baseline|final core|library` runs the comparable
real Chromium PWA measurements; `library` expects the launch benchmark's seeded
1,000-book test account.
