# Operations

Hark serves a Next.js PWA and authenticated PostgreSQL metadata APIs over HTTPS.
Audio, source documents, covers, and transcripts stay on the importing device.

## Configure the server

| Variable                      | Purpose                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`                | PostgreSQL for metadata, authentication, and sync receipts. |
| `BETTER_AUTH_SECRET`          | Private random signing secret of at least 32 characters.    |
| `BETTER_AUTH_URL`             | Exact app origin, including the port for local use.         |
| `RESEND_API_KEY`, `MAIL_FROM` | Configure both for password-reset delivery.                 |
| `ALLOW_LOCAL_MAIL_CAPTURE`    | Use `true` only for local production-mode test servers.     |

Omit both mail keys for development capture in `.data/mail`.
Production reset requests require real delivery or explicit local capture.
Partial mail configuration fails validation. Protect credentials, backups, and captured reset links.

## Build and migrate

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
```

Back up the database before migrations and prepare a rollback.
Drizzle applies ordered SQL. Keep migration files and snapshots; do not use runtime schema push.
Migration `0028` retains the legacy owner/fingerprint uniqueness index for compatible servers.
Receipt ordering requires all writers to follow the current per-account locking rule.
Do not mix older writers with direct database mutations.

Prebuild prepares pinned browser assets. Postbuild writes the runtime precache manifest.
Deploy the matching `.next`, static chunks, and `public` assets together.
The optional `vercel-build` command migrates only when `VERCEL_ENV=production`.
Hosting integrations can deploy on pushes or merges independently of CI.
`pnpm verify:kestrel-export` separately verifies model-export provenance against pinned upstream weights.

## Recover device data

| Condition                         | Action                                                                   |
| --------------------------------- | ------------------------------------------------------------------------ |
| Initial sync fails                | Retry the recovery screen when connected. Do not infer an empty account. |
| Session expires                   | Sign in again. Expiry preserves local media.                             |
| Audio is missing                  | Open the book and attach the matching source file.                       |
| Older narration cannot regenerate | Use a device that retains completed audio.                               |
| Narration stops before completion | Retry the source with Hark open. Completed attachments remain playable.  |
| Sync returns 503                  | Keep queued writes. Replay retries on reconnect.                         |
| Storage fills                     | Remove selected downloads whose originals you retain, then retry.        |

Do not clear browser data as a first repair. It can destroy the only audio copy and pending changes.
Sign-out drains queued changes for up to eight seconds, then removes that account's local data.
Book deletion removes its synced metadata and progress. Remove download affects only local media.
Account deletion checks the password, records pending local cleanup, and resumes interrupted cleanup on the next load.

## Back up and diagnose

Keep original files separately. PostgreSQL backups contain no media.
Settings exports metadata, chapters, progress, tags, collections, preferences, history, saved positions, and listening sessions as JSON.
Exports contain no audio, source files, covers, or transcript payloads. Hark has no JSON restore screen.

Settings **Resume diagnostics** shows the saved position, writer, and age.
Record the build, browser, action, result, HTTP status, and relevant console error.
Redact credentials and private content. Save evidence outside the source tree.
See [WebKit testing](ios-pwa-testing.md) for browser and native evidence limits.
