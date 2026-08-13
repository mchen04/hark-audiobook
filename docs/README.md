# Hark documentation

Start with [architecture.md](architecture.md) for how the app is built, and
[local-first.md](local-first.md) for why the local-first rules are what they are.

## Design and behavior

| Document                                       | What it covers                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [architecture.md](architecture.md)             | Stack, boundaries, data rules, the local read model, the write path, the launch path, rejected alternatives              |
| [local-first.md](local-first.md)               | The design contract: what is mirrored, the outbox, pull, conflict rules, eviction, account lifecycle                     |
| [lemonade.md](lemonade.md)                     | Narrating through AMD's Lemonade server: setup, engine selection, why the rendition key names the engine, and the limits |
| [repository-anatomy.md](repository-anatomy.md) | Tracked-line breakdown, generated-file policy, large-file classification, counting rules                                 |

## Building and running

| Document                         | What it covers                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [development.md](development.md) | Setup, environment variables, the local test database, every command, CI, and the limits of a green run |
| [operations.md](operations.md)   | Deployment shape, backup and restore, data lifecycle, platform limitations, troubleshooting             |

## Release gates

| Document                                                               | What it covers                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [ios-pwa-testing.md](ios-pwa-testing.md)                               | The automated WebKit gate and the physical-iPhone release checklist                 |
| [resume-durability-device-check.md](resume-durability-device-check.md) | The one resume check that needs a real iPhone, and its observable pass/fail signal  |
| [`../tests/perf/BASELINE.md`](../tests/perf/BASELINE.md)               | The proven-red launch baseline and the measured local-first result that replaced it |

## Conventions

Each document carries a review date in its header. When executable reality
changes, update the document in the same change — a stale contract is worse than
no contract. Figures that can be measured (line counts, launch percentiles,
schema versions) should name the command or file that reproduces them.
