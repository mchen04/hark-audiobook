# Operations

Hark serves a Next.js PWA and authenticated metadata APIs backed by PostgreSQL.
It has no server audio storage or cloud narration service. Deployments require
HTTPS (localhost is the development exception) and a database reachable by the
server. Each account owns its rows; serving the shell does not grant access to
private metadata.

## Configuration

| Variable                         | Purpose                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | PostgreSQL connection for metadata, auth, and receipts.                                                                       |
| `BETTER_AUTH_SECRET`             | Private random signing secret, at least 32 characters.                                                                        |
| `BETTER_AUTH_URL`                | Exact app origin, including port for local use.                                                                               |
| `RESEND_API_KEY` and `MAIL_FROM` | Configure both for password-reset delivery. Omit both for local capture.                                                      |
| `ALLOW_LOCAL_MAIL_CAPTURE=true`  | Explicitly allow production-mode **local test** servers to write reset mail to `.data/mail`. Never use this as real delivery. |

Do not set optional mail keys to empty strings. Partial mail configuration fails
validation. With neither mail key, development captures reset mail locally;
production reset requests fail unless real delivery or explicit local capture is
configured. Protect env files, database backups, and captured reset links. Never
commit secrets or log passwords, reset tokens, or document content.

## Build and migrations

For a configured environment:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
```

Drizzle applies the ordered SQL history; do not use runtime schema push.
`pnpm db:generate` creates a migration and snapshot for an intentional schema
change. Keep existing SQL and `drizzle/meta` snapshots intact.

Migration `0028` expands media uniqueness to include rendition identity while
retaining the older three-column owner/fingerprint arbiter for compatible
servers. Do not drop the legacy index casually. Receipt ordering requires all
cursor-bearing writers to use the current serialized database rule; mixed
predecessor/current servers or direct writes can invalidate it. See
[receipt ordering](local-first.md#3-aggregate-and-receipt-ordering).

Prebuild copies/verifies pinned browser assets locally and postbuild emits the
runtime precache manifest. Serve the matching `.next` output, static chunks, and
`public` assets together. The standalone test runner stages these assets and
reads an explicit env file; see [development](development.md#checks).
`pnpm verify:kestrel-export` is a separate provenance check that downloads pinned
upstream weights and reproduces the ONNX graphs; it is not required at each app
startup.

The optional `vercel-build` script applies migrations only when
`VERCEL_ENV=production`. Other builds use placeholder build credentials rather
than opening the production database. This does **not** make an automatically
published preview harmless or authorize deployment. Git hosting integrations
can create previews on pushes and production deployments on merges independently
of CI; inspect and resolve those triggers before a publication that must not deploy.

## Device storage and recovery

The server can restore metadata after device storage loss, but never the audio
or transcript bytes. Keep original source files separately. Browser persistence
requests reduce eviction risk without guaranteeing retention.

| Situation                                 | Recovery                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| First sync cannot reach the account       | Keep the loading/recovery state and retry when connected; do not infer an empty account.                                          |
| Session expired                           | Sign in again. Expiry itself preserves local media.                                                                               |
| Audio missing or removed from this device | Open the book and attach its matching source. Do not delete the book to reattach it.                                              |
| Unsupported older narration rendition     | Use a device that still has completed audio; Hark will not regenerate a different timeline onto the saved book.                   |
| Narration interrupted                     | Incomplete work is cancelled; retry the source while Hark stays open. A completed durable attachment remains available.           |
| Sync returns 503 with `Retry-After: 1`    | Durable intent remains queued. Normal replay resumes on mount/reconnect; sign-out can retry within its eight-second drain budget. |
| Quota exhausted                           | Free device storage or remove selected downloads whose originals you retain, then retry.                                          |

Do not clear browser data as a first troubleshooting step: it can remove the only
local audio copy and pending writes. **Remove download**, book deletion, sign-out,
and account deletion have different effects; see the
[account lifecycle](local-first.md#11-account-lifecycle).

## Export, backups, and diagnostics

Settings exports account/library metadata, chapters, progress, tags, collections,
preferences, playback history, legacy saved positions, and listening sessions as
JSON. It does not export audio, source documents, covers, or transcript payloads,
and Hark has no JSON-restore UI. Database backups likewise do not back up media.
Account deletion verifies the password and journals local purge before the
idempotent server deletion commit; interrupted deletion resumes on next load.

For a report, record the served commit/build, runtime/browser/device, action,
observed result, HTTP status, and relevant console error. Settings **Resume
diagnostics** shows the latest saved position, writer, and age; see the
[device procedure](resume-durability-device-check.md). Redact account identifiers,
source content, and credentials from shared receipts. Keep artifacts outside the
source tree and preserve failed outcomes alongside later results.

## Verification limits

Use the [quick and browser gates](development.md#checks) against disposable data
and the exact production build being accepted. A green unit suite does not prove
browser service-worker behavior. Desktop WebKit does not establish physical iOS
screen-off durability; the launch benchmark may fall back to Chromium when its
persistent-WebKit capability probe fails. Neither case should be reported as a
physical-device pass.
