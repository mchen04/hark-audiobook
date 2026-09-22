# Hark

A calm audiobook PWA for importing MP3s and turning documents into audio on your
device. Listen offline, keep your place, and sync library metadata between your
own devices. Audio, source documents, covers, and transcripts stay on the device
that imported them.

## Listening

- Import MP3, PDF, EPUB, DOCX, TXT, Markdown, or HTML from **Choose a book**.
  Documents use Kestrel Fast locally. Keep Hark open until narration finishes;
  progress and cancellation are available, and completed books remain playable
  during an import. The new book becomes playable only after its audio is saved.
- Play with chapter navigation, adjustable speed and skips, a sleep timer, smart
  rewind, and playback history. Compatible embedded MP3 transcripts support
  read-along text; document narration also creates a local transcript.
- Search, sort, tag, archive, and organize books into collections. Collection
  autoplay is optional. **On this device** filters the library to saved audio.
- On another device, sign in to sync metadata and progress, then attach the
  matching source file to listen. Audio is never transferred through the server.

Install Hark from your browser's install menu, or on iPhone from Safari's Share
menu using **Add to Home Screen**. Open it online first so the app shell is saved.
The first document narration also downloads public model/runtime assets; later
narration can work offline while those assets remain cached. Scanned PDFs need
text extraction elsewhere: Hark does not perform OCR or remove DRM.

## Your files and account

Browser storage can be evicted. Keep your original files: metadata sync and JSON
export are not audio backups. A missing download stays in the library and asks
for reattachment. Regenerated document audio must match the saved rendition and
chapter timing. Completed audio from an older narration engine can still play;
Hark refuses to regenerate an unsupported rendition over its old timeline.

**Remove download** frees this device's copy; deleting a book removes its library
metadata and progress across devices. Signing out removes that account's local
media and data after a bounded attempt to send pending writes. An expired session
does not itself delete downloads. Settings offers metadata export, account
deletion, and resume diagnostics. See [storage and sync](docs/local-first.md) for
the exact account and recovery boundaries.

## Run locally

Use Node 22 (the CI runtime), pnpm 9.6.0, and Docker Compose for disposable local
Postgres. FFmpeg is needed for browser test fixtures.

```sh
pnpm install --frozen-lockfile
test -f .env.test || cp .env.test.example .env.test
pnpm db:test:up
pnpm prepare:browser-assets
node --env-file=.env.test --run dev
```

Open [localhost:3000](http://localhost:3000). The bootstrap fills blank test
secrets and seeds a disposable account. Reuse its matching env file and database;
do not overwrite credentials for a retained fixture. For other databases,
production configuration, and troubleshooting, use the [setup guide](docs/development.md)
and [operations guide](docs/operations.md).

## Checks

After local setup, on Node 22:

```sh
node --env-file=.env.test --run verify:quick
pnpm exec playwright install webkit chromium
pnpm verify:browser
```

On Node 26, unit tests need `NODE_OPTIONS=--no-experimental-webstorage`. Browser checks build and run the
production PWA against disposable local data; they do not prove physical iOS
background behavior. See [iPhone testing](docs/ios-pwa-testing.md) and the
[device resume check](docs/resume-durability-device-check.md).

## Documentation

[Setup and contributing](docs/development.md) · [Architecture](docs/architecture.md) ·
[Storage and sync](docs/local-first.md) · [Operations](docs/operations.md) ·
[Changelog](CHANGELOG.md) · [Documentation index](docs/README.md)

## License

Hark is [Apache-2.0 licensed](LICENSE). Pinned model and runtime assets retain
their upstream licenses; see the [Kestrel asset manifest](src/lib/kestrel/asset-manifest.json)
for exact model and exporter revisions. Public model weights and voice data are
fetched from upstream on first narration and are not redistributed here.
