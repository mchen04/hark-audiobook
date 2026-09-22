# Launch performance gate

The [launch benchmark](launch-benchmark.spec.ts) measures time from navigation to
painted library content in a fresh browser process reusing a warm profile. Run it
against disposable local fixtures after [setup](../../docs/development.md):

```sh
pnpm test:e2e:launch
```

The harness builds/starts the production app, ensures at least 1,000 fixture books,
and refuses hosted databases. Its seeded account is test data; never point it at
a personal library or reset a retained database to improve a score.

## Fixed acceptance contract

- Six launches per profile: fast (0 ms), slow (400 ms), simulated cold database
  (3,000 ms), and offline.
- p95 no more than **500 ms** on every profile; spread between profile p95 values
  no more than **150 ms**.
- Real book cards and the `books` readiness marker must paint. A skeleton or
  accidental empty mirror is not a successful launch.
- The cached document, zero document transfers/server document hits, and zero
  Postgres queries before paint are asserted independently of the timing.
- Delay/offline controls and persistent cache survival are proved before the
  relevant samples count. CPU calibration normalizes a fixed reference workload;
  viewport emulation alone does not simulate phone CPU speed.

The harness probes persistent WebKit first. If its Cache Storage behavior fails
the probe, it can use Chromium with iPhone viewport emulation and calibrated CPU.
The report names the engine and capability result. Neither that fallback nor
Playwright WebKit is a physical-iPhone measurement.

## Recording a comparison

Use the same command, fixture scale, runtime, browser engine, CPU calibration,
network controls, and metric definitions for baseline and candidate. Record exact
source commit, dirty status, build id, samples, and final assertion outcomes in an
external receipt directory. Keep failures and incomplete output. A printed table
before assertions finish is not a passing result.

This file defines the protocol, not the latest measured score. Historical results
remain attributable to their original commits in Git history and external task
artifacts. Do not carry an earlier browser score forward as a measurement of a
new source head. Source LOC/complexity and build-wide asset totals from
`scripts/measure-source.mjs` are separate measurements, not launch latency or
initial-download size.
