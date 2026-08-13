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
