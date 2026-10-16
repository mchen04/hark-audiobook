# Hark documentation

- [Readme](../README.md): what Hark does, file handling, and local start.
- [Setup and contributing](development.md): environment, fixtures, commands, and CI.
- [Architecture](architecture.md): runtime boundaries, import, playback, and source map.
- [Storage and sync](local-first.md): persistence, receipt ordering, conflicts, and account lifecycle.
- [Operations](operations.md): production configuration, migrations, backups, and recovery.
- [WebKit PWA testing](ios-pwa-testing.md): browser proof, standalone emulation, and evidence limits.
- [Resume limits and optional observations](resume-durability-device-check.md): automated proof and optional background material.
- [Benchmark protocol](../tests/perf/BASELINE.md): metric definitions, flicker rules, and the launch gate.
- [Benchmark commands](development.md#benchmark): build preparation, comparisons, and recordings.
- [Update and playback checks](development.md#update-and-playback-checks): build rollover, Media Session, and exact resume.
- [Changelog](../CHANGELOG.md): user-visible changes awaiting release.

These are maintained docs. Generated review reports, command receipts, screenshots,
and benchmark runs belong outside the shipped source tree. Historical reports
remain in Git history; their results apply to their recorded commits and runtimes.
