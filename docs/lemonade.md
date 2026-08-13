# Narrating through Lemonade

Last reviewed: 2026-08-13

[Lemonade](https://lemonade-server.ai) is AMD's local AI server. It serves stock
Kokoro on whatever hardware the machine has — a Ryzen AI NPU, a GPU, or the CPU
— behind an OpenAI-compatible route on loopback. When it is running, Hark
narrates documents through it instead of running Kokoro in the page.

This does not weaken the privacy boundary. Loopback never leaves the machine,
and Lemonade is the user's own software on the user's own hardware. It is an
alternative to running Kokoro _in the browser_, not an alternative to running it
_locally_.

## Setup

Install Lemonade for your platform, then pull the voice:

```sh
lemonade pull kokoro-v1
lemonade status          # expect: Server is running on port 13305
```

Nothing in Hark needs configuring. The next document import detects the server
and uses it.

## How the engine is chosen

`createNarrationEngine()` in `src/lib/kestrel/engine.ts` probes
`GET /api/v1/models` on `http://localhost:13305`, bounded at 1.5s, and requires
`kokoro-v1` to be present **and already downloaded** — a registered but
undownloaded model would otherwise stall the first synthesis behind a 300 MB
download with no progress to report.

Every probe failure means "narrate in the page", never "fail the import",
including a stranger on port 13305 answering with something that is not JSON.

The engine is chosen once per book and then held, because it is part of the
book's rendition identity.

## Why the rendition key names the engine

Both engines narrate Kokoro's `af_heart`, and they sound like the same voice.
They are not the same build. Kestrel Fast is Hark's own split-graph export
driven by `onnxruntime-web`; Lemonade serves stock `kokoro-onnx`. Hark's seed
also drives vocoder noise, and Lemonade's API has no seed parameter.

So their samples are not interchangeable, and `renditionKeyFor()` in
`src/lib/document-import/rendition.ts` names the engine that produced a book.

The consequence is deliberate and worth stating plainly: **a Lemonade-narrated
book can only be rebuilt on a machine running Lemonade.** A device without it
gets a named error asking for Lemonade rather than a silent re-narration whose
chapter timings would no longer match the saved seek map — which
`assertSameRenditionTimeline` would reject anyway, after spending minutes
generating audio.

## Audio format

Lemonade's `response_format: "wav"` returns mono IEEE-float at 24 kHz, which is
already Hark's internal format, so samples reach the MP3 encoder with no
resample and no decode step. `decodeFloat32Wav()` walks the RIFF chunks rather
than assuming fixed offsets, and refuses anything that is not mono float32 at
24 kHz instead of silently converting it.

## Verification

`src/lib/kestrel/lemonade.test.ts` covers the probe, the client, and the WAV
decoder against a mocked fetch. That can only prove Hark honors a contract it
was told about, so there is a second, opt-in suite:

```sh
HARK_LIVE_LEMONADE=1 pnpm vitest run src/lib/kestrel/lemonade.live.test.ts
```

It runs against the real server and is skipped otherwise, so CI — which has no
Lemonade — does not appear to run a gate it cannot.

Measured on an M-series Mac (Metal, not an NPU): a sentence synthesizes in
roughly 400–700ms, and a three-chapter document imports end to end in about 27
seconds. AMD NPU figures are unmeasured here; this repository has no Ryzen AI
hardware to report from.

## How long it will take

`src/lib/document-import/narration-estimate.ts` answers two different questions
with two different methods.

**How much audio a document will produce** is arithmetic. Kokoro's pace is a
property of the voice, not of the machine: measured across two documents on
`af_heart`, speech ran 15.85 and 16.53 characters per audio second once
inter-chapter silence is excluded, so the midpoint of 16.2 predicts length from
the character count alone. That number is shown before a single sample exists.

**How long producing it will take** is not arithmetic — it depends on the engine
and the hardware, from an NPU to a phone on WASM — so it is measured while
narrating. The meter withholds a reading until two chunks are in, because the
first carries one-time cost (model load, cold graph, JIT warm-up) and an
estimate drawn from it would be wrong in the pessimistic direction exactly when
the user is watching.

Below a minute remaining, the countdown is withheld rather than rounded:
`formatDurationRounded` floors at "1m", so a short import would otherwise sit on
"1m left" through its final chapters and read as stuck.

Narration measured about 5.6x realtime here, which is why listening during an
import works at all. Readiness is judged from the buffer rather than from that
ratio, because the buffer is the thing that actually runs out.

## Listening while it narrates

A document appears in the library the moment it is chosen, as a narrating entry
with its own progress. Once about 20 seconds of audio is queued the entry offers
"Listen now" and plays what exists while the rest is still being made. When the
import finishes the entry is replaced by the real book.

This needs none of the durable machinery. The engine returns raw samples and the
import already holds them, so `narration-preview.ts` schedules those straight
onto an AudioContext — no media store, no service worker, no seek map, no
registered book. `importLocalDocument` reports them through an optional
`onNarrationAudio` callback and does not wait on it.

The entry is rendered **outside** the library's frozen region on purpose.
`useBookImport` aborts the import when the library unmounts, so tapping a real
book mid-import would destroy the narration in progress — which is why
everything that navigates stays `inert` while an import runs. This entry
navigates nowhere, so it can stay live.

The scheduling is kept free of Web Audio so it can be tested against a fake
clock; `browserNarrationSink` is the only part that touches an AudioContext, and
it is constructed from the button press because Safari will not start audio
otherwise. An MP3 import shows the same entry without the offer: it is copied,
not narrated, so there is no partial audio to play. If the engine falls behind playback the schedule restarts just ahead
of the clock and counts an underrun rather than queueing a moment already gone.

What this deliberately is not: there is no scrubbing, chapter jumping, or
resume, and the preview does not outlive the import. Those belong to a book with
a committed timeline, which is the next section.

## Streaming the book itself, not built

Narration currently completes before a book becomes playable. At 5.6x realtime a
300-page book is roughly 9.5 hours of audio and about 100 minutes of waiting,
which is the difference between a feature people use and one they abandon.

The audio itself already streams: the encoder writes progressively into 4 MiB
Cache Storage chunks as narration runs, and the service worker already answers
range requests from those chunks. What blocks playback is bookkeeping, not
audio — a book becomes playable only once its final duration and chapter seek
map are known, and `commitChunkedMedia` runs at the end.

Streaming would mean registering a book against an _estimated_ duration and
provisional chapter marks, then correcting them at the end. That is exactly what
`assertSameRenditionTimeline` exists to refuse, so the contract would have to
learn the difference between "still generating" and "wrong" — which is why this
is a designed change rather than a patch.

Two decisions worth recording before anyone builds it:

- **Gate on measured throughput, not on the engine.** "Is it Lemonade?" is a
  proxy for the real question. A CPU-only Lemonade box can run below realtime,
  and a fast WebGPU desktop can run above it. The preview already does this the
  right way — it offers to start only once the buffer says it will not stutter,
  which degrades honestly on slow hardware and improves for free as engines get
  faster.
- **Chunks, not chapters.** A 320-character chunk is roughly 20 seconds of
  audio and takes about 3.6s to produce here, so two chunks give a usable buffer
  in about 7 seconds. Waiting for a whole first chapter would be needlessly
  conservative on a book whose opening chapter runs ten minutes.

## Limits

- **Desktop only.** Lemonade has no iOS build and iOS does not permit background
  servers, so phones always use the in-browser engine.
- **HTTPS pages cannot reach it.** A page on `https://…` calling
  `http://localhost:13305` needs Private Network Access headers that Lemonade
  does not send. Demos and local use should run against
  `pnpm build && pnpm start` on `http://localhost:3000`.
- **The choice is automatic.** A user who happens to run Lemonade for something
  else gets a different narration engine than one who does not, with no setting
  to pin it. Making it explicit later means changing rendition keys for books
  already narrated.
